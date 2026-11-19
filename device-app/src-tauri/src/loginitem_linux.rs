//! Open at login on Linux: the autostart entry the CLI's installer and this app share.
//!
//! One file, which the CLI's installer writes too (install.sh write_login_entry) and its uninstaller removes while it is
//! the installer's own. What is whose is the first `Exec=` line: the installer leaves a file whose line is not its own
//! `<launcher> start`, and this app takes over any entry that is on, so the desktop session starts the app, and the app
//! the daemon. An entry the person turned off stays off, and one they deleted stays deleted: neither side writes a
//! second file.

#[cfg(target_os = "linux")]
use crate::loginitem::{LoginItem, SystemLoginItem};
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The entry's file name: the installer's (install.sh login_entry_file), apart from Desktop's menu entry.
pub const ENTRY: &str = "harnessd.desktop";

const NOT_AN_APPIMAGE: &str = "Login item not added (not an AppImage).";
const PATH_NOT_SUPPORTED: &str = "Login item not added (path not supported).";

/// The command, quoted for an `Exec=` value: the AppImage while it is there; once it is gone, the launcher's `start`,
/// as the installer's own entry runs it. The two paths follow as `$0` and `$1`, so neither is ever read as shell.
const RUN: &str = r#"/bin/sh -c "[ -x \\"\\$0\\" ] && exec \\"\\$0\\"; exec \\"\\$1\\" start""#;

/// `<config>/autostart/harnessd.desktop`: `$XDG_CONFIG_HOME` only when it is absolute, as the XDG spec and the
/// installer say, else `<home>/.config`.
pub fn entry_path(config_home: Option<&OsStr>, home: &Path) -> PathBuf {
    let config = match config_home.map(Path::new) {
        Some(config) if config.is_absolute() => config.to_path_buf(),
        _ => home.join(".config"),
    };
    config.join("autostart").join(ENTRY)
}

/// The AppImage this run came from: its runtime sets APPIMAGE to its own file. A developer's `cargo run` has none.
pub fn appimage(var: Option<&OsStr>) -> Option<PathBuf> {
    var.map(PathBuf::from).filter(|path| path.is_absolute() && path.is_file())
}

/// The entry's `Exec=` value. None for a path one UTF-8 line cannot hold.
pub fn exec_line(appimage: &Path, launcher: &Path) -> Option<String> {
    Some(format!("{RUN} {} {}", quoted(appimage)?, quoted(launcher)?))
}

/// A path as one `Exec=` argument, in the Desktop Entry spec's two layers (the quoting inside a string value, as the
/// installer's login_entry_exec writes it): a backslash is doubled twice, `"`, a backtick and `$` take an escaped
/// backslash, and `%`, a field code there, is doubled. GLib refuses a value with any other escape.
fn quoted(path: &Path) -> Option<String> {
    let text = path.to_str().filter(|text| !text.chars().any(char::is_control))?;
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '\\' => out.push_str(r"\\\\"),
            '"' | '`' | '$' => {
                out.push_str(r"\\");
                out.push(c);
            }
            '%' => out.push_str("%%"),
            c => out.push(c),
        }
    }
    out.push('"');
    Some(out)
}

/// A new entry, in the installer's format but for the line.
pub fn fresh(exec: &str) -> String {
    format!("[Desktop Entry]\nType=Application\nName=Harness\nExec={exec}\nX-GNOME-Autostart-enabled=true\n")
}

#[derive(Debug, PartialEq, Eq)]
pub enum Change {
    Write(String),
    Leave,
}

/// What the entry becomes. None there: written on the app's first registration only, so one the person deleted (KDE's
/// way of turning it off) stays deleted. Turned off: left as it is. On, with another `Exec=` line (the installer's, or
/// an AppImage since moved): that line becomes the app's, and the rest is kept.
pub fn change(existing: Option<&str>, exec: &str, first: bool) -> Change {
    let Some(existing) = existing else {
        return if first { Change::Write(fresh(exec)) } else { Change::Leave };
    };
    if existing.lines().any(is_off) {
        return Change::Leave;
    }
    let own = format!("Exec={exec}");
    let mut start = 0;
    // The first `Exec=` line, as the installer and the uninstaller read it.
    for line in existing.split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        if content.starts_with("Exec=") {
            if content == own {
                return Change::Leave;
            }
            return Change::Write(format!("{}{own}{}", &existing[..start], &existing[start + content.len()..]));
        }
        start += line.len();
    }
    Change::Write(fresh(exec))
}

