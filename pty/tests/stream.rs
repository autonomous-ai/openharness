mod common;
#[cfg(windows)]
use common::Connection;
use common::{Conn, WAIT, call, connect, dial, hello, script, start};
use harness_pty::protocol::{Kind, read_frame, write_frame};
use std::io::{BufReader, Write};
use std::time::{Duration, Instant};

fn stream(disc: &serde_json::Value) -> Conn {
    let mut s = dial(disc);
    s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    writeln!(s, "{}", hello(disc["token"].as_str().unwrap(), "stream")).unwrap();
    // Byte by byte, so no frame that follows the hello line is read into a buffer here.
    let mut line = Vec::new();
    let mut byte = [0u8];
    while byte[0] != b'\n' {
        std::io::Read::read_exact(&mut s, &mut byte).unwrap();
        line.push(byte[0]);
    }
    let line = String::from_utf8(line).unwrap();
    assert!(line.contains(r#""ok":true"#), "{line}");
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    s
}

/// `script` as a pane's command: `/bin/sh -c unix`, or PowerShell running `windows`.
fn create_with(
    w: &mut Conn,
    r: &mut BufReader<Conn>,
    unix: &str,
    windows: &str,
    hold: bool,
) -> String {
    let req = serde_json::json!({"id": 1, "op": "create", "command": script(unix, windows), "cols": 80, "rows": 24, "owner": "t", "hold": hold});
    call(w, r, &req.to_string())["pane"]
        .as_str()
        .unwrap()
        .to_string()
}

fn subscribe_with(
    s: &mut Conn,
    pane: &str,
    cols: u16,
    rows: u16,
    read_only: bool,
) -> serde_json::Value {
    let req = serde_json::json!({"pane": pane, "cols": cols, "rows": rows, "readOnly": read_only});
    write_frame(s, Kind::Subscribe, req.to_string().as_bytes()).unwrap();
    let (kind, payload) = read_frame(s).unwrap().unwrap();
    assert_eq!(kind, Kind::Ack);
    serde_json::from_slice(&payload).unwrap()
}

fn subscribe(s: &mut Conn, pane: &str) {
    let ack = subscribe_with(s, pane, 80, 24, false);
    assert_eq!(ack["ok"], true, "{ack}");
}

/// Reads frames until `until` returns true for the text gathered so far, the stream ends, or a
/// read times out. Returns (frames, text).
fn read_until(s: &mut Conn, until: impl Fn(&str) -> bool) -> (Vec<(Kind, Vec<u8>)>, String) {
    let mut frames = Vec::new();
    let mut text = String::new();
    let end = Instant::now() + WAIT;
    while Instant::now() < end {
        let Ok(Some((kind, payload))) = read_frame(s) else {
            break;
        };
        if kind == Kind::Output {
            text.push_str(&String::from_utf8_lossy(&payload[8..]))
        }
        frames.push((kind, payload));
        if until(&text) {
            break;
        }
    }
    (frames, text)
}

/// PowerShell has no SIGWINCH: it prints the console's size each time it changes, as the Unix
/// scripts' WINCH trap does.
const WATCH_SIZE: &str = r#"$s = $Host.UI.RawUI.WindowSize; echo ready; while ($true) { $n = $Host.UI.RawUI.WindowSize; if ($n.Width -ne $s.Width -or $n.Height -ne $s.Height) { $s = $n; echo "size-$($n.Height)x$($n.Width)" }; Start-Sleep -Milliseconds 100 }"#;

fn seq_of(payload: &[u8]) -> u64 {
    u64::from_be_bytes(payload[..8].try_into().unwrap())
}

fn json(payload: &[u8]) -> serde_json::Value {
    serde_json::from_slice(payload).unwrap()
}

/// The next frame that is not output.
fn next_reply(s: &mut Conn) -> (Kind, serde_json::Value) {
    loop {
        let (kind, payload) = read_frame(s).unwrap().expect("stream ended");
        if kind != Kind::Output {
            return (kind, json(&payload));
        }
    }
}

fn snapshot(s: &mut Conn, id: u64) -> serde_json::Value {
    let req = serde_json::json!({"id": id, "history": "none", "historyLines": 0});
    write_frame(s, Kind::Snapshot, req.to_string().as_bytes()).unwrap();
    loop {
        let (kind, v) = next_reply(s);
        if kind == Kind::SnapshotReply {
            assert_eq!(v["id"], id);
            return v;
        }
    }
}

fn wait_capture(w: &mut Conn, r: &mut BufReader<Conn>, pane: &str, needle: &str) {
    let end = Instant::now() + WAIT;
    loop {
        let req = serde_json::json!({"id": 9, "op": "capture", "pane": pane, "ansi": false, "visible": true});
        let v = call(w, r, &req.to_string());
        if v["text"].as_str().unwrap_or_default().contains(needle) {
            return;
        }
        assert!(Instant::now() < end, "no {needle}: {v}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn snapshot_seq_cuts_output() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create_with(
        &mut w,
        &mut r,
        "sleep 0.3; i=1; while [ $i -le 200 ]; do echo line-$i; i=$((i+1)); done; sleep 3",
        r#"Start-Sleep -Milliseconds 300; 1..200 | % { "line-$_" }; Start-Sleep 3"#,
        false,
    );
    let mut s = stream(&disc);
    subscribe(&mut s, &pane);
    read_until(&mut s, |t| t.contains("line-50"));
    write_frame(
        &mut s,
        Kind::Snapshot,
        br#"{"id":1,"history":"conversation","historyLines":300}"#,
    )
    .unwrap();
    let mut cut = None;
    let mut snapshot_text = String::new();
    let mut after = String::new();
    let end = Instant::now() + WAIT;
    while Instant::now() < end
        && !(snapshot_text.contains("line-200") || after.contains("line-200"))
    {
        let (kind, payload) = read_frame(&mut s).unwrap().unwrap();
        match kind {
            Kind::SnapshotReply => {
                let v: serde_json::Value = serde_json::from_slice(&payload).unwrap();
                cut = Some(v["seq"].as_u64().unwrap());
                snapshot_text = format!(
                    "{}{}",
                    v["history"].as_str().unwrap(),
                    v["capture"].as_str().unwrap()
                );
            }
            Kind::Output if cut.is_some() => {
                let seq = seq_of(&payload);
                if seq > cut.unwrap() {
                    after.push_str(&String::from_utf8_lossy(&payload[8..]))
                }
            }
            _ => {}
        }
    }
    let total = format!("{snapshot_text}{after}");
    assert_eq!(total.matches("line-200").count(), 1, "{total}");
    // Nothing is lost either: each line is there once, in the snapshot (its history reaches back
    // past line-50) or in the output after its cut. (The snapshot's rows end in "\n", output's in
    // "\r\n"; where the cut falls depends on how fast the child writes.)
    for i in [1, 50, 60, 199] {
        let once = total.matches(&format!("line-{i}\n")).count()
            + total.matches(&format!("line-{i}\r")).count();
        assert_eq!(once, 1, "line-{i}: {total}");
    }
}

// Unix only: it needs a child that writes 20 MB faster than a subscriber reads. ConPTY renders a
// child's output into screen frames, so on Windows what reaches the host is a few frames, not the
// bytes written; the queue limit itself is covered by `stream`'s unit tests.
#[cfg(unix)]
#[test]
fn overflow_drops_subscriber() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create_with(
        &mut w,
        &mut r,
        "sleep 0.3; yes 0123456789012345678901234567890123456789 | head -c 20000000; sleep 5",
        "",
        false,
    );
    let mut s = stream(&disc);
    subscribe(&mut s, &pane);
    // A second subscriber that reads gets all of it.
    let mut reading = stream(&disc);
    subscribe(&mut reading, &pane);
    let reader = std::thread::spawn(move || {
        let (mut bytes, mut last) = (0usize, None);
        while let Ok(Some((kind, payload))) = read_frame(&mut reading) {
            match kind {
                Kind::Output => bytes += payload.len() - 8,
                _ => last = Some((kind, json(&payload))),
            }
        }
        (bytes, last)
    });
    std::thread::sleep(Duration::from_secs(2)); // do not read: the queue fills past 4 MiB
    let mut closed = None;
    while let Ok(Some((kind, payload))) = read_frame(&mut s) {
        if kind == Kind::Closed {
            closed = Some(String::from_utf8_lossy(&payload).to_string());
            break;
        }
    }
    assert!(
        closed.as_deref().is_some_and(|c| c.contains("overflow")),
        "{closed:?}"
    );
    // The host ends the connection after `Closed`.
    assert!(matches!(read_frame(&mut s), Ok(None) | Err(_)));
    let mut again = stream(&disc);
    subscribe(&mut again, &pane);
    write_frame(
        &mut again,
        Kind::Snapshot,
        br#"{"id":2,"history":"none","historyLines":0}"#,
    )
    .unwrap();
    let (frames, _) = read_until(&mut again, |_| false);
    assert!(frames.iter().any(|(k, _)| *k == Kind::SnapshotReply));
    // The pane went on.
    let st = call(
        &mut w,
        &mut r,
        &serde_json::json!({"id": 2, "op": "paneState", "pane": pane}).to_string(),
    );
    assert!(
        st["state"] == "gone" || st["state"]["dead"] == false,
        "{st}"
    );
    let (bytes, last) = reader.join().unwrap();
    assert!(bytes >= 20_000_000, "{bytes}");
    assert_eq!(
        last,
        Some((Kind::Closed, serde_json::json!({"reason": "exited"})))
    );
}

#[test]
fn held_pane_keeps_stream_across_respawn() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create_with(
        &mut w,
        &mut r,
        "sleep 0.3; echo first; exit 0",
        "Start-Sleep -Milliseconds 300; echo first; exit 0",
        true,
    );
    let mut s = stream(&disc);
    subscribe(&mut s, &pane);
    read_until(&mut s, |t| t.contains("first"));
    let end = Instant::now() + WAIT;
    loop {
        let st = call(
            &mut w,
            &mut r,
            &serde_json::json!({"id": 2, "op": "paneState", "pane": pane}).to_string(),
        );
        if st["state"]["dead"] == true {
            break;
        }
        assert!(Instant::now() < end, "{st}");
        std::thread::sleep(Duration::from_millis(50));
    }
    let req = serde_json::json!({"id": 3, "op": "respawn", "pane": pane, "command": script("echo second; sleep 1", "echo second; Start-Sleep 1")});
    assert_eq!(call(&mut w, &mut r, &req.to_string())["ok"], true);
    let (frames, text) = read_until(&mut s, |t| t.contains("second"));
    assert!(text.contains("second"), "{text}");
    assert!(frames.iter().all(|(k, _)| *k == Kind::Output));
}

#[test]
fn a_pane_that_exits_or_is_killed_closes_its_streams() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create_with(
        &mut w,
        &mut r,
        "sleep 0.3; echo bye; exit 0",
        "Start-Sleep -Milliseconds 300; echo bye; exit 0",
        false,
    );
    let mut s = stream(&disc);
    subscribe(&mut s, &pane);
    let (frames, text) = read_until(&mut s, |_| false);
    assert!(text.contains("bye"), "{text}");
    let (kind, payload) = frames.last().unwrap();
    assert_eq!(
        (*kind, json(payload)),
        (Kind::Closed, serde_json::json!({"reason": "exited"}))
    );

    let pane = create_with(&mut w, &mut r, "sleep 30", "Start-Sleep 30", true);
    let mut s = stream(&disc);
    subscribe(&mut s, &pane);
    let req = serde_json::json!({"id": 4, "op": "kill", "pane": pane, "graceMs": 500});
    assert_eq!(call(&mut w, &mut r, &req.to_string())["ok"], true);
    let (kind, v) = next_reply(&mut s);
    assert_eq!(
        (kind, v),
        (Kind::Closed, serde_json::json!({"reason": "killed"}))
    );

    // A pane that is not there.
    let mut s = stream(&disc);
    let ack = subscribe_with(&mut s, "%99", 80, 24, false);
    assert_eq!(
        (ack["ok"].clone(), ack["reason"].clone()),
        (serde_json::json!(false), serde_json::json!("no_pane"))
    );
}

