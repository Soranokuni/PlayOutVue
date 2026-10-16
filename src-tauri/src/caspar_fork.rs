//! Typed commands for the PlayOut fork of CasparCG (`Soranokuni/casparcg-server`,
//! branch `playout/2.5.1`; reference `PLAYOUT-FORK.md` §4): the tagged wait
//! queue, on-air actions, the fallback clip and the per-layer event log.
//!
//! A stock server answers every fork verb with `400`. [`caspar_fork_probe`]
//! turns that into "stock mode" so the frontend keeps its old code path.
//!
//! `409 … CONFLICT` (a failed `EXPECT`) is a normal outcome here, not an
//! error: the cut happened while the caller was editing, and the caller
//! re-reads `QUEUE INFO` and retries. It is returned as data.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::amcp::{
    cg_add_cmd, cg_update_cmd, events_cmd, fallback_clear_cmd, fallback_cmd, fallback_stall_cmd,
    is_safe_template_name, onair_cmd, parse_events, parse_queue_clear_count, parse_queue_info,
    queue_clear_cmd, queue_info_cmd, queue_remove_cmd, tagged_item_cmd, AmcpClient, AmcpResponse,
    EngineEvent, EventsReply, ItemVerb, QueueInfo, TaggedItem,
};

/// Reply of a fork command whose `404`/`409` the caller handles itself.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ForkReply {
    pub code: u16,
    pub body: String,
    /// `QUEUE CLEAR`: the number of waiting items removed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
}

/// Accept 2xx plus the listed 4xx codes as data; anything else is an error.
fn accept(cmd: &str, resp: AmcpResponse, handled: &[u16]) -> Result<ForkReply, String> {
    if resp.is_ok() || handled.contains(&resp.code) {
        return Ok(ForkReply {
            code: resp.code,
            removed: parse_queue_clear_count(&resp.body),
            body: resp.body,
        });
    }
    Err(format!("CasparCG error {} for '{}': {}", resp.code, cmd, resp.body))
}

const CONFLICT: u16 = 409;
const NOT_FOUND: u16 = 404;

/// `QUEUE <ch>-<layer> INFO`. `None` when the server is stock (`400`).
#[tauri::command]
pub async fn caspar_fork_probe(
    channel: u8,
    layer: u16,
    client: State<'_, AmcpClient>,
) -> Result<Option<QueueInfo>, String> {
    probe(&client, channel, layer).await
}

pub async fn probe(client: &AmcpClient, channel: u8, layer: u16) -> Result<Option<QueueInfo>, String> {
    let resp = client.send(&queue_info_cmd(channel, layer)).await?;
    if resp.code == 400 {
        return Ok(None);
    }
    parse_queue_info(&resp.body).map(Some)
}

/// `EVENTS <ch>-<layer>[ <since>]`.
#[tauri::command]
pub async fn caspar_fork_events(
    channel: u8,
    layer: u16,
    since: Option<u64>,
    client: State<'_, AmcpClient>,
) -> Result<EventsReply, String> {
    fetch_events(&client, channel, layer, since).await
}

pub async fn fetch_events(
    client: &AmcpClient,
    channel: u8,
    layer: u16,
    since: Option<u64>,
) -> Result<EventsReply, String> {
    let resp = client.send(&events_cmd(channel, layer, since)).await?;
    let mut reply = parse_events(&resp.body)?;
    reply.lost = since.is_some_and(|seq| reply.lost_events_after(seq));
    Ok(reply)
}

/// `QUEUE`/`LOADBG`/`PLAY` of one tagged clip. `409` is returned.
#[tauri::command]
pub async fn caspar_fork_item(
    verb: ItemVerb,
    channel: u8,
    layer: u16,
    item: TaggedItem,
    client: State<'_, AmcpClient>,
) -> Result<ForkReply, String> {
    let cmd = tagged_item_cmd(verb, channel, layer, &item)?;
    let resp = client.send(&cmd).await?;
    accept(&cmd, resp, &[CONFLICT])
}

/// `QUEUE CLEAR[ AFTER <tag>][ EXPECT <tag>]`. `404` (AFTER tag gone) and
/// `409` are returned.
#[tauri::command]
pub async fn caspar_fork_queue_clear(
    channel: u8,
    layer: u16,
    after: Option<String>,
    expect: Option<String>,
    client: State<'_, AmcpClient>,
) -> Result<ForkReply, String> {
    let cmd = queue_clear_cmd(channel, layer, after.as_deref(), expect.as_deref())?;
    let resp = client.send(&cmd).await?;
    accept(&cmd, resp, &[NOT_FOUND, CONFLICT])
}

/// `QUEUE REMOVE <tag>[ EXPECT <tag>]`. `404` (not waiting) and `409` are returned.
#[tauri::command]
pub async fn caspar_fork_queue_remove(
    channel: u8,
    layer: u16,
    tag: String,
    expect: Option<String>,
    client: State<'_, AmcpClient>,
) -> Result<ForkReply, String> {
    let cmd = queue_remove_cmd(channel, layer, &tag, expect.as_deref())?;
    let resp = client.send(&cmd).await?;
    accept(&cmd, resp, &[NOT_FOUND, CONFLICT])
}

