//! `harness.exe` is the `harness` command on Windows (spec section 1, "Launchers"): what a person, a script or an
//! agent runs by name from cmd, PowerShell or a program. install.ps1 puts it in `%USERPROFILE%\.harness\bin`, which
//! is on the user's PATH.
//!
//! It runs `node.exe <cli\<version>\cli.js> <its own arguments>` and exits with node's exit code. It is a program,
//! not a batch file, so the arguments reach the CLI without a cmd parse: a `harness.cmd` re-parsed them, and an
//! argument holding `"` and then `&`, `|`, `<` or `>` ran commands of its own. Node gets the same console, stdio,
//! environment and working folder, and handles Ctrl-C and Ctrl-Break itself.
//!
//! The install is the folder above its own (`<root>\bin\harness.exe`), and the Node and CLI are the ones the
//! install's pointers name, by the rules harness-launch applies (`launcher::resolve`).
//!
//! The dial's inbox follower, `device claude inbox <session id>`, which the Claude Code plugin's mod starts once per
//! session for as long as it runs, starts on the version folder's own `inbox.mjs` when the folder holds it: Node
//! reading and compiling the 13 MB `cli.js` is most of what each follower holds (143 MB resident on `cli.js`, 57 MB
//! on the ~100 KB file, macOS; docs/plans/2026-11-27-windows-follower-ram-design.md). Every other line, and a version
//! folder an older installer or updater wrote without it, runs `cli.js`, which takes the follower's short path too.
//!
//! It builds and runs on Unix too, so `cargo test` covers the resolution and the exit code everywhere.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};

use crate::launcher::{Resolved, contained, resolve};

/// The inbox follower's own file, beside `cli.js` in a version folder.
const INBOX: &str = "inbox.mjs";

/// Whether [args] are the follower's line, by the match `entry.ts`, `inboxEntry.ts` and `inboxSessionOf`
/// (`cli/src/deviceClaude/inboxCommand.ts`) apply: the first is exactly `device`; of the rest, words starting with `-`
/// are dropped, at most three are left, and the first two are `claude` and `inbox`. A word that is not UTF-8 never
/// matches, so such a line runs `cli.js` as before. `inbox.mjs` answers any line those do not match `{"off":true}`, so
/// both sides are held to one list of lines (`tests/fixtures/follower_lines.json`).
fn follows_inbox(args: &[OsString]) -> bool {
    let Some(words) = args.iter().map(|arg| arg.to_str()).collect::<Option<Vec<&str>>>() else {
        return false;
    };
    let Some((&"device", rest)) = words.split_first() else {
        return false;
    };
    let rest: Vec<&str> = rest.iter().copied().filter(|word| !word.starts_with('-')).collect();
    rest.len() <= 3 && rest.starts_with(&["claude", "inbox"])
}

/// The script node runs for [args]: the version folder's `inbox.mjs` for the follower's line when it is a regular file
/// inside `cli\`, the check `resolve` applies to `cli.js`; otherwise `cli.js`.
fn script_for(resolved: &Resolved, args: &[OsString]) -> PathBuf {
    let inbox = resolved.cli_js.with_file_name(INBOX);
    let cli = resolved.cli_js.parent().and_then(Path::parent);
    if follows_inbox(args) && inbox.is_file() && cli.is_some_and(|cli| contained(cli, &inbox)) {
        inbox
    } else {
        resolved.cli_js.clone()
    }
}

/// What a broken install prints: one sentence a first-time user can act on.
pub const BROKEN: &str = "Harness is not installed completely; to install it again, open PowerShell and run: irm https://cdn.autonomous.ai/harness/cli/install.ps1 | iex";
pub const EXIT_BROKEN: i32 = 3;
pub const EXIT_SPAWN: i32 = 4;

/// `<root>` for `<root>\bin\harness.exe`.
pub fn root_of(exe: &Path) -> Option<PathBuf> {
    exe.parent()?.parent().map(Path::to_path_buf)
}