/// Turned off where the person turns off any login item, as the installer reads it (install.sh login_entry_off), with
/// the spaces the Desktop Entry spec allows around `=`.
fn is_off(line: &str) -> bool {
    let Some((key, value)) = line.split_once('=') else { return false };
    matches!(
        (key.trim(), value.trim()),
        ("Hidden", "true") | ("X-GNOME-Autostart-enabled", "false") | ("X-MATE-Autostart-enabled", "false")
    )
}

/// Brings the entry at `entry` to what `change` says for the AppImage APPIMAGE names. Ok(true): it wrote the entry.
pub fn apply(entry: &Path, appimage_var: Option<&OsStr>, launcher: &Path, first: bool) -> Result<bool, String> {
    let Some(appimage) = appimage(appimage_var) else { return skipped(first, NOT_AN_APPIMAGE) };
    let Some(exec) = exec_line(&appimage, launcher) else { return skipped(first, PATH_NOT_SUPPORTED) };
    let existing = match fs::read_to_string(entry) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(failed(&error)),
    };
    match change(existing.as_deref(), &exec, first) {
        Change::Leave => Ok(false),
        Change::Write(text) => write(entry, &text).map(|()| true).map_err(|error| failed(&error)),
    }
}

/// No entry this run can write: the first registration says why, a refresh changes nothing.
fn skipped(first: bool, why: &str) -> Result<bool, String> {
    if first { Err(why.into()) } else { Ok(false) }
}

/// The error's code only, as on macOS and Windows.
fn failed(error: &io::Error) -> String {
    match error.raw_os_error() {
        Some(code) => format!("Login item not added (error {code})."),
        None => format!("Login item not added ({:?}).", error.kind()),
    }
}

/// Through a temp file in the same folder and a rename, as the installer writes it: the session never reads half of
/// one.
fn write(entry: &Path, text: &str) -> io::Result<()> {
    if let Some(folder) = entry.parent() {
        fs::create_dir_all(folder)?;
    }
    let staged = entry.with_file_name(format!("{ENTRY}.{}.tmp", std::process::id()));
    let written = fs::write(&staged, text).and_then(|()| fs::rename(&staged, entry));
    if written.is_err() {
        let _ = fs::remove_file(&staged);
    }
    written
}

/// The first registration writes an entry that is missing; a refresh, at every launch and after each install, takes
/// over one that is on.
#[cfg(target_os = "linux")]
impl LoginItem for SystemLoginItem {
    fn register(&self) -> Result<(), String> {
        system(true).map(|_| ())
    }

    fn refresh(&self) -> Result<bool, String> {
        system(false)
    }
}

