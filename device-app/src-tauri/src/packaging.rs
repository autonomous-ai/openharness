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

// An icns is an 8-byte header, then chunks of a 4-byte type, a 4-byte big-endian length (header included) and the
// image. This returns the drawing of `kind` as `(side, rgba)`.
fn icns_drawing(kind: &str) -> (usize, Vec<u8>) {
    let icns = bytes("icons/icon.icns");
    let mut at = 8;
    while at < icns.len() {
        let len = u32::from_be_bytes(icns[at + 4..at + 8].try_into().unwrap()) as usize;
        if &icns[at..at + 4] == kind.as_bytes() {
            return decode(kind, &icns[at + 8..at + len]);
        }
        at += len;
    }
    panic!("icons/icon.icns has no {kind}");
}

// ic04 (16 px) and ic05 (32 px) are "ARGB" then each channel's plane run-length encoded: a byte below 0x80 copies the
// next byte + 1 bytes, any other repeats the next byte (byte - 0x80 + 3) times. The colour is straight, not
// premultiplied (`iconutil -c iconset` divides it by alpha anyway, so its 16 and 32 px edges come out pale). The
// larger sizes are PNG.
fn decode(kind: &str, body: &[u8]) -> (usize, Vec<u8>) {
    let Some(planes) = body.strip_prefix(b"ARGB") else {
        let image = tauri::image::Image::from_bytes(body).unwrap_or_else(|e| panic!("{kind}: {e}"));
        return (image.width() as usize, image.rgba().to_vec());
    };
    let (mut argb, mut at) = (Vec::new(), 0);
    while at < planes.len() {
        let run = planes[at] as usize;
        if run < 0x80 {
            argb.extend_from_slice(&planes[at + 1..at + 2 + run]);
            at += 2 + run;
        } else {
            argb.extend(std::iter::repeat_n(planes[at + 1], run - 0x80 + 3));
            at += 2;
        }
    }
    let n = argb.len() / 4;
    let rgba = (0..n).flat_map(|i| [argb[n + i], argb[2 * n + i], argb[3 * n + i], argb[i]]).collect();
    (n.isqrt(), rgba)
}

// `drawing` resized to `size` by nearest neighbour (each pixel takes the source pixel under its centre), which keeps
// pixel art's hard edges; at the drawing's own size it is the drawing.
fn nearest((side, rgba): &(usize, Vec<u8>), size: usize) -> Vec<u8> {
    let source = |i: usize| (2 * i + 1) * side / (2 * size);
    (0..size * size).flat_map(|i| rgba[(source(i / size) * side + source(i % size)) * 4..][..4].to_vec()).collect()
}

/// The Windows and Linux icons are the drawings macOS shows, from `icons/icon.icns`, size for size: its small sizes are
/// drawn per size, not `icon.png` scaled. A size the icns has no drawing for takes the nearest one that keeps the Pixel
/// H legible, by nearest neighbour: 24 px is the 16 px solid H (the 32 px dots merge into stripes at 24), and 48 px the
/// 64 px drawing (the larger ones' dots merge into stripes at 48).
/// Regenerate: write each size as `nearest(icns_drawing(kind), size)` to its PNG, and the ICO's sizes as PNG entries.
#[test]
fn the_windows_and_linux_icons_are_the_macos_drawings() {
    for (name, size, kind) in
        [("icons/32x32.png", 32, "ic05"), ("icons/128x128.png", 128, "ic07"), ("icons/128x128@2x.png", 256, "ic08")]
    {
        assert_drawing(name, &bytes(name), size, kind);
    }
    // An ICO is a 6-byte header with the image count at 4, a 16-byte entry per image (width at 0, where 0 means 256;
    // length at 8; offset at 12), then the images, each a PNG.
    let ico = bytes("icons/icon.ico");
    let u32_at = |i: usize| u32::from_le_bytes(ico[i..i + 4].try_into().unwrap()) as usize;
    let count = u16::from_le_bytes([ico[4], ico[5]]) as usize;
    let mut sizes = Vec::new();
    for entry in (0..count).map(|i| 6 + 16 * i) {
        let size = if ico[entry] == 0 { 256 } else { ico[entry] as usize };
        let kind = match size {
            16 | 24 => "ic04",
            32 => "ic05",
            48 | 64 => "ic12",
            _ => "ic08",
        };
        let (len, at) = (u32_at(entry + 8), u32_at(entry + 12));
        assert_drawing(&format!("icons/icon.ico {size}x{size}"), &ico[at..at + len], size, kind);
        sizes.push(size);
    }
    assert_eq!(sizes, [16, 24, 32, 48, 64, 256]);
}

fn assert_drawing(what: &str, png: &[u8], size: usize, kind: &str) {
    let image = tauri::image::Image::from_bytes(png).unwrap_or_else(|e| panic!("{what}: {e}"));
    assert_eq!((image.width() as usize, image.height() as usize), (size, size), "{what}");
    let want = nearest(&icns_drawing(kind), size);
    let differ = image.rgba().chunks(4).zip(want.chunks(4)).filter(|(got, want)| got != want).count();
    assert_eq!(differ, 0, "{what}: pixels that are not icons/icon.icns's {kind} drawing at {size} px");
}