/// Node's exit code, as the caller should see it. On Unix a signal has no code; the shells' 128 + signal stands in.
pub fn exit_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    1
}

/// Leave Ctrl-C and Ctrl-Break to node, which shares this console and gets the same event. This process must not
/// end first: the caller would then show its prompt while node still runs. A handler that returns TRUE is used,
/// not `SetConsoleCtrlHandler(NULL, TRUE)`: that one is inherited, and node would then never see a Ctrl-C.
#[cfg(windows)]
fn leave_ctrl_c_to_node() {
    use windows_sys::Win32::Foundation::{BOOL, FALSE, TRUE};
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT, SetConsoleCtrlHandler};
    unsafe extern "system" fn handler(event: u32) -> BOOL {
        if event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT { TRUE } else { FALSE }
    }
    unsafe {
        SetConsoleCtrlHandler(Some(handler), TRUE);
    }
}

#[cfg(not(windows))]
fn leave_ctrl_c_to_node() {}

/// Run node on the script for [args] (`script_for`) with [args] unchanged, and wait for it.
pub fn run_resolved(resolved: &Resolved, args: &[OsString]) -> io::Result<ExitStatus> {
    Command::new(&resolved.node).arg(script_for(resolved, args)).args(args).status()
}

/// [args] as `harness tui` takes them when this program runs as `hn.exe`.
fn hn_args(exe: Option<&Path>, args: Vec<OsString>) -> Vec<OsString> {
    let hn = exe.and_then(Path::file_stem).is_some_and(|stem| stem.eq_ignore_ascii_case("hn"));
    if hn { std::iter::once(OsString::from("tui")).chain(args).collect() } else { args }
}

