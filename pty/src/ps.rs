//! The Windows process table (`harness-pty ps --json` and the `processes` op): what the daemon
//! recognizes engine processes by, as it reads `ps` on Unix.
//!
//! One Toolhelp snapshot gives every process's pid, parent and exe file name (`ps comm`). Each
//! process is then opened with `PROCESS_QUERY_LIMITED_INFORMATION` alone (no `PROCESS_VM_READ`,
//! which another user's or an elevated process would refuse) for its creation time (the identity
//! marker, `w:<FILETIME>`), its full image path and its command line
//! (`NtQueryInformationProcess(ProcessCommandLineInformation)`, Windows 8.1 and later), which
//! `CommandLineToArgvW` splits as the C runtime does.
//!
//! A process that has exited is left out, though Toolhelp still lists it while anything holds a
//! handle to it: a dead engine must not look alive. A process that cannot be opened (another
//! user's, a protected one, or one gone during the scan) keeps its pid, parent and exe name with
//! an empty marker; the daemon drops such rows, since they can never be an identity. One process
//! never fails the scan.

use serde::Serialize;

/// One process, in the daemon's `ProcessRow` shape.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRowJson {
    pub pid: u32,
    pub parent_pid: u32,
    /// The exe file name, as Toolhelp reports it.
    pub executable: String,
    /// `w:<creation FILETIME as a decimal u64>`, or empty when the process could not be read.
    pub start_marker: String,
    /// The raw command line; the exe name when it could not be read.
    pub args: String,
    /// `args` split by `CommandLineToArgvW`; `[executable]` when the command line could not be read.
    pub native_argv: Vec<String>,
    /// The full image path, when it could be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_path: Option<String>,
}

#[cfg(windows)]
pub use windows::snapshot;

#[cfg(windows)]
mod windows {
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    use windows_sys::Wdk::System::Threading::{
        NtQueryInformationProcess, ProcessBasicInformation, ProcessCommandLineInformation,
    };
    use windows_sys::Win32::Foundation::{
        ERROR_NO_MORE_FILES, FILETIME, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
        NTSTATUS, STATUS_BUFFER_OVERFLOW, STATUS_BUFFER_TOO_SMALL, STATUS_INFO_LENGTH_MISMATCH,
        STILL_ACTIVE, UNICODE_STRING, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_BASIC_INFORMATION,
        PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
        QueryFullProcessImageNameW, WaitForSingleObject,
    };
    use windows_sys::Win32::UI::Shell::CommandLineToArgvW;

    use super::ProcessRowJson;

    /// Every process on the machine now.
    pub fn snapshot() -> io::Result<Vec<ProcessRowJson>> {
        let mut reader = Reader::default();
        Ok(listed()?
            .into_iter()
            .filter_map(|(pid, parent_pid, executable)| reader.row(pid, parent_pid, executable))
            .collect())
    }