/// One command to run when an item goes on air. CG payloads are serialized
/// and escaped here, exactly as a direct `CG ADD`/`CG UPDATE`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OnairAction {
    /// A plain command line (`CLEAR 1-31`, `PLAY 1-31 "<image>"`, `MIXER …`).
    Command { cmd: String },
    CgAdd { layer: u16, template: String, play: bool, data: serde_json::Value },
    CgUpdate { layer: u16, data: serde_json::Value },
}

fn onair_inner(channel: u8, action: &OnairAction) -> Result<String, String> {
    match action {
        OnairAction::Command { cmd } => Ok(cmd.clone()),
        OnairAction::CgAdd { layer, template, play, data } => {
            if !is_safe_template_name(template) {
                return Err(format!("CG template name '{}' contains disallowed characters", template));
            }
            let data = serde_json::to_string(data).map_err(|e| format!("CG payload serialize: {}", e))?;
            Ok(cg_add_cmd(channel, *layer, 1, template, *play, &data))
        }
        OnairAction::CgUpdate { layer, data } => {
            let data = serde_json::to_string(data).map_err(|e| format!("CG payload serialize: {}", e))?;
            Ok(cg_update_cmd(channel, *layer, 1, &data))
        }
    }
}

/// Build every `ONAIR` line for one tag, in order. Fails before anything is
/// sent when one action is invalid.
pub fn onair_lines(channel: u8, layer: u16, tag: &str, actions: &[OnairAction]) -> Result<Vec<String>, String> {
    actions
        .iter()
        .map(|action| onair_cmd(channel, layer, tag, &onair_inner(channel, action)?))
        .collect()
}

/// Attach the actions to `tag`, in order. Stops at the first failure: a
/// `404` means the item is no longer on the layer.
#[tauri::command]
pub async fn caspar_fork_onair(
    channel: u8,
    layer: u16,
    tag: String,
    actions: Vec<OnairAction>,
    client: State<'_, AmcpClient>,
) -> Result<Vec<ForkReply>, String> {
    let lines = onair_lines(channel, layer, &tag, &actions)?;
    let mut replies = Vec::with_capacity(lines.len());
    for line in lines {
        let resp = client.send(&line).await?;
        let reply = accept(&line, resp, &[NOT_FOUND])?;
        let stop = reply.code == NOT_FOUND;
        replies.push(reply);
        if stop {
            break;
        }
    }
    Ok(replies)
}

/// Configure the layer's fallback. `clip: None` removes the clip and keeps
/// only the stall limit. `stall` is in channel ticks, `0` = off.
#[tauri::command]
pub async fn caspar_fork_fallback(
    channel: u8,
    layer: u16,
    clip: Option<String>,
    tag: Option<String>,
    stall: Option<u32>,
    client: State<'_, AmcpClient>,
) -> Result<ForkReply, String> {
    let cmd = match clip.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        Some(clip) => fallback_cmd(channel, layer, clip, true, tag.as_deref().unwrap_or("fallback"), stall)?,
        None => {
            let clear = fallback_clear_cmd(channel, layer);
            let resp = client.send(&clear).await?;
            accept(&clear, resp, &[])?;
            fallback_stall_cmd(channel, layer, stall.unwrap_or(0))
        }
    };
    let resp = client.send(&cmd).await?;
    accept(&cmd, resp, &[])
}

// ── Engine mode and fork OSC events (`PLAYOUT-FORK.md` §5) ──────────────────

/// Which server drives the program layer. `Unknown` until the first probe;
/// `Stock` keeps the OSC advance inference in `caspar.rs`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineMode {
    #[default]
    Unknown,
    Stock,
    Fork,
}

/// One fork OSC message on the program layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForkOscMessage {
    /// `…/event/seq`: the layer's last event seq.
    Seq(u64),
    /// `…/event/<kind>`: the latest event of that kind, re-sent every tick.
    Event(EngineEvent),
    /// `…/foreground/tag`.
    ForegroundTag(String),
    /// `/channel/N/stage/frame`: the channel tick counter.
    Frame(i64),
}

const EVENT_KINDS: [&str; 5] = ["onair", "offair", "ended", "stalled", "actionfailed"];

fn osc_int(arg: &rosc::OscType) -> Option<i64> {
    match arg {
        rosc::OscType::Long(v) => Some(*v),
        rosc::OscType::Int(v) => Some(i64::from(*v)),
        _ => None,
    }
}

fn osc_str(arg: &rosc::OscType) -> Option<&str> {
    match arg {
        rosc::OscType::String(v) => Some(v.as_str()),
        _ => None,
    }
}

/// Parse a fork address of `channel`/`layer`. `None` for everything else,
/// including the stock `file/*` addresses.
pub fn parse_fork_osc(channel: u8, layer: u16, address: &str, args: &[rosc::OscType]) -> Option<ForkOscMessage> {
    let stage = format!("/channel/{}/stage/", channel);
    let rest = address.trim().strip_prefix(&stage)?;
    if rest == "frame" {
        return args.first().and_then(osc_int).map(ForkOscMessage::Frame);
    }
    let rest = rest.strip_prefix(&format!("layer/{}/", layer))?;
    if rest == "foreground/tag" {
        return args.first().and_then(osc_str).map(|t| ForkOscMessage::ForegroundTag(t.to_string()));
    }
    let kind = rest.strip_prefix("event/")?;
    if kind == "seq" {
        return args.first().and_then(osc_int).and_then(|v| u64::try_from(v).ok()).map(ForkOscMessage::Seq);
    }
    if !EVENT_KINDS.contains(&kind) || args.len() < 5 {
        return None;
    }
    Some(ForkOscMessage::Event(EngineEvent {
        seq: u64::try_from(osc_int(&args[0])?).ok()?,
        frame: osc_int(&args[1])?,
        time: osc_int(&args[2])?,
        kind: kind.to_string(),
        tag: osc_str(&args[3])?.to_string(),
        reason: osc_str(&args[4])?.to_string(),
    }))
}

