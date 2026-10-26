mod common;
#[cfg(windows)]
use common::Connection;
use common::{
    ENTER, WAIT, call, connect, dial, hello, host_command, script, shell, start, wait_discovery,
};
use std::io::{BufRead, BufReader, Write};
use std::time::{Duration, Instant};

use harness_pty::protocol::PROTOCOL;

#[test]
fn rejects_bad_token() {
    let (_h, disc) = start();
    let mut s = dial(&disc);
    s.set_read_timeout(Some(WAIT)).unwrap();
    writeln!(s, "{}", hello("nope", "control")).unwrap();
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).unwrap();
    assert!(line.contains(r#""code":"incompatible""#), "{line}");
}

#[test]
fn rejects_other_protocol() {
    let (_h, disc) = start();
    let mut s = dial(&disc);
    s.set_read_timeout(Some(WAIT)).unwrap();
    let token = disc["token"].as_str().unwrap();
    let auth = harness_pty::protocol::hello_auth(token, common::NONCE);
    writeln!(s, "{}", common::hello_with(&auth, "control", PROTOCOL + 1)).unwrap();
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    assert!(line.contains(r#""code":"incompatible""#), "{line}");
    // …and the host closes the connection.
    line.clear();
    assert_eq!(r.read_line(&mut line).unwrap(), 0, "{line}");
}

#[test]
fn a_hello_needs_the_auth_not_the_token_and_a_reflected_proof_is_refused() {
    let (_h, disc) = start();
    let token = disc["token"].as_str().unwrap();
    let refused = |hello: String| {
        let mut s = dial(&disc);
        s.set_read_timeout(Some(WAIT)).unwrap();
        writeln!(s, "{hello}").unwrap();
        let mut r = BufReader::new(s);
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        assert!(line.contains(r#""code":"incompatible""#), "{line}");
        line.clear();
        assert_eq!(r.read_line(&mut line).unwrap(), 0, "{line}");
    };
    // The token itself, as an auth or as the old hello's field.
    refused(common::hello_with(token, "control", PROTOCOL));
    refused(format!(
        r#"{{"hello":{{"token":"{token}","protocol":{PROTOCOL},"role":"control","clientId":"t"}}}}"#
    ));
    // The host's own proof for this nonce, sent back as the auth.
    let proof = harness_pty::protocol::hello_proof(token, common::NONCE);
    refused(common::hello_with(&proof, "control", PROTOCOL));
    // The real auth still works.
    let (mut w, mut r) = connect(&disc);
    assert_eq!(
        call(&mut w, &mut r, r#"{"id":1,"op":"titles"}"#)["ok"],
        true
    );
}

#[test]
fn discovery_names_the_host() {
    let (mut h, disc) = start();
    assert_eq!(disc["protocol"], PROTOCOL);
    assert_eq!(disc["instance"], harness_pty::instance::current());
    assert_eq!(disc["version"], env!("CARGO_PKG_VERSION"));
    if disc["pid"] != h.child.id() {
        // On Windows a host started inside a job serves from a copy of itself started outside it;
        // the one started exits at once, with success.
        if !cfg!(windows) {
            panic!("{disc} is not the child {}", h.child.id());
        }
        assert!(h.child.wait().unwrap().success());
    }
    let endpoint = disc["endpoint"].as_str().unwrap().to_owned();
    #[cfg(unix)]
    {
        use common::discovery_file;
        use std::os::unix::fs::PermissionsExt;
        let endpoint = std::path::Path::new(&endpoint);
        assert_eq!(
            endpoint,
            harness_pty::instance::socket_path(
                &h.home.path().join("run"),
                &harness_pty::instance::current()
            )
        );
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&discovery_file(h.home.path())), 0o600);
        assert_eq!(mode(endpoint), 0o600);
    }
    #[cfg(windows)]
    {
        // `\\.\pipe\harness-pty-<16 hex of the user and home>-<16 random hex>-<instance>`.
        let parts: Vec<&str> = endpoint
            .strip_prefix(r"\\.\pipe\harness-pty-")
            .and_then(|rest| rest.strip_suffix(&format!("-{}", harness_pty::instance::current())))
            .unwrap_or_else(|| panic!("{endpoint}"))
            .split('-')
            .collect();
        assert_eq!(parts.len(), 2, "{endpoint}");
        for part in parts {
            assert!(
                part.len() == 16
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
                "{endpoint}"
            );
        }
    }
    // The hello reply names the same host.
    let s = dial(&disc);
    s.set_read_timeout(Some(WAIT)).unwrap();
    let mut w = s.try_clone().unwrap();
    writeln!(w, "{}", hello(disc["token"].as_str().unwrap(), "control")).unwrap();
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).unwrap();
    let v: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["hello"]["instance"], harness_pty::instance::current());
    assert_eq!(v["hello"]["pid"], disc["pid"]);
    // A pre-G host sends no `features`; a client reads that as none.
    assert_eq!(v["hello"]["features"], serde_json::json!(["seed"]));
}

/// `data` as the `write` op carries it.
fn b64(data: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[cfg(windows)]
#[test]
fn ctrl_c_interrupts_a_pane_when_the_host_starts_in_a_new_process_group() {
    use common::Host;
    use harness_pty::breakaway::{CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};
    use std::os::windows::process::CommandExt;

    let home = tempfile::tempdir().unwrap();
    let child = host_command(home.path())
        .arg("--no-reexec")
        .creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS)
        .spawn()
        .unwrap();
    let disc = wait_discovery(home.path());
    let _host = Host {
        pid: disc["pid"].as_u64().unwrap() as u32,
        child,
        home,
    };
    let (mut w, mut r) = connect(&disc);
    let created = call(
        &mut w,
        &mut r,
        &serde_json::json!({"id": 1, "op": "create", "command": ["powershell.exe", "-NoLogo", "-NoProfile"], "cols": 100, "rows": 30, "owner": "ctrl-c-test", "hold": true}).to_string(),
    );
    let pane = created["pane"].as_str().unwrap();
    let write = |w: &mut common::Conn, r: &mut BufReader<common::Conn>, id: u64, text: &str| {
        call(
            w,
            r,
            &serde_json::json!({"id": id, "op": "write", "pane": pane, "data": b64(text)})
                .to_string(),
        )
    };
    assert_eq!(write(&mut w, &mut r, 2, "ping -t 127.0.0.1\r")["ok"], true);
    let capture = |w: &mut common::Conn, r: &mut BufReader<common::Conn>| {
        call(
            w,
            r,
            &serde_json::json!({"id": 4, "op": "capture", "pane": pane, "ansi": false, "visible": true}).to_string(),
        )["text"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let start = Instant::now();
    while !capture(&mut w, &mut r).contains("Reply from 127.0.0.1") {
        assert!(start.elapsed() < WAIT, "ping did not start");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(write(&mut w, &mut r, 3, "\u{3}")["ok"], true);
    let start = Instant::now();
    loop {
        let screen = capture(&mut w, &mut r);
        if screen
            .lines()
            .any(|line| line.starts_with("PS ") && line.trim_end().ends_with('>'))
        {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "Ctrl+C did not return to the shell: {screen}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn create_capture_kill() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let created = call(
        &mut w,
        &mut r,
        &serde_json::json!({"id": 1, "op": "create", "command": shell(), "cols": 80, "rows": 24, "owner": "t", "hold": false}).to_string(),
    );
    let pane = created["pane"].as_str().unwrap().to_string();
    assert!(pane.starts_with('%'));
    // The shell works the number out: "hi-42" is in its output, not in what was typed.
    let typed = if cfg!(windows) {
        "set /a x=40+2 >nul\recho hi-%x%\r".to_owned()
    } else {
        format!("echo hi-$((40+2)){ENTER}")
    };
    call(
        &mut w,
        &mut r,
        &format!(
            r#"{{"id":2,"op":"write","pane":"{pane}","data":"{}"}}"#,
            b64(&typed)
        ),
    );
    let end = Instant::now() + WAIT;
    loop {
        let cap = call(
            &mut w,
            &mut r,
            &format!(r#"{{"id":3,"op":"capture","pane":"{pane}","ansi":false,"visible":true}}"#),
        );
        if cap["text"].as_str().unwrap().contains("hi-42") {
            break;
        }
        assert!(Instant::now() < end, "no output: {cap}");
        std::thread::sleep(Duration::from_millis(50));
    }
    call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":4,"op":"kill","pane":"{pane}","graceMs":200}}"#),
    );
    let end = Instant::now() + WAIT;
    loop {
        let st = call(
            &mut w,
            &mut r,
            &format!(r#"{{"id":5,"op":"paneState","pane":"{pane}"}}"#),
        );
        if st["state"] == "gone" {
            break;
        }
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A drained host (cli/src/lib/ptyHost/drain.ts): `shutdown` is refused while the host has a pane,
/// and once it has none the host replies, takes its discovery file down and exits.
#[test]
fn shutdown_exits_a_host_with_no_panes_and_takes_its_discovery_file_down() {
    let (mut h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let created = call(
        &mut w,
        &mut r,
        &serde_json::json!({"id": 1, "op": "create", "command": shell(), "cols": 80, "rows": 24, "owner": "t", "hold": true}).to_string(),
    );
    let pane = created["pane"].as_str().unwrap().to_string();
    let refused = call(&mut w, &mut r, r#"{"id":2,"op":"shutdown"}"#);
    assert_eq!(refused["code"], "bad_request", "{refused}");
    assert!(
        refused["reason"]
            .as_str()
            .unwrap()
            .contains("host still has panes"),
        "{refused}"
    );
    call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":3,"op":"kill","pane":"{pane}","graceMs":0}}"#),
    );
    let granted = call(&mut w, &mut r, r#"{"id":4,"op":"shutdown"}"#);
    assert_eq!(granted, serde_json::json!({"id": 4, "ok": true}));
    // The host ends the connection, and the endpoint, as it exits.
    let mut line = String::new();
    let end = Instant::now() + WAIT;
    loop {
        line.clear();
        match r.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            // An exit notice for the killed pane may come first.
            Ok(_) => assert!(Instant::now() < end, "still open: {line}"),
        }
    }
    assert!(!common::discovery_file(h.home.path()).exists());
    let end = Instant::now() + WAIT;
    while common::open(disc["endpoint"].as_str().unwrap()).is_ok() {
        assert!(Instant::now() < end, "the endpoint still answers");
        std::thread::sleep(Duration::from_millis(20));
    }
    #[cfg(unix)]
    {
        assert!(h.child.wait().unwrap().success());
        assert!(!std::path::Path::new(disc["endpoint"].as_str().unwrap()).exists());
    }
    #[cfg(windows)]
    let _ = &mut h;
}

#[test]
fn second_host_exits_cleanly() {
    let (h, disc) = start();
    let status = host_command(h.home.path()).status().unwrap();
    assert!(status.success());
    // The first host still serves, and is the one the discovery file names.
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(wait_discovery(h.home.path()), disc);
    let (mut w, mut r) = connect(&disc);
    assert_eq!(
        call(&mut w, &mut r, r#"{"id":1,"op":"titles"}"#)["ok"],
        true
    );
}

/// The pane counter's ceiling: how many ids the hosts of a home have reserved.
fn reserved(home: &std::path::Path) -> String {
    std::fs::read_to_string(harness_pty::instance::run_file(
        &home.join("run"),
        &harness_pty::instance::current(),
        "panes",
    ))
    .unwrap()
}

#[test]
fn hosts_started_together_serve_once() {
    let home = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        // A socket file nobody answers on, as a crashed host leaves it: every host replaces it, and
        // without the run directory's lock two of them could each bind one and serve the same home.
        let run = home.path().join("run");
        std::fs::create_dir_all(&run).unwrap();
        drop(
            std::os::unix::net::UnixListener::bind(harness_pty::instance::socket_path(
                &run,
                &harness_pty::instance::current(),
            ))
            .unwrap(),
        );
    }
    let mut children: Vec<_> = (0..8)
        .map(|_| host_command(home.path()).spawn().unwrap())
        .collect();
    let disc = wait_discovery(home.path());
    let serving = disc["pid"].as_u64().unwrap() as u32;
    let _guard = scopeguard(serving);
    // Every other start exits, with success.
    let end = Instant::now() + WAIT;
    for child in &mut children {
        if child.id() == serving {
            continue;
        }
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < end, "a second host is still running");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(status.success(), "{status}");
    }
    // One host reserved one block of pane ids, and it is the one that answers.
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        reserved(home.path()),
        format!("{}\n", harness_pty::pane_ids::BLOCK)
    );
    let (mut w, mut r) = connect(&disc);
    assert_eq!(
        call(&mut w, &mut r, r#"{"id":1,"op":"titles"}"#)["ok"],
        true
    );
    assert_eq!(wait_discovery(home.path()), disc);
    for mut child in children {
        let _ = child.kill();
        let _ = child.wait();
    }
}

// Unix only: the race this stands for (two hosts each replacing the other's socket file) needs a
// socket file that can be removed; a pipe name cannot be taken while its first instance lives.
#[cfg(unix)]
#[test]
fn a_host_that_lost_its_socket_file_still_owns_its_home() {
    // What two hosts starting together on a stale socket could do: the second removes the
    // first's socket file (taking it for the stale one) and binds its own.
    let (h, disc) = start();
    std::fs::remove_file(disc["endpoint"].as_str().unwrap()).unwrap();
    let mut second = host_command(h.home.path()).spawn().unwrap();
    let end = Instant::now() + WAIT;
    let status = loop {
        if let Some(status) = second.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > end {
            let _ = second.kill();
            let _ = second.wait();
            panic!("the second host serves the same home");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "{status}");
    // The second host did not serve: one block of ids reserved, and the file names the first.
    assert_eq!(
        reserved(h.home.path()),
        format!("{}\n", harness_pty::pane_ids::BLOCK)
    );
    assert_eq!(wait_discovery(h.home.path()), disc);
}

// Unix only: a Windows host draws a new random pipe name each start (no squatter can know it), as
// `a_pipe_name_is_new_each_start_and_a_squatter_on_an_old_one_is_passed_by` shows.
#[cfg(unix)]
#[test]
fn a_squatter_on_the_endpoint_fails_the_start_and_the_discovery_file_is_set_aside() {
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    std::fs::create_dir_all(&run).unwrap();
    // A dead host's discovery file, naming the endpoint.
    let file = harness_pty::instance::run_file(&run, &harness_pty::instance::current(), "json");
    std::fs::write(&file, r#"{"stale":true}"#).unwrap();
    // Another process has the endpoint while no host holds the home's lock.
    let _squatter = std::os::unix::net::UnixListener::bind(harness_pty::instance::socket_path(
        &run,
        &harness_pty::instance::current(),
    ))
    .unwrap();
    // `--no-reexec`: the status is this host's own, not that of a first host that started it.
    let out = host_command(home.path())
        .arg("--no-reexec")
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "{stderr}");
    assert!(stderr.contains("held by another process"), "{stderr}");
    assert!(!file.exists());
    let mut aside = file.into_os_string();
    aside.push(".stale");
    assert_eq!(
        std::fs::read_to_string(&aside).unwrap(),
        r#"{"stale":true}"#
    );
}

#[cfg(windows)]
#[test]
fn a_pipe_name_is_new_each_start_and_a_squatter_on_an_old_one_is_passed_by() {
    use harness_pty::transport::{Bound, windows};
    let (h, first) = start();
    let old = first["endpoint"].as_str().unwrap().to_owned();
    assert!(old.starts_with(r"\\.\pipe\harness-pty-"), "{old}");
    // The host dies; another process takes the name it had, which it learned somehow.
    common::kill_pid(h.pid);
    let end = Instant::now() + WAIT;
    let squatter = loop {
        match windows::bind(&old).unwrap() {
            Bound::Listening(squatter) => break squatter,
            Bound::Taken => {
                assert!(Instant::now() < end, "the dead host's pipe is still there");
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    };
    // The next host of the home serves on a new name, and its discovery file names it.
    let child = host_command(h.home.path()).spawn().unwrap();
    let end = Instant::now() + WAIT;
    let second = loop {
        let disc = wait_discovery(h.home.path());
        if disc["pid"] != first["pid"] {
            break disc;
        }
        assert!(Instant::now() < end, "no new host");
        std::thread::sleep(Duration::from_millis(50));
    };
    let _second = common::Host {
        child,
        home: tempfile::tempdir().unwrap(),
        pid: second["pid"].as_u64().unwrap() as u32,
    };
    let new = second["endpoint"].as_str().unwrap();
    assert_ne!(new, old);
    // Same user and home, and the same instance: only the random part differs. Parsed from the front, and the
    // instance stripped whole: it has dashes of its own (`p2-0.4.31`).
    let suffix = format!("-{}", harness_pty::instance::current());
    let parts = |name: &str| -> (String, String) {
        let rest = name
            .strip_prefix(r"\\.\pipe\harness-pty-")
            .and_then(|rest| rest.strip_suffix(&suffix))
            .unwrap_or_else(|| panic!("{name} does not end in {suffix}"));
        let (home, random) = rest.split_once('-').unwrap_or_else(|| panic!("{name}"));
        (home.to_owned(), random.to_owned())
    };
    let (old_home, old_random) = parts(&old);
    let (new_home, new_random) = parts(new);
    assert_eq!(new_home, old_home, "{old} -> {new}");
    assert_ne!(new_random, old_random, "{old} -> {new}");
    let (mut w, mut r) = connect(&second);
    assert_eq!(
        call(&mut w, &mut r, r#"{"id":1,"op":"titles"}"#)["ok"],
        true
    );
    drop(squatter);
}

/// The log's text once it has [want] (the host writes it as it goes).
fn wait_log(home: &std::path::Path, want: &str) -> String {
    let path = harness_pty::logfile::log_path(home);
    let end = Instant::now() + WAIT;
    loop {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        if text.contains(want) {
            return text;
        }
        assert!(
            Instant::now() < end,
            "no {want:?} in {}: {text}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn the_host_logs_to_its_home_its_start_and_its_errors() {
    let (h, disc) = start();
    let text = wait_log(h.home.path(), "listening as");
    assert!(
        text.contains(&format!(
            "INFO harness_pty::cli: harness-pty {}",
            env!("CARGO_PKG_VERSION")
        )),
        "{text}"
    );
    assert!(text.contains(disc["endpoint"].as_str().unwrap()), "{text}");
    // Never the token.
    assert!(!text.contains(disc["token"].as_str().unwrap()), "{text}");
    // A second start says why it does not serve.
    assert!(host_command(h.home.path()).status().unwrap().success());
    wait_log(h.home.path(), "another host serves this home");

    // A start that fails logs why, as well as printing it.
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("run"), "not a directory").unwrap();
    let out = host_command(home.path())
        .arg("--no-reexec")
        .output()
        .unwrap();
    assert!(!out.status.success());
    let text = wait_log(home.path(), "ERROR harness_pty::cli: harness-pty: ");
    assert!(text.contains("serving"), "{text}");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("ERROR"),
        "{out:?}"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = harness_pty::logfile::log_path(home.path());
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn a_pane_without_a_cwd_starts_in_the_users_home() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let created = call(
        &mut w,
        &mut r,
        &serde_json::json!({"id": 1, "op": "create",
            "command": script(r#"echo "at=$(pwd -P)."; sleep 30"#, r#"echo "at=$((Get-Location).Path)."; Start-Sleep 30"#),
            "cols": 200, "rows": 24, "owner": "t", "hold": false})
        .to_string(),
    );
    let pane = created["pane"].as_str().unwrap().to_string();
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = std::fs::canonicalize(std::env::var_os(var).unwrap()).unwrap();
    let end = Instant::now() + WAIT;
    let at = loop {
        let cap = call(
            &mut w,
            &mut r,
            &format!(r#"{{"id":2,"op":"capture","pane":"{pane}","ansi":false,"visible":true}}"#),
        );
        let text = cap["text"].as_str().unwrap().to_owned();
        if let Some(at) = text.lines().find_map(|l| {
            l.trim()
                .strip_prefix("at=")?
                .strip_suffix('.')
                .map(str::to_owned)
        }) {
            break at;
        }
        assert!(Instant::now() < end, "{cap}");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(std::fs::canonicalize(&at).unwrap(), home, "{at}");
    call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":3,"op":"kill","pane":"{pane}","graceMs":200}}"#),
    );
}

/// Windows: the host's death ends every pane's whole tree (each pane's Job is kill-on-close, and
/// only the host holds it), as a tmux server's crash takes its panes; a shell still starting goes
/// too, which without it outlived the host with its console.
#[cfg(windows)]
#[test]
fn the_hosts_death_ends_every_panes_tree() {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };
    let (h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let create = |w: &mut common::Conn,
                  r: &mut BufReader<common::Conn>,
                  id: u32,
                  command: serde_json::Value| {
        let created = call(
            w,
            r,
            &serde_json::json!({"id": id, "op": "create", "command": command,
            "cols": 80, "rows": 24, "owner": "t", "hold": false})
            .to_string(),
        );
        created["pane"].as_str().unwrap().to_string()
    };
    // A shell with a descendant that has a console of its own, out of the pane's console's reach.
    let pane = create(
        &mut w,
        &mut r,
        1,
        script(
            "",
            "$p = Start-Process -PassThru -WindowStyle Hidden powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep 300'; echo \"child=$($p.Id).\"; Start-Sleep 300",
        ),
    );
    let end = Instant::now() + WAIT;
    let child: u32 = loop {
        let cap = call(
            &mut w,
            &mut r,
            &format!(r#"{{"id":2,"op":"capture","pane":"{pane}","ansi":false,"visible":true}}"#),
        );
        let text = cap["text"].as_str().unwrap().to_owned();
        if let Some(pid) = text
            .split("child=")
            .nth(1)
            .and_then(|t| t.split('.').next())
            .and_then(|t| t.parse().ok())
        {
            break pid;
        }
        assert!(Instant::now() < end, "{cap}");
        std::thread::sleep(Duration::from_millis(50));
    };
    // And a shell the host dies under while it is still starting.
    let starting = create(
        &mut w,
        &mut r,
        3,
        serde_json::json!(["powershell.exe", "-NoLogo", "-NoProfile"]),
    );
    let inv = call(&mut w, &mut r, r#"{"id":4,"op":"inventory"}"#);
    let root_of = |p: &str| {
        inv["panes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["pane"] == p)
            .unwrap()["rootPid"]
            .as_u64()
            .unwrap() as u32
    };
    let pids = [root_of(&pane), child, root_of(&starting)];
    // Handles first, so a reused pid cannot pass for one still running.
    let handles: Vec<_> = pids
        .iter()
        .map(|&pid| {
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            assert!(
                !handle.is_null(),
                "{pid}: {}",
                std::io::Error::last_os_error()
            );
            handle
        })
        .collect();
    common::kill_pid(h.pid);
    for (handle, pid) in handles.into_iter().zip(pids) {
        let waited = unsafe { WaitForSingleObject(handle, WAIT.as_millis() as u32) };
        unsafe { CloseHandle(handle) };
        assert_eq!(waited, WAIT_OBJECT_0, "{pid} outlived the host");
    }
}

/// Kills `pid` when dropped.
fn scopeguard(pid: u32) -> impl Drop {
    struct Kill(u32);
    impl Drop for Kill {
        fn drop(&mut self) {
            common::kill_pid(self.0);
        }
    }
    Kill(pid)
}

// Unix only: a named pipe goes away with its last handle, so Windows has no stale endpoint.
#[cfg(unix)]
#[test]
fn stale_socket_is_replaced() {
    use std::os::unix::net::UnixStream;
    let home = tempfile::tempdir().unwrap();
    let run = home.path().join("run");
    std::fs::create_dir_all(&run).unwrap();
    // A socket file nobody listens on, as a crashed host leaves it.
    let path = harness_pty::instance::socket_path(&run, &harness_pty::instance::current());
    drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
    // A child another test forks just now holds the listener until it execs: wait for refusal.
    let end = Instant::now() + Duration::from_secs(5);
    while UnixStream::connect(&path).is_ok() {
        assert!(Instant::now() < end, "the listener stays open");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(path.exists());
    let mut child = host_command(home.path()).spawn().unwrap();
    wait_discovery(home.path());
    assert!(UnixStream::connect(&path).is_ok());
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn exit_events_reach_every_control_connection() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let (_w2, mut r2) = connect(&disc);
    let created = call(
        &mut w,
        &mut r,
        &serde_json::json!({"id": 1, "op": "create",
            "command": script("sleep 0.3; exit 7", "Start-Sleep -Milliseconds 300; exit 7"),
            "cols": 80, "rows": 24, "owner": "t", "hold": false})
        .to_string(),
    );
    let pane = created["pane"].as_str().unwrap().to_string();
    for reader in [&mut r, &mut r2] {
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let v: serde_json::Value = serde_json::from_str(&line).unwrap();
            if v["event"] == "exit" {
                assert_eq!(v["pane"], pane.as_str());
                assert_eq!(v["status"], 7);
                break;
            }
        }
    }
    // Not held: gone once it exited.
    let st = call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":2,"op":"paneState","pane":"{pane}"}}"#),
    );
    assert_eq!(st["state"], "gone");
}

#[test]
fn held_pane_respawns_with_its_token() {
    // A held shell, as tmux's `heldPaneFormat` knows one: `harness-held` and the token in its start command.
    const TOK: &str = "0b5f9d38-3c1e-4c55-9f1a-1d2e3f4a5b6c";
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let command: Vec<String> = if cfg!(windows) {
        vec![
            "powershell.exe".into(),
            "-NoProfile".into(),
            "-Command".into(),
            format!("echo first; exit 3 # harness-held {TOK}"),
        ]
    } else {
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "echo first; exit 3".into(),
            "harness-held".into(),
            TOK.into(),
        ]
    };
    let created = call(
        &mut w,
        &mut r,
        &serde_json::json!({"id": 1, "op": "create", "command": command, "cols": 80, "rows": 24,
            "owner": "o", "label": "l", "hold": true})
        .to_string(),
    );
    let pane = created["pane"].as_str().unwrap().to_string();
    // Created held; holdOpen holds it again, dead or not.
    let held = call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":2,"op":"holdOpen","pane":"{pane}"}}"#),
    );
    if held["ok"] != true {
        panic!("holdOpen: {held}");
    }
    let end = Instant::now() + WAIT;
    let state = loop {
        let st = call(
            &mut w,
            &mut r,
            &format!(r#"{{"id":3,"op":"paneState","pane":"{pane}"}}"#),
        );
        if st["state"]["dead"] == true {
            break st;
        }
        assert!(Instant::now() < end, "{st}");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(state["state"]["exitStatus"], 3);
    assert_eq!(state["state"]["startCommand"], command.join(" "));
    let inv = call(&mut w, &mut r, r#"{"id":4,"op":"inventory"}"#);
    let row = inv["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["pane"] == pane.as_str())
        .unwrap()
        .clone();
    assert_eq!(row["dead"], true);
    assert_eq!(row["owner"], "o");
    assert!(row["rootPid"].as_u64().is_some(), "{row}");

    let next = script("echo second; sleep 30", "echo second; Start-Sleep 30");
    let wrong = call(
        &mut w,
        &mut r,
        &serde_json::json!({"id": 5, "op": "respawn", "pane": pane, "command": next,
            "expectedHeldToken": "11111111-2222-3333-4444-555555555555"})
        .to_string(),
    );
    assert_eq!(wrong["code"], "held_mismatch", "{wrong}");
    let ok = call(
        &mut w,
        &mut r,
        &serde_json::json!({"id": 6, "op": "respawn", "pane": pane, "command": next,
            "expectedHeldToken": TOK})
        .to_string(),
    );
    assert_eq!(ok["ok"], true, "{ok}");
    // A new ConPTY starts on a cleared screen, so on Windows the old output is in the history.
    let visible = !cfg!(windows);
    let end = Instant::now() + WAIT;
    loop {
        let cap = call(
            &mut w,
            &mut r,
            &serde_json::json!({"id": 7, "op": "capture", "pane": pane, "ansi": false,
                "visible": visible, "historyLines": 100})
            .to_string(),
        );
        let text = cap["text"].as_str().unwrap();
        if text.contains("second") {
            assert!(
                text.contains("first"),
                "the grid survives a respawn: {text:?}"
            );
            break;
        }
        assert!(Instant::now() < end, "{cap}");
        std::thread::sleep(Duration::from_millis(50));
    }
    let st = call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":8,"op":"paneState","pane":"{pane}"}}"#),
    );
    assert_eq!(st["state"]["dead"], false, "{st}");
    // kill removes a held pane (as tmux kill-pane does).
    call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":9,"op":"kill","pane":"{pane}","graceMs":200}}"#),
    );
    let st = call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":10,"op":"paneState","pane":"{pane}"}}"#),
    );
    assert_eq!(st["state"], "gone");
}

#[test]
fn children_see_harness_pane() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let created = call(
        &mut w,
        &mut r,
        &serde_json::json!({"id": 1, "op": "create",
            "command": script(r#"echo "hp=$HARNESS_PANE."; sleep 5"#, r#"echo "hp=$env:HARNESS_PANE."; Start-Sleep 5"#),
            "cols": 80, "rows": 24, "owner": "t", "hold": false})
        .to_string(),
    );
    let pane = created["pane"].as_str().unwrap().to_string();
    let want = format!("hp={}:{pane}.", harness_pty::instance::current());
    let end = Instant::now() + WAIT;
    loop {
        let cap = call(
            &mut w,
            &mut r,
            &format!(r#"{{"id":2,"op":"capture","pane":"{pane}","ansi":false,"visible":true}}"#),
        );
        if cap["text"].as_str().unwrap().contains(&want) {
            break;
        }
        assert!(Instant::now() < end, "no {want:?}: {cap}");
        std::thread::sleep(Duration::from_millis(50));
    }
    call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":3,"op":"kill","pane":"{pane}","graceMs":200}}"#),
    );
}

// Unix only: the child ignores SIGHUP to outlast the grace and dies by SIGKILL (128 + 9). The
// Windows kill (CTRL_CLOSE, then the pane's Job after the grace) is covered by
// `panes::windows_tests`.
#[cfg(unix)]
#[test]
fn kill_does_not_hold_up_the_connection_and_the_exit_still_arrives() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let created = call(
        &mut w,
        &mut r,
        r#"{"id":1,"op":"create","command":["/bin/sh","-c","trap '' HUP; echo ready; while :; do sleep 1; done"],"cols":80,"rows":24,"owner":"t","hold":false}"#,
    );
    let pane = created["pane"].as_str().unwrap().to_string();
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let cap = call(
            &mut w,
            &mut r,
            &format!(r#"{{"id":2,"op":"capture","pane":"{pane}","ansi":false,"visible":true}}"#),
        );
        if cap["text"].as_str().unwrap().contains("ready") {
            break;
        }
        assert!(Instant::now() < end, "{cap}");
        std::thread::sleep(Duration::from_millis(50));
    }
    let start = Instant::now();
    let killed = call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":3,"op":"kill","pane":"{pane}","graceMs":2000}}"#),
    );
    assert_eq!(killed["ok"], true, "{killed}");
    assert!(
        start.elapsed() < Duration::from_millis(500),
        "kill waited out the grace"
    );
    let st = call(
        &mut w,
        &mut r,
        &format!(r#"{{"id":4,"op":"paneState","pane":"{pane}"}}"#),
    );
    assert_eq!(st["state"], "gone");
    assert!(start.elapsed() < Duration::from_millis(500));
    // The shell ignores SIGHUP: SIGKILL after the grace, and its exit is announced.
    loop {
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        if v["event"] == "exit" && v["pane"] == pane.as_str() {
            assert_eq!(v["status"], 128 + 9);
            break;
        }
    }
    let waited = start.elapsed();
    assert!(waited >= Duration::from_millis(2000), "{waited:?}");
}

#[test]
fn bad_requests_get_error_replies() {
    let (_h, disc) = start();
    let (mut w, mut r) = connect(&disc);
    let v = call(&mut w, &mut r, r#"{"id":1,"op":"paneState","pane":"%999"}"#);
    assert_eq!(v["state"], "gone");
    let v = call(
        &mut w,
        &mut r,
        r#"{"id":2,"op":"capture","pane":"%999","ansi":false,"visible":true}"#,
    );
    assert_eq!(
        (v["ok"].clone(), v["code"].clone()),
        (false.into(), "no_pane".into()),
        "{v}"
    );
    let v = call(&mut w, &mut r, r#"{"id":3,"op":"nope"}"#);
    assert_eq!(v["code"], "bad_request", "{v}");
    assert_eq!(v["id"], 3);
    let v = call(
        &mut w,
        &mut r,
        r#"{"id":4,"op":"create","command":["/nonexistent/x"],"cols":80,"rows":24,"owner":"t","hold":false}"#,
    );
    // The spawn itself may succeed (env execs the command): either an error or a pane that exits.
    assert!(v["ok"] == true || v["code"] == "spawn_failed", "{v}");
}

/// Two builds of one protocol serve one home side by side, each with its own discovery file.
/// Runs only when `HARNESS_PTY_BIN_OLD` names a build of this source made with another
/// `HARNESS_PTY_VERSION`; otherwise there is no second build to start. Set, it must name a file: a
/// CI step that builds it in the wrong place must fail here, not pass with nothing tested.
#[test]
fn two_versions_serve_side_by_side() {
    let Some(old) = std::env::var_os("HARNESS_PTY_BIN_OLD") else {
        return;
    };
    assert!(
        std::path::Path::new(&old).is_file(),
        "HARNESS_PTY_BIN_OLD names no file: {}",
        std::path::Path::new(&old).display()
    );
    // The other build says its own version; that, not a guess, names its discovery file.
    let out = std::process::Command::new(&old)
        .arg("version")
        .output()
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let old_instance = harness_pty::instance::instance_name(
        v["protocol"].as_u64().unwrap() as u32,
        v["version"].as_str().unwrap(),
    );
    assert_ne!(old_instance, harness_pty::instance::current());

    let home = tempfile::tempdir().unwrap();
    let mut old_host = std::process::Command::new(&old);
    old_host.args(["serve", "--home"]).arg(home.path());
    let mut old_child = old_host.spawn().unwrap();
    let mut new_child = host_command(home.path()).spawn().unwrap();

    let run = home.path().join("run");
    let read = |instance: &str| -> serde_json::Value {
        let file = harness_pty::instance::run_file(&run, instance, "json");
        let end = Instant::now() + WAIT;
        loop {
            if let Ok(bytes) = std::fs::read(&file)
                && let Ok(disc) = serde_json::from_slice(&bytes)
            {
                return disc;
            }
            assert!(Instant::now() < end, "no discovery file {}", file.display());
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    let old_disc = read(&old_instance);
    let new_disc = read(&harness_pty::instance::current());
    let mut pids = vec![];
    for (disc, instance) in [
        (&old_disc, old_instance.clone()),
        (&new_disc, harness_pty::instance::current()),
    ] {
        let s = dial(disc);
        s.set_read_timeout(Some(WAIT)).unwrap();
        let mut w = s.try_clone().unwrap();
        writeln!(w, "{}", hello(disc["token"].as_str().unwrap(), "control")).unwrap();
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).unwrap();
        let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(reply["hello"]["instance"], instance, "{line}");
        pids.push(disc["pid"].as_u64().unwrap() as u32);
    }
    assert_ne!(old_disc["endpoint"], new_disc["endpoint"]);
    let _ = old_child.kill();
    let _ = new_child.kill();
    let _ = old_child.wait();
    let _ = new_child.wait();
    for pid in pids {
        common::kill_pid(pid);
    }
}
