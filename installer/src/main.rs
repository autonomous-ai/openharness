//! harness-install.exe: downloads this PC's Harness desktop app and hands it to the zip's own `Harness.exe --install`
//! (docs/superpowers/specs/2026-10-19-windows-installer-design.md). A GUI program: opened from a browser's download,
//! it shows a window and no console.
#![cfg_attr(windows, windows_subsystem = "windows")]
#![cfg_attr(not(windows), allow(dead_code))]

mod flow;
mod model;
#[cfg(windows)]
mod ui;
#[cfg(windows)]
mod windows;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(windows)]
    std::process::exit(windows::main(&args));
    #[cfg(not(windows))]
    {
        let _ = args;
        eprintln!("harness-install runs on Windows only");
        std::process::exit(model::EXIT_FAILED);
    }
}
