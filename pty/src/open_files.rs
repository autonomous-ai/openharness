#[cfg(windows)]
mod windows {
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
