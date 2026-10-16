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
    EventsReply, ItemVerb, QueueInfo, TaggedItem,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::amcp::{AmcpStatus, is_allowed_passthrough_command};

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
}
