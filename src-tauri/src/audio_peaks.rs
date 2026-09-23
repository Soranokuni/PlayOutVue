//! Audio peak envelope for the trim panel.
//!
//! The trimmer lets an operator listen while they cut. Hearing alone is not
//! enough to cut on a word: they also need to *see* where the sound starts and
//! stops, and a level meter that does not depend on the preview player. Both
//! come from this one scan.
//!
//! ffmpeg decodes the first audio stream to 8 kHz stereo s16 on stdout, and the
//! samples are folded into one peak per channel every 10 ms as they arrive. The
//! whole file is never held in memory: an hour of programme is ~57 MB of PCM
//! through the pipe and 720 KB of peaks out of it.
//!
//! The wire format is deliberately bare, so it can go back through
//! `tauri::ipc::Response` as an `ArrayBuffer` rather than as a JSON array of
//! numbers: interleaved `[L, R, L, R, ...]`, one byte per channel per 10 ms.
//! Each byte is the peak in dBFS mapped linearly from `DB_FLOOR` (0) to 0 dBFS
//! (255); 0 also means digital silence. `src/lib/audioPeaks.ts` holds the
//! matching constants and decoder.
//!
//! 8 kHz loses the top of the spectrum, so the envelope reads slightly under
//! true peak on bright material. It is a monitoring aid for finding a cut, not
//! a loudness or true-peak compliance meter, and the UI does not claim to be.

use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, Runtime, State};

use crate::runtime_settings::{resolve_tool_path, RuntimeSettingsState};

/// Peaks per second per channel. 10 ms is finer than a frame at any broadcast
/// rate, which is the resolution a cut is made at.
pub const PEAKS_PER_SECOND: u32 = 100;
/// Decode rate for the scan. See the module note on what this costs.
const ANALYSIS_RATE: u32 = 8_000;
const CHANNELS: usize = 2;
const SAMPLES_PER_PEAK: usize = (ANALYSIS_RATE / PEAKS_PER_SECOND) as usize;
/// Level mapped to byte 0. Anything quieter reads as silence.
pub const DB_FLOOR: f64 = -72.0;
/// Measured on the ARM broadcast box with x64 ffmpeg under emulation: a
/// 294 s mezzanine scans in 0.56 s, so a programme hour is ~7 s. The cap is
/// headroom for a slow SMB share, not an expected duration.
const SCAN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Envelopes kept in memory, so re-opening the trimmer on a clip is instant.
const CACHE_ENTRIES: usize = 8;
/// Envelopes kept on disk (app cache dir), so a restart does not re-read every
/// file. An hour of programme is 720 KB, so this is at most ~46 MB.
const DISK_CACHE_ENTRIES: usize = 64;
const DISK_CACHE_MAGIC: &str = "playout-audio-peaks v1";

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
/// The scan reads the whole file. On the playout machine that file sits on
/// the same volume CasparCG plays from, so the scan yields the CPU to it.
#[cfg(target_os = "windows")]
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
/// Error for a scan that was superseded or abandoned; the panel ignores it.
pub const CANCELLED: &str = "cancelled";

/// Map an absolute sample peak (0..=32768) to the byte encoding.
pub fn encode_peak(abs: u32) -> u8 {
    if abs == 0 {
        return 0;
    }
    let db = 20.0 * (abs as f64 / 32768.0).log10();
    if db <= DB_FLOOR {
        return 0;
    }
    let code = ((db - DB_FLOOR) / -DB_FLOOR * 255.0).round();
    code.clamp(1.0, 255.0) as u8
}

/// Folds interleaved s16le stereo into per-channel peaks. Bytes can arrive
/// split at any boundary, including mid-sample.
#[derive(Default)]
pub struct PeakAccumulator {
    carry: Vec<u8>,
    in_bucket: usize,
    max: [u32; CHANNELS],
    out: Vec<u8>,
}