/// Minimum spacing of `EVENTS` gap fetches.
const GAP_FETCH_INTERVAL_MS: u64 = 250;

/// What [`ForkOscState::drain`] asks the caller to do.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ForkDrain {
    /// Events to emit, in seq order.
    pub events: Vec<EngineEvent>,
    /// Fetch `EVENTS <since>`: seqs are missing.
    pub fetch_since: Option<u64>,
    /// The seq counter went back: the engine restarted.
    pub restarted: bool,
}

/// Fork-mode engine state, fed by OSC. Lives in the playback state so the
/// OSC listener needs no extra lock.
#[derive(Debug, Default)]
pub struct ForkOscState {
    pub mode: EngineMode,
    /// Server start time (ms) from the last `QUEUE INFO`/`EVENTS`.
    pub instance: Option<i64>,
    /// Last seq handed to the frontend. `None` until seeded.
    pub last_seq: Option<u64>,
    announced_seq: u64,
    pending: std::collections::BTreeMap<u64, EngineEvent>,
    pub foreground_tag: String,
    pub frame: i64,
    fetch_in_flight: bool,
    last_fetch_ms: u64,
}

impl ForkOscState {
    pub fn is_fork(&self) -> bool {
        self.mode == EngineMode::Fork
    }

    /// Stock server: OSC fork addresses never arrive; drop any fork state.
    pub fn set_stock(&mut self) {
        *self = ForkOscState { mode: EngineMode::Stock, ..ForkOscState::default() };
    }

    /// Fork server seen by `QUEUE INFO`. On the same instance the seq cursor
    /// is kept, so the gap fetch replays what happened since; on a new
    /// instance (or the first probe) it starts at `event_seq`. Returns true
    /// when a known instance was replaced: the engine restarted.
    pub fn set_fork(&mut self, instance: i64, event_seq: u64) -> bool {
        let restarted = self.instance.is_some_and(|known| known != instance);
        let same_instance = self.instance == Some(instance);
        self.mode = EngineMode::Fork;
        self.instance = Some(instance);
        if !same_instance || self.last_seq.is_none() {
            self.last_seq = Some(event_seq);
            self.pending.clear();
        }
        self.announced_seq = self.announced_seq.max(event_seq);
        restarted
    }

    pub fn observe(&mut self, message: ForkOscMessage) {
        if !self.is_fork() {
            return;
        }
        match message {
            ForkOscMessage::Seq(seq) => self.announced_seq = seq,
            // Kept even at or below the cursor: after an engine restart the
            // seq counts from 1 again. `drain` drops what is already handed out.
            ForkOscMessage::Event(event) => {
                self.pending.insert(event.seq, event);
            }
            ForkOscMessage::ForegroundTag(tag) => self.foreground_tag = tag,
            ForkOscMessage::Frame(frame) => self.frame = frame,
        }
    }

    /// Call after each OSC packet: hand out the events that follow the cursor
    /// without a hole, and ask for a fetch when one is missing.
    pub fn drain(&mut self, now_ms: u64) -> ForkDrain {
        let mut out = ForkDrain::default();
        if !self.is_fork() {
            return out;
        }
        let Some(mut last) = self.last_seq else {
            // Not seeded by a probe: start at what the engine shows now.
            let base = self.announced_seq.max(self.pending.keys().next_back().copied().unwrap_or(0));
            if base > 0 {
                self.last_seq = Some(base);
                self.pending.clear();
            }
            return out;
        };
        if self.announced_seq > 0 && self.announced_seq < last {
            // A restarted engine counts from 1 again.
            out.restarted = true;
            last = 0;
            let announced = self.announced_seq;
            self.pending.retain(|seq, _| *seq <= announced);
        }
        while let Some(event) = self.pending.remove(&(last + 1)) {
            last += 1;
            out.events.push(event);
        }
        self.pending.retain(|seq, _| *seq > last);
        self.last_seq = Some(last);

        let target = self.announced_seq.max(self.pending.keys().next_back().copied().unwrap_or(0));
        if target > last && !self.fetch_in_flight && now_ms.saturating_sub(self.last_fetch_ms) >= GAP_FETCH_INTERVAL_MS {
            self.fetch_in_flight = true;
            self.last_fetch_ms = now_ms;
            out.fetch_since = Some(last);
        }
        out
    }

    /// Apply an `EVENTS` reply fetched for a gap. Returns the events to emit
    /// and whether the reply came from another engine instance.
    pub fn apply_fetched(&mut self, reply: &EventsReply) -> (Vec<EngineEvent>, bool) {
        self.fetch_in_flight = false;
        let restarted = self.instance.is_some_and(|known| known != reply.instance);
        self.instance = Some(reply.instance);
        let mut last = if restarted { 0 } else { self.last_seq.unwrap_or(0) };
        let mut events: Vec<EngineEvent> = reply.events.iter().filter(|e| e.seq > last).cloned().collect();
        events.sort_by_key(|e| e.seq);
        if let Some(newest) = events.last() {
            last = newest.seq;
        }
        // Seqs that fell out of the log are skipped, never waited for.
        last = last.max(reply.last);
        self.pending.retain(|seq, _| *seq > last);
        self.last_seq = Some(last);
        (events, restarted)
    }

