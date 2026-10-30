//! Harness.exe, the Harness desktop app's launcher on Windows (harness_pty::desktop). A GUI-subsystem program: a
//! Start Menu click, a `harness://` link or Settings ▸ Apps starts it with no console window. The package scripts
//! name it Harness.exe (the crate's bin is `harness-desktop-launcher`, as `Harness` and `harness` would be one file
//! on a case-insensitive file system).
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    std::process::exit(harness_pty::desktop::run(
        std::env::args_os().skip(1).collect(),
    ));
}
