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
/// A hidden Flutter-class window; "ignore" exercises owned forced termination.
pub const STANDIN_WINDOW: &str = "HARNESS_STANDIN_WINDOW";

/// Review Focus 1: a profile with a space, an apostrophe, `&`, `%`, `!` and letters outside ASCII.
pub const ODD_NAME: &str = "Nguyễn Văn A' & 100% !x";

/// The test runner, or the stand-in when [STANDIN_OUT] is set. A failing test panics, which ends the run non-zero.
pub fn main(tests: &[(&str, fn())]) {
    if stand_in_entry() {
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

/// Dispatch a copied app or explicit stand-in child before selecting any test cases.
pub fn stand_in_entry() -> bool {
    // An inherited output variable must never turn the whole suite into a stand-in.
    let is_app = std::env::current_exe().unwrap().file_name().unwrap() == "harness-desktop.exe";
    let is_owned_child = std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--harness-desktop-stand-in");
    if let Some(out) = std::env::var_os(STANDIN_OUT).filter(|_| is_app || is_owned_child) {
        stand_in(Path::new(&out));
        return true;
    }
    false
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
        STANDIN_WINDOW,
        "HARNESS_DESKTOP_INSTANCE",
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
    #[cfg(windows)]
    if std::env::var_os(STANDIN_WINDOW).is_some() {
        window::run(out, report);
        return;
    }
    publish(out, &report);
    if let Some(ms) = std::env::var(STANDIN_SLEEP_MS)
        .ok()
        .and_then(|ms| ms.parse().ok())
    {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

fn publish(out: &Path, report: &serde_json::Value) {
    let tmp = out.with_extension("tmp");
    fs::write(&tmp, report.to_string()).unwrap();
    fs::rename(&tmp, out).unwrap();
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
        STANDIN_WINDOW,
        "HARNESS_DESKTOP_INSTANCE",
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

/// Only fixture processes register this hidden, top-level window. Readiness
/// follows successful registration, creation and finite-lifetime timer setup.
#[cfg(windows)]
mod window {
    use super::*;
    use std::ffi::OsStr;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use windows_sys::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, KillTimer,
        MSG, PostQuitMessage, RegisterClassW, RegisterWindowMessageW, SetTimer, UnregisterClassW,
        WM_TIMER, WNDCLASSW,
    };
    static QUIT: AtomicU32 = AtomicU32::new(0);
    static IGNORE: AtomicBool = AtomicBool::new(false);
    const TIMER: usize = 0x4751;
    unsafe extern "system" fn procedure(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let quit = QUIT.load(Ordering::Relaxed);
        if quit != 0 && message == quit {
            if !IGNORE.load(Ordering::Relaxed) {
                unsafe { PostQuitMessage(0) };
            }
            return 0;
        }
        if message == WM_TIMER && wparam == TIMER {
            unsafe { PostQuitMessage(86) };
            return 0;
        }
        unsafe { DefWindowProcW(window, message, wparam, lparam) }
    }
    struct Window {
        handle: HWND,
        instance: HINSTANCE,
        class: Vec<u16>,
    }
    impl Drop for Window {
        fn drop(&mut self) {
            unsafe {
                KillTimer(self.handle, TIMER);
                DestroyWindow(self.handle);
                UnregisterClassW(self.class.as_ptr(), self.instance);
            }
        }
    }
    pub fn run(out: &Path, mut report: serde_json::Value) {
        use harness_pty::desktop::win::wide;
        let quit = unsafe {
            RegisterWindowMessageW(
                wide(OsStr::new(harness_pty::desktop::win::QUIT_MESSAGE)).as_ptr(),
            )
        };
        assert_ne!(
            quit,
            0,
            "RegisterWindowMessageW: {}",
            std::io::Error::last_os_error()
        );
        QUIT.store(quit, Ordering::Relaxed);
        IGNORE.store(
            std::env::var(STANDIN_WINDOW).is_ok_and(|s| s == "ignore"),
            Ordering::Relaxed,
        );
        let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
        assert!(!instance.is_null());
        let class = wide(OsStr::new("FLUTTER_RUNNER_WIN32_WINDOW"));
        let mut definition: WNDCLASSW = unsafe { std::mem::zeroed() };
        definition.lpfnWndProc = Some(procedure);
        definition.hInstance = instance;
        definition.lpszClassName = class.as_ptr();
        assert_ne!(
            unsafe { RegisterClassW(&definition) },
            0,
            "RegisterClassW: {}",
            std::io::Error::last_os_error()
        );
        // A deliberately different title proves selection never depends on "Harness".
        let title = wide(OsStr::new("Owned hidden fixture"));
        let handle = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                0,
                0,
                0,
                100,
                100,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            )
        };
        if handle.is_null() {
            let error = std::io::Error::last_os_error();
            unsafe { UnregisterClassW(class.as_ptr(), instance) };
            panic!("CreateWindowExW: {error}");
        }
        let _window = Window {
            handle,
            instance,
            class,
        };
        assert_ne!(unsafe { SetTimer(handle, TIMER, 60_000, None) }, 0);
        report["hwnd"] = serde_json::json!(handle as usize as u64);
        report["window_ready"] = serde_json::json!(true);
        publish(out, &report);
        let mut message: MSG = unsafe { std::mem::zeroed() };
        loop {
            match unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } {
                -1 => panic!("GetMessageW: {}", std::io::Error::last_os_error()),
                0 => {
                    assert_eq!(message.wParam, 0, "fixture window exceeded its lifetime");
                    break;
                }
                _ => {
                    unsafe { DispatchMessageW(&message) };
                }
            }
        }
    }
}
