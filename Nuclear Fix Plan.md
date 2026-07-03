<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png" style="height:64px;margin-right:32px"/>

# @GitHub [https://github.com/Soranokuni/PlayoutTranscode](https://github.com/Soranokuni/PlayoutTranscode) maybe we need to target the transcoder? I want to have robust mp4 files for our playout that can be trimmed per frame safely, be previewed fast and work good with our setup etc etc, provide an antigravity 2.0 plans for both the playout and the playouttranscode, also check again the @github [https://github.com/Soranokuni/PlayOutVue](https://github.com/Soranokuni/PlayOutVue) and give me a detailed plan with code examples to fix this whole mess once and for all for reliable, fast, lightweight playback/playout sota enterprise ready

I wasn't able to re-fetch the two repos directly this round (GitHub access is intermittently blocked from the tool sandbox), so this plan builds on the deep structural analysis already established for both codebases in this conversation — `rundown.ts`/`caspar.ts` in PlayOutVue and the ffmpeg-based transcoding pipeline in PlayoutTranscode — cross-referenced against your actual CasparCG log symptoms (edit-list warnings, zero-duration producers, degenerate IN/OUT pairs).

Here is the "Antigravity 2.0" plan: a from-the-ground-up hardening of both projects with concrete code, aimed at frame-accurate, fast, SOTA-reliable playout — without breaking the Ingestor/PlayOutVue contract.

***

# PART 1 — PlayoutTranscode: The Mezzanine Rebuild

## 1.1 Why this is the actual root cause

Every symptom in your Caspar log — “Missing key frame while searching for timestamp: 1”, “Cannot find an index entry before timestamp: 1”, zero-duration ffmpeg tags, stalls at non-zero `IN` — is a **container/GOP problem**, not a PlayOutVue logic problem. Source files with edit lists, VFR timing, or irregular keyframes cannot be seeked to frame-accurately by CasparCG's ffmpeg producer, no matter how correct your trim math is.

The fix has to happen at ingest time: **normalize every asset into a clean, keyframe-regular, edit-list-free MP4** before it ever reaches a rundown.

## 1.2 Canonical mezzanine spec (encode profile)

```rust
// transcode/src/profile.rs
#[derive(Clone, Debug)]
pub struct MezzanineProfile {
    pub name: &'static str,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub gop_frames: u32,       // keyint
    pub min_gop_frames: u32,   // min-keyint
    pub video_bitrate_kbps: u32,
    pub audio_bitrate_kbps: u32,
    pub audio_sample_rate: u32,
}

pub const PROFILE_1080I50: MezzanineProfile = MezzanineProfile {
    name: "1080i50_broadcast",
    width: 1920,
    height: 1080,
    fps_num: 25,
    fps_den: 1,
    gop_frames: 50,      // 2s GOP @ 25fps
    min_gop_frames: 25,  // 1s min
    video_bitrate_kbps: 12000,
    audio_bitrate_kbps: 192,
    audio_sample_rate: 48000,
};
```


## 1.3 The ffmpeg command that fixes your exact log errors