impl PeakAccumulator {
    pub fn push(&mut self, bytes: &[u8]) {
        const FRAME: usize = 2 * CHANNELS;
        let mut data = bytes;
        if !self.carry.is_empty() {
            let need = FRAME - self.carry.len();
            if data.len() < need {
                self.carry.extend_from_slice(data);
                return;
            }
            let mut frame = [0u8; FRAME];
            frame[..self.carry.len()].copy_from_slice(&self.carry);
            frame[self.carry.len()..].copy_from_slice(&data[..need]);
            self.carry.clear();
            self.frame(&frame);
            data = &data[need..];
        }
        let whole = data.len() - data.len() % FRAME;
        for frame in data[..whole].chunks_exact(FRAME) {
            self.frame(frame);
        }
        self.carry.extend_from_slice(&data[whole..]);
    }

    fn frame(&mut self, frame: &[u8]) {
        for (channel, sample) in frame.chunks_exact(2).enumerate() {
            let value = i16::from_le_bytes([sample[0], sample[1]]) as i32;
            let abs = value.unsigned_abs();
            if abs > self.max[channel] {
                self.max[channel] = abs;
            }
        }
        self.in_bucket += 1;
        if self.in_bucket == SAMPLES_PER_PEAK {
            self.flush_bucket();
        }
    }

    fn flush_bucket(&mut self) {
        for channel in 0..CHANNELS {
            self.out.push(encode_peak(self.max[channel]));
        }
        self.max = [0; CHANNELS];
        self.in_bucket = 0;
    }

    /// The envelope, including a trailing partial bucket.
    pub fn finish(mut self) -> Vec<u8> {
        if self.in_bucket > 0 {
            self.flush_bucket();
        }
        self.out
    }
}

type CacheKey = (String, u64, Option<SystemTime>);
type PeakCache = Mutex<VecDeque<(CacheKey, Arc<Vec<u8>>)>>;

fn cache() -> &'static PeakCache {
    static CACHE: OnceLock<PeakCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn cache_get(key: &CacheKey) -> Option<Arc<Vec<u8>>> {
    let guard = cache().lock().ok()?;
    guard.iter().find(|(k, _)| k == key).map(|(_, v)| Arc::clone(v))
}

fn cache_put(key: CacheKey, value: Arc<Vec<u8>>) {
    if let Ok(mut guard) = cache().lock() {
        guard.retain(|(k, _)| k != &key);
        guard.push_back((key, value));
        while guard.len() > CACHE_ENTRIES {
            guard.pop_front();
        }
    }
}

/// The one scan allowed to run. Every request supersedes it: the trim panel
/// only ever wants the envelope of the clip it has open, and an abandoned scan
/// used to keep reading a multi-gigabyte file for up to `SCAN_TIMEOUT`.
struct ActiveScan {
    id: u64,
    cancel: Arc<AtomicBool>,
}

fn active_scan() -> &'static Mutex<Option<ActiveScan>> {
    static ACTIVE: OnceLock<Mutex<Option<ActiveScan>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

/// Raise the running scan's cancel flag, if there is one.
fn cancel_active_scan() {
    if let Ok(mut guard) = active_scan().lock() {
        if let Some(scan) = guard.take() {
            scan.cancel.store(true, Ordering::SeqCst);
        }
    }
}

/// Register a new scan, cancelling whichever one was running.
fn begin_scan() -> (u64, Arc<AtomicBool>) {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut guard) = active_scan().lock() {
        if let Some(previous) = guard.replace(ActiveScan { id, cancel: Arc::clone(&cancel) }) {
            previous.cancel.store(true, Ordering::SeqCst);
        }
    }
    (id, cancel)
}

fn end_scan(id: u64) {
    if let Ok(mut guard) = active_scan().lock() {
        if guard.as_ref().map(|scan| scan.id) == Some(id) {
            *guard = None;
        }
    }
}

fn mtime_nanos(modified: Option<SystemTime>) -> String {
    modified
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|| "none".to_string())
}

/// The header a cache file starts with. Checked on read, so a hash collision
/// or a stale file can only ever miss, never return another file's peaks.
fn disk_cache_header(key: &CacheKey) -> String {
    format!("{}\n{}\n{}\n{}\n", DISK_CACHE_MAGIC, key.0, key.1, mtime_nanos(key.2))
}

/// FNV-1a: stable across builds, unlike `DefaultHasher`.
fn disk_cache_file(dir: &Path, key: &CacheKey) -> PathBuf {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in disk_cache_header(key).bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    dir.join(format!("{:016x}.peaks", hash))
}

