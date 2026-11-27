//! `harness-pty files --json <pid>…` (Windows): which disk files a few processes hold open, and the
//! folder each works in, as `lsof -c` and `lsof -d cwd` tell the daemon on macOS. The open scan reads
//! it to learn which Codex holds a rollout after a restart (docs/plans/2026-11-27-windows-codex-rescan-design.md).
//!
//! Each process is opened with `PROCESS_QUERY_INFORMATION | PROCESS_DUP_HANDLE | PROCESS_VM_READ` and
//! nothing that writes. Its handles come from `NtQueryInformationProcess(ProcessHandleInformation)`,
//! that process's alone; each is duplicated into this one with no access and no options (never
//! `DUPLICATE_CLOSE_SOURCE`, which would close the process's own) and closed at once, never used for
//! I/O. A handle is named only when `GetFileType` says disk and it is no folder: `NtQueryObject`,
//! the call tools name handles by, hangs on a synchronous pipe with a read pending. It is never
//! made here, and `GetFinalPathNameByHandleW`, which may make it inside, is asked only after that
//! check. The folder is the handle the process keeps on it (its parameters' `CurrentDirectory`, read
//! from its memory), named the same way, so it reads as Node's `realpath` names the session's
//! folder, whatever spelling the process was given.
//!
//! A process it may not open, that has exited, or past a bound is left out: unknown, never "holds
//! nothing". Nothing is logged; the paths go to stdout alone.

use std::collections::BTreeSet;

use serde::Serialize;

/// The most processes one run reads.
pub const MAX_PIDS: usize = 32;
/// The most handles a process may hold to be read (a Codex holds hundreds).
pub const MAX_HANDLES: usize = 65_536;
/// The most distinct files listed for a process.
pub const MAX_FILES: usize = 4096;
/// The longest path named, in UTF-16 units: the longest Windows allows.
pub const MAX_PATH_UNITS: usize = 32 * 1024;

/// One process, in the daemon's field names (cli/src/lib/windows/openFiles.ts).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenFilesRow {
    pub pid: u32,
    /// `w:<creation FILETIME>`, as `ps --json` gives it: the daemon drops a row whose marker is not
    /// its table's (a reused pid).
    pub start_marker: String,
    /// The folder it works in; absent when it could not be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Its open disk files, each once, sorted.
    pub files: Vec<String>,
}

/// A path `GetFinalPathNameByHandleW` gave, as libuv's `realpath` (Node's) turns it: `\\?\UNC\` made
/// `\\`, `\\?\` dropped. `None` for one that is not valid UTF-16.
pub fn dos_path(final_path: &[u16]) -> Option<String> {
    let path = String::from_utf16(final_path).ok()?;
    Some(if let Some(share) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{share}")
    } else if let Some(local) = path.strip_prefix(r"\\?\") {
        local.to_owned()
    } else {
        path
    })
}

/// [paths] each once, sorted; `None` past `MAX_FILES` distinct, as soon as it is passed.
pub fn collect(paths: impl IntoIterator<Item = String>) -> Option<Vec<String>> {
    let mut seen = BTreeSet::new();
    for path in paths {
        seen.insert(path);
        if seen.len() > MAX_FILES {
            return None;
        }
    }
    Some(seen.into_iter().collect())
}

#[cfg(windows)]
pub use windows::read;

