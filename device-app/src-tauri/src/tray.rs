//! The tray icon for the panel's colour.

/// `Template` is `tray.png`, `Dark` is `tray-dark.png`, `Light` is `tray-light.png`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayIcon {
    /// macOS colours it for the menu bar by itself.
    Template,
    /// The dark glyph, for a light panel.
    Dark,
    /// The light glyph, for a dark panel.
    Light,
}

/// `os` is `std::env::consts::OS`. Only Windows tells its panel's colour; Linux has no common way to read one.
pub fn tray_icon(os: &str, light_panel: bool) -> TrayIcon {
    match os {
        "macos" => TrayIcon::Template,
        "windows" if light_panel => TrayIcon::Dark,
        _ => TrayIcon::Light,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_os_has_its_tray_icon() {
        // macOS draws its template glyph in the menu bar's colour by itself.
        assert_eq!(tray_icon("macos", false), TrayIcon::Template);
        assert_eq!(tray_icon("macos", true), TrayIcon::Template);
        assert_eq!(tray_icon("windows", true), TrayIcon::Dark);
        assert_eq!(tray_icon("windows", false), TrayIcon::Light);
        // No common way to read a Linux panel's colour: the light glyph.
        assert_eq!(tray_icon("linux", false), TrayIcon::Light);
        assert_eq!(tray_icon("linux", true), TrayIcon::Light);
    }

    /// The glyphs are the Harness mark, drawn by `scripts/icons.py tray`. tray.png is wide because macOS draws a tray
    /// icon 18 points tall and keeps its aspect ratio: 44x36 px shows 22x18 points. Windows and Linux draw one at 16 px
    /// (32 at 200 %). Every pixel holds the glyph's colour, so only alpha draws the mark.
    #[test]
    fn the_tray_glyphs_are_the_mark_in_their_colour() {
        use tauri::image::Image;
        let icon = |name: &str| std::fs::read(format!("{}/icons/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap();
        for (name, size, colour) in [
            ("tray.png", (44, 36), [0; 3]),
            ("tray-light.png", (32, 32), [255; 3]),
            ("tray-dark.png", (32, 32), [0x0c; 3]),
        ] {
            let glyph = Image::from_bytes(&icon(name)).unwrap();
            assert_eq!((glyph.width(), glyph.height()), size, "{name}");
            assert!(glyph.rgba().chunks(4).all(|pixel| pixel[..3] == colour), "{name}: a pixel not its colour");
            assert!(glyph.rgba().chunks(4).any(|pixel| pixel[3] == 255), "{name}: no opaque pixel");
        }
    }
}