#[test]
fn read_only_subscribers_cannot_type_paste_or_resize() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create_with(&mut w, &mut r, "sleep 30", "Start-Sleep 30", false);
    let mut s = stream(&disc);
    // A read-only subscriber does not resize the pane to its own size.
    let ack = subscribe_with(&mut s, &pane, 120, 40, true);
    assert_eq!(
        ack,
        serde_json::json!({"for": Kind::Subscribe as u8, "ok": true, "resized": false})
    );
    for (kind, payload) in [
        (Kind::Input, b"x".to_vec()),
        (Kind::Paste, b"y".to_vec()),
        (Kind::Resize, br#"{"cols":100,"rows":30}"#.to_vec()),
    ] {
        write_frame(&mut s, kind, &payload).unwrap();
        let (k, v) = next_reply(&mut s);
        assert_eq!(k, Kind::Ack);
        assert_eq!(
            v,
            serde_json::json!({"for": kind as u8, "ok": false, "reason": "read_only"})
        );
    }
    let snap = snapshot(&mut s, 1);
    assert_eq!(
        (snap["meta"]["cols"].clone(), snap["meta"]["rows"].clone()),
        (serde_json::json!(80), serde_json::json!(24))
    );
}

#[test]
fn subscribing_resizes_and_input_and_paste_reach_the_pane() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create_with(
        &mut w,
        &mut r,
        "stty -echo; echo ready; read a; echo got-$a; read b; echo pasted-$b; sleep 30",
        "echo ready; $a = Read-Host; echo got-$a; $b = Read-Host; echo pasted-$b; Start-Sleep 30",
        false,
    );
    let mut s = stream(&disc);
    let ack = subscribe_with(&mut s, &pane, 100, 30, false);
    assert_eq!(
        ack,
        serde_json::json!({"for": Kind::Subscribe as u8, "ok": true, "resized": true})
    );
    read_until(&mut s, |t| t.contains("ready"));
    write_frame(&mut s, Kind::Input, b"abc\r").unwrap();
    let (k, v) = next_reply(&mut s);
    assert_eq!(
        (k, v),
        (
            Kind::Ack,
            serde_json::json!({"for": Kind::Input as u8, "ok": true})
        )
    );
    read_until(&mut s, |t| t.contains("got-abc"));
    write_frame(&mut s, Kind::Paste, b"xyz\n").unwrap();
    let (k, v) = next_reply(&mut s);
    assert_eq!(
        (k, v),
        (
            Kind::Ack,
            serde_json::json!({"for": Kind::Paste as u8, "ok": true})
        )
    );
    let (_, text) = read_until(&mut s, |t| t.contains("pasted-xyz"));
    assert!(text.contains("pasted-xyz"), "{text}");
    let snap = snapshot(&mut s, 3);
    assert_eq!(
        (snap["meta"]["cols"].clone(), snap["meta"]["rows"].clone()),
        (serde_json::json!(100), serde_json::json!(30))
    );
    assert!(
        snap["capture"].as_str().unwrap().contains("got-abc"),
        "{snap}"
    );
}

