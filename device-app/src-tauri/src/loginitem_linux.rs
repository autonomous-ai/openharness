//! Open at login on Linux: the autostart entry the CLI's installer and this app share.

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
        // argument, the launcher `start`.
        let (appimage, launcher) = (odd.join("H.AppImage"), odd.join("harness"));
        std::os::unix::fs::symlink("/bin/echo", &appimage).unwrap();
        std::os::unix::fs::symlink("/bin/echo", &launcher).unwrap();
        let run = || {
            let argv = argv(&exec_line(&appimage, &launcher).unwrap());
            let output = Command::new(&argv[0]).args(&argv[1..]).output().unwrap();
            assert!(output.status.success());
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
        for off in ["Hidden=true", "Hidden = true", "X-GNOME-Autostart-enabled=false", "X-MATE-Autostart-enabled=false"] {
            let entry = format!("[Desktop Entry]\nType=Application\nName=Harness\n{INSTALLERS}\n{off}\n");
            for first in [true, false] {
                assert_eq!(change(Some(&entry), &exec(), first), Change::Leave, "{off}");
            }
        }
    }

    #[test]
    fn an_entry_that_is_on_is_taken_over_and_keeps_its_other_lines() {
        let installers =
            format!("[Desktop Entry]\nType=Application\nName=Harness\n{INSTALLERS}\nX-GNOME-Autostart-enabled=true\nHidden=false\n");
        let taken = installers.replace(INSTALLERS, &format!("Exec={}", exec()));
        // An older AppImage's line too: another path is not this app's own.
        let moved = installers.replace(INSTALLERS, &format!("Exec={}", exec_line(Path::new("/b/H.AppImage"), Path::new(LAUNCHER)).unwrap()));
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
        for not_one in [None, Some(OsStr::new("")), Some(OsStr::new("H.AppImage")), Some(dir.path().as_os_str()), Some(gone.as_os_str())] {
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