    pub fn fetch_failed(&mut self) {
        self.fetch_in_flight = false;
    }
}

/// Snapshot for the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStateReport {
    pub mode: EngineMode,
    pub instance: Option<i64>,
    pub last_seq: Option<u64>,
    pub foreground_tag: String,
    pub frame: i64,
}

impl From<&ForkOscState> for EngineStateReport {
    fn from(s: &ForkOscState) -> Self {
        EngineStateReport {
            mode: s.mode,
            instance: s.instance,
            last_seq: s.last_seq,
            foreground_tag: s.foreground_tag.clone(),
            frame: s.frame,
        }
    }
}

/// `caspar://engine-instance`: the engine restarted, its queue is gone.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInstanceChanged {
    pub instance: Option<i64>,
    pub reason: String,
}

const EVENT_TOPIC: &str = "caspar://engine-event";
const INSTANCE_TOPIC: &str = "caspar://engine-instance";

fn emit_events<R: tauri::Runtime>(app: &tauri::AppHandle<R>, instance: Option<i64>, events: Vec<EngineEvent>) {
    use tauri::Emitter;
    record_asrun(events.iter().map(|e| AsRunEntry::from_event(e, instance, false)).collect());
    for event in events {
        log::info!(
            "[CasparCG] event #{} {} {} ({}) frame {}",
            event.seq, event.kind, event.tag, event.reason, event.frame
        );
        let _ = app.emit(EVENT_TOPIC, event);
    }
}

fn emit_instance<R: tauri::Runtime>(app: &tauri::AppHandle<R>, instance: Option<i64>, reason: &str) {
    use tauri::Emitter;
    log::warn!("[CasparCG] Engine instance changed ({}): the queue is gone", reason);
    let _ = app.emit(INSTANCE_TOPIC, EngineInstanceChanged { instance, reason: reason.to_string() });
}

/// After one OSC packet: emit the in-order events and start a gap fetch.
pub fn after_osc_packet<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &std::sync::Arc<parking_lot::Mutex<crate::caspar::PlaybackStateInner>>,
    now_ms: u64,
) {
    let (drain, instance) = {
        let mut s = state.lock();
        if !s.fork.is_fork() {
            return;
        }
        (s.fork.drain(now_ms), s.fork.instance)
    };
    if drain.restarted {
        emit_instance(app, None, "event-seq-reset");
    }
    emit_events(app, instance, drain.events);
    if let Some(since) = drain.fetch_since {
        let app = app.clone();
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            let Some(client) = tauri::Manager::try_state::<AmcpClient>(&app).map(|c| c.inner().clone()) else {
                state.lock().fork.fetch_failed();
                return;
            };
            let reply = fetch_events(
                &client,
                crate::caspar_layers::PROGRAM_CHANNEL,
                crate::caspar_layers::CasparLayer::Video.layer(),
                Some(since),
            )
            .await;
            match reply {
                Ok(reply) => {
                    if reply.lost {
                        log::warn!(
                            "[CasparCG] Events after #{} fell out of the engine log (oldest #{})",
                            since, reply.oldest
                        );
                    }
                    let (events, restarted) = state.lock().fork.apply_fetched(&reply);
                    if restarted {
                        emit_instance(&app, Some(reply.instance), "events-instance");
                    }
                    emit_events(&app, Some(reply.instance), events);
                }
                Err(error) => {
                    log::warn!("[CasparCG] EVENTS gap fetch failed: {}", error);
                    state.lock().fork.fetch_failed();
                }
            }
        });
    }
}

/// Result of [`caspar_engine_detect`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineDetect {
    pub mode: EngineMode,
    pub info: Option<QueueInfo>,
    /// A known fork instance was replaced: the engine restarted.
    pub restarted: bool,
    /// Events that aired while PlayOut was not running (same engine
    /// instance as the previous session's checkpoint), oldest first.
    pub replayed: Vec<EngineEvent>,
    /// Some of those events fell out of the engine's 128-event log.
    pub replay_lost: bool,
}

/// After a PlayOut relaunch: the cursor to replay from, when the engine is
/// the same instance the previous session saw.
fn replay_cursor(previous: Option<&crate::recovery::EngineCheckpoint>, info: &QueueInfo) -> Option<u64> {
    let previous = previous?;
    let since = previous.last_seq?;
    (previous.instance == Some(info.instance) && since < info.event_seq).then_some(since)
}