#[cfg(target_os = "linux")]
fn system(first: bool) -> Result<bool, String> {
    // A relative home would put the entry under the app's working folder.
    let Some(home) = std::env::home_dir().filter(|home| home.is_absolute()) else {
        return skipped(first, PATH_NOT_SUPPORTED);
    };
    let entry = entry_path(std::env::var_os("XDG_CONFIG_HOME").as_deref(), &home);
    // The launcher the installer puts in ~/.local/bin.
    let launcher = home.join(".local").join("bin").join("harness");
    apply(&entry, std::env::var_os("APPIMAGE").as_deref(), &launcher, first)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::fs;
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    const APPIMAGE: &str = "/a/H.AppImage";
    const LAUNCHER: &str = "/h/.local/bin/harness";
    /// install.sh's own line for LAUNCHER (its login_entry_exec), which the uninstaller removes too.
    const INSTALLERS: &str = r#"Exec="/h/.local/bin/harness" start"#;

    fn exec() -> String {
        exec_line(Path::new(APPIMAGE), Path::new(LAUNCHER)).unwrap()
    }

    /// What the desktop session runs for an `Exec=` value: the string's escape (`\\` is the only one the line holds),
    /// the field codes (`%%` is the only one), then the arguments, quoted as the Desktop Entry spec quotes them.
    fn argv(value: &str) -> Vec<String> {
        let value = value.replace(r"\\", r"\").replace("%%", "%");
        let (mut args, mut arg, mut quoted, mut chars) = (Vec::new(), String::new(), false, value.chars());
        while let Some(c) = chars.next() {
            match c {
                '"' => quoted = !quoted,
                '\\' if quoted => arg.push(chars.next().unwrap()),
                ' ' if !quoted => args.push(std::mem::take(&mut arg)),
                c => arg.push(c),
            }
        }
        args.push(arg);
        args
    }

    #[test]
    fn the_entry_is_under_xdg_config_home_only_when_it_is_absolute() {
        let home = Path::new("/home/p");
        let absolute = entry_path(Some(OsStr::new("/x/config")), home);
        assert_eq!(absolute, PathBuf::from("/x/config/autostart/harnessd.desktop"));
        for not_absolute in [None, Some(OsStr::new("")), Some(OsStr::new("config"))] {
            assert_eq!(entry_path(not_absolute, home), PathBuf::from("/home/p/.config/autostart/harnessd.desktop"));
        }
    }

    #[test]
    fn the_exec_line_is_one_fixed_text() {
        assert_eq!(
            exec(),
            r#"/bin/sh -c "[ -x \\"\\$0\\" ] && exec \\"\\$0\\"; exec \\"\\$1\\" start" "/a/H.AppImage" "/h/.local/bin/harness""#
        );
    }

    #[test]
    fn a_path_with_a_space_a_percent_a_dollar_a_quote_and_a_backslash_is_quoted() {
        let appimage = Path::new(r#"/My Apps/100% $HOME "q" \b `x`.AppImage"#);
        let line = exec_line(appimage, Path::new("/h/Nguyễn/harness")).unwrap();
        let quoted = r#" "/My Apps/100%% \\$HOME \\"q\\" \\\\b \\`x\\`.AppImage" "/h/Nguyễn/harness""#;
        assert!(line.ends_with(quoted), "{line}");
        // A control character cannot be held in one line, nor a path that is not UTF-8 in a UTF-8 file.
        assert_eq!(exec_line(Path::new("/a/new\nline"), Path::new(LAUNCHER)), None);
        assert_eq!(exec_line(Path::new(APPIMAGE), Path::new("/h/a\ttab")), None);
        assert_eq!(exec_line(Path::new(OsStr::from_bytes(b"/a/\xff.AppImage")), Path::new(LAUNCHER)), None);
    }

    #[test]
    fn the_exec_line_starts_the_appimage_and_falls_back_to_the_launcher() {
        let dir = tempfile::tempdir().unwrap();
        let odd = dir.path().join(r#"My Apps 100% $HOME "q" \b `x`"#);
        fs::create_dir(&odd).unwrap();
        // Linked, not written as scripts (testing::Fake on ETXTBSY). echo says which ran: the AppImage gets no
        // argument, the launcher `start`. Each link is named echo, in a folder of its own: Ubuntu 26.04's coreutils
        // (uutils) is one program that refuses to run under any other tool's name.
        let (appimage, launcher) = (odd.join("app").join("echo"), odd.join("bin").join("echo"));
        for link in [&appimage, &launcher] {
            fs::create_dir(link.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink("/bin/echo", link).unwrap();
        }
        let run = || {
            let argv = argv(&exec_line(&appimage, &launcher).unwrap());
            let output = Command::new(&argv[0]).args(&argv[1..]).output().unwrap();
            assert!(output.status.success(), "{output:?}");
            String::from_utf8(output.stdout).unwrap()
        };
        assert_eq!(run(), "\n");
        fs::remove_file(&appimage).unwrap();
        assert_eq!(run(), "start\n");
    }

    #[test]
    fn a_fresh_entry_is_dial_linuxs_format() {
        assert_eq!(
            fresh("X"),
            "[Desktop Entry]\nType=Application\nName=Harness\nExec=X\nX-GNOME-Autostart-enabled=true\n"
        );
    }

    #[test]
    fn an_absent_entry_is_written_once_and_a_deleted_one_stays_deleted() {
        assert_eq!(change(None, &exec(), true), Change::Write(fresh(&exec())));
        assert_eq!(change(None, &exec(), false), Change::Leave);
    }

    #[test]
    fn an_entry_that_is_off_is_left_alone() {
        // install.sh's login_entry_off, and the Desktop Entry spec's spaces around `=`.
        for off in ["Hidden=true", "Hidden = true", "X-GNOME-Autostart-enabled=false", "X-MATE-Autostart-enabled=false"]
        {
            let entry = format!("[Desktop Entry]\nType=Application\nName=Harness\n{INSTALLERS}\n{off}\n");
            for first in [true, false] {
                assert_eq!(change(Some(&entry), &exec(), first), Change::Leave, "{off}");
            }
        }
    }

    #[test]
    fn an_entry_that_is_on_is_taken_over_and_keeps_its_other_lines() {
        let installers = format!(
            "[Desktop Entry]\nType=Application\nName=Harness\n{INSTALLERS}\nX-GNOME-Autostart-enabled=true\nHidden=false\n"
        );
        let taken = installers.replace(INSTALLERS, &format!("Exec={}", exec()));
        // An older AppImage's line too: another path is not this app's own.
        let moved = installers.replace(
            INSTALLERS,
            &format!("Exec={}", exec_line(Path::new("/b/H.AppImage"), Path::new(LAUNCHER)).unwrap()),
        );
        for (entry, first) in [(&installers, true), (&installers, false), (&moved, false)] {
            assert_eq!(change(Some(entry), &exec(), first), Change::Write(taken.clone()));
        }
        // One with no Exec= line is written fresh.
        assert_eq!(change(Some("[Desktop Entry]\nName=Harness\n"), &exec(), false), Change::Write(fresh(&exec())));
    }

    #[test]
    fn the_apps_own_entry_is_not_rewritten() {
        let own = fresh(&exec());
        for first in [true, false] {
            assert_eq!(change(Some(&own), &exec(), first), Change::Leave);
        }
    }

    #[test]
    fn only_an_appimage_run_registers() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("H.AppImage");
        fs::write(&file, "").unwrap();
        let gone = dir.path().join("gone.AppImage");
        assert_eq!(appimage(Some(file.as_os_str())), Some(file.clone()));
        for not_one in [
            None,
            Some(OsStr::new("")),
            Some(OsStr::new("H.AppImage")),
            Some(dir.path().as_os_str()),
            Some(gone.as_os_str()),
        ] {
            assert_eq!(appimage(not_one), None, "{not_one:?}");
        }

        let entry = entry_path(Some(dir.path().join("config").as_os_str()), dir.path());
        let launcher = Path::new(LAUNCHER);
        assert_eq!(apply(&entry, None, launcher, true), Err("Login item not added (not an AppImage).".into()));
        assert_eq!(apply(&entry, None, launcher, false), Ok(false));
        assert!(!entry.exists());
        assert_eq!(apply(&entry, Some(file.as_os_str()), launcher, true), Ok(true));
        assert_eq!(fs::read_to_string(&entry).unwrap(), fresh(&exec_line(&file, launcher).unwrap()));
        assert_eq!(apply(&entry, Some(file.as_os_str()), launcher, false), Ok(false));
        // Written through a temp file and a rename: nothing else is left beside it.
        assert_eq!(fs::read_dir(entry.parent().unwrap()).unwrap().count(), 1);
        // Deleted, it stays deleted.
        fs::remove_file(&entry).unwrap();
        assert_eq!(apply(&entry, Some(file.as_os_str()), launcher, false), Ok(false));
        assert!(!entry.exists());
    }
}
