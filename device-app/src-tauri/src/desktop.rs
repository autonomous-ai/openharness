//! The desktop app: installed, running, and opening it.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_names_come_from_the_desktop_packaging() {
        assert_eq!(process_names("linux"), &["harness"]);
        assert_eq!(process_names("windows"), &["harness-desktop.exe"]);
        assert!(process_names("macos").is_empty());
    }

    fn among(os: &str, exe: &str) -> bool {
        running_among(os, std::iter::once(exe.to_string()))
    }

    #[test]
    fn a_name_matches_the_file_whole() {
        assert!(among("linux", "/opt/harness/harness"));
        for other in ["/usr/bin/node", "/x/harness-pty", "/x/harnessd", "/x/Harness"] {
            assert!(!among("linux", other), "{other}");
        }
        assert!(among("windows", r"C:\x\Harness-Desktop.exe"));
        assert!(!among("macos", "/Applications/Harness.app/Contents/MacOS/harness"));
        assert!(!among("macos", "harness"));
    }

    #[test]
    fn open_harness_is_one_fixed_command() {
        assert_eq!(open_desktop_args(), ["-b", "ai.autonomous.harness"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_system_answers() {
        // Read-only lookups: either answer is right; the calls must return.
        let _ = SystemDesktopApp.installed();
        let _ = SystemDesktopApp.running();
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn no_desktop_app_is_installed_off_a_mac() {
        assert!(!SystemDesktopApp.installed());
        let _ = SystemDesktopApp.running();
    }
}