fn disk_cache_get(dir: &Path, key: &CacheKey) -> Option<Vec<u8>> {
    let bytes = std::fs::read(disk_cache_file(dir, key)).ok()?;
    let header = disk_cache_header(key);
    let body = bytes.strip_prefix(header.as_bytes())?;
    (!body.is_empty() && body.len() % CHANNELS == 0).then(|| body.to_vec())
}

fn disk_cache_put(dir: &Path, key: &CacheKey, peaks: &[u8]) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let target = disk_cache_file(dir, key);
    let temp = target.with_extension("tmp");
    let mut bytes = disk_cache_header(key).into_bytes();
    bytes.extend_from_slice(peaks);
    if std::fs::write(&temp, &bytes).is_err() || std::fs::rename(&temp, &target).is_err() {
        let _ = std::fs::remove_file(&temp);
        return;
    }
    prune_disk_cache(dir);
}

/// Keep the newest `DISK_CACHE_ENTRIES` envelopes.
fn prune_disk_cache(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "peaks"))
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect();
    if files.len() <= DISK_CACHE_ENTRIES {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in files.into_iter().skip(DISK_CACHE_ENTRIES) {
        let _ = std::fs::remove_file(path);
    }
}

/// The error string the panel keys on to say "this file has no audio" rather
/// than "the scan failed".
pub const NO_AUDIO: &str = "no_audio";

fn classify_failure(stderr: &str) -> String {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("matches no streams") || lower.contains("does not contain any stream") {
        return NO_AUDIO.to_string();
    }
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        "ffmpeg exited without saying why".to_string()
    } else {
        trimmed.lines().last().unwrap_or(trimmed).to_string()
    }
}

fn scan(ffmpeg: &str, path: &str, cancel: &AtomicBool) -> Result<Vec<u8>, String> {
    let mut command = Command::new(ffmpeg);
    // `-i` keeps a path starting with `-` from being read as an option; the
    // whitelist keeps the scan to local and UNC files.
    let rate = ANALYSIS_RATE.to_string();
    command.args([
        "-v", "error",
        "-nostdin",
        "-protocol_whitelist", "file",
        "-i", path,
        "-map", "0:a:0",
        "-vn", "-sn", "-dn",
        "-ac", "2",
        "-ar", rate.as_str(),
        "-f", "s16le",
        "pipe:1",
    ]);
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    }

    let mut child = command.spawn().map_err(|e| format!("failed to start ffmpeg: {}", e))?;
    let mut stdout = child.stdout.take().ok_or("ffmpeg stdout unavailable")?;
    let mut stderr = child.stderr.take().ok_or("ffmpeg stderr unavailable")?;

    let reader = std::thread::spawn(move || {
        let mut acc = PeakAccumulator::default();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => acc.push(&buf[..n]),
            }
        }
        acc.finish()
    });
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if cancel.load(Ordering::SeqCst) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                let _ = errors.join();
                return Err(CANCELLED.to_string());
            }
            Ok(None) if started.elapsed() >= SCAN_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("audio scan timed out after {} s", SCAN_TIMEOUT.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => {
                let _ = child.kill();
                return Err(format!("failed to wait for ffmpeg: {}", e));
            }
        }
    };

    let peaks = reader.join().unwrap_or_default();
    let stderr = errors.join().unwrap_or_default();
    if !status.success() {
        return Err(classify_failure(&stderr));
    }
    if peaks.is_empty() {
        return Err(NO_AUDIO.to_string());
    }
    Ok(peaks)
}

/// Everything after the command boundary: stat, caches, scan. Runs on the
/// blocking pool, because a `metadata` call on an SMB path can block for the
/// share's timeout.
fn load_peaks(ffmpeg: &str, path: &str, cache_dir: Option<&Path>) -> Result<Arc<Vec<u8>>, String> {
    // The panel only wants the clip it has open now; stop reading the last one.
    cancel_active_scan();

    let meta = std::fs::metadata(Path::new(path)).map_err(|_| format!("File not found on disk: {}", path))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", path));
    }
    let key: CacheKey = (path.to_string(), meta.len(), meta.modified().ok());
    if let Some(hit) = cache_get(&key) {
        return Ok(hit);
    }
    if let Some(hit) = cache_dir.and_then(|dir| disk_cache_get(dir, &key)) {
        let hit = Arc::new(hit);
        cache_put(key, Arc::clone(&hit));
        return Ok(hit);
    }

    let (id, cancel) = begin_scan();
    let result = scan(ffmpeg, path, &cancel);
    end_scan(id);
    let scanned = Arc::new(result?);
    if let Some(dir) = cache_dir {
        disk_cache_put(dir, &key, &scanned);
    }
    cache_put(key, Arc::clone(&scanned));
    Ok(scanned)
}

