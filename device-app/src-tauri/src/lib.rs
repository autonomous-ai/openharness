//! Harness Device: every rule of the menu-bar app. The binary (main.rs) only draws the tray and the window.

pub mod account;
pub mod app;
pub mod claude;
pub mod cli;
pub mod desktop;
pub mod front;
#[cfg(target_os = "macos")]
pub mod front_macos;
pub mod install;
pub mod keepalive;
pub mod log;
pub mod loginitem;
pub mod model;
pub mod runner;
pub mod state;
pub mod types;
pub mod watch;

#[cfg(test)]
mod testing;