    /// (pid, parent, exe file name) of every process in one Toolhelp snapshot.
    fn listed() -> io::Result<Vec<(u32, u32, String)>> {
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snap = unsafe { OwnedHandle::from_raw_handle(snap as _) };
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut out = Vec::with_capacity(512);
        let mut ok = unsafe { Process32FirstW(snap.as_raw_handle() as _, &mut entry) };
        while ok != 0 {
            let name = &entry.szExeFile;
            let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
            out.push((
                entry.th32ProcessID,
                entry.th32ParentProcessID,
                String::from_utf16_lossy(&name[..len]),
            ));
            ok = unsafe { Process32NextW(snap.as_raw_handle() as _, &mut entry) };
        }
        if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
            return Err(io::Error::last_os_error());
        }
        Ok(out)
    }

    /// Buffers reused from one process to the next.
    #[derive(Default)]
    struct Reader {
        path: Vec<u16>,
        /// `usize` words, so the `UNICODE_STRING` at its start is aligned.
        command_line: Vec<usize>,
    }

    impl Reader {
        /// The listed process's row, or `None` when it has exited: an exited process stays in the
        /// Toolhelp list while anything holds a handle to it, and must not look alive.
        fn row(&mut self, pid: u32, parent_pid: u32, executable: String) -> Option<ProcessRowJson> {
            let mut row = ProcessRowJson {
                pid,
                parent_pid,
                args: executable.clone(),
                native_argv: vec![executable.clone()],
                executable,
                start_marker: String::new(),
                image_path: None,
            };
            // Pid 0 is the idle process, which has nothing to open.
            if pid == 0 {
                return Some(row);
            }
            let Some((process, synchronize)) = open(pid) else {
                return Some(row);
            };
            let h = process.as_raw_handle() as HANDLE;
            if exited(h, synchronize) {
                return None;
            }
            // The pid may have been reused since the snapshot (its process exited and another
            // started): that one's parent is not the listed parent. Its marker would pair the
            // listed name with the newcomer's start, so the row is left unidentifiable.
            if parent(h) != Some(parent_pid) {
                return Some(row);
            }
            let Some(created) = creation_time(h) else {
                return Some(row);
            };
            row.start_marker = format!("w:{created}");
            row.image_path = self.image_path(h);
            if let Some(line) = self.command_line(h).filter(|l| !l.is_empty()) {
                row.native_argv = split(&line);
                row.args = String::from_utf16_lossy(&line);
            }
            Some(row)
        }

        fn image_path(&mut self, h: HANDLE) -> Option<String> {
            // The longest Win32 path, so one call always has room.
            self.path.resize(32_768, 0);
            let mut len = self.path.len() as u32;
            let ok = unsafe {
                QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, self.path.as_mut_ptr(), &mut len)
            };
            (ok != 0).then(|| String::from_utf16_lossy(&self.path[..len as usize]))
        }

        /// The command line's UTF-16 units.
        fn command_line(&mut self, h: HANDLE) -> Option<Vec<u16>> {
            let word = std::mem::size_of::<usize>();
            if self.command_line.is_empty() {
                self.command_line.resize(4096 / word, 0);
            }
            for _ in 0..3 {
                let size = (self.command_line.len() * word) as u32;
                let mut needed = 0u32;
                let status: NTSTATUS = unsafe {
                    NtQueryInformationProcess(
                        h,
                        ProcessCommandLineInformation,
                        self.command_line.as_mut_ptr().cast(),
                        size,
                        &mut needed,
                    )
                };
                if status >= 0 {
                    let s = unsafe { &*self.command_line.as_ptr().cast::<UNICODE_STRING>() };
                    if s.Buffer.is_null() || s.Length == 0 {
                        return Some(Vec::new());
                    }
                    let units = s.Length as usize / 2;
                    // The string lies in the buffer, after the header.
                    let start = self.command_line.as_ptr().cast::<u8>() as usize;
                    let end = start + size as usize;
                    let at = s.Buffer as usize;
                    if at < start || at + units * 2 > end {
                        return None;
                    }
                    return Some(unsafe { std::slice::from_raw_parts(s.Buffer, units) }.to_vec());
                }
                let short = [
                    STATUS_INFO_LENGTH_MISMATCH,
                    STATUS_BUFFER_TOO_SMALL,
                    STATUS_BUFFER_OVERFLOW,
                ];
                if !short.contains(&status) || needed <= size {
                    return None;
                }
                self.command_line
                    .resize((needed as usize).div_ceil(word), 0);
            }
            None
        }
    }

    /// The process opened for queries, and whether the handle can be waited on (`SYNCHRONIZE`,
    /// which a process may refuse while it still allows limited queries).
    fn open(pid: u32) -> Option<(OwnedHandle, bool)> {
        [
            (
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                true,
            ),
            (PROCESS_QUERY_LIMITED_INFORMATION, false),
        ]
        .into_iter()
        .find_map(|(access, synchronize)| {
            let handle = unsafe { OpenProcess(access, 0, pid) };
            (!handle.is_null()).then(|| {
                (
                    unsafe { OwnedHandle::from_raw_handle(handle as _) },
                    synchronize,
                )
            })
        })
    }

    /// Whether the process has exited: its handle is signaled; without `SYNCHRONIZE`, it has an
    /// exit code (a live process reports `STILL_ACTIVE`).
    fn exited(h: HANDLE, synchronize: bool) -> bool {
        if synchronize {
            return unsafe { WaitForSingleObject(h, 0) } == WAIT_OBJECT_0;
        }
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(h, &mut code) != 0 && code != STILL_ACTIVE as u32 }
    }

    /// The parent the kernel recorded for the process.
    fn parent(h: HANDLE) -> Option<u32> {
        let mut info: PROCESS_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<PROCESS_BASIC_INFORMATION>() as u32;
        let status = unsafe {
            NtQueryInformationProcess(
                h,
                ProcessBasicInformation,
                (&mut info as *mut PROCESS_BASIC_INFORMATION).cast(),
                size,
                std::ptr::null_mut(),
            )
        };
        (status >= 0).then_some(info.InheritedFromUniqueProcessId as u32)
    }

    /// The creation `FILETIME` as one number.
    fn creation_time(h: HANDLE) -> Option<u64> {
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        let ok = unsafe { GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user) };
        let value = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
        (ok != 0 && value != 0).then_some(value)
    }

    /// `CommandLineToArgvW` of a non-empty command line (an empty one would give this process's
    /// own path).
    fn split(line: &[u16]) -> Vec<String> {
        let mut z = line.to_vec();
        z.push(0);
        let mut n = 0i32;
        let argv = unsafe { CommandLineToArgvW(z.as_ptr(), &mut n) };
        if argv.is_null() {
            return vec![String::from_utf16_lossy(line)];
        }
        let words = unsafe { std::slice::from_raw_parts(argv, n.max(0) as usize) };
        let out = words
            .iter()
            .map(|&w| {
                let len = (0..).take_while(|&i| unsafe { *w.add(i) } != 0).count();
                String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(w, len) })
            })
            .collect();
        unsafe { LocalFree(argv.cast()) };
        out
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::time::{Duration, Instant};

        #[test]
        fn snapshot_contains_self_with_command_line() {
            let rows = snapshot().unwrap();
            let me = rows
                .iter()
                .find(|r| r.pid == std::process::id())
                .expect("self row");
            assert!(me.start_marker.starts_with("w:"));
            assert!(
                me.args.contains("harness_pty") || me.args.contains("ps-"),
                "{}",
                me.args
            );
            assert_eq!(
                me.native_argv.first().map(|s| s.ends_with(".exe")),
                Some(true)
            );
            assert!(
                me.image_path
                    .as_deref()
                    .is_some_and(|p| p.to_lowercase().ends_with(&me.executable.to_lowercase())),
                "{me:?}"
            );
        }

        fn row(rows: &[ProcessRowJson], pid: u32) -> Option<&ProcessRowJson> {
            rows.iter().find(|r| r.pid == pid)
        }

        #[test]
        fn a_child_is_listed_under_this_process_with_its_command_line() {
            let mut child = std::process::Command::new("ping.exe")
                .args(["-n", "30", "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let first = snapshot().unwrap();
            let c = row(&first, child.id()).expect("child row").clone();
            assert_eq!(c.parent_pid, std::process::id());
            assert_eq!(c.executable.to_lowercase(), "ping.exe");
            assert!(c.start_marker.starts_with("w:"), "{c:?}");
            assert!(c.start_marker[2..].parse::<u64>().unwrap() > 0);
            assert!(c.args.ends_with("-n 30 127.0.0.1"), "{}", c.args);
            assert!(c.native_argv[0].to_lowercase().ends_with("ping.exe"));
            assert_eq!(c.native_argv[1..], ["-n", "30", "127.0.0.1"]);
            assert!(
                c.image_path
                    .as_deref()
                    .is_some_and(|p| p.to_lowercase().ends_with("\\ping.exe")),
                "{c:?}"
            );

            // The same process has the same marker in the next scan.
            let second = snapshot().unwrap();
            assert_eq!(
                row(&second, child.id()).map(|r| &r.start_marker),
                Some(&c.start_marker)
            );

            // Once it has exited, it is gone, though `child` still holds its handle (so its pid
            // cannot have been reused either).
            child.kill().unwrap();
            child.wait().unwrap();
            let after = snapshot().unwrap();
            assert_eq!(row(&after, c.pid), None);
        }

        #[test]
        fn an_exited_process_is_not_listed_while_a_handle_keeps_it() {
            let mut child = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "exit 3"])
                .spawn()
                .unwrap();
            assert_eq!(child.wait().unwrap().code(), Some(3));
            // `child` still holds its process handle, so the kernel keeps the exited process
            // (and Toolhelp lists it) until it is dropped.
            let rows = snapshot().unwrap();
            assert_eq!(row(&rows, child.id()), None);
            drop(child);
        }

        #[test]
        fn command_lines_split_as_the_c_runtime_does() {
            let line: Vec<u16> =
                r#""C:\Program Files\a.exe" -p "two words" x\"y"#.encode_utf16().collect();
            assert_eq!(
                split(&line),
                [r"C:\Program Files\a.exe", "-p", "two words", "x\"y"]
            );
        }

        #[test]
        fn rows_that_cannot_be_read_keep_their_names() {
            let rows = snapshot().unwrap();
            // The idle process and System are never opened for their command line.
            let idle = row(&rows, 0).expect("idle row");
            assert_eq!(idle.start_marker, "");
            assert_eq!(idle.args, idle.executable);
            assert_eq!(idle.native_argv, vec![idle.executable.clone()]);
            let system = row(&rows, 4).expect("System row");
            assert_eq!(system.executable, "System");
            // Serialized in the daemon's field names; no image path key when there is none.
            let json = serde_json::to_value(idle).unwrap();
            assert!(json.get("parentPid").is_some() && json.get("nativeArgv").is_some());
            assert!(json.get("startMarker").is_some() && json.get("imagePath").is_none());
        }

        #[test]
        fn a_scan_is_quick() {
            // The fastest of a few scans: the scan's own cost, not the time the other tests (which
            // start shells in parallel) keep this thread off the CPU.
            snapshot().unwrap();
            let (took, rows) = (0..5)
                .map(|_| {
                    let start = Instant::now();
                    let rows = snapshot().unwrap().len();
                    (start.elapsed(), rows)
                })
                .min()
                .unwrap();
            eprintln!("ps: {rows} rows in {took:?}");
            assert!(took < Duration::from_millis(500), "{took:?}");
        }
    }
}
