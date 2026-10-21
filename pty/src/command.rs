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
//! It builds and runs on Unix too, so `cargo test` covers the resolution and the exit code everywhere.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};

use crate::launcher::{Resolved, resolve};

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

/// Run the resolved CLI with [args] and wait for it.
pub fn run_resolved(resolved: &Resolved, args: &[OsString]) -> io::Result<ExitStatus> {
    Command::new(&resolved.node).arg(&resolved.cli_js).args(args).status()
}

/// The program, given its own path and its arguments: node's exit code; 3 when the install does not resolve, 4 when
/// node does not start.
pub fn run(exe: io::Result<PathBuf>, args: Vec<OsString>) -> i32 {
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
