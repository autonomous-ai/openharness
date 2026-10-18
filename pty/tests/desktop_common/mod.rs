//! Shared by the tests that run the real `Harness.exe` (the `harness-desktop-launcher` bin). Each such test file has
//! `harness = false` and calls [main], so its own executable doubles as the desktop app: copied to
//! `app\<ver>\harness-desktop.exe`, and started with [STANDIN_OUT] set, it writes what it was given and exits.
#![allow(dead_code)]

#[cfg(windows)]
pub mod owned_windows;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

pub const LAUNCHER: &str = env!("CARGO_BIN_EXE_harness-desktop-launcher");
/// Where the stand-in writes `{ "args": [...], "cwd": "..." }`.
pub const STANDIN_OUT: &str = "HARNESS_STANDIN_OUT";
/// The stand-in waits this many ms after writing, so a test can watch a running app.
pub const STANDIN_SLEEP_MS: &str = "HARNESS_STANDIN_SLEEP_MS";

/// Review Focus 1: a profile with a space, an apostrophe, `&`, `%`, `!` and letters outside ASCII.
pub const ODD_NAME: &str = "Nguyễn Văn A' & 100% !x";

/// The test runner, or the stand-in when [STANDIN_OUT] is set. A failing test panics, which ends the run non-zero.
pub fn main(tests: &[(&str, fn())]) {
    // An inherited output variable must never turn the whole suite into a stand-in.
    let is_app = std::env::current_exe().unwrap().file_name().unwrap() == "harness-desktop.exe";
    let is_owned_child = std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--harness-desktop-stand-in");
    if let Some(out) = std::env::var_os(STANDIN_OUT).filter(|_| is_app || is_owned_child) {
        stand_in(Path::new(&out));
        return;
    }
    let filter = std::env::args().skip(1).find(|arg| !arg.starts_with('-'));
    let mut count = 0;
    for (name, test) in tests {
        if filter.as_deref().is_none_or(|filter| name.contains(filter)) {
            println!("test {name} ...");
            test();
            println!("test {name} ... ok");
            count += 1;
        }
    }
    assert!(count > 0, "no desktop tests matched {filter:?}");
    println!("{count} desktop tests passed");
}

fn stand_in(out: &Path) {
    let environment = [
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "HARNESS_DESKTOP_INSTALL_ROOT",
        "HARNESS_DESKTOP_PROGRAMS_DIR",
        "HARNESS_DESKTOP_REGISTRY_ROOT",
        "HARNESS_DESKTOP_NO_DIALOG",
        STANDIN_OUT,
    ]
    .into_iter()
    .filter_map(|key| std::env::var(key).ok().map(|value| (key, value)))
    .collect::<std::collections::BTreeMap<_, _>>();
    let report = serde_json::json!({
        "args": std::env::args().skip(1).collect::<Vec<_>>(),
        "cwd": std::env::current_dir().unwrap(),
        "pid": std::process::id(),
        "exe": std::env::current_exe().unwrap(),
        "env": environment,
    });
    let tmp = out.with_extension("tmp");
    fs::write(&tmp, report.to_string()).unwrap();
    fs::rename(&tmp, out).unwrap();
    if let Some(ms) = std::env::var(STANDIN_SLEEP_MS)
        .ok()
        .and_then(|ms| ms.parse().ok())
    {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

/// [this test's own executable] as `<root>\app\<version>\harness-desktop.exe`.
pub fn put_app(root: &Path, version: &str) -> PathBuf {
    let dir = root.join("app").join(version);
    fs::create_dir_all(&dir).unwrap();
    let exe = dir.join("harness-desktop.exe");
    fs::copy(std::env::current_exe().unwrap(), &exe).unwrap();
    exe
}

/// `current` naming [version], as the launcher writes it.
pub fn point(root: &Path, name: &str, version: &str) {
    fs::write(root.join(name), format!("{version}\r\n")).unwrap();
}

/// The stand-in's report at [out], once it is whole.
pub fn report(out: &Path) -> serde_json::Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(text) = fs::read_to_string(out)
            && let Ok(value) = serde_json::from_str(&text)
        {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "the app never started: no {}",
            out.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The launcher, with message boxes off.
pub fn isolated_command(exe: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(exe);
    for key in [
        STANDIN_OUT,
        STANDIN_SLEEP_MS,
        "HARNESS_DESKTOP_INSTALL_ROOT",
        "HARNESS_DESKTOP_PROGRAMS_DIR",
        "HARNESS_DESKTOP_REGISTRY_ROOT",
    ] {
        command.env_remove(key);
    }
    command.env("HARNESS_DESKTOP_NO_DIALOG", "1");
    command
}

pub fn launcher() -> Command {
    isolated_command(LAUNCHER)
}

pub fn stand_in_command() -> Command {
    let mut command = isolated_command(std::env::current_exe().unwrap());
    command.arg("--harness-desktop-stand-in");
    command
}

/// Finish only the app identified by this fixture's private report, before deleting
/// its mapped executable on Windows. The launcher has already returned by this point.
pub fn finish_app(report: &serde_json::Value) {
    use harness_pty::desktop::system::{Real, System};
    let pid = u32::try_from(report["pid"].as_u64().unwrap()).unwrap();
    Real.wait_for_exit(pid, Duration::from_secs(20)).unwrap();
}

pub fn same(a: &Path, b: &Path) -> bool {
    fs::canonicalize(a).unwrap() == fs::canonicalize(b).unwrap()
}