/// Peak envelope of `path`'s first audio stream, as described in the module
/// note. Fails with exactly [`NO_AUDIO`] when the file has no audio stream and
/// with [`CANCELLED`] when a newer request or `cancel_audio_peaks` replaced it.
#[tauri::command]
pub async fn get_audio_peaks<R: Runtime>(
    path: String,
    app: AppHandle<R>,
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<tauri::ipc::Response, String> {
    let ffmpeg = resolve_tool_path(Some(&app), Some(&runtime_settings), "ffmpeg.exe");
    let cache_dir = app.path().app_cache_dir().ok().map(|dir| dir.join("audio-peaks"));
    let peaks = tauri::async_runtime::spawn_blocking(move || load_peaks(&ffmpeg, &path, cache_dir.as_deref()))
        .await
        .map_err(|e| format!("audio scan task failed: {}", e))??;
    Ok(tauri::ipc::Response::new(peaks.as_ref().clone()))
}

/// Abandon the running scan: the trim panel closed.
#[tauri::command]
pub fn cancel_audio_peaks() {
    cancel_active_scan();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo(frames: &[(i16, i16)]) -> Vec<u8> {
        frames
            .iter()
            .flat_map(|(l, r)| {
                let mut v = l.to_le_bytes().to_vec();
                v.extend_from_slice(&r.to_le_bytes());
                v
            })
            .collect()
    }

    #[test]
    fn encode_maps_the_range_onto_a_byte() {
        assert_eq!(encode_peak(0), 0, "digital silence");
        assert_eq!(encode_peak(32768), 255, "full scale");
        assert_eq!(encode_peak(1), 0, "-90 dBFS is below the floor");
        // -18 dBFS, the EBU alignment level: (72 - 18) / 72 * 255 = 191.25
        let minus_18 = (32768.0 * 10f64.powf(-18.0 / 20.0)).round() as u32;
        assert_eq!(encode_peak(minus_18), 191);
    }

    #[test]
    fn i16_min_does_not_overflow() {
        let mut acc = PeakAccumulator::default();
        acc.push(&stereo(&vec![(i16::MIN, 0); SAMPLES_PER_PEAK]));
        assert_eq!(acc.finish(), vec![255, 0]);
    }

    #[test]
    fn one_peak_per_channel_per_bucket_and_channels_stay_apart() {
        let mut frames = vec![(0i16, 0i16); SAMPLES_PER_PEAK * 2];
        frames[3] = (32767, 0); // loud left in the first bucket only
        frames[SAMPLES_PER_PEAK + 5] = (0, -32767); // loud right in the second only
        let mut acc = PeakAccumulator::default();
        acc.push(&stereo(&frames));
        assert_eq!(acc.finish(), vec![255, 0, 0, 255]);
    }

    #[test]
    fn bytes_split_mid_sample_give_the_same_result() {
        let mut frames = vec![(100i16, -200i16); SAMPLES_PER_PEAK * 3 + 7];
        frames[SAMPLES_PER_PEAK * 2 + 1] = (-30000, 12000);
        let bytes = stereo(&frames);

        let mut whole = PeakAccumulator::default();
        whole.push(&bytes);
        let expected = whole.finish();

        for split in [1usize, 2, 3, 5, 333, 4095] {
            let mut acc = PeakAccumulator::default();
            for chunk in bytes.chunks(split) {
                acc.push(chunk);
            }
            assert_eq!(acc.finish(), expected, "chunk size {}", split);
        }
        // 3 whole buckets plus a partial one.
        assert_eq!(expected.len(), 4 * CHANNELS);
    }

    /// End-to-end against a real file and a real ffmpeg. Opt-in:
    /// `PLAYOUT_PEAKS_SAMPLE=<media> PLAYOUT_FFMPEG=<ffmpeg.exe> cargo test -- --ignored scans_a_real_file`
    #[test]
    #[ignore]
    fn scans_a_real_file() {
        let (Ok(sample), Ok(ffmpeg)) = (std::env::var("PLAYOUT_PEAKS_SAMPLE"), std::env::var("PLAYOUT_FFMPEG")) else {
            return;
        };
        let started = Instant::now();
        let peaks = scan(&ffmpeg, &sample, &AtomicBool::new(false)).expect("scan");
        eprintln!("{} peak bytes in {:?}", peaks.len(), started.elapsed());
        assert_eq!(peaks.len() % CHANNELS, 0);
        assert!(peaks.iter().any(|&b| b > 0), "a programme is not all silence");
        if let Ok(out) = std::env::var("PLAYOUT_PEAKS_OUT") {
            std::fs::write(out, &peaks).unwrap();
        }
    }

    /// A cancelled scan kills its ffmpeg instead of reading on. Opt-in, like
    /// `scans_a_real_file`.
    #[test]
    #[ignore]
    fn cancels_a_real_scan() {
        let (Ok(sample), Ok(ffmpeg)) = (std::env::var("PLAYOUT_PEAKS_SAMPLE"), std::env::var("PLAYOUT_FFMPEG")) else {
            return;
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancel);
        let started = Instant::now();
        let worker = std::thread::spawn(move || scan(&ffmpeg, &sample, &flag));
        std::thread::sleep(Duration::from_millis(30));
        cancel.store(true, Ordering::SeqCst);
        let result = worker.join().expect("scan thread");
        eprintln!("cancelled scan returned after {:?}", started.elapsed());
        assert_eq!(result, Err(CANCELLED.to_string()));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_new_scan_cancels_the_running_one() {
        let (first_id, first) = begin_scan();
        let (second_id, second) = begin_scan();
        assert!(first.load(Ordering::SeqCst), "superseded");
        assert!(!second.load(Ordering::SeqCst));

        // The superseded scan finishing must not unregister the newer one.
        end_scan(first_id);
        cancel_active_scan();
        assert!(second.load(Ordering::SeqCst), "cancel reaches the current scan");
        end_scan(second_id);
    }

    #[test]
    fn disk_cache_round_trips_and_rejects_another_files_entry() {
        let dir = std::env::temp_dir().join(format!("playout-peaks-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let modified = Some(UNIX_EPOCH + Duration::from_secs(1_700_000_000));
        let key: CacheKey = ("D:/media/a.mxf".to_string(), 1234, modified);
        let peaks = vec![10u8, 20, 30, 40];

        assert_eq!(disk_cache_get(&dir, &key), None);
        disk_cache_put(&dir, &key, &peaks);
        assert_eq!(disk_cache_get(&dir, &key), Some(peaks.clone()));

        // A changed file (size or mtime) is a miss, not the old envelope.
        let resized: CacheKey = (key.0.clone(), 1235, modified);
        assert_eq!(disk_cache_get(&dir, &resized), None);

        // Another key's file under this key's name: its header rejects it.
        std::fs::copy(disk_cache_file(&dir, &key), disk_cache_file(&dir, &resized)).unwrap();
        assert_eq!(disk_cache_get(&dir, &resized), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disk_cache_keeps_the_newest_entries() {
        let dir = std::env::temp_dir().join(format!("playout-peaks-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for n in 0..(DISK_CACHE_ENTRIES + 3) {
            let key: CacheKey = (format!("D:/media/{}.mxf", n), n as u64, None);
            disk_cache_put(&dir, &key, &[1, 2]);
        }
        let count = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).count();
        assert_eq!(count, DISK_CACHE_ENTRIES);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_audio_stream_is_named_as_such() {
        assert_eq!(
            classify_failure("Stream map '0:a:0' matches no streams.\nTo ignore this, add a trailing '?' to the map."),
            NO_AUDIO
        );
        assert_eq!(classify_failure("foo.mp4: Invalid data found when processing input\n"), "foo.mp4: Invalid data found when processing input");
        assert_eq!(classify_failure(""), "ffmpeg exited without saying why");
    }
}
