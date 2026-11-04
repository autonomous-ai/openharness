//! What a Mac or Linux and Windows do differently outside the terminal and its sockets (./sock.rs, ./local.rs).

use std::path::PathBuf;

/// What a process in this hn is told to find its home and shell by: 28 places read `$HOME` and `$SHELL`. Windows sets
/// neither for a program it starts, so they are given their Windows meanings once, before anything else runs and before
/// any thread starts, and each of those places keeps its one meaning.
pub fn prepare_environment() {
    #[cfg(windows)]
    {
        if std::env::var_os("HOME").is_none_or(|home| home.is_empty()) {
            if let Some(profile) = std::env::var_os("USERPROFILE") {
                // SAFETY: first thing in main, before the runtime or any other thread starts.
                unsafe { std::env::set_var("HOME", profile) }
            }
        }
        if std::env::var_os("SHELL").is_none_or(|shell| shell.is_empty()) {
            // SAFETY: as above.
            unsafe { std::env::set_var("SHELL", windows_shell()) }
        }
    }
}

/// A console that reads the escape sequences hn writes. Windows Terminal and conhost both take them, once asked; without this
/// they print them. Input is the reader thread's (term_input.rs).
pub fn prepare_console() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::{CONSOLE_MODE, DISABLE_NEWLINE_AUTO_RETURN, ENABLE_PROCESSED_OUTPUT, ENABLE_VIRTUAL_TERMINAL_PROCESSING, GetConsoleMode, GetStdHandle, STD_OUTPUT_HANDLE, SetConsoleMode};
        // SAFETY: the process's own output handle; a handle that is no console fails harmlessly.
        unsafe {
            let out = GetStdHandle(STD_OUTPUT_HANDLE);
            let mut mode: CONSOLE_MODE = 0;
            if GetConsoleMode(out, &mut mode) != 0 {
                SetConsoleMode(out, mode | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN);
            }
        }
    }
}

/// The shell a new pane runs when nothing names one: PowerShell, what a Windows terminal opens.
#[cfg(windows)]
fn windows_shell() -> String {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    format!(r"{root}\System32\WindowsPowerShell\v1.0\powershell.exe")
}

/// What runs hn's jobs and a tmux config's commands: `/bin/sh`, or Git Bash on Windows, which Harness needs anyway. They are
/// shell text written for sh wherever they come from: a `.tmux.conf`, `#()`, `run-shell`.
pub fn sh() -> String {
    #[cfg(unix)] { "/bin/sh".to_string() }
    #[cfg(windows)] { git_bash().unwrap_or_else(|| "bash.exe".to_string()) }
}

/// Git Bash, where Git for Windows puts it: for the machine, then this user alone. `bash.exe` on PATH may be WSL's.
#[cfg(windows)]
fn git_bash() -> Option<String> {
    let candidates = [
        std::env::var("ProgramFiles").ok().map(|p| format!(r"{p}\Git\bin\bash.exe")),
        std::env::var("ProgramFiles(x86)").ok().map(|p| format!(r"{p}\Git\bin\bash.exe")),
        std::env::var("LOCALAPPDATA").ok().map(|p| format!(r"{p}\Programs\Git\bin\bash.exe")),
    ];
    candidates.into_iter().flatten().find(|path| std::path::Path::new(path).is_file())
}

/// Whether a path is a Windows one: `C:\work`, `C:/work`, `\\server\share`. By what it says and never by this computer: hn on a
/// Mac shows the folders of a Windows machine, and the other way round.
pub fn windows_path(path: &str) -> bool {
    let b = path.as_bytes();
    path.starts_with(r"\\") || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/'))
}

/// Whether a path, from any computer, names a folder from its root.
pub fn path_absolute(path: &str) -> bool { path.starts_with('/') || windows_path(path) }

/// A path's last part, from any computer: a backslash is a separator only in a Windows path, and a name's own character elsewhere.
pub fn path_name(path: &str) -> &str {
    if windows_path(path) {
        let trimmed = path.trim_end_matches(['/', '\\']);
        trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed)
    } else {
        let trimmed = path.trim_end_matches('/');
        trimmed.rsplit('/').next().unwrap_or(trimmed)
    }
}

/// The name of this program's shell, for a pane title.
pub fn shell_label(shell: &str) -> &str {
    let name = shell.rsplit(['/', '\\']).next().unwrap_or("sh");
    name.strip_suffix(".exe").unwrap_or(name)
}

/// How [shell] runs a command, and how it starts for a person. Mac and Linux: `-c` and a login shell.
pub fn shell_args(shell: &str, command: Option<&str>) -> Vec<String> {
    let program = shell_label(shell).to_ascii_lowercase();
    let strings = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let mut args = match (program.as_str(), command.is_some()) {
        ("powershell" | "pwsh", true) => strings(&["-NoLogo", "-Command"]),
        ("powershell" | "pwsh", false) => strings(&["-NoLogo"]),
        ("cmd", true) => strings(&["/d", "/s", "/c"]),
        ("cmd", false) => strings(&["/d"]),
        (_, true) => strings(&["-c"]),
        (_, false) => strings(&["-l", "-i"]),
    };
    if let Some(command) = command { args.push(command.to_string()); }
    args
}

