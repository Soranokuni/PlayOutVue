use rosc::{OscPacket, OscType};
use serde::Serialize;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::time::timeout;

const CASPAR_AMCP_ADDR: &str = "127.0.0.1:5250";
const CASPAR_OSC_ADDR: &str = "127.0.0.1:6250";
const CONNECT_TIMEOUT: Duration = Duration::from_millis(750);
const IO_TIMEOUT: Duration = Duration::from_millis(750);
const READ_GAP_TIMEOUT: Duration = Duration::from_millis(125);

#[derive(Debug, Clone, Serialize)]
pub struct CasparOscEvent {
    pub address: String,
    pub args: Vec<String>,
    pub position_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub received_at: String,
}

#[tauri::command]
pub async fn caspar_send_command(cmd: String) -> Result<String, String> {
    let mut stream = timeout(CONNECT_TIMEOUT, TcpStream::connect(CASPAR_AMCP_ADDR))
        .await
        .map_err(|_| format!("Timed out connecting to CasparCG at {}", CASPAR_AMCP_ADDR))?
        .map_err(|error| format!("Failed to connect to CasparCG at {}: {}", CASPAR_AMCP_ADDR, error))?;

    let normalized = if cmd.ends_with("\r\n") {
        cmd
    } else {
        format!("{}\r\n", cmd.trim_end())
    };

    timeout(IO_TIMEOUT, stream.write_all(normalized.as_bytes()))
        .await
        .map_err(|_| "Timed out sending CasparCG command".to_string())?
        .map_err(|error| format!("Failed to send CasparCG command: {}", error))?;

    let mut response = Vec::new();
    let mut chunk = [0_u8; 4096];

    loop {
        match timeout(READ_GAP_TIMEOUT, stream.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(read)) => {
                response.extend_from_slice(&chunk[..read]);
                if read < chunk.len() {
                    break;
                }
            }
            Ok(Err(error)) => return Err(format!("Failed to read CasparCG response: {}", error)),
            Err(_) => break,
        }
    }

    Ok(String::from_utf8_lossy(&response).trim().to_string())
}

pub async fn start_osc_listener<R: Runtime>(app: AppHandle<R>) {
    let socket = match UdpSocket::bind(CASPAR_OSC_ADDR).await {
        Ok(socket) => socket,
        Err(error) => {
            eprintln!("[CasparCG] OSC listener failed to bind {}: {}", CASPAR_OSC_ADDR, error);
            return;
        }
    };

    let mut buffer = [0_u8; 4096];

    loop {
        let Ok((size, _peer)) = socket.recv_from(&mut buffer).await else {
            continue;
        };

        match rosc::decoder::decode_udp(&buffer[..size]) {
            Ok((_remainder, packet)) => {
                for event in collect_osc_events(packet) {
                    if let Err(error) = app.emit("caspar-osc", event) {
                        eprintln!("[CasparCG] Failed to emit OSC event: {}", error);
                    }
                }
            }
            Err(error) => {
                eprintln!("[CasparCG] Failed to decode OSC packet: {}", error);
            }
        }
    }
}

fn collect_osc_events(packet: OscPacket) -> Vec<CasparOscEvent> {
    match packet {
        OscPacket::Message(message) => vec![osc_message_to_event(message.addr, message.args)],
        OscPacket::Bundle(bundle) => bundle
            .content
            .into_iter()
            .flat_map(collect_osc_events)
            .collect(),
    }
}

fn osc_message_to_event(address: String, args: Vec<OscType>) -> CasparOscEvent {
    let numeric_args = args.iter().filter_map(arg_to_millis).collect::<Vec<_>>();

    CasparOscEvent {
        address,
        args: args.iter().map(|arg| format!("{:?}", arg)).collect(),
        position_ms: numeric_args.first().copied(),
        duration_ms: numeric_args.get(1).copied(),
        received_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().to_string())
            .unwrap_or_else(|_| "0".to_string()),
    }
}

fn arg_to_millis(arg: &OscType) -> Option<u64> {
    let seconds = match arg {
        OscType::Float(value) => Some(*value as f64),
        OscType::Double(value) => Some(*value),
        OscType::Int(value) => Some(*value as f64),
        OscType::Long(value) => Some(*value as f64),
        _ => None,
    }?;

    if !seconds.is_finite() || seconds.is_sign_negative() {
        return None;
    }

    Some((seconds * 1000.0).round() as u64)
}