#[cfg(windows)]
mod windows {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    use windows_sys::Wdk::System::Threading::{
        NtQueryInformationProcess, ProcessHandleInformation,
    };
    use windows_sys::Win32::Foundation::{DuplicateHandle, HANDLE, STATUS_INFO_LENGTH_MISMATCH};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_STANDARD_INFO, FILE_TYPE_DISK, FileStandardInfo, GetFileInformationByHandleEx,
        GetFileType, GetFinalPathNameByHandleW, VOLUME_NAME_DOS,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE, PROCESS_QUERY_INFORMATION,
        PROCESS_VM_READ,
    };

    use super::{MAX_HANDLES, MAX_PATH_UNITS, OpenFilesRow, collect, dos_path};
    use crate::ps::{process_exited, process_started};

    /// The rows of [pids] that could be read, in the order asked.
    pub fn read(pids: &[u32]) -> Vec<OpenFilesRow> {
        let mut path = vec![0u16; MAX_PATH_UNITS + 1];
        pids.iter().filter_map(|&pid| row(pid, &mut path)).collect()
    }

    /// [pid]'s row, or `None` when it cannot be opened (the idle process, System, another user's or
    /// an elevated one), has exited (a handle elsewhere keeps it listed), or is past a bound.
    fn row(pid: u32, path: &mut [u16]) -> Option<OpenFilesRow> {
        let rights = PROCESS_QUERY_INFORMATION | PROCESS_DUP_HANDLE | PROCESS_VM_READ;
        let process = unsafe { OpenProcess(rights, 0, pid) };
        if process.is_null() {
            return None;
        }
        // Held to the end: the pid cannot be reused meanwhile, so the marker and the files are
        // the same process's.
        let process = unsafe { OwnedHandle::from_raw_handle(process as _) };
        let h = process.as_raw_handle() as HANDLE;
        if process_exited(h, false) {
            return None;
        }
        let created = process_started(h)?;
        let files = files(h, path)?;
        Some(OpenFilesRow {
            pid,
            start_marker: format!("w:{created}"),
            cwd: folder(h, path),
            files,
        })
    }

    /// `PROCESS_HANDLE_TABLE_ENTRY_INFO`.
    #[repr(C)]
    struct HandleEntry {
        value: HANDLE,
        _count: usize,
        _pointers: usize,
        _access: u32,
        _type_index: u32,
        _attributes: u32,
        _reserved: u32,
    }

    /// `PROCESS_HANDLE_SNAPSHOT_INFORMATION`'s header; the entries follow it.
    #[repr(C)]
    struct HandleSnapshot {
        count: usize,
        _reserved: usize,
    }

    /// The handles [process] holds, or `None` when they cannot be read or are more than
    /// `MAX_HANDLES`.
    fn handles(process: HANDLE) -> Option<Vec<HANDLE>> {
        const HEADER: usize = size_of::<HandleSnapshot>();
        const ENTRY: usize = size_of::<HandleEntry>();
        const MOST: usize = HEADER + MAX_HANDLES * ENTRY;
        let word = size_of::<usize>();
        let mut size = HEADER + 1024 * ENTRY;
        for _ in 0..3 {
            // `usize` words, so the entries are aligned.
            let mut buffer = vec![0usize; size.div_ceil(word)];
            let size_given = buffer.len() * word;
            let mut needed = 0u32;
            let status = unsafe {
                NtQueryInformationProcess(
                    process,
                    ProcessHandleInformation,
                    buffer.as_mut_ptr().cast(),
                    size_given as u32,
                    &mut needed,
                )
            };
            if status >= 0 {
                let count = buffer[0];
                if count > MAX_HANDLES || HEADER + count * ENTRY > size_given {
                    return None;
                }
                let entries = unsafe {
                    let first = buffer
                        .as_ptr()
                        .cast::<u8>()
                        .add(HEADER)
                        .cast::<HandleEntry>();
                    std::slice::from_raw_parts(first, count)
                };
                return Some(entries.iter().map(|entry| entry.value).collect());
            }
            let needed = needed as usize;
            if status != STATUS_INFO_LENGTH_MISMATCH || needed <= size_given || needed > MOST {
                return None;
            }
            // Room for the handles it opens before the next call.
            size = (needed + 64 * ENTRY).min(MOST);
        }
        None
    }

    /// The disk files [process] holds, or `None` past a bound.
    fn files(process: HANDLE, path: &mut [u16]) -> Option<Vec<String>> {
        let mut too_long = false;
        // The first path too long to name ends the read: the row is left out.
        let named = handles(process)?.into_iter().map_while(|handle| {
            let file = name(process, handle, false, path);
            too_long |= file.is_err();
            file.ok()
        });
        let files = collect(named.flatten());
        if too_long {
            return None;
        }
        files
    }

    /// A path longer than `MAX_PATH_UNITS`.
    struct TooLong;

    /// [handle] of [process] as a path, when it is a disk folder ([folder]) or a disk file that is
    /// none; `Ok(None)` for anything else or what cannot be told.
    fn name(
        process: HANDLE,
        handle: HANDLE,
        folder: bool,
        path: &mut [u16],
    ) -> Result<Option<String>, TooLong> {
        let mut copy = std::ptr::null_mut();
        // No access and no options: never DUPLICATE_CLOSE_SOURCE, which would close the process's
        // own handle.
        let copied =
            unsafe { DuplicateHandle(process, handle, GetCurrentProcess(), &mut copy, 0, 0, 0) };
        if copied == 0 {
            return Ok(None);
        }
        let copy = unsafe { OwnedHandle::from_raw_handle(copy as _) };
        let h = copy.as_raw_handle() as HANDLE;
        // The I/O manager answers `GetFileType` without the file's own lock, so a pipe or a
        // console with a read pending is told apart without waiting on it.
        if unsafe { GetFileType(h) } != FILE_TYPE_DISK {
            return Ok(None);
        }
        let mut info: FILE_STANDARD_INFO = unsafe { std::mem::zeroed() };
        let told = unsafe {
            GetFileInformationByHandleEx(
                h,
                FileStandardInfo,
                (&mut info as *mut FILE_STANDARD_INFO).cast(),
                size_of::<FILE_STANDARD_INFO>() as u32,
            )
        };
        if told == 0 || (info.Directory != 0) != folder {
            return Ok(None);
        }
        let len = unsafe {
            GetFinalPathNameByHandleW(h, path.as_mut_ptr(), path.len() as u32, VOLUME_NAME_DOS)
        } as usize;
        match len {
            0 => Ok(None),
            // Too small: the length it needs.
            len if len >= path.len() => Err(TooLong),
            len => Ok(dos_path(&path[..len])),
        }
    }

    /// The folder [process] works in: the handle its parameters keep on it (`CurrentDirectory`),
    /// named. None for a 32-bit process, whose parameters are laid out otherwise, or when any step
    /// fails.
    #[cfg(target_pointer_width = "64")]
    fn folder(process: HANDLE, path: &mut [u16]) -> Option<String> {
        use std::mem::offset_of;
        use windows_sys::Wdk::System::Threading::ProcessBasicInformation;
        use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
        use windows_sys::Win32::System::Threading::{
            IsWow64Process, PEB, PROCESS_BASIC_INFORMATION,
        };

        /// `CurrentDirectory.Handle` in the 64-bit `RTL_USER_PROCESS_PARAMETERS`, past its
        /// `DosPath`, which keeps the spelling the process was given.
        const CURRENT_DIRECTORY_HANDLE: usize = 0x48;

        let word_at = |address: usize| {
            let (mut word, mut read) = (0usize, 0usize);
            let ok = unsafe {
                ReadProcessMemory(
                    process,
                    address as *const _,
                    (&mut word as *mut usize).cast(),
                    size_of::<usize>(),
                    &mut read,
                )
            };
            (ok != 0 && read == size_of::<usize>()).then_some(word)
        };
        let mut wow64 = 0;
        if unsafe { IsWow64Process(process, &mut wow64) } == 0 || wow64 != 0 {
            return None;
        }
        let mut info: PROCESS_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
        let status = unsafe {
            NtQueryInformationProcess(
                process,
                ProcessBasicInformation,
                (&mut info as *mut PROCESS_BASIC_INFORMATION).cast(),
                size_of::<PROCESS_BASIC_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        if status < 0 {
            return None;
        }
        let parameters =
            word_at(info.PebBaseAddress as usize + offset_of!(PEB, ProcessParameters))?;
        let handle = word_at(parameters + CURRENT_DIRECTORY_HANDLE)?;
        name(process, handle as HANDLE, true, path).ok().flatten()
    }

    /// harness-pty ships x64 and arm64 alone: a 32-bit build reads no folder.
    #[cfg(not(target_pointer_width = "64"))]
    fn folder(_: HANDLE, _: &mut [u16]) -> Option<String> {
        None
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::ffi::OsStr;
        use std::fs::File;
        use std::io::{Read, Write};
        use std::os::windows::io::{FromRawHandle, OwnedHandle};
        use std::path::{Path, PathBuf};
        use std::process::{Child, Command, Stdio};
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        use windows_sys::Win32::System::Pipes::CreatePipe;

        use crate::open_files::OpenFilesRow;

        /// [path] as Windows resolves it, `\\?\` trimmed by hand: never by `dos_path`, which the
        /// read itself uses.
        fn resolved(path: &Path) -> String {
            let full = std::fs::canonicalize(path).unwrap();
            let full = full.to_str().unwrap();
            full.strip_prefix(r"\\?\").unwrap_or(full).to_owned()
        }

        fn own_row() -> OpenFilesRow {
            let mut rows = read(&[std::process::id()]);
            assert_eq!(rows.len(), 1);
            rows.remove(0)
        }

        /// [pid]'s marker in the process table (`ps --json`).
        fn table_marker(pid: u32) -> String {
            crate::ps::snapshot()
                .unwrap()
                .into_iter()
                .find(|row| row.pid == pid)
                .expect("table row")
                .start_marker
        }

        /// A drive letter's path or a share's: a name Windows gave a disk file.
        fn dos_named(path: &str) -> bool {
            let b = path.as_bytes();
            path.starts_with(r"\\") || (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
        }

        /// `ping` running in [dir] for 30 s, past its start: its first byte written, so its loader
        /// has set its folder.
        fn ping(exe: impl AsRef<OsStr>, dir: &Path) -> Child {
            let mut child = Command::new(exe)
                .args(["-n", "30", "127.0.0.1"])
                .current_dir(dir)
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdout
                .as_mut()
                .unwrap()
                .read_exact(&mut [0u8; 1])
                .unwrap();
            child
        }

        #[test]
        fn lists_a_file_this_process_holds_and_its_folder() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("rollout.jsonl");
            let held = File::create(&path).unwrap();
            let row = own_row();
            assert!(row.files.contains(&resolved(&path)), "{row:?}");
            assert_eq!(row.cwd, Some(resolved(&std::env::current_dir().unwrap())));
            assert_eq!(row.start_marker, table_marker(std::process::id()));
            drop(held);
        }

        #[test]
        fn a_file_closed_before_the_read_is_not_listed() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("closed.jsonl");
            drop(File::create(&path).unwrap());
            let closed = resolved(&path);
            assert!(!own_row().files.contains(&closed));
        }

        #[test]
        fn a_pipe_with_a_pending_read_is_skipped_and_the_read_returns() {
            let (mut read_end, mut write_end) = (std::ptr::null_mut(), std::ptr::null_mut());
            assert_ne!(
                unsafe { CreatePipe(&mut read_end, &mut write_end, std::ptr::null(), 0) },
                0
            );
            let mut reader = File::from(unsafe { OwnedHandle::from_raw_handle(read_end as _) });
            let mut writer = File::from(unsafe { OwnedHandle::from_raw_handle(write_end as _) });
            let (reading, about_to_read) = mpsc::channel();
            // A synchronous read: the pipe's file object stays busy until a byte comes, which is
            // what hangs `NtQueryObject` on its name.
            let blocked = std::thread::spawn(move || {
                reading.send(()).unwrap();
                reader.read(&mut [0u8; 1]).unwrap()
            });
            about_to_read.recv().unwrap();
            for _ in 0..3 {
                let (done, read_rows) = mpsc::channel();
                std::thread::spawn(move || {
                    let _ = done.send(read(&[std::process::id()]));
                });
                let rows = read_rows
                    .recv_timeout(Duration::from_secs(10))
                    .expect("the read returns");
                let files = &rows.first().expect("own row").files;
                assert!(files.iter().all(|f| dos_named(f)), "{files:?}");
            }
            writer.write_all(b"x").unwrap();
            assert_eq!(blocked.join().unwrap(), 1);
        }

        #[test]
        fn a_childs_folder_is_named_as_windows_resolves_it() {
            let dir = tempfile::tempdir().unwrap();
            let work = dir.path().join("Work Dial");
            std::fs::create_dir(&work).unwrap();
            // The process keeps the spelling it was given (here upper-cased; on a runner TEMP may be
            // an 8.3 name too); the folder is named as Windows resolves it.
            let given = PathBuf::from(work.to_str().unwrap().to_uppercase());
            let mut child = ping("ping.exe", &given);
            let rows = read(&[child.id()]);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].cwd, Some(resolved(&work)));
            assert_eq!(rows[0].start_marker, table_marker(child.id()));
            // Exited, though `child` still holds its handle (so its pid cannot have been reused):
            // left out.
            child.kill().unwrap();
            child.wait().unwrap();
            assert!(read(&[child.id()]).is_empty());
        }

        #[test]
        fn a_32_bit_process_has_no_folder() {
            let system = std::env::var_os("SystemRoot").expect("SystemRoot");
            let exe = Path::new(&system).join(r"SysWOW64\PING.EXE");
            let mut child = ping(&exe, &std::env::current_dir().unwrap());
            let rows = read(&[child.id()]);
            child.kill().unwrap();
            child.wait().unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].cwd, None);
        }

        #[test]
        fn processes_it_may_not_open_so_are_left_out() {
            // The idle process and System.
            assert!(read(&[0, 4]).is_empty());
        }

        #[test]
        fn a_read_is_quick() {
            // The fastest of a few reads: the read's own cost, not the time the other tests keep
            // this thread off the CPU.
            let pid = [std::process::id()];
            read(&pid);
            let (took, files) = (0..5)
                .map(|_| {
                    let start = Instant::now();
                    let files = read(&pid).first().map_or(0, |row| row.files.len());
                    (start.elapsed(), files)
                })
                .min()
                .unwrap();
            eprintln!("files: {files} files in {took:?}");
            assert!(took < Duration::from_millis(500), "{took:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(path: &str) -> Vec<u16> {
        path.encode_utf16().collect()
    }

    #[test]
    fn dos_path_names_a_path_as_node_realpath_does() {
        assert_eq!(
            dos_path(&units(r"\\?\C:\work\dial")).as_deref(),
            Some(r"C:\work\dial")
        );
        assert_eq!(
            dos_path(&units(r"\\?\UNC\srv\share\x")).as_deref(),
            Some(r"\\srv\share\x")
        );
        assert_eq!(dos_path(&units(r"C:\x")).as_deref(), Some(r"C:\x"));
        // A lone surrogate is no path the daemon could match.
        assert_eq!(dos_path(&[u16::from(b'C'), 0xD800]), None);
    }

    #[test]
    fn collect_keeps_each_path_once_and_refuses_past_the_bound() {
        let distinct = |n: usize| (0..n).map(|i| format!(r"C:\f\{i:05}"));
        let kept = collect(distinct(MAX_FILES).rev().chain(distinct(10))).unwrap();
        assert_eq!(kept, distinct(MAX_FILES).collect::<Vec<_>>());
        assert_eq!(collect(distinct(MAX_FILES + 1)), None);
    }

    #[test]
    fn a_row_serializes_in_the_daemons_field_names() {
        let row = OpenFilesRow {
            pid: 421,
            start_marker: "w:134087000000040000".into(),
            cwd: Some(r"C:\work\dial".into()),
            files: vec![r"C:\x".into()],
        };
        assert_eq!(
            serde_json::to_value(&row).unwrap(),
            serde_json::json!({
                "pid": 421,
                "startMarker": "w:134087000000040000",
                "cwd": "C:\\work\\dial",
                "files": ["C:\\x"],
            })
        );
        let json = serde_json::to_value(OpenFilesRow { cwd: None, ..row }).unwrap();
        assert!(json.get("cwd").is_none(), "{json}");
    }
}
