//! The tray icon for the panel's colour.

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