/// Starts [command] on its own, so it outlives this process and takes no signal from its terminal: its own session, or on
/// Windows no console and out of any job this process is in.
pub fn detach(command: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe.
        unsafe { command.pre_exec(|| { if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) } }); }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
    }
}

/// Ends a job this process started as a group of its own, and what it started.
pub fn end_group(pid: i32) {
    #[cfg(unix)]
    // SAFETY: only signals; a group gone already is nothing.
    unsafe { libc::kill(-pid, libc::SIGTERM); }
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("taskkill");
        command.args(["/T", "/F", "/PID", &pid.to_string()]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        hide_console(&mut command);
        let _ = command.spawn();
    }
}

/// No console window flashing up for a background job.
#[cfg(windows)]
fn hide_console(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
}

// The C runtime's local time and date words on Windows, which the libc crate does not list.
#[cfg(windows)]
unsafe extern "C" {
    #[link_name = "_localtime64_s"]
    pub fn localtime(tm: *mut libc::tm, time: *const libc::time_t) -> i32;
    pub fn strftime(out: *mut libc::c_char, room: usize, format: *const libc::c_char, tm: *const libc::tm) -> usize;
}

/// [format] as Windows' strftime can take it: an unknown `%x` there is an invalid parameter, which ends the program, where a
/// Mac prints it. So those are written out as they stand. The rest mean what they mean on a Mac.
#[cfg(any(windows, test))]
pub fn strftime_format(format: &str) -> String {
    const KNOWN: &str = "aAbBcCdDeFgGhHIjmMnprRStTuUVwWxXyYzZ%";
    let mut out = String::with_capacity(format.len());
    let mut chars = format.chars();
    while let Some(c) = chars.next() {
        if c != '%' { out.push(c); continue }
        match chars.next() {
            Some(spec) if KNOWN.contains(spec) => { out.push('%'); out.push(spec) }
            Some(spec) => { out.push_str("%%"); out.push(spec) }
            None => out.push_str("%%"),
        }
    }
    out
}

/// Becomes [command]: this process's place taken on a Mac or Linux. Windows has no such call, so this one waits and leaves with
/// its exit code. Returns only if it could not start.
pub fn exec(command: &mut std::process::Command) -> std::io::Error {
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; command.exec() }
    #[cfg(windows)]
    {
        match command.status() {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(error) => error,
        }
    }
}

/// Whether process [pid] is running.
pub fn running(pid: u64) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = i32::try_from(pid) else { return false };
        if pid <= 0 { return false }
        // SAFETY: signal 0 sends nothing. There, or there and not ours to signal.
        let there = unsafe { libc::kill(pid, 0) } == 0;
        there || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForSingleObject};
        let Ok(pid) = u32::try_from(pid) else { return false };
        if pid == 0 { return false }
        // SAFETY: the handle is checked, waited on without blocking, and closed.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid);
            if process.is_null() { return std::io::Error::last_os_error().kind() == std::io::ErrorKind::PermissionDenied }
            let alive = WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
            CloseHandle(process);
            alive
        }
    }
}

/// This computer's name.
pub fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut bytes = [0u8; 256];
        // SAFETY: a buffer of the length said; the last byte stays NUL.
        if unsafe { libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len() - 1) } != 0 { return String::new() }
        let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
        String::from_utf8_lossy(&bytes[..end]).into_owned()
    }
    #[cfg(windows)]
    { std::env::var("COMPUTERNAME").unwrap_or_default() }
}

/// This computer's offset from UTC, in seconds, summer time included.
#[cfg(windows)]
pub fn utc_offset() -> i64 {
    use windows_sys::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
    // SAFETY: a zeroed struct the call fills in. Its bias is minutes west of UTC.
    unsafe {
        let mut zone: TIME_ZONE_INFORMATION = std::mem::zeroed();
        let extra = match GetTimeZoneInformation(&mut zone) { 1 => zone.StandardBias, 2 => zone.DaylightBias, _ => 0 };
        -i64::from(zone.Bias + extra) * 60
    }
}

/// This account's name, by its own record.
pub fn username() -> String {
    #[cfg(unix)]
    {
        // SAFETY: the record is read before anything else can call getpwuid on this thread.
        unsafe {
            let record = libc::getpwuid(libc::getuid());
            if record.is_null() { return String::new() }
            std::ffi::CStr::from_ptr((*record).pw_name).to_string_lossy().into_owned()
        }
    }
    #[cfg(windows)]
    { std::env::var("USERNAME").unwrap_or_default() }
}