/// D1: `QUEUE INFO` on the program layer decides the engine mode. Call on
/// every (re)connect.
#[tauri::command]
pub async fn caspar_engine_detect<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    client: State<'_, AmcpClient>,
    playback: State<'_, crate::caspar::CasparPlaybackState>,
) -> Result<EngineDetect, String> {
    let channel = crate::caspar_layers::PROGRAM_CHANNEL;
    let layer = crate::caspar_layers::CasparLayer::Video.layer();
    let info = probe(&client, channel, layer).await?;
    let (mode, restarted, fresh_process) = {
        let mut s = playback.0.lock();
        // No cursor yet: this process has not seen the engine before.
        let fresh_process = s.fork.last_seq.is_none();
        match &info {
            Some(info) => (EngineMode::Fork, s.fork.set_fork(info.instance, info.event_seq), fresh_process),
            None => {
                s.fork.set_stock();
                (EngineMode::Stock, false, fresh_process)
            }
        }
    };
    if restarted {
        emit_instance(&app, info.as_ref().map(|i| i.instance), "queue-info-instance");
    }
    log::info!("[CasparCG] Engine mode: {:?}", mode);

    // D7: what aired while PlayOut was away goes into the as-run. The live
    // cursor already starts at the engine's current seq, so nothing is
    // replayed into the playout logic.
    let mut replayed = Vec::new();
    let mut replay_lost = false;
    if let (true, Some(info)) = (fresh_process, info.as_ref()) {
        let previous = tauri::Manager::try_state::<crate::recovery::RecoveryState>(&app)
            .and_then(|recovery| recovery.previous_engine());
        if let Some(since) = replay_cursor(previous.as_ref(), info) {
            match fetch_events(&client, channel, layer, Some(since)).await {
                Ok(reply) => {
                    replay_lost = reply.lost;
                    replayed = reply.events.into_iter().filter(|e| e.seq <= info.event_seq).collect();
                    record_asrun(replayed.iter().map(|e| AsRunEntry::from_event(e, Some(info.instance), true)).collect());
                    log::info!(
                        "[CasparCG] {} engine event(s) aired while PlayOut was away (since #{}{})",
                        replayed.len(),
                        since,
                        if replay_lost { ", some lost from the engine log" } else { "" }
                    );
                }
                Err(error) => log::warn!("[CasparCG] EVENTS replay after relaunch failed: {}", error),
            }
        }
    }
    Ok(EngineDetect { mode, info, restarted, replayed, replay_lost })
}

#[tauri::command]
pub async fn caspar_engine_state(
    playback: State<'_, crate::caspar::CasparPlaybackState>,
) -> Result<EngineStateReport, String> {
    Ok(EngineStateReport::from(&playback.0.lock().fork))
}

// ── Fallback slate (handoff D5) ────────────────────────────────────────────

/// Deployed to `<media>/playout/` with the templates; the default fallback
/// clip `playout/emergency` resolves to it.
pub const EMERGENCY_SLATE_FILE: &str = "emergency.png";

/// A full-frame, opaque, near-black slate (1920x1080). Plain on purpose: it
/// replaces a frozen or empty picture, and it must never look like content.
pub fn emergency_slate_png() -> Result<Vec<u8>, String> {
    let image = image::RgbaImage::from_pixel(1920, 1080, image::Rgba([12, 14, 18, 255]));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode the fallback slate: {}", e))?;
    Ok(bytes.into_inner())
}

// ── As-run from engine events (handoff D7) ─────────────────────────────────

/// One aired event, as the engine stamped it. Appended to
/// `recovery/asrun-YYYY-MM-DD.jsonl` (UTC day of the event).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsRunEntry {
    /// Engine wall-clock time of the event, ms since the epoch.
    pub at_ms: i64,
    pub instance: Option<i64>,
    pub seq: u64,
    pub kind: String,
    pub tag: String,
    /// The rundown row (the tag without its occurrence suffix).
    pub row_id: String,
    /// Channel tick counter of the event.
    pub frame: i64,
    pub reason: String,
    /// Replayed by `EVENTS` after a relaunch: it aired while PlayOut was away.
    pub replayed: bool,
}

impl AsRunEntry {
    pub fn from_event(event: &EngineEvent, instance: Option<i64>, replayed: bool) -> Self {
        let row_id = event.tag.split(':').next().unwrap_or("").to_string();
        AsRunEntry {
            at_ms: event.time,
            instance,
            seq: event.seq,
            kind: event.kind.clone(),
            tag: event.tag.clone(),
            row_id,
            frame: event.frame,
            reason: event.reason.clone(),
            replayed,
        }
    }
}

/// UTC calendar date of an epoch-ms time (`YYYY-MM-DD`), civil-from-days.
pub fn utc_date(epoch_ms: i64) -> String {
    let days = epoch_ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{:04}-{:02}-{:02}", year, month, day)
}

fn asrun_path(dir: &std::path::Path, epoch_ms: i64) -> std::path::PathBuf {
    dir.join(format!("asrun-{}.jsonl", utc_date(epoch_ms)))
}

/// Append entries, one JSON line each, to the file of each entry's day.
pub fn append_asrun(dir: &std::path::Path, entries: &[AsRunEntry]) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    for entry in entries {
        let line = serde_json::to_string(entry).map_err(std::io::Error::other)?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(asrun_path(dir, entry.at_ms))?;
        writeln!(file, "{}", line)?;
    }
    Ok(())
}

/// The last `limit` entries of the given day's file.
pub fn read_asrun(dir: &std::path::Path, epoch_ms: i64, limit: usize) -> Vec<AsRunEntry> {
    let Ok(raw) = std::fs::read_to_string(asrun_path(dir, epoch_ms)) else { return Vec::new() };
    let entries: Vec<AsRunEntry> = raw.lines().filter_map(|line| serde_json::from_str(line).ok()).collect();
    let skip = entries.len().saturating_sub(limit);
    entries.into_iter().skip(skip).collect()
}

fn record_asrun(entries: Vec<AsRunEntry>) {
    if entries.is_empty() {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = append_asrun(&crate::recovery::recovery_dir(), &entries) {
            log::warn!("[CasparCG] Could not append {} as-run event(s): {}", entries.len(), error);
        }
    });
}

