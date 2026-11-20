//! Linux: the app lists itself in the app list when it runs from an AppImage, which a browser's download never does.
//!
//! One entry, `harness-device.desktop`, with three writers: this app at every launch, Desktop's installer and the
//! one-line installer. They follow one rule, held in tests/fixtures/app-list-entry-vectors.json, which each writer's
//! tests read: an entry that starts another AppImage still on disk, or a program by name, is left alone; a missing,
//! stale or broken one is written again.

use crate::loginitem_linux::appimage;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The entry's file name, the one Desktop's installer writes (device_app_launcher.dart).
pub const ENTRY: &str = "harness-device.desktop";
/// The image's own icon, under the folder its runtime mounts it at: Desktop and the one-line installer extract the same
/// member.
pub const ICON_MEMBER: &str = "usr/share/icons/hicolor/128x128/apps/harness-device.png";
/// The window's WM_CLASS instance and Wayland app id, the vectors' `startupWMClass` (why it is this name is there).
pub const WM_CLASS: &str = "harness-device";

const ICON: &str = "harness-device.png";

/// `$XDG_DATA_HOME` when it is absolute, as the XDG spec says, else `$HOME/.local/share` when HOME is absolute; None
/// when neither is: a relative one would put the entry under the app's working folder.
pub fn data_home(xdg_data_home: Option<&OsStr>, home: Option<&Path>) -> Option<PathBuf> {
    match xdg_data_home.map(Path::new) {
        Some(xdg) if xdg.is_absolute() => Some(xdg.to_path_buf()),
        _ => home.filter(|home| home.is_absolute()).map(|home| home.join(".local").join("share")),
    }
}

/// The path as the Desktop Entry spec wants it in `Exec=`, as Desktop's quoteLauncherExec writes it: in quotes, with
/// `"`, a backtick, `$` and `\` backslashed, when it holds a character a launcher would split or expand on; every `%`
/// doubled, a single one being a field code. None for a control character, which one line cannot hold, or not UTF-8.
pub fn exec_value(appimage: &Path) -> Option<String> {
    let path = appimage.to_str().filter(|path| !path.chars().any(char::is_control))?;
    let doubled = path.replace('%', "%%");
    if !path.chars().any(|c| c.is_whitespace() || "\"'\\$`<>~|&;*?#()".contains(c)) {
        return Some(doubled);
    }
    let escaped: String =
        doubled.chars().flat_map(|c| ["\"`$\\".contains(c).then_some('\\'), Some(c)]).flatten().collect();
    Some(format!("\"{escaped}\""))
}

/// The program the entry's first `Exec=` line starts, unquoted, as Desktop's launcherExecTarget reads it: `%%` as `%`
/// before the quotes, as GLib reads it; None when it has no such line or an unclosed quote.
pub fn exec_target(entry: &str) -> Option<String> {
    let value = entry.lines().find_map(|line| line.strip_prefix("Exec="))?.trim().replace("%%", "%");
    let Some(quoted) = value.strip_prefix('"') else {
        return Some(value.split(' ').next().unwrap_or_default().to_string());
    };
    let (mut target, mut chars) = (String::new(), quoted.chars());
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(target),
            '\\' => target.push(chars.next()?),
            c => target.push(c),
        }
    }
    None
}

/// The entry's bytes, every writer's: Desktop's, with the window's class last so a dock groups the window under it.
pub fn entry(exec: &str, icon: Option<&Path>) -> String {
    let icon = icon.map(|icon| format!("Icon={}\n", icon.display())).unwrap_or_default();
    format!(
        "[Desktop Entry]\nType=Application\nName=Harness Device\nComment=The app for your Harness device.\n\
         Exec={exec}\n{icon}Terminal=false\nCategories=Utility;\nStartupWMClass={WM_CLASS}\n"
    )
}

#[derive(Debug, PartialEq, Eq)]
pub enum Change {
    Write,
    Leave,
}

