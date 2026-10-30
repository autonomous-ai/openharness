//! `harness-launch` is how the CLI starts in the background on Windows (spec section 1, "Launchers"). Three things
//! use it: the scheduled task, `harness start` from a terminal, and a master handing over to its replacement.
//!
//! It resolves the installed Node and CLI from the pointer files that install.ps1 and the updater keep. It then
//! starts `node.exe <cli.js> <args>` with no visible window and outside any job, and exits 0 as soon as the CLI has
//! started. When it cannot, it exits non-zero and says why in `<root>\cli\data\logs\launch.log`: a GUI-subsystem
//! program has no console to say it on.
//!
//! It reads the pointers by the CLI's rules (cli/src/lib/windows/installLayout.ts):
//! - `cli\current` names one version folder;
//! - `runtime\current-node` names a node.exe inside `runtime\`, as on a Mac (`managedNodePath`).
//!
//! It builds and runs on Unix too, where it starts the CLI in a process group of its own, so `cargo test` covers
//! the resolver everywhere.

use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::breakaway::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP};

/// The CLI runs as a console program whose console nobody sees. It does not also get `DETACHED_PROCESS`, because
/// Windows ignores `CREATE_NO_WINDOW` beside it ("Process Creation Flags"). The CLI would then have no console at
/// all, and each console program it started without `windowsHide` would open a visible window.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const ERROR_ACCESS_DENIED: i32 = 5;

pub const USAGE: &str = "usage: harness-launch [--root <dir>] -- <cli args...>";
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_UNRESOLVED: i32 = 3;
pub const EXIT_SPAWN: i32 = 4;

#[derive(Debug, PartialEq, Eq)]
pub struct Invocation {
    pub root: Option<PathBuf>,
    pub args: Vec<OsString>,
}

/// `[--root <dir>] -- <cli args...>`. Everything after `--` belongs to the CLI and passes through unread.
pub fn parse(args: &[OsString]) -> Result<Invocation, String> {
    let mut root = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].to_str() {
            Some("--") => return Ok(Invocation { root, args: args[i + 1..].to_vec() }),
            Some("--root") => {
                let dir = args.get(i + 1).ok_or_else(|| format!("--root needs a folder\n{USAGE}"))?;
                root = Some(PathBuf::from(dir));
                i += 2;
            }
            _ => return Err(format!("unexpected argument {:?}\n{USAGE}", args[i])),
        }
    }
    Err(format!("missing `--` before the CLI's arguments\n{USAGE}"))
}

/// `%USERPROFILE%\.harness`, the folder install.ps1 installs into (`HOME` off Windows, for the tests).
pub fn default_root(env: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let home = env("USERPROFILE").or_else(|| env("HOME")).filter(|home| !home.is_empty())?;
    Some(PathBuf::from(home).join(".harness"))
}

#[derive(Debug, PartialEq, Eq)]
pub struct Resolved {
    pub node: PathBuf,
    pub cli_js: PathBuf,
}

/// A pointer names one folder: never `.`, any `..`, a separator, or a `:` (a drive or an NTFS stream).
pub fn single_segment(value: &str) -> bool {
    !value.is_empty() && value != "." && !value.contains("..") && !value.contains(['/', '\\', ':', '\0'])
}

pub(crate) fn read_pointer(file: &Path) -> Result<String, String> {
    let text = fs::read_to_string(file).map_err(|err| format!("cannot read {}: {err}", file.display()))?;
    // A leading byte order mark, as Notepad and Windows PowerShell 5.1 write one: Node's trim() drops it, so must this.
    let line = text.strip_prefix('\u{feff}').unwrap_or(&text).lines().next().unwrap_or("").trim().to_owned();
    if line.is_empty() {
        return Err(format!("{} is empty", file.display()));
    }
    Ok(line)
}

/// Whether `file` resolves inside `dir`. Both sides are compared resolved, so a `..`, a junction or a symlink that
/// leads out is caught. The case is the disk's own, on both sides.
fn contained(dir: &Path, file: &Path) -> bool {
    match (fs::canonicalize(dir), fs::canonicalize(file)) {
        (Ok(dir), Ok(file)) => file != dir && file.starts_with(&dir),
        _ => false,
    }
}

