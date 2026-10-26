# Aether — Administrator Manual

For broadcast engineers who install, configure and maintain Aether (PlayOutVue). Day-to-day operation is in
the [operator manual](OPERATOR-MANUAL.md).

---

## 1. System overview

| Component | Role | Address |
|---|---|---|
| **Aether** | Playout controller (this application) | — |
| **CasparCG** 2.3+ (stock) or the **PlayOut fork** 2.5.1 | Playout engine, DeckLink output | AMCP `127.0.0.1:5250` (fixed), OSC → `127.0.0.1:6250` |
| **PlayoutTranscode** | Ingest, QC, mezzanine files, asset registry | HTTP, default `http://127.0.0.1:4353` |

**CasparCG must run on the same machine as Aether.** AMCP is hard-wired to loopback, and the OSC listener only
accepts loopback packets. PlayoutTranscode may run elsewhere, but local is the tested layout.

The fork (`Soranokuni/casparcg-server`, branch `playout/2.5.1`) adds an engine-side queue, fallback slate and
filler list. Aether detects it on every connect (`QUEUE 1-10 INFO` → `201`) and shows **Connected · fork**.
Fork-only settings are marked *Needs the PlayOut fork* on a stock engine.

---

## 2. Installation

### Requirements

- Windows x64 with the WebView2 runtime. The installer embeds the WebView2 bootstrapper, which needs internet
  access if WebView2 is missing.
- Microsoft VC++ 2015–2022 x64 redistributable — installed silently by the Aether installer.
- ffmpeg and ffprobe (see below).
- CasparCG configured for your DeckLink output, and PlayoutTranscode running.

### Installer

`Aether_<version>_x64-setup.exe` (NSIS) installs per machine, by default under `%ProgramFiles%\Aether`.
Identifier: `com.playout.client`. The app has a tray icon (Show / Hide / Exit); closing the window does not stop
a supervised engine unless configured to.

### ffmpeg and ffprobe

They are **not** bundled. Aether uses them for probing, trimming, audio waveforms and the fallback self-test.
They are looked up in this order:

1. **Settings › Media & ingest › FFmpeg › Binary folder override**
2. `<install dir>\Requirements\ffmpeg\bin\`, then `<install dir>\ffmpeg\bin\`
3. The same relative to the working directory and its parent
4. `PATH`

The simplest setup is to copy `ffmpeg.exe` and `ffprobe.exe` into `<install dir>\Requirements\ffmpeg\bin\`.
From a source checkout, `scripts/download-ffmpeg.ps1` fetches a build into `Requirements\ffmpeg`.

### First launch checklist

1. **Settings › Playout engine › Server location** — point to `casparcg.exe` (or its folder). Aether derives the
   config, media and template paths from it. Set **Config filename** if it is not `casparcg.config`.
2. **Settings › Media & ingest › PlayoutTranscode API** — base URL and API token; press **Test connection**.
3. **Settings › Media & ingest › Media root** — set the local media path and press **Verify**. If CasparCG's
   `<media-path>` differs, use **Fix CasparCG media path** (off air only; it backs up the config and restarts the engine).
4. **Settings › Hardware › Open setup wizard** — DeckLink output, and the live input device/format if used.
5. **Settings › Graphics (CG) › Deploy templates** — installs the advisory, crawl and emergency slate into
   CasparCG's template and media folders.
6. On the fork engine, **Settings › Playout engine** — fallback clip and filler folder (local disks only).
7. Check the bottom bar: connection chip green, INGEST light green, media health chip green.

---

## 3. CasparCG

### Supervision

Aether is the engine's supervisor when it launched it (or when **Server location** is set and the engine is
stopped at launch).

| Setting (Playout engine › Supervision) | Default | Effect |
|---|---|---|
| Start the server when Aether launches | off | Start the engine at launch. A *configured but stopped* engine is started at launch regardless. |
| Leave the server running when Aether exits | on | 24/7 continuity. Off = the engine is tied to Aether and dies with it. |
| Relaunch the server after a crash | on | Backoff 0.5 s → 2 s → 5 s. More than 3 crashes in 60 s trips the breaker (**Crash loop**); clear it with **Relaunch & Reset** on the connection chip. |
| Resume the clip from its crash-time position | on | After a relaunch, Aether resumes the on-air clip at its position, or takes the next row if it had ended. |

- If an engine is already running (port 5250 open), Aether **adopts** it instead of starting another.
- An engine Aether did not launch is never relaunched by Aether.
- Stop sends `EXIT` and waits 5 s before terminating. Start / Stop / Restart are in Settings › Playout engine
  and on the connection chip.

### Monitor mode

Only one instance controls the engine (named mutex `Local\PlayOutVue_Instance_Port_5250`). A second instance
starts in **MONITOR** mode: read-only AMCP, no start/stop, on-air controls disabled.

### OSC

Aether listens on UDP `127.0.0.1:<OSC port>` (default **6250**, Settings › Playout engine › Connection). The
CasparCG config must send OSC there — add a `<predefined-client>` for `127.0.0.1` on that port, or rely on
`<default-port>` with `disable-send-to-amcp-clients` false. Without OSC there is no timing and no auto-advance.

### Configuration editing

**Settings › Hardware › Advanced XML configurator** edits `casparcg.config`. Every save writes a timestamped
`.bak` next to the file first. Structured edits patch the XML in place, so hand-added elements survive.

### Timing profile

**Playout profile**: PAL 1080i50 or PAL 1080p25. **Transition length** and **Pre-roll buffer** (frames) default
to 2. On interlaced channels SEEK/LENGTH are counted in fields; this is handled automatically.

### Fork engine settings (Playout engine)

| Setting | Default | Notes |
|---|---|---|
| Rows queued behind the on-air clip | 2 | 1–8; each keeps a decoder open |
| Fallback clip | `playout/emergency` | Slate installed by *Deploy templates*. Local disk only; network/UNC paths are refused |
| Filler folder | empty | Played as a list when the queue runs dry |
| Random order | on | Sends `SHUFFLE` |
| At the end of the rundown, stay on the fillers | on | Until a row is taken |
| Stall limit (channel ticks) | 50 | 50 = 2 s at 1080i50; 0 = off |

The fallback self-test runs on connect and every hour; failures appear on the media health chip and as toasts.
The fork's as-run log is written to `recovery\asrun-YYYY-MM-DD.jsonl` (UTC days).

---

## 4. PlayoutTranscode

- **API base URL** (default `http://127.0.0.1:4353`) and **API token**. If the service has `server.api_token`
  set (`PlayoutTranscode gen-token`), enter the same token; otherwise every call except health is refused (401)
  and the INGEST light pulses amber.