/// The rule. No entry: write. One that starts this AppImage: leave it while it is `wanted`, byte for byte, and the
/// icon it names is there, else write. One that starts an absolute path that is gone: write. Any other (another
/// AppImage on disk, a program by name, no `Exec=`) is someone else's: leave.
pub fn change(existing: Option<&str>, appimage: &Path, wanted: &str, exists: impl Fn(&Path) -> bool) -> Change {
    let Some(existing) = existing else { return Change::Write };
    let Some(target) = exec_target(existing).map(PathBuf::from) else { return Change::Leave };
    let icon_there =
        || wanted.lines().find_map(|line| line.strip_prefix("Icon=")).is_none_or(|icon| exists(Path::new(icon)));
    let own = target == appimage;
    if (own && (existing != wanted || !icon_there())) || (!own && target.is_absolute() && !exists(&target)) {
        Change::Write
    } else {
        Change::Leave
    }
}

/// Brings `<data_home>/applications/harness-device.desktop` to what `change` says for the AppImage APPIMAGE names,
/// with the icon from the image mounted at APPDIR (absolute, as appimage_env.rs takes it). None: the run is no
/// AppImage. Else what it did, or the error's log line.
pub fn apply(
    data_home: Option<&Path>,
    appimage_var: Option<&OsStr>,
    appdir_var: Option<&OsStr>,
) -> Option<Result<Change, String>> {
    let appimage = appimage(appimage_var)?;
    let Some(data_home) = data_home else { return Some(Err(not_written("no data folder"))) };
    let Some(exec) = exec_value(&appimage) else { return Some(Err(not_written("path not one line"))) };
    // The icon's path goes in the entry as it is: one line, UTF-8.
    if data_home.to_str().is_none_or(|path| path.chars().any(char::is_control)) {
        return Some(Err(not_written("path not one line")));
    }
    Some(write_entry(data_home, &appimage, &exec, appdir_var))
}

fn write_entry(data_home: &Path, appimage: &Path, exec: &str, appdir_var: Option<&OsStr>) -> Result<Change, String> {
    let icon_bytes = appdir_var
        .map(Path::new)
        .filter(|appdir| appdir.is_absolute())
        .and_then(|appdir| fs::read(appdir.join(ICON_MEMBER)).ok());
    let icon = data_home.join("icons").join(ICON);
    let wanted = entry(exec, icon_bytes.as_ref().map(|_| icon.as_path()));
    let file = data_home.join("applications").join(ENTRY);
    let existing = match fs::read(&file) {
        Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(failed(&error)),
    };
    if change(existing.as_deref(), appimage, &wanted, Path::exists) == Change::Leave {
        return Ok(Change::Leave);
    }
    // The icon first: an entry is never there naming an icon that is not.
    if let Some(bytes) = &icon_bytes {
        write(&icon, bytes).map_err(|error| failed(&error))?;
    }
    write(&file, wanted.as_bytes()).map(|()| Change::Write).map_err(|error| failed(&error))
}

/// The log line for what `apply` did. A left entry has one too: a check that waits for this run's decision sees it.
pub fn line(outcome: Result<Change, String>) -> String {
    match outcome {
        Ok(Change::Write) => "app list: entry written".into(),
        Ok(Change::Leave) => "app list: entry kept".into(),
        Err(line) => line,
    }
}

fn not_written(why: &str) -> String {
    format!("app list: entry not written ({why})")
}

/// The error's code only: an error's text names the path, which holds the person's name.
fn failed(error: &io::Error) -> String {
    match error.raw_os_error() {
        Some(code) => not_written(&format!("error {code}")),
        None => not_written(&format!("{:?}", error.kind())),
    }
}

