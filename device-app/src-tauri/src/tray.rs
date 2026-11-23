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

    /// Windows and Linux draw a tray icon at 16 px (32 at 200 %), where tray.png's 36 px scale blurs. Each glyph is
    /// tray.png's 8x8 grid at 4 px a cell, its dot the cell's top-left 2x2: halved, every pixel stays whole.
    #[test]
    fn the_tray_glyphs_are_trays_grid_at_4_px_a_cell() {
        use tauri::image::Image;
        let icon = |name: &str| std::fs::read(format!("{}/icons/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let template = Image::from_bytes(&icon("tray.png")).unwrap();
        assert_eq!((template.width(), template.height()), (36, 36));
        // tray.png's dots are 3 px on a 4 px pitch from (2, 2): a cell is on where its dot's middle is.
        let on = |column: usize, row: usize| template.rgba()[((3 + 4 * row) * 36 + 3 + 4 * column) * 4 + 3] == 255;
        for (name, colour) in [("tray-light.png", [255; 3]), ("tray-dark.png", [0; 3])] {
            let glyph = Image::from_bytes(&icon(name)).unwrap();
            assert_eq!((glyph.width(), glyph.height()), (32, 32), "{name}");
            for (index, pixel) in glyph.rgba().chunks(4).enumerate() {
                let (x, y) = (index % 32, index / 32);
                let dot = x % 4 < 2 && y % 4 < 2 && on(x / 4, y / 4);
                assert_eq!(pixel[3], if dot { 255 } else { 0 }, "{name} alpha at ({x}, {y})");
                assert_eq!(pixel[..3], colour, "{name} colour at ({x}, {y})");
            }
        }
    }
}
