//! The real `harness-launch` binary. It starts the CLI the pointers name, with the arguments after `--` and from the
//! install's root, and exits without waiting for it. A broken install exits 3 and says why in launch.log; a command
//! line without `--` exits 2.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const LAUNCH: &str = env!("CARGO_BIN_EXE_harness-launch");

/// The fake CLI writes what it was given, and where it ran, to $HARNESS_LAUNCH_TEST_OUT.
const CLI_JS: &str = "const fs = require('node:fs')\n\
fs.writeFileSync(process.env.HARNESS_LAUNCH_TEST_OUT, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))\n";

/// A Node to run the fake CLI with: $NODE, or the first one on PATH. With none, the test is skipped on a Rust-only
/// machine, and fails when `CI` is set: Windows CI and the VM both have one, so a missing Node there is a broken
/// runner, not a reason to pass.
fn node() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("NODE").map(PathBuf::from).filter(|path| path.is_file()) {
        return Some(path);
    }
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|path| path.is_file())
}

/// An install under `root`. Its Node is a hard link to the real one, or a copy, inside runtime\, as the
/// containment rule requires. The source is resolved first: Homebrew's `node` is a symlink, and a hard link to a
/// symlink would resolve outside runtime\.
fn install(root: &Path, node: &Path) {
    let node = fs::canonicalize(node).unwrap();
    let dir = root.join("runtime").join("node-test");
    fs::create_dir_all(&dir).unwrap();
    let linked = dir.join(node.file_name().unwrap());
    if fs::hard_link(&node, &linked).is_err() {
        fs::copy(&node, &linked).unwrap();
    }
    fs::write(root.join("runtime").join("current-node"), format!("{}\r\n", linked.display())).unwrap();
    let cli = root.join("cli").join("1.2.3");
    fs::create_dir_all(&cli).unwrap();
    fs::write(cli.join("cli.js"), CLI_JS).unwrap();
    fs::write(root.join("cli").join("current"), "1.2.3\r\n").unwrap();
}

/// The fake CLI's report, once it has written all of it.
fn report(out: &Path) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(text) = fs::read_to_string(out)
            && let Ok(value) = serde_json::from_str(&text)
        {
            return value;
        }
        assert!(Instant::now() < deadline, "the CLI never ran");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn starts_the_cli_with_its_arguments_from_the_root_and_returns_at_once() {
    let Some(node) = node() else {
        assert!(std::env::var_os("CI").is_none(), "no node on PATH, and CI is set: the runner must have one");
        eprintln!("skipped: no node on PATH");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    install(root, &node);
    let out = root.join("out.json");
    let started = Instant::now();
    let status = Command::new(LAUNCH)
        .arg("--root")
        .arg(root)
        .args(["--", "start", "--if-down", "two words"])
        .env("HARNESS_LAUNCH_TEST_OUT", &out)
        .status()
        .unwrap();
    assert!(status.success(), "{status:?}");
    // It does not wait for what it started: that is a daemon.
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    let report = report(&out);
    assert_eq!(report["args"], serde_json::json!(["start", "--if-down", "two words"]));
    assert_eq!(
        fs::canonicalize(report["cwd"].as_str().unwrap()).unwrap(),
        fs::canonicalize(root).unwrap()
    );
    let log = fs::read_to_string(root.join("cli").join("data").join("logs").join("launch.log")).unwrap_or_default();
    // The one line allowed is the warning of a job that refuses a breakaway: an SSH session's job is one, and the
    // test then runs inside it. The CLI still started, as the report above shows.
    assert!(log.lines().all(|line| line.contains("refuses a breakaway")), "{log}");
}

#[test]
fn a_broken_install_exits_3_and_says_why_in_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let status = Command::new(LAUNCH).arg("--root").arg(dir.path()).args(["--", "version"]).status().unwrap();
    assert_eq!(status.code(), Some(3));
    let log = fs::read_to_string(dir.path().join("cli").join("data").join("logs").join("launch.log")).unwrap();
    assert!(log.contains("current-node"), "{log}");
}

#[test]
fn a_command_line_without_the_separator_exits_2() {
    let dir = tempfile::tempdir().unwrap();
    let status = Command::new(LAUNCH).arg("--root").arg(dir.path()).arg("version").status().unwrap();
    assert_eq!(status.code(), Some(2));
    assert!(!dir.path().join("cli").exists(), "a usage error is not logged");
}

#[test]
fn a_cli_that_cannot_start_exits_4_and_says_so_in_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    // Both pointers resolve, but the "Node" is an empty file: not executable on Unix, not a program on Windows.
    let runtime = root.join("runtime").join("node-test");
    fs::create_dir_all(&runtime).unwrap();
    let fake = runtime.join(if cfg!(windows) { "node.exe" } else { "node" });
    fs::write(&fake, b"").unwrap();
    fs::write(root.join("runtime").join("current-node"), format!("{}\r\n", fake.display())).unwrap();
    fs::create_dir_all(root.join("cli").join("1.2.3")).unwrap();
    fs::write(root.join("cli").join("1.2.3").join("cli.js"), b"").unwrap();
    fs::write(root.join("cli").join("current"), "1.2.3\r\n").unwrap();
    let status = Command::new(LAUNCH).arg("--root").arg(root).args(["--", "version"]).status().unwrap();
    assert_eq!(status.code(), Some(4));
    let log = fs::read_to_string(root.join("cli").join("data").join("logs").join("launch.log")).unwrap();
    assert!(log.contains("could not start"), "{log}");
}
