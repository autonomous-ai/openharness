//! harness-launch.exe starts the Harness CLI in the background, outside any job, with no window
//! (harness_pty::launcher). It is a GUI-subsystem program on Windows, so starting it never opens a console window,
//! whether from the scheduled task or from a terminal.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    std::process::exit(harness_pty::launcher::run(std::env::args_os().skip(1).collect()));
}