#[test]
fn resize_is_acked_once_applied() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create_with(
        &mut w,
        &mut r,
        "trap 'echo size-$(stty size | tr \" \" x)' WINCH; echo ready; while :; do sleep 0.1; done",
        WATCH_SIZE,
        false,
    );
    let mut s = stream(&disc);
    subscribe(&mut s, &pane);
    read_until(&mut s, |t| t.contains("ready"));
    let before = snapshot(&mut s, 1)["seq"].as_u64().unwrap();
    write_frame(&mut s, Kind::Resize, br#"{"cols":100,"rows":40}"#).unwrap();
    let (k, ack) = next_reply(&mut s);
    assert_eq!(k, Kind::Ack);
    assert_eq!(
        (ack["for"].clone(), ack["ok"].clone()),
        (
            serde_json::json!(Kind::Resize as u8),
            serde_json::json!(true)
        )
    );
    // The ack names the last output before the resize: later outputs were drawn at the new size.
    let at = ack["seq"].as_u64().unwrap();
    assert!(at >= before, "{ack}");
    let snap = snapshot(&mut s, 2);
    assert_eq!(
        (snap["meta"]["cols"].clone(), snap["meta"]["rows"].clone()),
        (serde_json::json!(100), serde_json::json!(40))
    );
    assert!(snap["seq"].as_u64().unwrap() >= at);
    // The child is told as well.
    let (_, text) = read_until(&mut s, |t| t.contains("size-40x100"));
    assert!(text.contains("size-40x100"), "{text}");
}

