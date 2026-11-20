#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::ffi::OsStr;
    use std::fs;
    use std::path::{Path, PathBuf};

    /// The rule every writer of the entry follows (Desktop, the one-line installer, this app), one file for all.
    const VECTORS: &str =
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/fixtures/app-list-entry-vectors.json"));

    fn vectors(name: &str) -> Vec<Value> {
        let all: Value = serde_json::from_str(VECTORS).unwrap();
        all[name].as_array().unwrap().clone()
    }

    /// An AppImage in a temp folder, with a space as a person's folder may have, and its APPDIR holding the icon.
    struct Image {
        dir: tempfile::TempDir,
        appimage: PathBuf,
        appdir: PathBuf,
    }

    const ICON_BYTES: &[u8] = b"\x89PNG\r\n\x1a\nthe image's own icon";

    fn an_image() -> Image {
        let dir = tempfile::tempdir().unwrap();
        let appimage = dir.path().join("My Apps").join("Harness-Device.AppImage");
        fs::create_dir_all(appimage.parent().unwrap()).unwrap();
        fs::write(&appimage, "").unwrap();
        let appdir = dir.path().join("mount");
        let member = appdir.join(ICON_MEMBER);
        fs::create_dir_all(member.parent().unwrap()).unwrap();
        fs::write(&member, ICON_BYTES).unwrap();
        Image { dir, appimage, appdir }
    }

    impl Image {
        fn data_home(&self) -> PathBuf {
            self.dir.path().join("data")
        }

        fn entry_file(&self) -> PathBuf {
            self.data_home().join("applications").join(ENTRY)
        }

        fn icon_file(&self) -> PathBuf {
            self.data_home().join("icons").join("harness-device.png")
        }

        fn apply(&self, appdir: Option<&OsStr>) -> Result<bool, String> {
            apply(&self.data_home(), Some(self.appimage.as_os_str()), appdir)
        }
    }

    #[test]
    fn the_window_class_is_the_vectors() {
        let all: Value = serde_json::from_str(VECTORS).unwrap();
        assert_eq!(all["startupWMClass"], WM_CLASS);
    }

    #[test]
    fn the_data_home_is_desktops() {
        for case in vectors("dataHome") {
            let env = &case["env"];
            let xdg = env["XDG_DATA_HOME"].as_str().map(OsStr::new);
            let home = env["HOME"].as_str().map(Path::new);
            assert_eq!(data_home(xdg, home), case["dataHome"].as_str().map(PathBuf::from), "{case}");
        }
    }

    #[test]
    fn the_exec_line_quotes_as_desktop_does() {
        for case in vectors("exec") {
            let path = case["path"].as_str().unwrap();
            assert_eq!(exec_value(Path::new(path)).as_deref(), case["exec"].as_str(), "{case}");
            // What it writes, it reads back as the same path.
            if let Some(exec) = exec_value(Path::new(path)) {
                assert_eq!(exec_target(&format!("[Desktop Entry]\nExec={exec}\n")).as_deref(), Some(path));
            }
        }
    }

    #[test]
    fn a_path_not_utf8_has_no_exec_line() {
        use std::os::unix::ffi::OsStrExt;
        assert_eq!(exec_value(Path::new(OsStr::from_bytes(b"/a/\xff.AppImage"))), None);
    }

    #[test]
    fn the_entry_is_desktops_byte_for_byte() {
        for case in vectors("entries") {
            let exec = exec_value(Path::new(case["appImage"].as_str().unwrap())).unwrap();
            let icon = Path::new(case["dataHome"].as_str().unwrap()).join("icons").join("harness-device.png");
            let icon = case["icon"].as_bool().unwrap().then_some(icon.as_path());
            assert_eq!(entry(&exec, icon), case["entry"].as_str().unwrap(), "{case}");
        }
    }

    #[test]
    fn who_writes_the_entry_is_one_rule() {
        for case in vectors("decisions") {
            let on_disk: Vec<&str> = case["onDisk"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
            let exists = |path: &Path| on_disk.iter().any(|there| Path::new(there) == path);
            let appimage = Path::new(case["appImage"].as_str().unwrap());
            let wanted = case["wanted"].as_str().unwrap();
            let decided = change(case["existing"].as_str(), appimage, wanted, exists);
            let write = if case["write"].as_bool().unwrap() { Change::Write } else { Change::Leave };
            assert_eq!(decided, write, "{}", case["name"]);
        }
    }

    #[test]
    fn the_icon_comes_from_inside_the_image() {
        let image = an_image();
        assert_eq!(image.apply(Some(image.appdir.as_os_str())), Ok(true));
        assert_eq!(fs::read(image.icon_file()).unwrap(), ICON_BYTES);
        let exec = exec_value(&image.appimage).unwrap();
        assert_eq!(fs::read_to_string(image.entry_file()).unwrap(), entry(&exec, Some(&image.icon_file())));

        // No APPDIR, one that is not absolute, or one without the icon: the entry names no icon, and none is written.
        let empty = image.dir.path().join("empty");
        fs::create_dir(&empty).unwrap();
        for appdir in [None, Some(OsStr::new("mount")), Some(empty.as_os_str())] {
            let image = an_image();
            assert_eq!(image.apply(appdir), Ok(true), "{appdir:?}");
            assert!(!image.icon_file().exists(), "{appdir:?}");
            assert_eq!(
                fs::read_to_string(image.entry_file()).unwrap(),
                entry(&exec_value(&image.appimage).unwrap(), None)
            );
        }
    }

    #[test]
    fn not_an_appimage_writes_nothing() {
        let image = an_image();
        let folder = image.dir.path().join("My Apps");
        for appimage in [None, Some(OsStr::new("Harness-Device.AppImage")), Some(folder.as_os_str())] {
            assert_eq!(apply(&image.data_home(), appimage, Some(image.appdir.as_os_str())), Ok(false), "{appimage:?}");
            assert!(!image.data_home().exists(), "{appimage:?}");
        }
    }

    #[test]
    fn a_second_run_leaves_the_entry() {
        let image = an_image();
        let appdir = Some(image.appdir.as_os_str());
        assert_eq!(image.apply(appdir), Ok(true));
        let written = fs::metadata(image.entry_file()).unwrap().modified().unwrap();
        let bytes = fs::read(image.entry_file()).unwrap();
        assert_eq!(image.apply(appdir), Ok(false));
        assert_eq!(fs::read(image.entry_file()).unwrap(), bytes);
        assert_eq!(fs::metadata(image.entry_file()).unwrap().modified().unwrap(), written);
    }

    #[test]
    fn a_failure_is_a_log_line_not_a_panic() {
        let image = an_image();
        fs::write(image.data_home(), "").unwrap();
        assert_eq!(image.apply(Some(image.appdir.as_os_str())), Err("app list: entry not written (error 20)".into()));
    }

    #[test]
    fn the_entry_is_written_whole() {
        let image = an_image();
        assert_eq!(image.apply(Some(image.appdir.as_os_str())), Ok(true));
        let names = |folder: &Path| -> Vec<String> {
            fs::read_dir(folder).unwrap().map(|file| file.unwrap().file_name().into_string().unwrap()).collect()
        };
        assert_eq!(names(&image.data_home().join("applications")), [ENTRY]);
        assert_eq!(names(&image.data_home().join("icons")), ["harness-device.png"]);
    }
}
