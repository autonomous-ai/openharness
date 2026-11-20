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

const NOT_AN_APPIMAGE: &str = "Login item not set (not an AppImage).";
const PATH_NOT_SUPPORTED: &str = "Login item not set (path not supported).";

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

/// The entry's `Exec=` value: the AppImage while it is there; once it is gone, the launcher's `start`, as the
/// installer's own entry runs it. The value holds no `\`, `$`, backtick or `"` but the two around the `sh -c` text, so
/// it reads the same whichever way the session reads it: GLib's, or systemd's autostart generator (GNOME and KDE
/// under systemd), which writes `$` as `\$` in the unit and keeps that backslash. None for a path it cannot hold.
pub fn exec_line(appimage: &Path, launcher: &Path) -> Option<String> {
    let (appimage, launcher) = (quoted(appimage)?, quoted(launcher)?);
    Some(format!(r#"/bin/sh -c "[ -x {appimage} ] && exec {appimage}; exec {launcher} start""#))
}

/// A path in single quotes, which keep every other character from the shell; `%`, a field code in `Exec=`, doubled.
/// None for a path holding a character a quote cannot hold in both readings (`'`, `"`, `$`, a backtick, a backslash, a
/// control character), or not UTF-8.
fn quoted(path: &Path) -> Option<String> {
    let text = path.to_str()?;
    let refused = |c: char| c.is_control() || matches!(c, '\'' | '"' | '$' | '`' | '\\');
    (!text.chars().any(refused)).then(|| format!("'{}'", text.replace('%', "%%")))
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
        Some(code) => format!("Login item not set (error {code})."),
        None => format!("Login item not set ({:?}).", error.kind()),
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

    /// What a session that reads the entry itself (GLib's way) runs for an `Exec=` value: the string's escape (`\\`),
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

    /// What GNOME and KDE run under systemd: its xdg-autostart-generator (252 and later) turns the value into a unit's
    /// `ExecStart=`, which systemd then reads. The generator takes the string's escapes, unquotes the words (a
    /// backslash keeps the next character), C-unescapes each word, doubles `%` for systemd, and quotes each word that
    /// needs it with `"`, `\`, `` ` `` and `$` backslashed. `ExecStart=` reads `%%` as `%`, then unquotes the words
    /// with C escapes, and keeps the backslash of any other (its retry after "Ignoring unknown escape sequences").
    fn systemd_argv(value: &str) -> Vec<String> {
        let mut unescaped = String::new();
        let mut chars = value.chars();
        while let Some(c) = chars.next() {
            unescaped.push(match c {
                '\\' => match chars.next().unwrap() {
                    's' => ' ',
                    'n' => '\n',
                    't' => '\t',
                    'r' => '\r',
                    other => other,
                },
                c => c,
            });
        }
        let line: Vec<String> = systemd_words(&unescaped, false)
            .into_iter()
            .enumerate()
            .map(|(i, word)| {
                let word = c_unescaped(&word);
                let word = if i == 0 { word } else { word.replace("%%", "%").replace('%', "%%") };
                quoted_for_exec_start(&word)
            })
            .collect();
        systemd_words(&line.join(" ").replace("%%", "%"), true)
    }

    /// systemd's extract_first_word with EXTRACT_UNQUOTE: `'` and `"` quote, and a backslash takes the next character;
    /// with `cunescape`, its C escape, or the backslash and the character when it is none.
    fn systemd_words(text: &str, cunescape: bool) -> Vec<String> {
        let (mut words, mut word, mut quote, mut started) = (Vec::new(), String::new(), None, false);
        let mut chars = text.chars();
        while let Some(c) = chars.next() {
            match (c, quote) {
                ('\\', _) => {
                    let next = chars.next().unwrap();
                    match c_escape(next) {
                        Some(decoded) if cunescape => word.push(decoded),
                        _ if cunescape => word.extend(['\\', next]),
                        _ => word.push(next),
                    }
                    started = true;
                }
                (c, Some(open)) if c == open => quote = None,
                (c, Some(_)) => word.push(c),
                ('\'' | '"', None) => (quote, started) = (Some(c), true),
                (' ' | '\t' | '\n' | '\r', None) => {
                    if std::mem::take(&mut started) {
                        words.push(std::mem::take(&mut word));
                    }
                }
                (c, None) => {
                    word.push(c);
                    started = true;
                }
            }
        }
        if started {
            words.push(word);
        }
        words
    }

    /// A C escape systemd decodes.
    fn c_escape(c: char) -> Option<char> {
        let decoded = [('a', '\x07'), ('b', '\x08'), ('f', '\x0c'), ('n', '\n'), ('r', '\r'), ('t', '\t')]
            .into_iter()
            .chain([('v', '\x0b'), ('\\', '\\'), ('"', '"'), ('\'', '\''), ('s', ' ')])
            .find(|(escape, _)| *escape == c)?;
        Some(decoded.1)
    }

    /// The generator's cunescape on a word: it gives up on the entry at an escape it does not know.
    fn c_unescaped(word: &str) -> String {
        let (mut out, mut chars) = (String::new(), word.chars());
        while let Some(c) = chars.next() {
            out.push(if c == '\\' {
                c_escape(chars.next().unwrap()).expect("the generator drops the entry")
            } else {
                c
            });
        }
        out
    }

    /// systemd's shell_maybe_quote: a word with a space, a glob or a shell character goes in `"`, with `"`, `\`, `` ` ``
    /// and `$` backslashed from the first such character on.
    fn quoted_for_exec_start(word: &str) -> String {
        const NEEDS_QUOTES: &str = "\"\\`$*?[]'()<>|&;! \t\n\r";
        assert!(!word.chars().any(char::is_control), "{word:?}");
        let Some(at) = word.find(|c: char| NEEDS_QUOTES.contains(c)) else { return word.to_string() };
        let escaped: String =
            word[at..].chars().flat_map(|c| ["\"\\`$".contains(c).then_some('\\'), Some(c)]).flatten().collect();
        format!("\"{}{escaped}\"", &word[..at])
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
            r#"/bin/sh -c "[ -x '/a/H.AppImage' ] && exec '/a/H.AppImage'; exec '/h/.local/bin/harness' start""#
        );
    }

    #[test]
    fn a_path_with_a_space_a_percent_or_a_shell_character_is_quoted() {
        let appimage = Path::new("/My Apps/100% (x) & y; z*.AppImage");
        let line = exec_line(appimage, Path::new("/h/Nguyễn/harness")).unwrap();
        let quoted = r#"exec '/My Apps/100%% (x) & y; z*.AppImage'; exec '/h/Nguyễn/harness' start""#;
        assert!(line.ends_with(quoted), "{line}");
    }

    #[test]
    fn a_path_no_quoting_holds_in_both_readings_gets_no_line() {
        // A quote, `$`, a backtick or a backslash needs a backslash in the value, which systemd's generator keeps.
        for odd in ["'", "\"", "$", "`", "\\"] {
            assert_eq!(exec_line(Path::new(&format!("/a/{odd}.AppImage")), Path::new(LAUNCHER)), None, "{odd}");
            assert_eq!(exec_line(Path::new(APPIMAGE), Path::new(&format!("/h/{odd}/harness"))), None, "{odd}");
        }
        // A control character cannot be held in one line, nor a path that is not UTF-8 in a UTF-8 file.
        assert_eq!(exec_line(Path::new("/a/new\nline"), Path::new(LAUNCHER)), None);
        assert_eq!(exec_line(Path::new(APPIMAGE), Path::new("/h/a\ttab")), None);
        assert_eq!(exec_line(Path::new(OsStr::from_bytes(b"/a/\xff.AppImage")), Path::new(LAUNCHER)), None);
    }

    #[test]
    fn the_exec_line_starts_the_appimage_and_falls_back_to_the_launcher() {
        let dir = tempfile::tempdir().unwrap();
        let odd = dir.path().join("My Apps 100% (x) & y; z*");
        fs::create_dir(&odd).unwrap();
        // Linked, not written as scripts (testing::Fake on ETXTBSY). echo says which ran: the AppImage gets no
        // argument, the launcher `start`. Each link is named echo, in a folder of its own: Ubuntu 26.04's coreutils
        // (uutils) is one program that refuses to run under any other tool's name.
        let (appimage, launcher) = (odd.join("app").join("echo"), odd.join("bin").join("echo"));
        for link in [&appimage, &launcher] {
            fs::create_dir(link.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink("/bin/echo", link).unwrap();
        }
        // Both ways a session reads the entry.
        let run = |reading: fn(&str) -> Vec<String>| {
            let argv = reading(&exec_line(&appimage, &launcher).unwrap());
            let output = Command::new(&argv[0]).args(&argv[1..]).output().unwrap();
            assert!(output.status.success(), "{argv:?}: {output:?}");
            String::from_utf8(output.stdout).unwrap()
        };
        for reading in [argv, systemd_argv] {
            assert_eq!(run(reading), "\n");
        }
        fs::remove_file(&appimage).unwrap();
        for reading in [argv, systemd_argv] {
            assert_eq!(run(reading), "start\n");
        }
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
        assert_eq!(apply(&entry, None, launcher, true), Err("Login item not set (not an AppImage).".into()));
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