#[test]
fn same_size_subscribe_and_resize_change_nothing_and_say_so() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create_with(
        &mut w,
        &mut r,
        "trap 'echo size-$(stty size | tr \" \" x)' WINCH; echo ready; while :; do sleep 0.1; done",
        WATCH_SIZE,
        false,
    );
    let mut s = stream(&disc);
    // Created 80x24: subscribing at that size resizes nothing.
    let ack = subscribe_with(&mut s, &pane, 80, 24, false);
    assert_eq!(
        ack,
        serde_json::json!({"for": Kind::Subscribe as u8, "ok": true, "resized": false})
    );
    read_until(&mut s, |t| t.contains("ready"));
    write_frame(&mut s, Kind::Resize, br#"{"cols":80,"rows":24}"#).unwrap();
    let (k, ack) = next_reply(&mut s);
    assert_eq!(k, Kind::Ack);
    assert_eq!(
        (
            ack["for"].clone(),
            ack["ok"].clone(),
            ack["resized"].clone()
        ),
        (
            serde_json::json!(Kind::Resize as u8),
            serde_json::json!(true),
            serde_json::json!(false)
        )
    );
    assert!(ack["seq"].is_u64(), "{ack}");
    // The child is not told of a size it already has: no SIGWINCH, so nothing printed.
    s.set_read_timeout(Some(Duration::from_millis(600)))
        .unwrap();
    let (_, quiet) = read_until(&mut s, |_| false);
    assert!(!quiet.contains("size-"), "{quiet}");
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write_frame(&mut s, Kind::Resize, br#"{"cols":90,"rows":20}"#).unwrap();
    let (frames, text) = read_until(&mut s, |t| t.contains("size-20x90"));
    let acks: Vec<_> = frames
        .iter()
        .filter(|(k, _)| *k == Kind::Ack)
        .map(|(_, p)| json(p))
        .collect();
    assert_eq!(acks.len(), 1, "{acks:?}");
    assert_eq!(acks[0]["resized"], true, "{acks:?}");
    assert!(text.contains("size-20x90"), "{text}");
}

#[test]
fn pause_holds_output_until_resume() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create_with(
        &mut w,
        &mut r,
        "stty -echo; echo ready; read x; i=1; while [ $i -le 50 ]; do echo out-$i; i=$((i+1)); done; sleep 30",
        r#"echo ready; $x = Read-Host; 1..50 | % { "out-$_" }; Start-Sleep 30"#,
        false,
    );
    let mut s = stream(&disc);
    subscribe(&mut s, &pane);
    read_until(&mut s, |t| t.contains("ready\r\n"));
    write_frame(&mut s, Kind::Pause, b"").unwrap();
    write_frame(&mut s, Kind::Input, b"go\r").unwrap();
    // Replies still come while paused; output does not.
    let (k, payload) = read_frame(&mut s).unwrap().unwrap();
    assert_eq!(
        (k, json(&payload)["ok"].clone()),
        (Kind::Ack, serde_json::json!(true))
    );
    wait_capture(&mut w, &mut r, &pane, "out-50");
    s.set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    let held = read_frame(&mut s);
    assert!(held.is_err(), "paused, yet got {held:?}");
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write_frame(&mut s, Kind::Resume, b"").unwrap();
    let (frames, text) = read_until(&mut s, |t| t.contains("out-50"));
    let seqs: Vec<u64> = frames
        .iter()
        .filter(|(k, _)| *k == Kind::Output)
        .map(|(_, p)| seq_of(p))
        .collect();
    assert!(seqs.windows(2).all(|p| p[1] == p[0] + 1), "{seqs:?}");
    // Every line is there, in order. The bundled ConPTY (OpenConsole) holds the last line's line end
    // back until it next draws (here, never: the script sleeps), so `out-50` may come without it.
    let positions: Vec<usize> = (1..=50)
        .map(|i| {
            let line = if i == 50 && common::bundled_conpty() {
                format!("out-{i}")
            } else {
                format!("out-{i}\r")
            };
            text.find(&line)
                .unwrap_or_else(|| panic!("out-{i}: {text}"))
        })
        .collect();
    assert!(positions.windows(2).all(|p| p[0] < p[1]), "{text}");
}