```rust
// transcode/src/encode.rs
use std::process::Command;

pub fn build_encode_args(input: &str, output: &str, p: &MezzanineProfile) -> Vec<String> {
    vec![
        "-y".into(),
        "-i".into(), input.into(),

        // Strip edit lists, chapters, and stale metadata — THIS fixes
        // "Missing key frame while searching for timestamp: 1" and
        // "Cannot find an index entry before timestamp: 1"
        "-map".into(), "0:v:0".into(),
        "-map".into(), "0:a:0?".into(),
        "-map_metadata".into(), "-1".into(),
        "-map_chapters".into(), "-1".into(),

        // Force constant frame rate at the channel's exact fps —
        // eliminates VFR/PTS drift that causes ffmpeg producer stalls
        "-vsync".into(), "cfr".into(),
        "-r".into(), format!("{}/{}", p.fps_num, p.fps_den),

        // Regular, forced keyframes on exact frame boundaries.
        // sc_threshold 0 stops scene-cut keyframes from breaking the
        // regular GOP grid that your trim math depends on.
        "-force_key_frames".into(), format!("expr:gte(t,n_forced*{})",
            p.gop_frames as f64 * (p.fps_den as f64 / p.fps_num as f64)),
        "-g".into(), p.gop_frames.to_string(),
        "-keyint_min".into(), p.min_gop_frames.to_string(),
        "-sc_threshold".into(), "0".into(),
        "-flags".into(), "+cgop".into(),

        // Video encode
        "-c:v".into(), "libx264".into(),
        "-profile:v".into(), "high".into(),
        "-pix_fmt".into(), "yuv420p".into(),
        "-b:v".into(), format!("{}k", p.video_bitrate_kbps),
        "-maxrate".into(), format!("{}k", p.video_bitrate_kbps * 12 / 10),
        "-bufsize".into(), format!("{}k", p.video_bitrate_kbps * 2),
        "-s".into(), format!("{}x{}", p.width, p.height),

        // Audio encode — fixed sample rate, no drift
        "-c:a".into(), "aac".into(),
        "-b:a".into(), format!("{}k", p.audio_bitrate_kbps),
        "-ar".into(), p.audio_sample_rate.to_string(),
        "-async".into(), "1".into(),

        // Fast-start: moov atom at front → instant preview seek,
        // no waiting for full download/parse before scrubbing
        "-movflags".into(), "+faststart".into(),

        // Explicit, stable timescale so trim-frame math never drifts
        "-video_track_timescale".into(), "90000".into(),

        output.into(),
    ].into_iter().map(String::from).collect()
}

pub fn run_encode(input: &str, output: &str, p: &MezzanineProfile) -> std::io::Result<std::process::ExitStatus> {
    Command::new("ffmpeg")
        .args(build_encode_args(input, output, p))
        .status()
}
```

Every one of the warning classes visible in your Caspar log maps directly to a flag above:


| Log symptom | Root cause | Fix flag |
| :-- | :-- | :-- |
| `Missing key frame while searching for timestamp: 1` | Source edit list + non-regular GOP | `-map_chapters -1`, `-g`, `-force_key_frames` |
| `Cannot find an index entry before timestamp: 1` | Broken/stale MP4 index from source | Full re-encode + `-map_metadata -1` |
| `filter context ... incoming frame pts_time: 401.76` warnings | VFR source, timestamp jumps | `-vsync cfr` |
| Zero-duration ffmpeg tag (`|0.0000/0.0000|`) | Producer can't determine duration due to broken index | Clean re-encode resolves index |

## 1.4 Post-encode validation (never trust a "successful" encode blindly)

```rust
// transcode/src/validate.rs
use serde::Deserialize;
use std::process::Command;

#[derive(Deserialize)]
struct FfprobeStream {
    codec_type: String,
    r_frame_rate: String,
    nb_frames: Option<String>,
}

#[derive(Deserialize)]
struct FfprobeFormat {
    duration: String,
}

#[derive(Deserialize)]
struct FfprobeOutput {
    streams: Vec<FfprobeStream>,
    format: FfprobeFormat,
}

pub struct HealthReport {
    pub mezzanine_ok: bool,
    pub duration_ms: u64,
    pub fps: f64,
    pub total_frames: u64,
    pub warnings: Vec<String>,
}

pub fn probe_and_validate(path: &str, expected: &MezzanineProfile) -> HealthReport {
    let mut warnings = vec![];
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-print_format", "json",
               "-show_streams", "-show_format", path])
        .output()
        .expect("ffprobe failed to run");

    let parsed: FfprobeOutput = serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|_| { warnings.push("ffprobe_parse_failed".into());
            FfprobeOutput { streams: vec![], format: FfprobeFormat { duration: "0".into() } } });

    let video = parsed.streams.iter().find(|s| s.codec_type == "video");
    let duration_s: f64 = parsed.format.duration.parse().unwrap_or(0.0);
    let duration_ms = (duration_s * 1000.0) as u64;

    let fps = video.and_then(|v| {
        let parts: Vec<&str> = v.r_frame_rate.split('/').collect();
        if parts.len() == 2 {
            let n: f64 = parts[^0].parse().ok()?;
            let d: f64 = parts[^1].parse().ok()?;
            Some(n / d)
        } else { None }
    }).unwrap_or(0.0);

    let expected_fps = expected.fps_num as f64 / expected.fps_den as f64;
    if (fps - expected_fps).abs() > 0.01 {
        warnings.push(format!("fps_mismatch: got {:.3} expected {:.3}", fps, expected_fps));
    }
    if duration_ms == 0 {
        warnings.push("zero_duration".into());
    }

    let total_frames = video
        .and_then(|v| v.nb_frames.as_ref())
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or_else(|| ((duration_ms as f64 / 1000.0) * fps) as u64);

    HealthReport {
        mezzanine_ok: warnings.is_empty(),
        duration_ms,
        fps,
        total_frames,
        warnings,
    }
}
```