/// This account's id, as a number where it has one: 0 on Windows, whose accounts have SIDs, and where nothing in hn asks.
pub fn uid() -> u32 {
    #[cfg(unix)]
    // SAFETY: getuid cannot fail.
    { unsafe { libc::getuid() } }
    #[cfg(windows)]
    { 0 }
}

/// The home of a named account: `~name`. None for an account hn cannot find.
pub fn home_of(name: &str) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        let name = std::ffi::CString::new(name).ok()?;
        // SAFETY: a NUL-terminated name; the record is read at once.
        unsafe {
            let record = libc::getpwnam(name.as_ptr());
            if record.is_null() { return None }
            Some(PathBuf::from(std::ffi::CStr::from_ptr((*record).pw_dir).to_string_lossy().into_owned()))
        }
    }
    #[cfg(windows)]
    {
        // Other accounts' profiles sit beside this one's.
        let profile = PathBuf::from(std::env::var_os("USERPROFILE")?);
        Some(profile.parent()?.join(name)).filter(|home| home.is_dir())
    }
}

/// [file] held for this process alone until it is dropped.
pub fn lock_file(file: &std::fs::File) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        // SAFETY: a valid descriptor, held open for as long as the lock.
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) == 0 }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{LOCKFILE_EXCLUSIVE_LOCK, LockFileEx};
        // SAFETY: a valid handle, a zeroed OVERLAPPED for offset 0; closing the file releases it.
        unsafe {
            let mut overlapped = std::mem::zeroed();
            LockFileEx(file.as_raw_handle() as _, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &mut overlapped) != 0
        }
    }
}

/// Whether this account may run [path], or write it.
pub fn executable(path: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return false };
        // SAFETY: a NUL-terminated path.
        unsafe { libc::access(c.as_ptr(), libc::X_OK) == 0 }
    }
    #[cfg(windows)]
    { path.is_file() }
}

pub fn writable(path: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return false };
        // SAFETY: a NUL-terminated path.
        unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
    }
    #[cfg(windows)]
    { std::fs::metadata(path).is_ok_and(|m| !m.permissions().readonly()) }
}

/// Options that make a new file its owner's alone: `0600`; on Windows the profile's ACL, inherited, says so.
pub fn private_file(options: &mut std::fs::OpenOptions) -> &mut std::fs::OpenOptions {
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600) }
    #[cfg(windows)]
    { options }
}

/// The signal that ended a child, where children end by signals.
pub fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    { use std::os::unix::process::ExitStatusExt; status.signal() }
    #[cfg(windows)]
    { let _ = status; None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_shell_runs_a_command_its_own_way() {
        assert_eq!(shell_args("/bin/zsh", None), ["-l", "-i"]);
        assert_eq!(shell_args("/bin/zsh", Some("ls")), ["-c", "ls"]);
        assert_eq!(shell_args(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe", None), ["-NoLogo"]);
        assert_eq!(shell_args(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe", Some("ls")), ["-NoLogo", "-Command", "ls"]);
        assert_eq!(shell_args(r"C:\Windows\System32\cmd.exe", Some("dir")), ["/d", "/s", "/c", "dir"]);
        assert_eq!(shell_args(r"C:\Program Files\Git\bin\bash.exe", None), ["-l", "-i"]);
    }

    #[test]
    fn a_path_reads_by_the_computer_it_is_from() {
        assert!(path_absolute("/Users/a") && path_absolute(r"C:\work") && path_absolute("C:/work") && path_absolute(r"\\pc\share"));
        assert!(!path_absolute("work") && !path_absolute("C:") && !path_absolute("~/work") && !path_absolute("a:b"));
        assert_eq!(path_name("/Users/a/project/"), "project");
        assert_eq!(path_name(r"C:\Users\a\project\"), "project");
        assert_eq!(path_name("C:/Users/a/project"), "project");
        // On a Mac or Linux a backslash is part of a name.
        assert_eq!(path_name(r"/tmp/odd\name"), r"odd\name");
        assert_eq!(path_name("project"), "project");
    }

    #[test]
    fn a_pane_is_named_for_its_program() {
        assert_eq!(shell_label("/bin/zsh"), "zsh");
        assert_eq!(shell_label(r"C:\Windows\System32\cmd.exe"), "cmd");
        assert_eq!(shell_label("sh"), "sh");
    }

    #[test]
    fn a_date_word_windows_does_not_know_is_written_out() {
        assert_eq!(strftime_format("%H:%M %d-%b-%y"), "%H:%M %d-%b-%y");
        assert_eq!(strftime_format("%k%l %%"), "%%k%%l %%");
        assert_eq!(strftime_format("100%"), "100%%");
    }

    #[test]
    fn this_process_is_running() {
        assert!(running(u64::from(std::process::id())));
        assert!(!running(0));
    }
}