#[test]
fn two_subscribers_get_the_same_outputs() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create_with(
        &mut w,
        &mut r,
        "sleep 0.5; i=1; while [ $i -le 100 ]; do echo line-$i; i=$((i+1)); done; sleep 30",
        r#"Start-Sleep -Milliseconds 500; 1..100 | % { "line-$_" }; Start-Sleep 30"#,
        false,
    );
    let mut a = stream(&disc);
    subscribe(&mut a, &pane);
    let mut b = stream(&disc);
    let ack = subscribe_with(&mut b, &pane, 80, 24, true);
    assert_eq!(ack["ok"], true);
    let outputs = |s: &mut Conn| -> Vec<(u64, Vec<u8>)> {
        let (frames, text) = read_until(s, |t| t.contains("line-100\r"));
        assert!(text.contains("line-100"), "{text}");
        frames
            .into_iter()
            .filter(|(k, _)| *k == Kind::Output)
            .map(|(_, p)| (seq_of(&p), p[8..].to_vec()))
            .collect()
    };
    let (from_a, from_b) = (outputs(&mut a), outputs(&mut b));
    assert!(!from_a.is_empty());
    assert_eq!(from_a, from_b);
}

#[test]
fn frames_before_subscribe_are_refused() {
    let (_h, disc) = start();
    let mut s = stream(&disc);
    write_frame(&mut s, Kind::Input, b"x").unwrap();
    let (k, v) = next_reply(&mut s);
    assert_eq!(
        (k, v),
        (
            Kind::Ack,
            serde_json::json!({"for": Kind::Input as u8, "ok": false, "reason": "not_subscribed"})
        )
    );
    write_frame(&mut s, Kind::Snapshot, br#"{"id":5,"history":"none"}"#).unwrap();
    let (k, v) = next_reply(&mut s);
    assert_eq!(
        (k, v),
        (
            Kind::SnapshotReply,
            serde_json::json!({"id": 5, "ok": false, "reason": "not_subscribed"})
        )
    );
}

#[test]
fn conversation_snapshots_carry_the_joined_history() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let command = if cfg!(windows) {
        serde_json::json!([
            "cmd.exe",
            "/d",
            "/c",
            "ping -n 2 127.0.0.1 >nul& echo h1& echo CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC& echo s2& echo s3& echo s4& echo s5& <nul set /p =s6& ping -n 30 127.0.0.1 >nul"
        ])
    } else {
        serde_json::json!([
            "/bin/sh",
            "-c",
            "sleep 0.3; printf 'h1\\nCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\\ns2\\ns3\\ns4\\ns5\\ns6'; sleep 30"
        ])
    };
    let req = serde_json::json!({"id": 1, "op": "create", "command": command,
        "cols": 20, "rows": 6, "owner": "t", "hold": false});
    let pane = call(&mut w, &mut r, &req.to_string())["pane"]
        .as_str()
        .unwrap()
        .to_string();
    let mut s = stream(&disc);
    assert_eq!(subscribe_with(&mut s, &pane, 20, 6, false)["ok"], true);
    read_until(&mut s, |t| t.contains("s6"));
    let ask = |s: &mut Conn, id: u64, history: &str| {
        let req = serde_json::json!({"id": id, "history": history, "historyLines": 100});
        write_frame(s, Kind::Snapshot, req.to_string().as_bytes()).unwrap();
        loop {
            let (kind, v) = next_reply(s);
            if kind == Kind::SnapshotReply {
                return v;
            }
        }
    };
    let v = ask(&mut s, 1, "conversation");
    // The inbox ConPTY starts with `ESC[2J` on the empty screen, and the grid's clear scrolls the
    // cursor's (blank) row into the history: there the history starts with it. The bundled one
    // (OpenConsole) sends no such clear, and its history starts as on Unix.
    let lead = if cfg!(windows) && !common::bundled_conpty() {
        "\n"
    } else {
        ""
    };
    // Rows: the wrapped line's first row is the history's last line, its second the screen's first.
    assert_eq!(v["history"], format!("{lead}h1\nCCCCCCCCCCCCCCCCCCCC\n"));
    assert_eq!(v["capture"], "CCCCCCCCCC\ns2\ns3\ns4\ns5\ns6\n");
    assert_eq!(
        v["historyJoined"],
        format!("{lead}h1\nCCCCCCCCCCCCCCCCCCCC\n")
    );
    assert_eq!(v["lastContinues"], true);
    let v = ask(&mut s, 2, "plain");
    assert_eq!(v["history"], format!("{lead}h1\nCCCCCCCCCCCCCCCCCCCC\n"));
    assert!(
        v.get("historyJoined").is_none() && v.get("lastContinues").is_none(),
        "{v}"
    );
}

