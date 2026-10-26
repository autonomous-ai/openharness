//! Helpers shared by the integration tests: a host on a temporary home, connections to it on
//! either transport (a Unix socket, a named pipe on Windows), and control calls.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use harness_pty::protocol::PROTOCOL;
pub use harness_pty::transport::Connection;

/// A client connection to the host's endpoint.
#[cfg(unix)]
pub type Conn = std::os::unix::net::UnixStream;
/// A client connection to the host's endpoint: the pipe opened as a file (`OpenOptions`), with
/// overlapped I/O so that a read can time out as a socket's does.
#[cfg(windows)]
pub type Conn = harness_pty::transport::windows::PipeConn;

/// Connect to `endpoint` (a socket path, or a pipe name on Windows).
pub fn open(endpoint: &str) -> std::io::Result<Conn> {
    #[cfg(unix)]
    {
        std::os::unix::net::UnixStream::connect(endpoint)
    }
    #[cfg(windows)]
    {
        harness_pty::transport::windows::connect(endpoint)
    }
}

/// How long a host has to come up, or a pane to show output. Windows children (PowerShell,
/// ConPTY) start much slower than `/bin/sh`.
pub const WAIT: Duration = if cfg!(windows) {
    Duration::from_secs(20)
} else {
    Duration::from_secs(5)
};

pub struct Host {
    pub child: Child,
    pub home: tempfile::TempDir,
    /// The pid serving: the child, or (Windows) the copy of itself it started out of its job.
    pub pid: u32,
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        kill_pid(self.pid);
    }
}

/// End the process `pid`, if it is still there.
pub fn kill_pid(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

pub fn discovery_file(home: &std::path::Path) -> std::path::PathBuf {
    harness_pty::instance::run_file(&home.join("run"), &harness_pty::instance::current(), "json")
}

/// The discovery file of `home` once it is there.
pub fn wait_discovery(home: &std::path::Path) -> serde_json::Value {
    let file = discovery_file(home);
    let end = Instant::now() + WAIT;
    loop {
        if let Ok(bytes) = std::fs::read(&file)
            && let Ok(disc) = serde_json::from_slice(&bytes)
        {
            return disc;
        }
        assert!(Instant::now() < end, "no discovery file");
        std::thread::sleep(Duration::from_millis(20))
    }
}

/// Whether the host under test runs the bundled ConPTY (`conpty.dll` beside it, where
/// `scripts/fetch-conpty.ps1`'s payload goes in a release and in CI) rather than the inbox one. They
/// frame the same output a little differently; the stream tests say where.
pub fn bundled_conpty() -> bool {
    cfg!(windows)
        && std::path::Path::new(env!("CARGO_BIN_EXE_harness-pty"))
            .with_file_name("conpty.dll")
            .exists()
}

pub fn host_command(home: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_harness-pty"));
    command.args(["serve", "--home"]).arg(home);
    command
}

pub fn start() -> (Host, serde_json::Value) {
    let home = tempfile::tempdir().unwrap();
    let child = host_command(home.path()).spawn().unwrap();
    let disc = wait_discovery(home.path());
    let pid = disc["pid"].as_u64().unwrap() as u32;
    (Host { child, home, pid }, disc)
}

/// The nonce every test hello carries.
pub const NONCE: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

/// A hello proving `token` (it never carries the token itself).
pub fn hello(token: &str, role: &str) -> String {
    hello_with(
        &harness_pty::protocol::hello_auth(token, NONCE),
        role,
        PROTOCOL,
    )
}

/// A hello carrying `auth` as it is.
pub fn hello_with(auth: &str, role: &str, protocol: u32) -> String {
    format!(
        r#"{{"hello":{{"auth":"{auth}","nonce":"{NONCE}","protocol":{protocol},"role":"{role}","clientId":"t"}}}}"#
    )
}

/// A raw connection to the endpoint `disc` names, before any hello.
pub fn dial(disc: &serde_json::Value) -> Conn {
    open(disc["endpoint"].as_str().unwrap()).unwrap()
}

pub fn connect(disc: &serde_json::Value) -> (Conn, BufReader<Conn>) {
    let s = dial(disc);
    s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
    let mut w = s.try_clone().unwrap();
    writeln!(w, "{}", hello(disc["token"].as_str().unwrap(), "control")).unwrap();
    let mut r = BufReader::new(s);
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    assert!(line.contains(r#""ok":true"#), "{line}");
    // The host proves it knows the token.
    let reply: serde_json::Value = serde_json::from_str(&line).unwrap();
    let token = disc["token"].as_str().unwrap();
    assert_eq!(
        reply["hello"]["proof"],
        harness_pty::protocol::hello_proof(token, NONCE),
        "{line}"
    );
    (w, r)
}

pub fn call(w: &mut Conn, r: &mut BufReader<Conn>, req: &str) -> serde_json::Value {
    writeln!(w, "{req}").unwrap();
    loop {
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        let v: serde_json::Value =
            serde_json::from_slice(line.as_bytes()).unwrap_or_else(|e| panic!("{e}: {line:?}"));
        if v.get("id").is_some() {
            return v;
        }
    }
}

/// A command line that runs `unix` with `/bin/sh -c`, or `windows` with PowerShell.
pub fn script(unix: &str, windows: &str) -> serde_json::Value {
    if cfg!(windows) {
        serde_json::json!([
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-Command",
            windows
        ])
    } else {
        serde_json::json!(["/bin/sh", "-c", unix])
    }
}

/// An interactive shell: `/bin/sh`, or `cmd.exe` on Windows.
pub fn shell() -> serde_json::Value {
    if cfg!(windows) {
        serde_json::json!(["cmd.exe", "/d"])
    } else {
        serde_json::json!(["/bin/sh"])
    }
}

/// The line ending a pane takes as Enter.
pub const ENTER: &str = if cfg!(windows) { "\r" } else { "\n" };