## 1.5 Keyframe-safe seek map (per-asset, computed once)

This is the piece that lets PlayOutVue trim **per frame, safely** — it precomputes exactly which frames are keyframes so trims can snap to guaranteed-seekable points.

```rust
// transcode/src/keyframes.rs
use std::process::Command;

pub fn extract_keyframe_frames(path: &str) -> Vec<u64> {
    let out = Command::new("ffprobe")
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-skip_frame", "nokey",
            "-show_entries", "frame=pkt_pts_time",
            "-of", "csv=p=0",
            path,
        ])
        .output()
        .expect("ffprobe keyframe scan failed");

    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .filter_map(|l| l.trim().parse::<f64>().ok())
        .map(|t_sec| (t_sec * 1000.0).round() as u64) // ms
        .collect()
}
```

Store this as `keyframe_offsets_ms: Vec<u64>` per asset. Because your mezzanine profile forces a **regular** GOP (every 50 frames = exactly 2 seconds), this list is short, predictable, and cheap to store/transmit — unlike raw source files where keyframes land unpredictably.

## 1.6 Non-breaking metadata extension for Ingestor

Add fields to the asset record **without removing or renaming anything existing**:

```json
{
  "id": "asset-uuid",
  "path": "C:/Ingest/clip.mp4",
  "duration_ms": 45280,
  "trim_in_ms": 0,
  "trim_out_ms": 45280,

  "mezzanine_ok": true,
  "fps": 25.0,
  "total_frames": 1132,
  "gop_frames": 50,
  "keyframe_safe_start_ms": 0,
  "warnings": []
}
```

PlayOutVue can ignore these fields entirely until it's ready to consume them — zero risk to the existing contract.

## 1.7 Fast preview proxy generation

```rust
pub fn build_preview_args(input: &str, output: &str) -> Vec<String> {
    vec![
        "-y", "-i", input,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", "scale=640:-2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
        "-g", "25", "-keyint_min", "25", "-sc_threshold", "0",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        output,
    ].into_iter().map(String::from).collect()
}
```

Same GOP discipline as the mezzanine (so trim-frame math is 1:1 transferable), just smaller/faster to scrub in the PlayOutVue trim UI.

***

# PART 2 — PlayOutVue: Consuming the Mezzanine Safely

## 2.1 Frame-accurate trim model (replacing the ms-guessing logic)

```typescript
// src/lib/frameMath.ts
export interface FrameGeometry {
  fps: number;
  totalFrames: number;
  gopFrames: number;
  keyframeSafeStartMs: number;
  mezzanineOk: boolean;
}

export function msToFrame(ms: number, fps: number): number {
  return Math.round((ms / 1000) * fps);
}

export function frameToMs(frame: number, fps: number): number {
  return Math.round((frame / fps) * 1000);
}

/** Clamp a requested trim-in point to the nearest safe frame for this asset. */
export function clampTrimIn(requestedMs: number, geo: FrameGeometry): number {
  if (!geo.mezzanineOk) return requestedMs; // legacy asset, no guarantees
  const safe = Math.max(requestedMs, geo.keyframeSafeStartMs);
  const frame = msToFrame(safe, geo.fps);
  return frameToMs(frame, geo.fps);
}

export function clampTrimOut(requestedMs: number, geo: FrameGeometry): number {
  const frame = msToFrame(requestedMs, geo.fps);
  const clampedFrame = Math.min(frame, geo.totalFrames);
  return frameToMs(clampedFrame, geo.fps);
}
```


## 2.2 Fixing the `trim_out_ms` semantic collision (the actual bug from earlier analysis)

