//! Harness Device: every rule of the menu-bar app. The binary (main.rs) only draws the tray and the window.
//!
//! Each OS's code is a module of its own. Its pure rules compile on a unix host under test, so a Mac checks them
//! too; a module whose tests need unix calls compiles under test on unix only.

pub mod account;
pub mod app;
#[cfg(any(target_os = "linux", all(test, unix)))]
pub mod app_list;
#[cfg(any(target_os = "linux", all(test, unix)))]
mod appimage_env;
#[cfg(unix)]
mod child_unix;
#[cfg(windows)]
mod child_windows;
pub mod cli;
pub mod desktop;
pub mod follow;
#[cfg(target_os = "macos")]
pub mod follow_macos;
pub mod front;
#[cfg(any(target_os = "linux", all(test, unix)))]
pub mod front_hyprland;
#[cfg(target_os = "macos")]
pub mod front_macos;
#[cfg(any(target_os = "linux", all(test, unix)))]
pub mod front_sway;
#[cfg(any(windows, test))]
pub mod front_windows;
#[cfg(target_os = "linux")]
pub mod front_x11;
pub mod harness_home;
pub mod install;
pub mod instance;
pub mod keepalive;
pub mod log;
pub mod loginitem;
#[cfg(any(target_os = "linux", all(test, unix)))]
pub mod loginitem_linux;
#[cfg(any(windows, test))]
pub mod loginitem_windows;
pub mod logs;
pub mod model;
pub mod open;
#[cfg(test)]
mod packaging;
#[cfg(test)]
mod parity;
pub mod runner;
pub mod state;
#[cfg(any(windows, test))]
mod stdin_queue;
pub mod tabs;
#[cfg(target_os = "macos")]
pub mod tabs_macos;
#[cfg(any(target_os = "linux", all(test, unix)))]
pub mod terminal;
#[cfg(any(windows, test))]
pub mod theme_windows;
pub mod tick;
pub mod tray;
#[cfg(any(target_os = "linux", all(test, unix)))]
pub mod tray_host;
pub mod types;
pub mod update;
pub mod watch;

// The fake CLI is a shell script, linked with a unix symlink.
#[cfg(all(test, unix))]
mod testing;
