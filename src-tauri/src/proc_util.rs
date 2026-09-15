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

    #[test]
    fn spawn_failure_is_reported_not_panicked() {
        let result = run_with_timeout(Command::new("definitely-not-a-real-binary-xyz"), Duration::from_secs(1));
        assert!(result.is_err());
    }
}