/// Through a temp file in the same folder and a rename, as loginitem_linux.rs writes: the app list never reads half of
/// one.
fn write(file: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(folder) = file.parent() {
        fs::create_dir_all(folder)?;
    }
    let name = file.file_name().unwrap_or_default().to_string_lossy();
    let staged = file.with_file_name(format!("{name}.{}.tmp", std::process::id()));
    let written = fs::write(&staged, bytes).and_then(|()| fs::rename(&staged, file));
    if written.is_err() {
        let _ = fs::remove_file(&staged);
    }
    written
}

/// What the log says of this launch's entry: one line from an AppImage, None from any other run.
#[cfg(target_os = "linux")]
pub fn system() -> Option<String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let data_home = data_home(std::env::var_os("XDG_DATA_HOME").as_deref(), home.as_deref());
    apply(data_home.as_deref(), std::env::var_os("APPIMAGE").as_deref(), std::env::var_os("APPDIR").as_deref())
        .map(line)
}

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

        fn apply(&self, appdir: Option<&OsStr>) -> Option<Result<Change, String>> {
            apply(Some(&self.data_home()), Some(self.appimage.as_os_str()), appdir)
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
        assert_eq!(image.apply(Some(image.appdir.as_os_str())), Some(Ok(Change::Write)));
        assert_eq!(fs::read(image.icon_file()).unwrap(), ICON_BYTES);
        let exec = exec_value(&image.appimage).unwrap();
        assert_eq!(fs::read_to_string(image.entry_file()).unwrap(), entry(&exec, Some(&image.icon_file())));

        // No APPDIR, one that is not absolute, or one without the icon: the entry names no icon, and none is written.
        let empty = image.dir.path().join("empty");
        fs::create_dir(&empty).unwrap();
        for appdir in [None, Some(OsStr::new("mount")), Some(empty.as_os_str())] {
            let image = an_image();
            assert_eq!(image.apply(appdir), Some(Ok(Change::Write)), "{appdir:?}");
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
            assert_eq!(apply(Some(&image.data_home()), appimage, Some(image.appdir.as_os_str())), None, "{appimage:?}");
            assert!(!image.data_home().exists(), "{appimage:?}");
        }
    }

    #[test]
    fn a_second_run_leaves_the_entry() {
        let image = an_image();
        let appdir = Some(image.appdir.as_os_str());
        assert_eq!(image.apply(appdir).map(line).as_deref(), Some("app list: entry written"));
        let written = fs::metadata(image.entry_file()).unwrap().modified().unwrap();
        let bytes = fs::read(image.entry_file()).unwrap();
        // The log says so: a left entry is a line too, the sign that the run decided.
        assert_eq!(image.apply(appdir).map(line).as_deref(), Some("app list: entry kept"));
        assert_eq!(fs::read(image.entry_file()).unwrap(), bytes);
        assert_eq!(fs::metadata(image.entry_file()).unwrap().modified().unwrap(), written);
    }

    #[test]
    fn a_failure_is_a_log_line_not_a_panic() {
        let image = an_image();
        fs::write(image.data_home(), "").unwrap();
        let not_written = |why: &str| Some(format!("app list: entry not written ({why})"));
        assert_eq!(image.apply(Some(image.appdir.as_os_str())).map(line), not_written("error 20"));
        // An AppImage run always ends in one line, with no data folder or a path one line cannot hold too.
        let appimage = Some(image.appimage.as_os_str());
        assert_eq!(apply(None, appimage, None).map(line), not_written("no data folder"));
        assert_eq!(apply(Some(Path::new("/a\nb")), appimage, None).map(line), not_written("path not one line"));
    }

    #[test]
    fn the_entry_is_written_whole() {
        let image = an_image();
        assert_eq!(image.apply(Some(image.appdir.as_os_str())), Some(Ok(Change::Write)));
        let names = |folder: &Path| -> Vec<String> {
            fs::read_dir(folder).unwrap().map(|file| file.unwrap().file_name().into_string().unwrap()).collect()
        };
        assert_eq!(names(&image.data_home().join("applications")), [ENTRY]);
        assert_eq!(names(&image.data_home().join("icons")), ["harness-device.png"]);
    }
}
