//! The binary on real Windows. The runners have no dial, so these pin what an empty machine and a missing port say;
//! the dial itself is plan E1.3 and E5 on the test PC.
#![cfg(windows)]

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_harness-serial"))
}

#[test]
fn watch_reports_no_dial_and_ends_when_its_stdin_closes() {
    let mut child = bin()
        .arg("watch")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    // Keep stdout open so only stdin EOF, rather than a broken output pipe, can end the watch.
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    stdout.read_line(&mut line).unwrap();
    // A runner may have other COM ports; none is a dial.
    assert!(
        line.starts_with(r#"{"console":"#) && line.trim_end().ends_with(r#""ports":[]}"#),
        "{line}"
    );
    // Review Focus 3: the parent going away closes the pipe, and that alone ends the watch.
    drop(child.stdin.take());
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert_eq!(status.code(), Some(0));
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "watch outlived its stdin"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_port_that_is_not_there_is_gone_for_open_and_probe() {
    for command in ["open", "probe"] {
        let out = bin()
            .args([command, "COM250"])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(4), "{command}");
        if command == "open" {
            assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "gone");
        }
    }
}