- Aether uses API v2 where available and falls back to v1. The library is polled every 30 s; the health check
  runs every 5 s. A green light proves the API answers, not that ingest is running — check the service itself
  (`%ProgramData%\PlayoutTranscode`) when new media does not appear.
- **Readiness**: an asset is playable when the file exists, metadata is present (registry or JSON sidecar
  `<stem>.uuid.json`) and QC passed. **QC & compliance › Warning sensitivity** (Strict / Production / Lenient)
  only changes which warnings are *shown*.
- **Media root**: the folder must contain the transcoder's `.playouttranscode-registry.json` marker. Verdicts
  appear on the media health chip (strong / weak / wrong / missing). A wrong media root makes takes fail hard.
- **Recycle Bin retention** (Media & ingest): Forever, 1–3 weeks or 1 month; **Empty now** purges immediately.

---

## 5. Graphics and CG Studio

- Templates: `playout/advisory` (layer 32: logo, rating, warnings, TP) and `playout/crawl` (layer 33). Both
  names are configurable in **Settings › Graphics (CG)**.
- **Deploy templates** writes the templates, fonts, presets and `<media>\playout\emergency.png`. Re-run it after
  changing the CG Studio default preset or upgrading Aether.
- **Keep the station ID bug on air** (default on) keeps the logo through STOP.
- **Open CG Studio** opens the designer in a browser through the local studio bridge (`127.0.0.1:6258`, or 6259).

### AI designer (optional)

CG Studio can generate style variants with Claude. Configure it in **Settings › Media & ingest › AI designer**:
API key (empty = off), model, effort and an advisory monthly cap (not enforced). Calls go from the Aether backend
to `https://api.anthropic.com`; the key never reaches CasparCG or the browser.

> The API key and the PlayoutTranscode token are stored in plain text in `runtime_config.json` and in the
> WebView storage of the Windows user. Protect the user profile accordingly.

---

## 6. Recovery behaviour

| Event | Behaviour |
|---|---|
| CasparCG crash | Relaunch with backoff, restore layer 32 and the crawl, resume the clip |
| Aether crash | Release builds restart automatically (`--recovered`), unless 3+ unclean exits in 10 min (crash loop) |
| Aether UI hang | Watchdog reloads the UI after 12 s; relaunches Aether if still dead 25 s later; at most 3 reloads per 10 min |
| After a restart | **PlayOut restarted** dialog proposes a plan |

Relaunch plan settings (Playout engine › PlayOut recovery):