/// Today's (UTC) engine as-run, newest last.
#[tauri::command]
pub async fn caspar_engine_asrun(limit: Option<usize>) -> Result<Vec<AsRunEntry>, String> {
    let limit = limit.unwrap_or(200).min(5_000);
    tauri::async_runtime::spawn_blocking(move || {
        read_asrun(&crate::recovery::recovery_dir(), crate::recovery::now_epoch_ms() as i64, limit)
    })
    .await
    .map_err(|e| format!("as-run read failed: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::amcp::{is_allowed_passthrough_command, AmcpStatus};

    fn resp(code: u16, body: &str) -> AmcpResponse {
        AmcpResponse { code, status: AmcpStatus::from_code(code), body: body.to_string() }
    }

    #[test]
    fn conflicts_are_data_other_errors_are_not() {
        let ok = accept("Q", resp(201, "201 QUEUE CLEAR OK\r\n3"), &[CONFLICT]).unwrap();
        assert_eq!((ok.code, ok.removed), (201, Some(3)));
        let conflict = accept("Q", resp(409, "409 QUEUE CONFLICT"), &[CONFLICT]).unwrap();
        assert_eq!(conflict.code, 409);
        assert!(accept("Q", resp(404, "404 QUEUE FAILED"), &[CONFLICT]).is_err());
        assert!(accept("Q", resp(403, "403 QUEUE FAILED"), &[NOT_FOUND, CONFLICT]).is_err());
    }

    #[test]
    fn onair_actions_deserialize_and_build_in_order() {
        let actions: Vec<OnairAction> = serde_json::from_str(
            r#"[{"kind":"command","cmd":"CLEAR 1-31"},
                {"kind":"command","cmd":"CLEAR 1-34"},
                {"kind":"cgUpdate","layer":32,"data":{"text":"Ακατάλληλο για \"13\""}},
                {"kind":"cgAdd","layer":32,"template":"playout/advisory","play":true,"data":{}}]"#,
        )
        .unwrap();
        let lines = onair_lines(1, 10, "row-1", &actions).unwrap();
        assert_eq!(lines[0], "ONAIR 1-10 row-1 CLEAR 1-31");
        assert_eq!(lines[1], "ONAIR 1-10 row-1 CLEAR 1-34");
        assert_eq!(
            lines[2],
            r#"ONAIR 1-10 row-1 CG 1-32 UPDATE 1 "{\"text\":\"Ακατάλληλο για \\\"13\\\"\"}""#
        );
        assert_eq!(lines[3], r#"ONAIR 1-10 row-1 CG 1-32 ADD 1 "playout/advisory" 1 "{}""#);
        assert!(lines.iter().all(|l| is_allowed_passthrough_command(l)));
    }

    #[test]
    fn one_bad_onair_action_rejects_the_batch() {
        let actions = vec![
            OnairAction::Command { cmd: "CLEAR 1-31".into() },
            OnairAction::Command { cmd: "KILL".into() },
        ];
        assert!(onair_lines(1, 10, "row-1", &actions).is_err());
        let bad_template = vec![OnairAction::CgAdd {
            layer: 32,
            template: "x\" 1 \"{}\"".into(),
            play: true,
            data: serde_json::json!({}),
        }];
        assert!(onair_lines(1, 10, "row-1", &bad_template).is_err());
    }

    // ── Fork OSC ──────────────────────────────────────────────────────────

    use rosc::{OscBundle, OscMessage, OscPacket, OscTime, OscType};

    const P: &str = "/channel/1/stage/layer/10";

    fn msg(addr: &str, args: Vec<OscType>) -> OscPacket {
        OscPacket::Message(OscMessage { addr: addr.to_string(), args })
    }

    fn event_msg(kind: &str, seq: i64, frame: i64, tag: &str, reason: &str) -> OscPacket {
        msg(
            &format!("{}/event/{}", P, kind),
            vec![
                OscType::Long(seq),
                OscType::Long(frame),
                OscType::Long(1_792_069_797_688),
                OscType::String(tag.into()),
                OscType::String(reason.into()),
            ],
        )
    }

    /// Encode then decode, as the listener receives it, and feed every message.
    fn feed(state: &mut ForkOscState, content: Vec<OscPacket>) {
        let bundle = OscPacket::Bundle(OscBundle { timetag: OscTime { seconds: 0, fractional: 1 }, content });
        let bytes = rosc::encoder::encode(&bundle).unwrap();
        let (_, packet) = rosc::decoder::decode_udp(&bytes).unwrap();
        fn walk(state: &mut ForkOscState, packet: OscPacket) {
            match packet {
                OscPacket::Message(m) => {
                    if let Some(parsed) = parse_fork_osc(1, 10, &m.addr, &m.args) {
                        state.observe(parsed);
                    }
                }
                OscPacket::Bundle(b) => b.content.into_iter().for_each(|p| walk(state, p)),
            }
        }
        walk(state, packet);
    }

    fn fork_state(seq: u64) -> ForkOscState {
        let mut s = ForkOscState::default();
        assert!(!s.set_fork(1_792_069_796_000, seq));
        s
    }

    fn seqs(events: &[EngineEvent]) -> Vec<u64> {
        events.iter().map(|e| e.seq).collect()
    }

    #[test]
    fn parses_fork_addresses_only() {
        assert_eq!(
            parse_fork_osc(1, 10, "/channel/1/stage/frame", &[OscType::Long(553)]),
            Some(ForkOscMessage::Frame(553))
        );
        assert_eq!(
            parse_fork_osc(1, 10, &format!("{}/foreground/tag", P), &[OscType::String("a".into())]),
            Some(ForkOscMessage::ForegroundTag("a".into()))
        );
        assert_eq!(parse_fork_osc(1, 10, &format!("{}/event/seq", P), &[OscType::Int(4)]), Some(ForkOscMessage::Seq(4)));
        assert_eq!(parse_fork_osc(1, 10, &format!("{}/file/time", P), &[OscType::Float(1.0)]), None);
        assert_eq!(parse_fork_osc(1, 10, "/channel/1/stage/layer/20/event/seq", &[OscType::Long(4)]), None);
        assert_eq!(parse_fork_osc(1, 10, &format!("{}/event/bogus", P), &[]), None);
        assert_eq!(parse_fork_osc(1, 10, &format!("{}/event/onair", P), &[OscType::Long(1)]), None);
    }

    /// One tick of an AUTO hand-over latches `ended`, `offair` and `onair` in one bundle.
    #[test]
    fn auto_handover_bundle_drains_in_seq_order() {
        let mut s = fork_state(1);
        feed(&mut s, vec![
            msg(&format!("{}/event/seq", P), vec![OscType::Long(4)]),
            event_msg("onair", 4, 443, "b", "auto"),
            event_msg("offair", 3, 443, "a", "auto"),
            event_msg("ended", 2, 443, "a", "ended"),
            msg(&format!("{}/foreground/tag", P), vec![OscType::String("b".into())]),
        ]);
        let drain = s.drain(1_000);
        assert_eq!(seqs(&drain.events), [2, 3, 4]);
        assert_eq!(drain.events[2].kind, "onair");
        assert_eq!(drain.events[2].tag, "b");
        assert_eq!(drain.fetch_since, None);
        assert_eq!(s.foreground_tag, "b");

        // Latched events are re-sent every tick: nothing new.
        feed(&mut s, vec![
            msg(&format!("{}/event/seq", P), vec![OscType::Long(4)]),
            event_msg("onair", 4, 443, "b", "auto"),
            event_msg("ended", 2, 443, "a", "ended"),
        ]);
        assert_eq!(s.drain(1_040), ForkDrain::default());
    }

    #[test]
    fn a_lost_latched_event_triggers_one_fetch() {
        let mut s = fork_state(4);
        // Two onair events between packets: #5 (ended b) and #6 (offair b) were
        // overwritten by #8/#9 of the same kind before the next packet.
        feed(&mut s, vec![
            msg(&format!("{}/event/seq", P), vec![OscType::Long(10)]),
            event_msg("ended", 8, 523, "c", "ended"),
            event_msg("offair", 9, 523, "c", "auto"),
            event_msg("onair", 10, 523, "d", "auto"),
        ]);
        let drain = s.drain(1_000);
        assert!(drain.events.is_empty());
        assert_eq!(drain.fetch_since, Some(4));
        // In flight: no second fetch.
        assert_eq!(s.drain(2_000).fetch_since, None);

        let reply = EventsReply {
            channel: 1,
            layer: 10,
            instance: 1_792_069_796_000,
            frame: 530,
            last: 10,
            oldest: 1,
            events: (5..=10)
                .map(|seq| EngineEvent {
                    seq,
                    frame: 500,
                    time: 0,
                    kind: "onair".into(),
                    tag: format!("t{}", seq),
                    reason: "auto".into(),
                })
                .collect(),
            lost: false,
        };
        let (events, restarted) = s.apply_fetched(&reply);
        assert!(!restarted);
        assert_eq!(seqs(&events), [5, 6, 7, 8, 9, 10]);
        assert_eq!(s.last_seq, Some(10));
        assert_eq!(s.drain(3_000), ForkDrain::default());
    }

    #[test]
    fn events_lost_from_the_engine_log_are_skipped() {
        let mut s = fork_state(4);
        feed(&mut s, vec![msg(&format!("{}/event/seq", P), vec![OscType::Long(300)])]);
        assert_eq!(s.drain(1_000).fetch_since, Some(4));
        let reply = EventsReply {
            channel: 1, layer: 10, instance: 1_792_069_796_000, frame: 0, last: 300, oldest: 173,
            events: vec![], lost: true,
        };
        let (events, _) = s.apply_fetched(&reply);
        assert!(events.is_empty());
        assert_eq!(s.last_seq, Some(300));
    }

    #[test]
    fn seq_going_back_means_the_engine_restarted() {
        let mut s = fork_state(40);
        feed(&mut s, vec![
            msg(&format!("{}/event/seq", P), vec![OscType::Long(1)]),
            event_msg("onair", 1, 12, "fallback", "ended"),
        ]);
        let drain = s.drain(1_000);
        assert!(drain.restarted);
        assert_eq!(seqs(&drain.events), [1]);
        assert_eq!(s.last_seq, Some(1));
    }

    #[test]
    fn probe_seeding_keeps_the_cursor_on_the_same_instance() {
        let mut s = ForkOscState::default();
        assert!(!s.set_fork(100, 7));
        assert_eq!(s.last_seq, Some(7));
        s.last_seq = Some(9);
        assert!(!s.set_fork(100, 12));
        assert_eq!(s.last_seq, Some(9), "same instance: the gap fetch replays 10..12");
        assert!(s.set_fork(200, 3));
        assert_eq!(s.last_seq, Some(3));
    }

    #[test]
    fn stock_mode_ignores_fork_messages() {
        let mut s = ForkOscState::default();
        s.set_stock();
        feed(&mut s, vec![
            msg(&format!("{}/event/seq", P), vec![OscType::Long(2)]),
            event_msg("onair", 2, 1, "x", "take"),
        ]);
        assert_eq!(s.drain(1_000), ForkDrain::default());
        assert_eq!(s.last_seq, None);
    }

    #[test]
    fn unseeded_fork_state_starts_at_the_current_seq() {
        let mut s = ForkOscState { mode: EngineMode::Fork, ..ForkOscState::default() };
        feed(&mut s, vec![
            msg(&format!("{}/event/seq", P), vec![OscType::Long(6)]),
            event_msg("onair", 6, 1, "x", "take"),
        ]);
        assert!(s.drain(1_000).events.is_empty(), "history is not replayed as live events");
        assert_eq!(s.last_seq, Some(6));
        feed(&mut s, vec![
            msg(&format!("{}/event/seq", P), vec![OscType::Long(7)]),
            event_msg("offair", 7, 2, "x", "stop"),
        ]);
        assert_eq!(seqs(&s.drain(1_100).events), [7]);
    }

    #[test]
    fn engine_event_payload_shape() {
        let event = EngineEvent {
            seq: 4, frame: 443, time: 1_792_069_797_688, kind: "onair".into(), tag: "b".into(), reason: "auto".into(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["timeMs"], 1_792_069_797_688i64);
        assert_eq!(json["kind"], "onair");
        assert!(json.get("time").is_none());
    }

    // ── As-run and relaunch replay ────────────────────────────────────────

    #[test]
    fn emergency_slate_is_a_full_hd_png() {
        let png = emergency_slate_png().unwrap();
        assert_eq!(&png[1..4], b"PNG");
        let decoded = image::load_from_memory(&png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (1920, 1080));
        assert!(png.len() < 64 * 1024, "a solid slate compresses to a few KB");
    }

    #[test]
    fn utc_dates() {
        assert_eq!(utc_date(0), "1970-01-01");
        assert_eq!(utc_date(951_782_400_000), "2000-02-29");
        assert_eq!(utc_date(1_792_065_829_887), "2026-10-15");
        assert_eq!(utc_date(1_792_108_799_999), "2026-10-15");
        assert_eq!(utc_date(1_792_108_800_000), "2026-10-16");
    }

    fn onair(seq: u64, tag: &str, time: i64) -> EngineEvent {
        EngineEvent { seq, frame: seq as i64 * 25, time, kind: "onair".into(), tag: tag.into(), reason: "auto".into() }
    }

    #[test]
    fn asrun_entries_carry_the_row_id() {
        let entry = AsRunEntry::from_event(&onair(4, "row-1:2", 7), Some(9), true);
        assert_eq!(entry.row_id, "row-1");
        assert_eq!(entry.tag, "row-1:2");
        assert!(entry.replayed);
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["atMs"], 7);
        assert_eq!(json["rowId"], "row-1");
    }

    #[test]
    fn asrun_appends_per_day_and_reads_the_tail() {
        let dir = std::env::temp_dir().join(format!("playout-asrun-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let day = 1_792_065_829_887;
        let next_day = day + 86_400_000;
        let entries: Vec<AsRunEntry> = vec![
            AsRunEntry::from_event(&onair(1, "a", day), Some(1), false),
            AsRunEntry::from_event(&onair(2, "b", day + 1), Some(1), false),
            AsRunEntry::from_event(&onair(3, "c", next_day), Some(1), false),
        ];
        append_asrun(&dir, &entries[..2]).unwrap();
        append_asrun(&dir, &entries[2..]).unwrap();
        assert_eq!(read_asrun(&dir, day, 10), entries[..2].to_vec());
        assert_eq!(read_asrun(&dir, day, 1), entries[1..2].to_vec());
        assert_eq!(read_asrun(&dir, next_day, 10), entries[2..].to_vec());
        assert!(read_asrun(&dir, next_day + 86_400_000, 10).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn info(instance: i64, event_seq: u64) -> QueueInfo {
        QueueInfo {
            channel: 1,
            layer: 10,
            instance,
            frame: 0,
            event_seq,
            foreground: None,
            waiting: vec![],
            fallback: Default::default(),
        }
    }

    #[test]
    fn relaunch_replays_only_on_the_same_engine_instance() {
        use crate::recovery::EngineCheckpoint;
        let previous = EngineCheckpoint { mode: EngineMode::Fork, instance: Some(100), last_seq: Some(40) };
        assert_eq!(replay_cursor(Some(&previous), &info(100, 52)), Some(40));
        assert_eq!(replay_cursor(Some(&previous), &info(100, 40)), None, "nothing new");
        assert_eq!(replay_cursor(Some(&previous), &info(200, 52)), None, "the engine restarted");
        assert_eq!(replay_cursor(None, &info(100, 52)), None);
        let no_cursor = EngineCheckpoint { last_seq: None, ..previous };
        assert_eq!(replay_cursor(Some(&no_cursor), &info(100, 52)), None);
    }
}
