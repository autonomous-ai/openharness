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

// `icon.png` scaled to `size` by averaging each pixel's block, as `[r, g, b, a]` with the colour premultiplied by alpha,
// so a transparent pixel's colour counts for nothing.
fn scaled_icon(size: usize) -> Vec<[f64; 4]> {
    let icon = tauri::image::Image::from_bytes(&bytes("icons/icon.png")).unwrap();
    let (side, rgba) = (icon.width() as usize, icon.rgba());
    let span = |i: usize| i * side / size..(i + 1) * side / size;
    let mut out = Vec::with_capacity(size * size);
    for y in 0..size {
        for x in 0..size {
            let (mut sum, mut n) = ([0.0; 4], 0.0);
            for sy in span(y) {
                for sx in span(x) {
                    sum = add(sum, premultiplied(&rgba[(sy * side + sx) * 4..][..4]));
                    n += 1.0;
                }
            }
            out.push(sum.map(|s| s / n));
        }
    }
    out
}

fn premultiplied(pixel: &[u8]) -> [f64; 4] {
    let a = pixel[3] as f64;
    [pixel[0] as f64 * a / 255.0, pixel[1] as f64 * a / 255.0, pixel[2] as f64 * a / 255.0, a]
}

fn add(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]]
}

// `cargo tauri icon` resamples with a sharper filter than a block average, so the two never match exactly; the mean
// per-channel difference stays small (at most 2.9 of 255 for the Pixel H's sizes), and another picture's is far larger
// (35 to 40 for the logo before it).
fn assert_scaled_icon(what: &str, png: &[u8], size: usize) {
    let image = tauri::image::Image::from_bytes(png).unwrap_or_else(|e| panic!("{what}: {e}"));
    assert_eq!((image.width() as usize, image.height() as usize), (size, size), "{what}");
    let total: f64 = (image.rgba().chunks(4).zip(scaled_icon(size)))
        .map(|(pixel, want)| premultiplied(pixel).iter().zip(want).map(|(got, want)| (got - want).abs()).sum::<f64>())
        .sum();
    let mean = total / (size * size * 4) as f64;
    assert!(mean < 8.0, "{what} is not icons/icon.png scaled (mean difference {mean:.2}): run `cargo tauri icon`");
}

/// The Windows and Linux icons are made from `icons/icon.png` by `cargo tauri icon icons/icon.png` (tauri-cli 2.12.4).
/// Pixels are compared, not pinned hashes: a hash pins today's files, so a new `icon.png` with its sizes regenerated
/// would fail it too, and one whose hash is updated by hand would pass with stale sizes. Pixels fail exactly when a
/// size is not `icon.png`.
#[test]
fn the_windows_and_linux_icons_are_icon_png_scaled() {
    for (name, size) in [("icons/32x32.png", 32), ("icons/128x128.png", 128), ("icons/128x128@2x.png", 256)] {
        assert_scaled_icon(name, &bytes(name), size);
    }
    // An ICO is a 6-byte header with the image count at 4, a 16-byte entry per image (width at 0, where 0 means 256;
    // length at 8; offset at 12), then the images, each a PNG as `cargo tauri icon` writes them.
    let ico = bytes("icons/icon.ico");
    let u32_at = |i: usize| u32::from_le_bytes(ico[i..i + 4].try_into().unwrap()) as usize;
    let count = u16::from_le_bytes([ico[4], ico[5]]) as usize;
    let mut sizes = Vec::new();
    for entry in (0..count).map(|i| 6 + 16 * i) {
        let size = if ico[entry] == 0 { 256 } else { ico[entry] as usize };
        let (len, at) = (u32_at(entry + 8), u32_at(entry + 12));
        assert_scaled_icon(&format!("icons/icon.ico {size}x{size}"), &ico[at..at + len], size);
        sizes.push(size);
    }
    assert_eq!(sizes, [16, 24, 32, 48, 64, 256]);
}
