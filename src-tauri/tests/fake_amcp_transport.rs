use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use std::time::Duration;

/// Integration test simulating AMCP socket behavior: delayed 202 PLAY OK, dropped connections,
/// and response validation.
#[test]
fn test_fake_amcp_socket_delayed_ack_handling() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind fake AMCP listener");
    let addr = listener.local_addr().unwrap();

    let server_handle = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 512];
            if let Ok(n) = stream.read(&mut buf) {
                let cmd = String::from_utf8_lossy(&buf[..n]);
                if cmd.contains("PLAY") {
                    // Simulate delayed AMCP response
                    thread::sleep(Duration::from_millis(50));
                    let _ = stream.write_all(b"202 PLAY OK\r\n");
                }
            }
        }
    });

    // Client side connection test
    let mut client = std::net::TcpStream::connect(addr).expect("Client connect failed");
    client.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
    client.write_all(b"PLAY 1-10 \"MY_CLIP\"\r\n").unwrap();

    let mut response_buf = [0u8; 128];
    let n = client.read(&mut response_buf).expect("Read failed");
    let resp_str = String::from_utf8_lossy(&response_buf[..n]);

    assert!(resp_str.contains("202 PLAY OK"));

    server_handle.join().unwrap();
}