| Setting | Default |
|---|---|
| Restart Aether automatically after it crashes or hangs | on |
| Resume the interrupted clip if off air for less than | 30 s |
| Otherwise join the schedule if off air for less than | 30 min |
| Countdown before the plan runs by itself | 10 s (0 = always wait for the operator) |

---

## 7. Network and security

| Port | Direction | Purpose |
|---|---|---|
| TCP 5250 | Aether → 127.0.0.1 | AMCP (fixed) |
| UDP 6250 (configurable) | CasparCG → 127.0.0.1 | OSC |
| TCP random, loopback | local | Preview media server (per-launch token) |
| TCP 6258 / 6259, loopback | local | CG Studio bridge (per-launch bearer token) |
| TCP 4353 (configurable) | outbound | PlayoutTranscode |
| TCP 443 | outbound | api.anthropic.com (AI designer only) |

All Aether listeners are loopback-only; no inbound firewall rules are needed. Aether only sends allow-listed
AMCP verbs; `KILL`, `RESTART` and similar are blocked.

---

## 8. Files and locations

| What | Where |
|---|---|
| Runtime settings (Rust side) | `%APPDATA%\com.playout.client\runtime_config.json` |
| Full settings and rundowns | WebView2 storage, `%LOCALAPPDATA%\com.playout.client\EBWebView` |
| Probe cache (SQLite) | `%APPDATA%\com.playout.client\media_cache.db` |
| Engine / playout log | `%APPDATA%\com.playout.client\caspar-playout.log` (20 MiB × 6) |
| Application log | `%LOCALAPPDATA%\com.playout.client\logs\` (50 MiB, 10 kept) |
| Crash reports | `%APPDATA%\com.playout.client\crash-reports\panic-<ms>.txt` |
| Recovery checkpoint, as-run, sessions | `%APPDATA%\com.playout.client\recovery\` |
| Audio waveform cache | `%LOCALAPPDATA%\com.playout.client\audio-peaks\` |
| Playlist files | `.plx`, wherever saved; the previous version is kept as `<name>.bak` |
| Written into the media root | `__sota_caspar\` (aliases for non-ASCII paths), `.playout_media_index.json`, `playout\emergency.png` |
| CasparCG config backups | `casparcg.<unixsecs>.config.bak`, `casparcg.config.bak-YYYYMMDD-HHMMSS` |

**Backup**: save each playlist to a `.plx` file and copy `%APPDATA%\com.playout.client\` together with the
CasparCG config. Rundowns live in WebView storage, so also export them before reinstalling Windows or changing user.

---

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| Chip **Not found** | Settings › Playout engine › Server location |
| Chip **Crash loop** | `caspar-playout.log` for `[CasparServer]` lines; fix the engine (config, GPU, DeckLink), then **Relaunch & Reset** |
| Connected but no timing / no auto-advance | OSC not arriving: port in Settings vs `<osc>` in `casparcg.config` |
| **MONITOR** on the main machine | Another Aether instance is already running (check the tray) |
| INGEST light red | Service down or wrong base URL — *Test connection* |
| INGEST light amber | API token mismatch |
| *Wrong media root* / takes fail with `[media-root]` | Local media path vs the transcoder's media root; **Verify**, then **Fix CasparCG media path** |
| Rows grey after restart | Media deleted or moved in PlayoutTranscode; re-add from the library |
| *Fallback broken / not local* | Fallback clip or filler folder missing, or on a network share |
| Preview shows *File not found on disk* | Path not reachable from this PC; check the media root |
| Waveform *Audio scan failed* | ffmpeg not found — see [ffmpeg and ffprobe](#ffmpeg-and-ffprobe) |
| AI designer *No AI API key configured* | Settings › Media & ingest › AI designer |

Useful log lines in `caspar-playout.log`: `Adopted active CasparCG instance`, `CasparCG spawned successfully`,
`process exited unexpectedly`, `Circuit breaker TRIPPED`, `PANIC`. Turn on **Advanced › Enable debug tools and
diagnostics** (off air only) for the in-app diagnostics panel and log export.

After any engine, config or Aether change, run the test in
[PLAYOUT-RELIABILITY-VERIFICATION.md](PLAYOUT-RELIABILITY-VERIFICATION.md) on a non-production channel.

---

## 10. Upgrading

1. Stop playout at a safe point (or run the upgrade on a standby machine).
2. Save every playlist to `.plx`.
3. Run the new installer; settings and rundowns are kept.
4. **Settings › Graphics (CG) › Deploy templates** to update the graphics.
5. Run the reliability verification.