```typescript
// src/store/rundown.ts — single source of truth for absolute out-point
function hydrateItem(item: RawIngestorItem, geo: FrameGeometry): RundownItem {
  const totalMs = item.duration_ms ?? 0;

  // ALWAYS absolute out-point in ms. Never a tail-offset. This is the
  // single most important invariant in the whole codebase.
  const trimOutMs = item.trim_out_ms && item.trim_out_ms > 0
    ? clampTrimOut(item.trim_out_ms, geo)
    : totalMs;

  const trimInMs = clampTrimIn(item.trim_in_ms ?? 0, geo);

  return {
    ...item,
    duration_ms: totalMs,       // single canonical field — no camelCase twin
    trim_in_ms: trimInMs,
    trim_out_ms: trimOutMs,
    frameGeometry: geo,
  };
}
```


## 2.3 Deadline computation that can never produce a zero/garbage duration

```typescript
// src/lib/caspar.ts
export function computePlaybackDeadline(item: RundownItem): number {
  const { trim_in_ms, trim_out_ms, duration_ms } = item;
  const inMs = trim_in_ms ?? 0;

  const outMs = (trim_out_ms && trim_out_ms > 0) ? trim_out_ms : duration_ms;
  const effectiveDuration = outMs > inMs ? outMs - inMs : 0;

  if (effectiveDuration <= 0) {
    // Never register a zero-length watchdog. Signal caller to defer
    // registration until refreshCurrentProducerDuration resolves it.
    return -1;
  }
  return effectiveDuration;
}
```

```rust
// src-tauri/src/caspar.rs
pub fn register_playback(item_id: String, duration_ms: i64) {
    if duration_ms <= 0 {
        log::warn!("Refusing to arm watchdog for {item_id}: duration_ms={duration_ms}");
        return; // rely on OSC EOF only, no premature deadline
    }
    // existing watchdog arm logic...
}
```


## 2.4 AMCP builder with mezzanine-aware safety clamps

```typescript
// src/lib/amcp.ts
export function buildPlayCommand(item: RundownItem, layer: number): string {
  const geo = item.frameGeometry;
  const fps = geo?.fps ?? 25;

  let inFrame = msToFrame(item.trim_in_ms ?? 0, fps);
  let outFrame = msToFrame(item.trim_out_ms ?? item.duration_ms, fps);

  // Never send degenerate IN==OUT — expand by one GOP's worth of frames
  if (outFrame <= inFrame) {
    outFrame = inFrame + (geo?.gopFrames ?? 25);
  }

  // Clamp to file bounds
  const total = geo?.totalFrames ?? outFrame;
  outFrame = Math.min(outFrame, total);
  inFrame = Math.max(0, Math.min(inFrame, outFrame - 1));

  return `PLAY 1-${layer} "${item.path}" IN ${inFrame} OUT ${outFrame} CLEAR_ON_404`;
}
```


## 2.5 Precache retry that waits for `mezzanine_ok` + resolved path

```typescript
// src/lib/caspar.ts
async function preloadNextItemAt(index: number, attempt = 0): Promise<void> {
  const item = getPlayableItems()[index];
  if (!item) return;

  const ready = item.path && item.path.length > 0 && item.ingestorStatus === 'ready';
  if (!ready) {
    if (attempt >= 3) {
      logPlayoutEvent('preload_failed', { itemId: item.id, attempt });
      return;
    }
    await sleep(500 * Math.pow(2, attempt));
    return preloadNextItemAt(index, attempt + 1);
  }

  const cmd = buildLoadBgCommand(item, 10);
  await sendAmcp(cmd);
}
```


## 2.6 Restarting the UI progress timer with the resolved duration

```typescript
// src/lib/caspar.ts
async function refreshCurrentProducerDuration(item: RundownItem, playbackStartTime: number) {
  const totalDurationMs = await ensureItemDurationMs(item);
  store.updateItem(item.id, { duration_ms: totalDurationMs });

  // THIS was previously missing — the UI countdown would freeze/wrap
  // early because the timer kept using the play-time estimate.
  store.startPlaybackProgressTimer(item.id, totalDurationMs, playbackStartTime);
}
```


## 2.7 JS-side end-guard for the "hangs on a frame but says PLAYING" case

