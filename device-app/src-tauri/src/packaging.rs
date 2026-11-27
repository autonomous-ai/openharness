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

/// Tauri's NSIS uninstaller deletes the Run value named after the product, and an update (`/UPDATE`) does not run the
/// old uninstaller. So the login item's value must carry the product's name: an uninstall removes it, and an update
/// keeps it.
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

/// The publisher is what Windows shows in Settings > Apps and in the exe's details. Up to 0.1.14 it was "autonomous",
/// the identifier's second part; the identifier stays, so installed apps keep updating. Tauri keeps the install folder
/// under the publisher's key, so the hooks move it from the old key, and an install over an older one finds it.
#[test]
fn windows_shows_autonomous_inc_as_the_publisher() {
    let main = config("tauri.conf.json");
    assert_eq!(main["bundle"]["publisher"], "Autonomous Inc.");
    assert_eq!(main["identifier"], "ai.autonomous.harness.device");
    let nsis = &config("tauri.windows.conf.json")["bundle"]["windows"]["nsis"];
    assert_eq!(nsis["installerHooks"], "windows/installer-hooks.nsh");
    assert!(file("windows/installer-hooks.nsh").contains(r"Software\autonomous\Harness Device"));
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
fn the_window_is_harness_device_at_420_by_320_with_no_taskbar_button() {
    let window = &config("tauri.conf.json")["app"]["windows"][0];
    assert_eq!(window["title"], "Harness Device");
    assert_eq!((window["width"].clone(), window["height"].clone()), (json!(420), json!(320)));
    assert_eq!(window["skipTaskbar"], true);
}

#[test]
fn every_windows_build_is_a_gui_program() {
    assert_eq!(file("src/main.rs").lines().next(), Some(r#"#![cfg_attr(windows, windows_subsystem = "windows")]"#));
}

// The side of a square icon image: a PNG, or for an icns' ic04 (16 px) and ic05 (32 px) "ARGB" then each channel's
// plane run-length encoded, where a byte below 0x80 copies the next byte + 1 bytes and any other repeats the next byte
// (byte - 0x80 + 3) times.
fn side(what: &str, image: &[u8]) -> usize {
    let Some(planes) = image.strip_prefix(b"ARGB") else {
        let png = tauri::image::Image::from_bytes(image).unwrap_or_else(|e| panic!("{what}: {e}"));
        assert_eq!(png.width(), png.height(), "{what}: not square");
        return png.width() as usize;
    };
    let (mut len, mut at) = (0, 0);
    while at < planes.len() {
        let run = planes[at] as usize;
        (len, at) = if run < 0x80 { (len + run + 1, at + 2 + run) } else { (len + run - 0x80 + 3, at + 2) };
    }
    (len / 4).isqrt()
}

/// icon.icns and icon.ico are the design team's (the Harness_AppIcon set, dark), as they sent them; the PNGs are
/// written from icons/app-1024.png by `scripts/icons.py app`.
#[test]
fn the_icns_and_the_ico_hold_every_size() {
    // An icns is an 8-byte header, then chunks of a 4-byte type, a 4-byte big-endian length (header included) and the
    // image. iconutil adds an `info` chunk, which is no image.
    let icns = bytes("icons/icon.icns");
    assert_eq!(&icns[..4], b"icns");
    let (mut images, mut at) = (Vec::new(), 8);
    while at < icns.len() {
        let kind = std::str::from_utf8(&icns[at..at + 4]).unwrap();
        let len = u32::from_be_bytes(icns[at + 4..at + 8].try_into().unwrap()) as usize;
        if kind != "info" {
            images.push((kind, side(&format!("icons/icon.icns {kind}"), &icns[at + 8..at + len])));
        }
        at += len;
    }
    images.sort();
    assert_eq!(
        images,
        [
            ("ic04", 16),
            ("ic05", 32),
            ("ic07", 128),
            ("ic08", 256),
            ("ic09", 512),
            ("ic10", 1024),
            ("ic11", 32),
            ("ic12", 64),
            ("ic13", 256),
            ("ic14", 512)
        ]
    );
    // An ICO is a 6-byte header with the image count at 4, a 16-byte entry per image (width at 0 and height at 1, where
    // 0 means 256; length at 8; offset at 12), then the images, each a PNG.
    let ico = bytes("icons/icon.ico");
    let u32_at = |i: usize| u32::from_le_bytes(ico[i..i + 4].try_into().unwrap()) as usize;
    let count = u16::from_le_bytes([ico[4], ico[5]]) as usize;
    let mut sizes = Vec::new();
    for entry in (0..count).map(|i| 6 + 16 * i) {
        let size = if ico[entry] == 0 { 256 } else { ico[entry] as usize };
        assert_eq!(ico[entry + 1], ico[entry], "icons/icon.ico {size} px entry: height differs from width");
        let (len, at) = (u32_at(entry + 8), u32_at(entry + 12));
        assert!(ico[at..].starts_with(b"\x89PNG"), "icons/icon.ico {size} px entry: not a PNG");
        assert_eq!(side(&format!("icons/icon.ico {size} px"), &ico[at..at + len]), size);
        sizes.push(size);
    }
    assert_eq!(sizes, [16, 24, 32, 48, 64, 128, 256]);
}