/// The program, given its own path and its arguments: node's exit code; 3 when the install does not resolve, 4 when
/// node does not start.
pub fn run(exe: io::Result<PathBuf>, args: Vec<OsString>) -> i32 {
    // The same program as `hn.exe` beside it (install.ps1) is the terminal app's command, as `hn` is on a Mac.
    let args = hn_args(exe.as_deref().ok(), args);
    let resolved = exe.ok().and_then(|exe| root_of(&exe)).ok_or_else(String::new).and_then(|root| resolve(&root));
    let Ok(resolved) = resolved else {
        eprintln!("{BROKEN}");
        return EXIT_BROKEN;
    };
    leave_ctrl_c_to_node();
    match run_resolved(&resolved, &args) {
        Ok(status) => exit_code(status),
        Err(err) => {
            eprintln!("Harness could not start its Node runtime ({err}); to install it again, open PowerShell and run: irm https://cdn.autonomous.ai/harness/cli/install.ps1 | iex");
            EXIT_SPAWN
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn os(words: &[&str]) -> Vec<OsString> {
        words.iter().map(OsString::from).collect()
    }

    /// The lines of `tests/fixtures/follower_lines.json` under [key]. `cli/src/deviceClaude/inboxCommand.spec.ts` holds
    /// `inboxSessionOf` to the same file, so the two copies of the match cannot drift apart.
    fn lines_of(key: &str) -> Vec<Vec<String>> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/follower_lines.json");
        let fixture: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        serde_json::from_value(fixture[key].clone()).unwrap()
    }

    #[test]
    fn follows_inbox_only_for_the_followers_line() {
        let followers = lines_of("follower");
        assert!(!followers.is_empty());
        for line in followers {
            let words: Vec<&str> = line.iter().map(String::as_str).collect();
            assert!(follows_inbox(&os(&words)), "{line:?}");
        }
        // Among them what `hn` hands on: `tui` first.
        let others = lines_of("other");
        assert!(!others.is_empty());
        for line in others {
            let words: Vec<&str> = line.iter().map(String::as_str).collect();
            assert!(!follows_inbox(&os(&words)), "{line:?}");
        }
        #[cfg(unix)]
        let not_utf8 = {
            use std::os::unix::ffi::OsStringExt;
            OsString::from_vec(vec![0x66, 0xff])
        };
        #[cfg(windows)]
        let not_utf8 = {
            use std::os::windows::ffi::OsStringExt;
            OsString::from_wide(&[0xD800])
        };
        let mut line = os(&["device", "claude", "inbox"]);
        line.push(not_utf8);
        assert!(!follows_inbox(&line));
    }

    #[test]
    fn script_for_runs_inbox_mjs_only_when_the_version_folder_holds_it() {
        let dir = tempfile::tempdir().unwrap();
        let version = dir.path().join("cli").join("1.2.3");
        fs::create_dir_all(&version).unwrap();
        let cli_js = version.join("cli.js");
        fs::write(&cli_js, b"").unwrap();
        let resolved = Resolved { node: dir.path().join("node"), cli_js: cli_js.clone() };
        let follower = os(&["device", "claude", "inbox", "x"]);
        let inbox = version.join(INBOX);

        // A version folder from before inbox.mjs.
        assert_eq!(script_for(&resolved, &follower), cli_js);
        fs::create_dir(&inbox).unwrap();
        assert_eq!(script_for(&resolved, &follower), cli_js);
        fs::remove_dir(&inbox).unwrap();

        fs::write(&inbox, b"").unwrap();
        assert_eq!(script_for(&resolved, &follower), inbox);
        assert_eq!(script_for(&resolved, &os(&["device", "claude", "attach", "x"])), cli_js);

        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            let elsewhere = outside.path().join(INBOX);
            fs::write(&elsewhere, b"").unwrap();
            fs::remove_file(&inbox).unwrap();
            std::os::unix::fs::symlink(&elsewhere, &inbox).unwrap();
            assert_eq!(script_for(&resolved, &follower), cli_js);
        }
    }

    #[test]
    fn as_hn_it_is_the_terminal_app() {
        let words = |args: Vec<OsString>| args.into_iter().map(|a| a.into_string().unwrap()).collect::<Vec<_>>();
        let given = vec![OsString::from("ls")];
        assert_eq!(words(hn_args(Some(&Path::new("R").join("bin").join("hn.exe")), given.clone())), ["tui", "ls"]);
        assert_eq!(words(hn_args(Some(Path::new("hn")), given.clone())), ["tui", "ls"]);
        assert_eq!(words(hn_args(Some(Path::new("HN.EXE")), vec![])), ["tui"]);
        assert_eq!(words(hn_args(Some(Path::new("harness.exe")), given.clone())), ["ls"]);
        assert_eq!(words(hn_args(None, given)), ["ls"]);
    }

    #[test]
    fn the_root_is_the_folder_above_the_programs_own() {
        let exe = Path::new("R").join("bin").join("harness.exe");
        assert_eq!(root_of(&exe), Some(PathBuf::from("R")));
        assert_eq!(root_of(Path::new("harness.exe")), None);
        assert_eq!(root_of(Path::new("")), None);
    }

    #[test]
    fn a_program_whose_path_is_unknown_or_whose_install_is_broken_exits_3() {
        assert_eq!(run(Err(io::Error::from(io::ErrorKind::NotFound)), vec![]), EXIT_BROKEN);
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(run(Ok(dir.path().join("bin").join("harness.exe")), vec![]), EXIT_BROKEN);
    }

    #[test]
    fn the_sentence_names_powershell_and_the_install_command() {
        assert!(BROKEN.contains("open PowerShell and run: irm https://cdn.autonomous.ai/harness/cli/install.ps1 | iex"));
        assert!(!BROKEN.contains('\n'));
    }

    #[cfg(unix)]
    #[test]
    fn a_signal_is_128_plus_its_number() {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(exit_code(ExitStatus::from_raw(7 << 8)), 7);
        assert_eq!(exit_code(ExitStatus::from_raw(2)), 130);
    }
}