/// `create` with an optional seed, `rows` high.
fn create_seeded(
    w: &mut Conn,
    r: &mut BufReader<Conn>,
    seed: Option<&str>,
    rows: u16,
    unix: &str,
    windows: &str,
) -> String {
    let mut req = serde_json::json!({"id": 1, "op": "create", "command": script(unix, windows), "cols": 80, "rows": rows, "owner": "t", "hold": false});
    if let Some(seed) = seed {
        req["seed"] = serde_json::json!(seed);
    }
    let created = call(w, r, &req.to_string());
    created["pane"].as_str().unwrap().to_string()
}

fn history_snapshot(s: &mut Conn, id: u64) -> serde_json::Value {
    let req = serde_json::json!({"id": id, "history": "plain", "historyLines": 50});
    write_frame(s, Kind::Snapshot, req.to_string().as_bytes()).unwrap();
    loop {
        let (kind, v) = next_reply(s);
        if kind == Kind::SnapshotReply {
            return v;
        }
    }
}

#[test]
fn a_seeded_pane_starts_with_its_seed_in_history() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create_seeded(
        &mut w,
        &mut r,
        Some("one\r\ntwo\r\n\x1b[31mthree\x1b[0m"),
        10,
        "sleep 1.5; echo ready; sleep 5",
        r#"Start-Sleep -Milliseconds 1500; "ready"; Start-Sleep 5"#,
    );
    let mut s = stream(&disc);
    subscribe_with(&mut s, &pane, 80, 10, false);
    // Before the child prints anything.
    let v = history_snapshot(&mut s, 1);
    let history = v["history"].as_str().unwrap();
    let (one, two, three) = (
        history.find("one").expect(history),
        history.find("two").expect(history),
        history.find("three").expect(history),
    );
    assert!(one < two && two < three, "{history:?}");
    assert!(history.contains("\x1b[31m"), "colour kept: {history:?}");
    assert!(v["capture"].as_str().unwrap().trim().is_empty(), "{v}");
    assert_eq!(v["meta"]["cursor_x"], 0, "{v}");
    assert_eq!(v["meta"]["cursor_y"], 0, "{v}");
    // The child draws from the top of the screen.
    wait_capture(&mut w, &mut r, &pane, "ready");
    let cap = call(
        &mut w,
        &mut r,
        &serde_json::json!({"id": 9, "op": "capture", "pane": pane, "ansi": false, "visible": true}).to_string(),
    );
    assert!(cap["text"].as_str().unwrap().starts_with("ready"), "{cap}");
}