```typescript
// src/lib/endGuard.ts
interface GuardState {
  lastPositionMs: number;
  lastTickAt: number;
  stalledTicks: number;
}

const guards = new Map<string, GuardState>();

export function onPlaybackTick(itemId: string, positionMs: number, effectiveDuration: number, playStartedAt: number) {
  const now = Date.now();
  const g = guards.get(itemId) ?? { lastPositionMs: -1, lastTickAt: now, stalledTicks: 0 };

  const moved = Math.abs(positionMs - g.lastPositionMs) > 40; // ~1 frame @25fps
  g.stalledTicks = moved ? 0 : g.stalledTicks + 1;
  g.lastPositionMs = positionMs;
  g.lastTickAt = now;
  guards.set(itemId, g);

  const overtime = now - playStartedAt > effectiveDuration * 1.2;
  const stalled = g.stalledTicks >= 5; // ~5 consecutive stale ticks

  if (overtime && stalled) {
    logPlayoutEvent('js_end_guard_triggered', { itemId, positionMs, effectiveDuration });
    advanceNext(false, 'js-end-guard');
    guards.delete(itemId);
  }
}
```


## 2.8 Structured trace logging tying it all together

```typescript
// src/lib/playoutTrace.ts
export interface TraceEvent {
  traceId: string;
  itemId: string;
  path: string;
  event: 'play' | 'loadbg' | 'osc_tick' | 'advance' | 'stall_guard' | 'preload_retry';
  data: Record<string, unknown>;
  ts: number;
}

const buffer: TraceEvent[] = [];

export function trace(ev: Omit<TraceEvent, 'ts'>) {
  buffer.push({ ...ev, ts: Date.now() });
  if (buffer.length > 500) flushTrace();
}

export async function flushTrace() {
  if (buffer.length === 0) return;
  const lines = buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
  await invoke('append_trace_log', { lines });
  buffer.length = 0;
}
```

Embed the same `traceId` in the AMCP comment so you can grep-correlate against `caspar_*.log`:

```typescript
const traceId = crypto.randomUUID().slice(0, 8);
trace({ traceId, itemId: item.id, path: item.path, event: 'play', data: { inFrame, outFrame } });
const cmd = `${buildPlayCommand(item, 10)} /*trace:${traceId}*/`;
```


***

# PART 3 — Rollout Order (won't break Ingestor integration)

1. **PlayoutTranscode**: ship the new mezzanine profile + validator + keyframe map as an *additive* pipeline. Old assets untouched; new encodes carry `mezzanine_ok`, `fps`, `keyframe_safe_start_ms`.
2. **PlayOutVue**: fix the `trim_out_ms` absolute-value invariant and zero-duration watchdog guard first — these are pure bug fixes, zero new dependencies.
3. **PlayOutVue**: wire in `frameGeometry`-aware clamping only when `mezzanine_ok === true`; legacy assets fall back to current (looser) behavior automatically.
4. **PlayOutVue**: add end-guard + trace logging — purely additive, no behavior change to happy-path clips.
5. **Batch re-encode** the specific offending files visible in your Caspar log (`A Year In The Wild...`, the Re-Battery spots) through the new profile — this alone should eliminate most of the "hangs on a frame" and "skips mid-duration" reports, since those are the exact files showing edit-list/index warnings.

This sequence guarantees the Ingestor contract is never touched — only additive metadata and defensive logic on the consuming side — while systematically removing the actual root cause (bad source containers) at the transcoding layer.
<span style="display:none">[^10][^11][^12][^13][^14][^15][^2][^3][^4][^5][^6][^7][^8][^9]</span>

<div align="center">⁂</div>

[^1]: https://github.com/anjok07

[^2]: https://github.com/jianchang512/pyvideotrans

[^3]: https://github.com/CasparCG/help/wiki/List-of-clients-for-controlling-CasparCG

[^4]: https://github.com/mcdikki/CasparsPlayoutClient

[^5]: https://github.com/topics/playout

[^6]: https://github.com/julemai/CaSPAr

[^7]: https://github.com/jaskie/PlayoutAutomation

[^8]: https://github.com/yujia-yan/transkun

[^9]: https://github.com/CasparPlay/CasparPlay/blob/master/HOWTO.txt

[^10]: https://github.com/tdoukinitsas/Playout-Manager

[^11]: https://github.com/casparcg

[^12]: https://github.com/Yleisradio/caspartool

[^13]: https://github.com/jaskie/PlayoutAutomation/issues/56

[^14]: https://github.com/nebulabroadcast/nebula-tutorial/blob/main/doc/casparcg.md

[^15]: https://github.com/tsukumijima/KonomiTV/releases

