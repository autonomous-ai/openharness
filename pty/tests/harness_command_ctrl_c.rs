//! Windows: Ctrl-C in the console `harness` runs in reaches the CLI, which decides what it means, and `harness`
//! itself stays until the CLI has exited, then exits with its code. A `harness.cmd` asked "Terminate batch job
//! (Y/N)?" instead; a `harness.exe` that ignored Ctrl-C with `SetConsoleCtrlHandler(NULL, TRUE)` would pass that on
//! to node, which then never saw it.
//!
//! The test runs harness.exe in a console of its own, attaches to that console and raises Ctrl-C there. It is the
//! only test in this binary, because it detaches the test process from its own console.
#![cfg(windows)]
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use windows_sys::Win32::System::Console::{AttachConsole, CTRL_C_EVENT, FreeConsole, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler};
use windows_sys::Win32::System::Threading::CREATE_NEW_CONSOLE;

const HARNESS: &str = env!("CARGO_BIN_EXE_harness");

/// The fake CLI says it is ready, then waits for SIGINT (Node's name for Ctrl-C), records it and exits 42.
const CLI_JS: &str = "const fs = require('node:fs')\n\
process.on('SIGINT', () => { fs.writeFileSync(process.env.OUT, 'sigint'); process.exit(42) })\n\
fs.writeFileSync(process.env.OUT + '.ready', 'ready')\n\
setTimeout(() => process.exit(9), 30000)\n";

fn node() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("NODE").map(PathBuf::from).filter(|path| path.is_file()) {
        return Some(path);
    }
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join("node.exe")).find(|path| path.is_file())
}

fn install(root: &Path, node: &Path) -> PathBuf {
    let dir = root.join("runtime").join("node-test");
    fs::create_dir_all(&dir).unwrap();
    let linked = dir.join("node.exe");
    if fs::hard_link(node, &linked).is_err() {
        fs::copy(node, &linked).unwrap();
    }
    fs::write(root.join("runtime").join("current-node"), format!("{}\r\n", linked.display())).unwrap();
    fs::create_dir_all(root.join("cli").join("1.2.3")).unwrap();
    fs::write(root.join("cli").join("1.2.3").join("cli.js"), CLI_JS).unwrap();
    fs::write(root.join("cli").join("current"), "1.2.3\r\n").unwrap();
    fs::create_dir_all(root.join("bin")).unwrap();
    let exe = root.join("bin").join("harness.exe");
    fs::copy(HARNESS, &exe).unwrap();
    exe
}

fn wait_for(file: &Path) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !file.exists() {
        assert!(Instant::now() < deadline, "{} never appeared", file.display());
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn ctrl_c_reaches_the_cli_and_harness_exits_with_its_code() {
    let Some(node) = node() else {
        assert!(std::env::var_os("CI").is_none(), "no node on PATH, and CI is set: the runner must have one");
        eprintln!("skipped: no node on PATH");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let exe = install(dir.path(), &fs::canonicalize(node).unwrap());
    let out = dir.path().join("out");
    // A process started in a new process group ignores Ctrl-C, and passes that on: an SSH session's processes may
    // (OpenSSH starts them so). harness.exe would inherit it here and prove nothing, so this process clears it first.
    unsafe {
        SetConsoleCtrlHandler(None, 0);
    }
    let mut child = Command::new(&exe).arg("wait").env("OUT", &out).creation_flags(CREATE_NEW_CONSOLE).spawn().unwrap();
    wait_for(&out.with_extension("ready"));

    unsafe {
        FreeConsole();
        assert_ne!(AttachConsole(child.id()), 0, "{}", std::io::Error::last_os_error());
        // This process is in that console now too, and must not end on its own Ctrl-C.
        SetConsoleCtrlHandler(None, 1);
        assert_ne!(GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0), 0, "{}", std::io::Error::last_os_error());
        FreeConsole();
    }

    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "harness never exited");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(fs::read_to_string(&out).ok().as_deref(), Some("sigint"), "the CLI never saw Ctrl-C");
    // 42 is the CLI's own code. Had harness.exe ended on the Ctrl-C itself, it would be STATUS_CONTROL_C_EXIT.
    assert_eq!(status.code(), Some(42));
}
