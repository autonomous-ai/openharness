//! The tray icon for the panel's colour.

/// `Template` and `Dark` are `tray.png`, `Light` is `tray-light.png`.
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
}