#[test]
fn a_create_without_seed_is_unchanged() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create_seeded(
        &mut w,
        &mut r,
        None,
        10,
        "sleep 1.5; echo ready; sleep 5",
        r#"Start-Sleep -Milliseconds 1500; "ready"; Start-Sleep 5"#,
    );
    let mut s = stream(&disc);
    subscribe_with(&mut s, &pane, 80, 10, false);
    let v = history_snapshot(&mut s, 1);
    assert_eq!(v["history"], "", "{v}");
    assert!(v["capture"].as_str().unwrap().trim().is_empty(), "{v}");
    wait_capture(&mut w, &mut r, &pane, "ready");
}

#[test]
fn a_history_style_seed_has_no_staircase_and_no_extra_blank_row() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create_seeded(
        &mut w,
        &mut r,
        Some("one\ntwo\n\x1b[31mthree\x1b[0m\n"),
        10,
        "sleep 5",
        "Start-Sleep 5",
    );
    let mut s = stream(&disc);
    subscribe_with(&mut s, &pane, 80, 10, false);
    let v = history_snapshot(&mut s, 1);
    let lines: Vec<&str> = v["history"].as_str().unwrap().lines().collect();
    assert_eq!(lines.len(), 3, "{lines:?}");
    assert!(lines[0].starts_with("one"), "{lines:?}");
    assert!(lines[1].starts_with("two"), "{lines:?}");
    assert!(lines[2].starts_with("\x1b[31mthree"), "{lines:?}");
}

#[test]
fn a_seed_that_ends_with_a_colour_on_leaves_the_screen_default() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let pane = create_seeded(&mut w, &mut r, Some("red\n\x1b[41m"), 10, "sleep 5", "Start-Sleep 5");
    let mut s = stream(&disc);
    subscribe_with(&mut s, &pane, 80, 10, false);
    let v = history_snapshot(&mut s, 1);
    let capture = v["capture"].as_str().unwrap();
    assert!(!capture.contains('\x1b') && capture.trim().is_empty(), "{capture:?}");
    assert!(v["history"].as_str().unwrap().starts_with("red"), "{v}");
}
