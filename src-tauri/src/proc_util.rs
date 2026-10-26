//! Bounded child-process execution.
//!
//! `std::process::Command::output()` blocks until the child exits. For
//! ffprobe/ffmpeg on a media file that lives on an SMB share which just went
//! offline, that can be the SMB timeout (30-60 s or more). Called from a Tauri
//! command it parks an async worker thread; a few such takes in a row starve
//! the OSC listener and playback watchdog. Every external tool invocation on
//! the playout path goes through [`run_with_timeout`] instead, which kills
//! the child and returns an error once the deadline passes.

use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Run `command` to completion, or kill it and fail once `timeout` elapses.
/// stdout/stderr are drained on helper threads so a chatty child can never
/// dead-lock on a full pipe.
pub fn run_with_timeout(mut command: Command, timeout: Duration) -> Result<Output, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn process: {}", error))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || drain(stdout));
    let stderr_reader = std::thread::spawn(move || drain(stderr));

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    // Do NOT join the reader threads here: a grandchild (e.g.
                    // `cmd /c ffprobe`) can keep the pipe open after the direct
                    // child is dead, and joining would block for its lifetime.
                    // The detached readers exit on their own at EOF.
                    drop(stdout_reader);
                    drop(stderr_reader);
                    return Err(format!(
                        "process timed out after {} ms and was killed",
                        timeout.as_millis()
                    ));
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(error) => {
                let _ = child.kill();
                return Err(format!("failed to wait for process: {}", error));
            }
        }
    };

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    Ok(Output { status, stdout, stderr })
}

/// Absolute path of a Windows system tool (audit T2-4). `Command::new("taskkill")`
/// resolves through `PATH`, and the process CWD is searched first on Windows,
/// so a planted `taskkill.exe` next to a media root or in the CasparCG folder
/// would run with the operator's privileges. Always spawn system tools from
/// `%SystemRoot%\System32` (or `%SystemRoot%` for explorer.exe).
#[cfg(windows)]
pub fn windows_system_tool(name: &str) -> std::path::PathBuf {
    let root = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"));
    if name.eq_ignore_ascii_case("explorer.exe") {
        root.join(name)
    } else {
        root.join("System32").join(name)
    }
}

/// Keep a socket out of the child processes PlayOut spawns.
///
/// tokio's sockets (mio's plain `socket()`) are inheritable on Windows, and
/// CasparCG is spawned with piped stdio, so it gets a copy of every socket
/// PlayOut has open at that moment: the OSC listener, the studio and media
/// servers, the AMCP connection. After a PlayOut crash the engine keeps them
/// alive, and the relaunched PlayOut cannot bind its OSC port again (seen
/// live: an engine relaunched by the supervisor held 127.0.0.1:6250, so
/// PlayOut never reconnected). Call this right after creating a socket.
#[cfg(windows)]
pub fn disinherit_socket<S: std::os::windows::io::AsRawSocket>(socket: &S) {
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
    // SAFETY: the raw socket is a valid handle owned by `socket` for the call.
    let ok = unsafe { SetHandleInformation(socket.as_raw_socket() as HANDLE, HANDLE_FLAG_INHERIT, 0) };
    if ok == 0 {
        log::warn!("[proc_util] Could not clear the inherit flag of a socket: {}", std::io::Error::last_os_error());
    }
}

#[cfg(not(windows))]
pub fn disinherit_socket<S>(_socket: &S) {}

fn drain<R: Read>(reader: Option<R>) -> Vec<u8> {
    let mut buffer = Vec::new();
    if let Some(mut reader) = reader {
        let _ = reader.read_to_end(&mut buffer);
    }
    buffer
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn shell(args: &[&str]) -> Command {
        let mut command = Command::new("cmd");
        command.arg("/c");
        command.args(args);
        command
    }

    #[cfg(not(windows))]
    fn shell(args: &[&str]) -> Command {
        let mut command = Command::new("sh");
        command.arg("-c");
        command.arg(args.join(" "));
        command
    }

    #[test]
    fn completes_fast_process_and_captures_stdout() {
        let output = run_with_timeout(shell(&["echo", "hello"]), Duration::from_secs(5)).expect("echo");
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains("hello"));
    }

    #[cfg(windows)]
    #[test]
    fn kills_process_that_exceeds_timeout() {
        // `ping -n 6` sleeps ~5 s between echoes.
        let started = Instant::now();
        let result = run_with_timeout(shell(&["ping", "-n", "6", "127.0.0.1"]), Duration::from_millis(400));
        assert!(result.is_err(), "must time out");
        assert!(result.unwrap_err().contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(4), "kill must be prompt");
    }

    #[cfg(windows)]
    fn inherits(socket: &impl std::os::windows::io::AsRawSocket) -> bool {
        use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
        let mut flags = 0u32;
        assert_ne!(unsafe { GetHandleInformation(socket.as_raw_socket() as HANDLE, &mut flags) }, 0);
        flags & HANDLE_FLAG_INHERIT != 0
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn disinherit_socket_clears_the_inherit_flag() {
        let udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stream = tokio::net::TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
        // Why this exists: older tokio/mio created them inheritable. Newer
        // releases do not, so set the flag here to keep exercising the clear.
        use std::os::windows::io::AsRawSocket;
        for raw in [udp.as_raw_socket(), listener.as_raw_socket(), stream.as_raw_socket()] {
            use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
            assert_ne!(unsafe { SetHandleInformation(raw as HANDLE, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) }, 0);
        }
        assert!(inherits(&udp) && inherits(&listener) && inherits(&stream));
        disinherit_socket(&udp);
        disinherit_socket(&listener);
        disinherit_socket(&stream);
        assert!(!inherits(&udp) && !inherits(&listener) && !inherits(&stream));
    }

    #[test]
    fn spawn_failure_is_reported_not_panicked() {
        let result = run_with_timeout(Command::new("definitely-not-a-real-binary-xyz"), Duration::from_secs(1));
        assert!(result.is_err());
    }
}