/// The node.exe and cli.js the install's pointers name, by the rules the CLI applies to them.
pub fn resolve(root: &Path) -> Result<Resolved, String> {
    let runtime = root.join("runtime");
    let pointer = runtime.join("current-node");
    let node = PathBuf::from(read_pointer(&pointer)?);
    if !node.is_absolute() {
        return Err(format!("{} names {}, which is not inside {}", pointer.display(), node.display(), runtime.display()));
    }
    if !node.is_file() {
        return Err(format!("the Node runtime {} that {} names is missing", node.display(), pointer.display()));
    }
    if !contained(&runtime, &node) {
        return Err(format!("{} names {}, which is not inside {}", pointer.display(), node.display(), runtime.display()));
    }
    let cli = root.join("cli");
    let version = read_pointer(&cli.join("current"))?;
    if !single_segment(&version) {
        return Err(format!("{} names {version:?}, which is not one version folder", cli.join("current").display()));
    }
    let cli_js = cli.join(&version).join("cli.js");
    if !cli_js.is_file() || !contained(&cli, &cli_js) {
        return Err(format!("the CLI {} that cli\\current names is missing", cli_js.display()));
    }
    Ok(Resolved { node, cli_js })
}

/// Start the CLI. The first attempt is outside the job this launcher runs in: an SSH session's job, or the task's,
/// ends every process in it when it closes. A job with no `BREAKAWAY_OK` refuses that with `ERROR_ACCESS_DENIED`
/// (a Harness pane's job is one). Then the CLI is started inside it, with a warning, as the pty host does
/// (breakaway.rs). Any other failure is the answer.
pub fn start(mut spawn: impl FnMut(u32) -> io::Result<u32>, mut warn: impl FnMut(String)) -> io::Result<u32> {
    let base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
    match spawn(base | CREATE_BREAKAWAY_FROM_JOB) {
        Ok(pid) => Ok(pid),
        Err(err) if err.raw_os_error() == Some(ERROR_ACCESS_DENIED) => {
            warn(format!("the job this launcher runs in refuses a breakaway ({err}): the CLI starts inside the job, and may end with it"));
            spawn(base)
        }
        Err(err) => Err(err),
    }
}

/// One line in `<root>\cli\data\logs\launch.log`, beside the daemon's own logs. A log that cannot be written is
/// not a second failure: the exit code still says it.
pub fn log_failure(root: &Path, message: &str) {
    let dir = root.join("cli").join("data").join("logs");
    let _ = fs::create_dir_all(&dir);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(dir.join("launch.log")) {
        let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(file, "{seconds} harness-launch: {message}");
    }
}

/// Append [arg] to a command line, quoted so the C runtime (and `CommandLineToArgvW`) splits it back to [arg]:
/// quoted when it is empty or holds a space or a tab; a `"` escaped, and the backslashes before it doubled, as are
/// the backslashes before a closing quote. Other backslashes are literal.
pub fn quote_arg(arg: &[u16], out: &mut Vec<u16>) {
    const QUOTE: u16 = b'"' as u16;
    const BACKSLASH: u16 = b'\\' as u16;
    let quote = arg.is_empty() || arg.iter().any(|&c| c == b' ' as u16 || c == b'\t' as u16);
    if quote {
        out.push(QUOTE);
    }
    let mut backslashes = 0;
    for &c in arg {
        if c == BACKSLASH {
            backslashes += 1;
        } else {
            if c == QUOTE {
                out.extend(std::iter::repeat_n(BACKSLASH, backslashes + 1));
            }
            backslashes = 0;
        }
        out.push(c);
    }
    if quote {
        out.extend(std::iter::repeat_n(BACKSLASH, backslashes));
        out.push(QUOTE);
    }
}

/// `"<node>" <cli.js> <args>` for CreateProcessW. The program's own name is always quoted: Windows reads the first
/// word by quotes alone.
#[cfg(windows)]
pub fn command_line(node: &Path, cli_js: &Path, args: &[OsString]) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let mut line: Vec<u16> = Vec::new();
    line.push(b'"' as u16);
    line.extend(node.as_os_str().encode_wide());
    line.push(b'"' as u16);
    for arg in std::iter::once(cli_js.as_os_str()).chain(args.iter().map(|arg| arg.as_os_str())) {
        line.push(b' ' as u16);
        quote_arg(&arg.encode_wide().collect::<Vec<u16>>(), &mut line);
    }
    line
}

/// Spawn `node.exe <cli.js> <args>` from the install's root with no stdio, so the CLI holds no handle of the
/// launcher's and the launcher can exit. It returns the CLI's pid.
#[cfg(unix)]
fn spawn_cli(resolved: &Resolved, args: &[OsString], root: &Path, flags: u32) -> io::Result<u32> {
    use std::os::unix::process::CommandExt;
    let _ = flags;
    Command::new(&resolved.node)
        .arg(&resolved.cli_js)
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map(|child| child.id())
}

