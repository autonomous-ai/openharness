//! The bundle settings each OS's installer is built from.

use crate::loginitem_windows::RUN_VALUE;
use serde_json::{Value, json};
use std::path::PathBuf;

// Read at run time, not with `include_str!`, so a missing file fails its own test, not the whole build.
fn bytes(name: &str) -> Vec<u8> {
    std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn file(name: &str) -> String {
    String::from_utf8(bytes(name)).unwrap()
}

fn config(name: &str) -> Value {
    serde_json::from_str(&file(name)).unwrap()
}

// The width and height a PNG's IHDR chunk carries (bytes 16 to 24).
fn png_size(name: &str) -> (u32, u32) {
    let bytes = bytes(name);
    let at = |i: usize| u32::from_be_bytes(bytes[i..i + 4].try_into().unwrap());
    (at(16), at(20))
}

/// Tauri's NSIS uninstaller deletes the Run value named after the product, and not on an update, which runs the old
/// uninstaller with `/UPDATE`. So the login item's value must carry the product's name: an uninstall removes it, and
/// an update keeps it.
#[test]
fn the_run_value_is_named_after_the_product() {
    assert_eq!(config("tauri.conf.json")["productName"], RUN_VALUE);
    assert_eq!(config("tauri.windows.conf.json").get("productName"), None);
}

#[test]
fn windows_installs_per_user_as_harness_device() {
    assert_eq!(config("tauri.conf.json")["productName"], "Harness Device");
    let windows = &config("tauri.windows.conf.json")["bundle"];
    assert_eq!(windows["targets"], json!(["nsis"]));
    assert_eq!(windows["windows"]["nsis"]["installMode"], "currentUser");
}

#[test]
fn linux_is_an_appimage() {
    let linux = &config("tauri.linux.conf.json")["bundle"];
    assert_eq!(linux["targets"], json!(["appimage"]));
    assert_eq!(
        linux["icon"],
        json!(["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.png"])
    );
    assert_eq!(png_size("icons/32x32.png"), (32, 32));
    assert_eq!(png_size("icons/128x128.png"), (128, 128));
    assert_eq!(png_size("icons/128x128@2x.png"), (256, 256));
}

#[test]
fn the_window_is_harness_at_420_by_320_with_no_taskbar_button() {
    let window = &config("tauri.conf.json")["app"]["windows"][0];
    assert_eq!(window["title"], "Harness");
    assert_eq!((window["width"].clone(), window["height"].clone()), (json!(420), json!(320)));
    assert_eq!(window["skipTaskbar"], true);
}

#[test]
fn every_windows_build_is_a_gui_program() {
    assert_eq!(file("src/main.rs").lines().next(), Some(r#"#![cfg_attr(windows, windows_subsystem = "windows")]"#));
}
