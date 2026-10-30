//! Windows: the CLI that `harness-launch` starts inherits none of its caller's handles. An SSH session's output, or the
//! pipe a PowerShell pipeline reads `harness start` through, went from the CLI to the master, its core and the terminal
//! host, and the caller waited on it for as long as the daemon ran (B3.15, on the VM).
//!
//! A test binary of its own, with one test: it holds an inheritable pipe open while it starts the launcher, and any
//! other test of the same binary starting a process at that moment (they run on parallel threads) would inherit the
//! pipe as well, and hold it.
#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, TRUE};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::ReadFile;
use windows_sys::Win32::System::Pipes::CreatePipe;

const LAUNCH: &str = env!("CARGO_BIN_EXE_harness-launch");

/// The fake CLI says it started, then stays up for four seconds, as a daemon would for longer.
const CLI_JS: &str = "require('node:fs').writeFileSync(process.env.HARNESS_LAUNCH_TEST_OUT, 'started')\n\
setTimeout(() => {}, 4000)\n";

/// $NODE, or the first node.exe on PATH; as in harness_launch.rs, a missing one fails only under CI.
fn node() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("NODE").map(PathBuf::from).filter(|path| path.is_file()) {
        return Some(path);
    }
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join("node.exe")).find(|path| path.is_file())
}

/// An install under `root` whose Node is a hard link to the real one (or a copy) inside runtime\.
fn install(root: &Path, node: &Path) {
    let node = fs::canonicalize(node).unwrap();
    let dir = root.join("runtime").join("node-test");
    fs::create_dir_all(&dir).unwrap();
    let linked = dir.join("node.exe");
    if fs::hard_link(&node, &linked).is_err() {
        fs::copy(&node, &linked).unwrap();
    }
    fs::write(root.join("runtime").join("current-node"), format!("{}\r\n", linked.display())).unwrap();
    let cli = root.join("cli").join("1.2.3");
    fs::create_dir_all(&cli).unwrap();
    fs::write(cli.join("cli.js"), CLI_JS).unwrap();
    fs::write(root.join("cli").join("current"), "1.2.3\r\n").unwrap();
}

#[test]
fn the_cli_inherits_none_of_the_callers_handles() {
    let Some(node) = node() else {
        assert!(std::env::var_os("CI").is_none(), "no node on PATH, and CI is set: the runner must have one");
        eprintln!("skipped: no node on PATH");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    install(root, &node);
    let out = root.join("started.txt");

    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: TRUE,
    };
    let (mut read, mut write): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
    assert_ne!(unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) }, 0);
    // `Command` hands the launcher every inheritable handle of this process, the pipe's write end among them, as the
    // CLI's own spawn (libuv) hands it whatever an SSH session or a PowerShell pipeline gave the CLI.
    let status = Command::new(LAUNCH)
        .arg("--root")
        .arg(root)
        .args(["--", "start"])
        .env("HARNESS_LAUNCH_TEST_OUT", &out)
        .status()
        .unwrap();
    assert!(status.success(), "{status:?}");
    let deadline = Instant::now() + Duration::from_secs(20);
    while !out.is_file() {
        assert!(Instant::now() < deadline, "the CLI never ran");
        std::thread::sleep(Duration::from_millis(50));
    }

    // With this process's write end closed, the read ends at once, unless the CLI holds a copy: then not before it
    // exits, four seconds on.
    unsafe { CloseHandle(write) };
    let started = Instant::now();
    let mut byte = 0u8;
    let mut got = 0u32;
    let ok = unsafe { ReadFile(read, (&mut byte as *mut u8).cast(), 1, &mut got, std::ptr::null_mut()) };
    let waited = started.elapsed();
    unsafe { CloseHandle(read) };
    assert_eq!((ok, got), (0, 0), "the pipe ends with no data");
    assert!(waited < Duration::from_millis(1_500), "the CLI held the caller's pipe for {waited:?}");
}