/// Windows: CreateProcessW itself, because the CLI must inherit no handle but its NUL stdio. `Command` (and libuv,
/// for whatever started this launcher) creates a child with every inheritable handle of its parent: an SSH session's
/// output, or the pipe a PowerShell pipeline reads `harness start` through, went from the CLI to the master, its core
/// and the terminal host. The caller then waited on it for as long as the daemon ran: `ssh host "harness start"` did
/// not return, and install.ps1 hung (B3.15, on the VM). `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` names the one handle the
/// CLI gets: NUL, as its stdin, stdout and stderr. The environment is this launcher's, as `Command` passed it.
#[cfg(windows)]
fn spawn_cli(resolved: &Resolved, args: &[OsString], root: &Path, flags: u32) -> io::Result<u32> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, TRUE};
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList, UpdateProcThreadAttribute,
        EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    let wide = |path: &Path| path.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let application = wide(&resolved.node);
    let directory = wide(root);
    let mut line = command_line(&resolved.node, &resolved.cli_js, args);
    line.push(0);

    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: TRUE,
    };
    let nul_name: Vec<u16> = "NUL".encode_utf16().chain(std::iter::once(0)).collect();
    let nul: HANDLE = unsafe {
        CreateFileW(nul_name.as_ptr(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, OPEN_EXISTING, 0, std::ptr::null_mut())
    };
    if nul == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }

    // The attribute list, in a buffer aligned for the pointers it holds.
    let mut size = 0usize;
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
    let mut buffer = vec![0usize; size.div_ceil(std::mem::size_of::<usize>()).max(1)];
    let list: LPPROC_THREAD_ATTRIBUTE_LIST = buffer.as_mut_ptr().cast();
    let handles = [nul];
    let outcome = (|| {
        if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let updated = unsafe {
            UpdateProcThreadAttribute(
                list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize, handles.as_ptr().cast(), std::mem::size_of_val(&handles),
                std::ptr::null_mut(), std::ptr::null(),
            )
        };
        let result = if updated == 0 {
            Err(io::Error::last_os_error())
        } else {
            let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
            startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = nul;
            startup.StartupInfo.hStdOutput = nul;
            startup.StartupInfo.hStdError = nul;
            startup.lpAttributeList = list;
            let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
            let created = unsafe {
                CreateProcessW(
                    application.as_ptr(), line.as_mut_ptr(), std::ptr::null(), std::ptr::null(), TRUE,
                    flags | EXTENDED_STARTUPINFO_PRESENT, std::ptr::null(), directory.as_ptr(),
                    (&startup as *const STARTUPINFOEXW).cast(), &mut info,
                )
            };
            if created == 0 {
                Err(io::Error::last_os_error())
            } else {
                unsafe {
                    CloseHandle(info.hThread);
                    CloseHandle(info.hProcess);
                }
                Ok(info.dwProcessId)
            }
        };
        unsafe { DeleteProcThreadAttributeList(list) };
        result
    })();
    unsafe { CloseHandle(nul) };
    outcome
}

