//! The ChatGPT window on macOS, through Accessibility: only its focused window's title, read and never set.

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    const CODEX: &str = "<key>CFBundleIdentifier</key><string>com.openai.codex</string>";

    /// An app at `app` whose Info.plist's dict holds `dict`.
    fn app_with(app: &Path, dict: &str) {
        fs::create_dir_all(app.join("Contents")).unwrap();
        let plist = format!(r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>{dict}</dict></plist>"#);
        fs::write(app.join("Contents").join("Info.plist"), plist).unwrap();
    }

    #[test]
    fn a_bundle_id_is_read_from_its_info_plist() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("X.app");
        app_with(&app, CODEX);
        assert_eq!(bundle_id(&app).as_deref(), Some("com.openai.codex"));

        let unnamed = root.path().join("Unnamed.app");
        app_with(&unnamed, "<key>CFBundleName</key><string>Unnamed</string>");
        assert_eq!(bundle_id(&unnamed), None);
        let numbered = root.path().join("Numbered.app");
        app_with(&numbered, "<key>CFBundleIdentifier</key><integer>7</integer>");
        assert_eq!(bundle_id(&numbered), None);
        let bare = root.path().join("Bare.app");
        fs::create_dir_all(bare.join("Contents")).unwrap();
        assert_eq!(bundle_id(&bare), None);
        let folder = root.path().join("Folder.app");
        fs::create_dir_all(folder.join("Contents").join("Info.plist")).unwrap();
        assert_eq!(bundle_id(&folder), None);
        assert_eq!(bundle_id(&root.path().join("Gone.app")), None);
    }

    #[test]
    fn installed_reads_only_the_two_places() {
        // Never the real /Applications: an empty folder stands in for it.
        let home = tempfile::tempdir().unwrap();
        let applications = tempfile::tempdir().unwrap();
        let follow = MacFollow::new(home.path().to_path_buf());
        assert!(!follow.installed_in(applications.path()));
        app_with(&home.path().join("Applications").join("ChatGPT.app"), CODEX);
        assert!(follow.installed_in(applications.path()));
    }

    #[test]
    fn the_observer_thread_ends_when_its_handle_is_dropped() {
        // This test's own process has no window and may or may not be trusted: either way its thread ends.
        for after_first_heard in [false, true] {
            let (heard_to, heard) = mpsc::channel();
            let (ended_to, ended) = mpsc::channel();
            let observation = observe_pid(
                std::process::id() as libc::pid_t,
                Box::new(move |told| {
                    let _ = heard_to.send(told);
                }),
                move || {
                    let _ = ended_to.send(());
                },
            );
            if after_first_heard {
                heard.recv_timeout(Duration::from_secs(5)).expect("a first title or no observer");
            }
            let dropping = Instant::now();
            drop(observation);
            // A drop that waited for the thread would wait out ChatGPT's 1 s timeout.
            assert!(dropping.elapsed() < Duration::from_millis(250), "{:?}", dropping.elapsed());
            ended.recv_timeout(Duration::from_secs(5)).expect("the observer thread ended");
        }
    }

    #[test]
    fn the_permission_is_read_and_its_notification_registered() {
        // Never prompt(): it shows macOS's dialog.
        let follow = MacFollow::new(PathBuf::from("/nonexistent"));
        let _either = follow.trusted();
        follow.start(Box::new(|| {}));
    }
}
