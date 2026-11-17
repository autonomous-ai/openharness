//! Harness Device: every rule of the menu-bar app. The binary (main.rs) only draws the tray and the window.

pub mod account;
pub mod app;
pub mod cli;
pub mod desktop;
pub mod front;
#[cfg(target_os = "macos")]
pub mod front_macos;
// Its pure rules compile everywhere under test, so a Mac checks them too; the X11 source is Linux only.
#[cfg(any(target_os = "linux", test))]
pub mod front_x11;
pub mod install;
pub mod keepalive;
pub mod log;
pub mod loginitem;
pub mod model;
pub mod runner;
pub mod state;
pub mod tabs;
#[cfg(target_os = "macos")]
pub mod tabs_macos;
#[cfg(target_os = "macos")]
pub mod tray_macos;
pub mod types;
pub mod update;
pub mod vscode;
pub mod watch;

#[cfg(test)]
mod testing;