/// The program: 0 once the CLI has started. A usage error is 2 and goes unlogged: whatever called the launcher
/// wrongly sees the code, and with no `--root` there is no folder of the caller's to log in. 3 when the install
/// does not resolve, 4 when the CLI does not start; both are logged.
pub fn run(args: Vec<OsString>) -> i32 {
    let invocation = match parse(&args) {
        Ok(invocation) => invocation,
        Err(err) => {
            eprintln!("{err}");
            return EXIT_USAGE;
        }
    };
    let Some(root) = invocation.root.clone().or_else(|| default_root(|key| std::env::var_os(key))) else {
        eprintln!("harness-launch: no USERPROFILE, and no --root");
        return EXIT_UNRESOLVED;
    };
    let root = std::path::absolute(&root).unwrap_or(root);
    let resolved = match resolve(&root) {
        Ok(resolved) => resolved,
        Err(err) => {
            log_failure(&root, &err);
            return EXIT_UNRESOLVED;
        }
    };
    match start(|flags| spawn_cli(&resolved, &invocation.args, &root, flags), |warning| log_failure(&root, &warning)) {
        Ok(_) => 0,
        Err(err) => {
            log_failure(&root, &format!("could not start {} {}: {err}", resolved.node.display(), resolved.cli_js.display()));
            EXIT_SPAWN
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::breakaway::DETACHED_PROCESS;

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_a_root_and_takes_everything_after_the_separator_for_the_cli() {
        assert_eq!(
            parse(&os(&["--", "start", "--if-down"])).unwrap(),
            Invocation { root: None, args: os(&["start", "--if-down"]) }
        );
        assert_eq!(
            parse(&os(&["--root", "R", "--", "version"])).unwrap(),
            Invocation { root: Some(PathBuf::from("R")), args: os(&["version"]) }
        );
        // What follows `--` is the CLI's, even another `--root` or `--`.
        assert_eq!(parse(&os(&["--", "--root", "x", "--"])).unwrap().args, os(&["--root", "x", "--"]));
    }

    /// Final review R1a-4: a pointer saved with a BOM (Notepad, `Set-Content -Encoding UTF8` on PowerShell 5.1) worked
    /// for the daemon, whose JS trim() drops U+FEFF, but not here: harness.exe said "not installed completely" and the
    /// scheduled task's launcher exited 3. Read as Node reads it.
    #[test]
    fn reads_a_pointer_saved_with_a_byte_order_mark_as_node_does() {
        let dir = std::env::temp_dir().join(format!("harness-launch-bom-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("current");
        fs::write(&file, "\u{feff}0.5.0\r\n").unwrap();
        assert_eq!(read_pointer(&file).unwrap(), "0.5.0");
        fs::write(&file, "\u{feff}\r\n").unwrap();
        assert!(read_pointer(&file).unwrap_err().contains("is empty"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_a_command_line_without_the_separator() {
        assert!(parse(&os(&[])).unwrap_err().contains("missing `--`"));
        assert!(parse(&os(&["start"])).unwrap_err().contains("unexpected argument"));
        assert!(parse(&os(&["--root"])).unwrap_err().contains("--root needs a folder"));
    }

    #[test]
    fn the_default_root_is_the_profiles_harness_folder() {
        let env = |key: &str| (key == "USERPROFILE").then(|| OsString::from("P"));
        assert_eq!(default_root(env), Some(PathBuf::from("P").join(".harness")));
        let unix = |key: &str| (key == "HOME").then(|| OsString::from("H"));
        assert_eq!(default_root(unix), Some(PathBuf::from("H").join(".harness")));
        assert_eq!(default_root(|_| None), None);
        assert_eq!(default_root(|_| Some(OsString::new())), None);
    }

    /// An install under `root`: a node.exe inside runtime\ named by current-node, and cli\<version>\cli.js
    /// named by cli\current, both written with CRLF as install.ps1 writes them.
    fn install(root: &Path, version: &str) -> PathBuf {
        let node_dir = root.join("runtime").join("node-v22.0.0-win32-x64");
        fs::create_dir_all(&node_dir).unwrap();
        let node = node_dir.join("node.exe");
        fs::write(&node, b"").unwrap();
        fs::write(root.join("runtime").join("current-node"), format!("{}\r\n", node.display())).unwrap();
        let cli = root.join("cli").join(version);
        fs::create_dir_all(&cli).unwrap();
        fs::write(cli.join("cli.js"), b"").unwrap();
        fs::write(root.join("cli").join("current"), format!("{version}\r\n")).unwrap();
        node
    }

    #[test]
    fn resolves_the_node_and_the_cli_the_pointers_name() {
        let dir = tempfile::tempdir().unwrap();
        let node = install(dir.path(), "1.2.3");
        let resolved = resolve(dir.path()).unwrap();
        assert_eq!(resolved.node, node);
        assert_eq!(resolved.cli_js, dir.path().join("cli").join("1.2.3").join("cli.js"));
    }

    #[test]
    fn refuses_a_node_outside_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        install(root, "1.2.3");
        let outside = tempfile::tempdir().unwrap();
        let elsewhere = outside.path().join("node.exe");
        fs::write(&elsewhere, b"").unwrap();
        let current_node = root.join("runtime").join("current-node");
        fs::write(&current_node, elsewhere.display().to_string()).unwrap();
        assert!(resolve(root).unwrap_err().contains("not inside"));
        // A relative name is no better.
        fs::write(&current_node, "node.exe").unwrap();
        assert!(resolve(root).unwrap_err().contains("not inside"));
        // Nor is one that climbs out of runtime\ and back to a real file.
        let climbing = root.join("runtime").join("..").join("cli").join("1.2.3").join("cli.js");
        fs::write(&current_node, climbing.display().to_string()).unwrap();
        assert!(resolve(root).unwrap_err().contains("not inside"));
    }

    #[test]
    fn refuses_a_cli_pointer_that_names_more_than_one_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        install(root, "1.2.3");
        for bad in ["..", "../1.2.3", "1.2.3\\..\\x", "a/b", "C:x", "  "] {
            fs::write(root.join("cli").join("current"), bad).unwrap();
            assert!(resolve(root).is_err(), "{bad:?}");
            assert!(!single_segment(bad.trim()), "{bad:?}");
        }
        assert!(single_segment("0.3.120-dev.abc123"));
    }

    #[test]
    fn says_which_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve(dir.path()).unwrap_err().contains("current-node"));
        install(dir.path(), "1.2.3");
        fs::remove_file(dir.path().join("cli").join("1.2.3").join("cli.js")).unwrap();
        assert!(resolve(dir.path()).unwrap_err().contains("cli.js"));
    }

    const DENIED: i32 = 5; // ERROR_ACCESS_DENIED

    #[test]
    fn starts_the_cli_outside_the_job_with_a_console_nobody_sees() {
        let mut flags = Vec::new();
        let pid = start(|f| { flags.push(f); Ok(7) }, |w| panic!("no warning expected: {w}")).unwrap();
        assert_eq!(pid, 7);
        assert_eq!(flags, [CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB]);
        // With DETACHED_PROCESS, Windows ignores CREATE_NO_WINDOW. The CLI would then have no console, and every
        // console program it starts would open a visible window of its own.
        assert_eq!(flags[0] & DETACHED_PROCESS, 0);
    }

    #[test]
    fn a_job_that_forbids_breakaway_gets_the_cli_inside_it_and_a_warning() {
        let mut flags = Vec::new();
        let mut warnings = Vec::new();
        let pid = start(
            |f| {
                flags.push(f);
                if f & CREATE_BREAKAWAY_FROM_JOB != 0 { Err(io::Error::from_raw_os_error(DENIED)) } else { Ok(9) }
            },
            |w| warnings.push(w),
        )
        .unwrap();
        assert_eq!(pid, 9);
        assert_eq!(flags, [CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP]);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("inside the job"), "{warnings:?}");
    }

    #[test]
    fn any_other_failure_is_reported_and_not_retried() {
        let mut calls = 0;
        let err = start(|_| { calls += 1; Err(io::Error::from(io::ErrorKind::NotFound)) }, |_| {}).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert_eq!(calls, 1);
    }

    fn quoted(arg: &str) -> String {
        let mut out = Vec::new();
        quote_arg(&arg.encode_utf16().collect::<Vec<u16>>(), &mut out);
        String::from_utf16(&out).unwrap()
    }

    #[test]
    fn quotes_each_argument_as_the_c_runtime_splits_it() {
        assert_eq!(quoted("start"), "start");
        assert_eq!(quoted(""), r#""""#);
        assert_eq!(quoted(r"C:\Users\Jö 日 & co\.harness"), r#""C:\Users\Jö 日 & co\.harness""#);
        // Backslashes are literal unless a quote follows them: then each is doubled, and the quote escaped.
        assert_eq!(quoted(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quoted(r#"a\"b"#), r#"a\\\"b"#);
        assert_eq!(quoted(r"C:\a b\"), r#""C:\a b\\""#);
        assert_eq!(quoted(r"C:\ab\"), r"C:\ab\");
    }

    #[cfg(windows)]
    #[test]
    fn the_command_line_splits_back_into_the_arguments() {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::UI::Shell::CommandLineToArgvW;
        let args = os(&["start", "--if-down", "", "two words", r#"a\"b"#, r"C:\a b\", "Jö 日 & co"]);
        let mut line = command_line(&PathBuf::from(r"C:\Program Files\node.exe"), &PathBuf::from(r"C:\x y\cli.js"), &args);
        line.push(0);
        let mut n = 0i32;
        let argv = unsafe { CommandLineToArgvW(line.as_ptr(), &mut n) };
        assert!(!argv.is_null());
        let words: Vec<String> = unsafe { std::slice::from_raw_parts(argv, n as usize) }
            .iter()
            .map(|&w| {
                let len = (0..).take_while(|&i| unsafe { *w.add(i) } != 0).count();
                String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(w, len) })
            })
            .collect();
        unsafe { LocalFree(argv.cast()) };
        let mut expected = vec![r"C:\Program Files\node.exe".to_owned(), r"C:\x y\cli.js".to_owned()];
        expected.extend(args.iter().map(|a| a.to_string_lossy().into_owned()));
        assert_eq!(words, expected);
    }

    #[test]
    fn a_failure_is_logged_in_the_data_folders_logs() {
        let dir = tempfile::tempdir().unwrap();
        log_failure(dir.path(), "first");
        log_failure(dir.path(), "second");
        let log = fs::read_to_string(dir.path().join("cli").join("data").join("logs").join("launch.log")).unwrap();
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with("harness-launch: first"), "{log}");
        assert!(lines[1].ends_with("harness-launch: second"), "{log}");
    }
}
