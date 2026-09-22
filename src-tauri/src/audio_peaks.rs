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
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Runtime, State};

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

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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

fn scan(ffmpeg: &str, path: &str) -> Result<Vec<u8>, String> {
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
        command.creation_flags(CREATE_NO_WINDOW);
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

/// Peak envelope of `path`'s first audio stream, as described in the module
/// note. Fails with exactly [`NO_AUDIO`] when the file has no audio stream.
#[tauri::command]
pub async fn get_audio_peaks<R: Runtime>(
    path: String,
    app: AppHandle<R>,
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<tauri::ipc::Response, String> {
    let meta = std::fs::metadata(Path::new(&path)).map_err(|_| format!("File not found on disk: {}", path))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", path));
    }
    let key: CacheKey = (path.clone(), meta.len(), meta.modified().ok());
    if let Some(hit) = cache_get(&key) {
        return Ok(tauri::ipc::Response::new(hit.as_ref().clone()));
    }

    let ffmpeg = resolve_tool_path(Some(&app), Some(&runtime_settings), "ffmpeg.exe");
    let scanned = tauri::async_runtime::spawn_blocking(move || scan(&ffmpeg, &path))
        .await
        .map_err(|e| format!("audio scan task failed: {}", e))??;
    let scanned = Arc::new(scanned);
    cache_put(key, Arc::clone(&scanned));
    Ok(tauri::ipc::Response::new(scanned.as_ref().clone()))
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
        let peaks = scan(&ffmpeg, &sample).expect("scan");
        eprintln!("{} peak bytes in {:?}", peaks.len(), started.elapsed());
        assert_eq!(peaks.len() % CHANNELS, 0);
        assert!(peaks.iter().any(|&b| b > 0), "a programme is not all silence");
        if let Ok(out) = std::env::var("PLAYOUT_PEAKS_OUT") {
            std::fs::write(out, &peaks).unwrap();
        }
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
