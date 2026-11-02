//! Who is calling over loopback, for the daemon's check (`cli/src/lib/peerAccount.ts`).
//!
//! `harness-pty peer-account` answers whether the client end of 127.0.0.1:peer -> 127.0.0.1:own
//! belongs to a process of this account. Any account can bind a free loopback port and hear a
//! secret, so a secret heard must open nothing (audit W1, docs/security/2026-11-02-team-account-windows.md).
//! Windows PowerShell took 20 to 25 s for this on the ARM runner; this takes milliseconds.
//!
//! [`verdict`] holds every rule, so they run in every platform's tests. The Windows layer only
//! gathers the facts. Anything that cannot be read is a no: this guards a credential.

/// `FILETIME` units in one second.
pub const TICKS_PER_SECOND: u64 = 10_000_000;

/// What the daemon starts for a lookup: this binary, the fallback PowerShell, and their console hosts.
const LOOKUP_PROCESSES: [&str; 3] = ["harness-pty.exe", "powershell.exe", "conhost.exe"];

/// One row of the TCP table the connection's pair of ports matched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub pid: u32,
    /// When the connection was made, as a `FILETIME`; 0 when Windows gave none.
    pub created: u64,
}

/// What Windows says of the process that owns a row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Process {
    /// Its creation `FILETIME`; 0 when Windows gave none.
    pub started: u64,
    pub parent: Option<u32>,
    /// Its exe file name.
    pub name: String,
    /// Whether its token's user is this process's: `None` when Windows will not give it.
    pub this_account: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Yes,
    No(String),
}

/// The answer for [rows], those of the exact pair; `process` reads one by id, `None` when it is
/// gone or cannot be opened. [lookup] is this process's id, [daemon] the daemon's.
pub fn verdict(
    rows: &[Row],
    lookup: u32,
    daemon: u32,
    mut process: impl FnMut(u32) -> Option<Process>,
) -> Verdict {
    let no = |why: String| Verdict::No(why);
    let [row] = rows else {
        return no(format!("{} connections match", rows.len()));
    };
    // The lookup's own process is never the caller: it could have taken a freed id.
    if row.pid == lookup {
        return no("the lookup itself owns it".into());
    }
    let Some(caller) = process(row.pid) else {
        return no("its process is gone".into());
    };
    if row.created == 0 || caller.started == 0 {
        return no("Windows gave no start time".into());
    }
    // Windows keeps naming a socket's creator after it exits when a child inherited the handle,
    // and the id may have gone to another process since: only one that started before the
    // connection was made can be its owner. A connection time to the second alone is compared to
    // the second, so a fresh process that connected at once still reads as yes; a finer one closes
    // a reuse within that second too.
    let started = if row.created % TICKS_PER_SECOND == 0 {
        caller.started - caller.started % TICKS_PER_SECOND
    } else {
        caller.started
    };
    if started > row.created {
        return no(format!(
            "its process started after its connection ({} > {})",
            caller.started, row.created
        ));
    }
    // Nor another lookup running at once, or its console host, started in the connection's second:
    // it could have taken the freed id, and nothing of the kind the daemon starts calls its port
    // with a secret. The rule of W1's PowerShell query, word for word, so both give the same answers.
    if LOOKUP_PROCESSES
        .iter()
        .any(|name| caller.name.eq_ignore_ascii_case(name))
        && (caller.parent == Some(daemon)
            || caller
                .parent
                .and_then(&mut process)
                .is_some_and(|parent| parent.parent == Some(daemon)))
    {
        return no(format!("a {} the daemon started owns it", caller.name));
    }
    match caller.this_account {
        Some(true) => Verdict::Yes,
        Some(false) => no("its owner is another account".into()),
        None => no("Windows will not give its owner".into()),
    }
}

#[cfg(windows)]
pub use windows::ask;

#[cfg(windows)]
mod windows {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, HANDLE, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP_STATE_ESTAB, MIB_TCPROW_OWNER_MODULE,
        TCP_TABLE_OWNER_MODULE_CONNECTIONS,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET;
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcessToken, PROCESS_NAME_WIN32, QueryFullProcessImageNameW,
    };

    use super::{Process, Row, Verdict, verdict};

    /// 127.0.0.1 as the table stores it: network order in memory.
    const LOOPBACK: u32 = u32::from_ne_bytes([127, 0, 0, 1]);

    /// The answer for the client end of 127.0.0.1:[peer] -> 127.0.0.1:[own].
    pub fn ask(peer: u16, own: u16, daemon: u32) -> Verdict {
        let rows = match rows(peer, own) {
            Ok(rows) => rows,
            Err(code) => return Verdict::No(format!("Windows gave no connections ({code})")),
        };
        let Some(this) = user_of(unsafe { GetCurrentProcess() }) else {
            return Verdict::No("Windows will not give this account".into());
        };
        verdict(&rows, std::process::id(), daemon, |pid| read(pid, &this))
    }

    /// The established rows whose client end is [peer] and server end [own], both on 127.0.0.1.
    /// Windows lists a connection once from each end, so the pair of ports in this order is one.
    fn rows(peer: u16, own: u16) -> Result<Vec<Row>, u32> {
        // `u64` words, so the table's 64-bit timestamps are aligned.
        let mut words = vec![0u64; 4096];
        loop {
            let mut size = (words.len() * 8) as u32;
            let code = unsafe {
                GetExtendedTcpTable(
                    words.as_mut_ptr().cast(),
                    &mut size,
                    0,
                    AF_INET as u32,
                    TCP_TABLE_OWNER_MODULE_CONNECTIONS,
                    0,
                )
            };
            if code == ERROR_INSUFFICIENT_BUFFER {
                words.resize((size as usize).div_ceil(8) + 512, 0);
                continue;
            }
            if code != NO_ERROR {
                return Err(code);
            }
            break;
        }
        // MIB_TCPTABLE_OWNER_MODULE: a count, then rows at the rows' own alignment.
        let count = unsafe { *words.as_ptr().cast::<u32>() } as usize;
        let first = unsafe {
            words
                .as_ptr()
                .cast::<u8>()
                .add(std::mem::align_of::<MIB_TCPROW_OWNER_MODULE>())
        }
        .cast::<MIB_TCPROW_OWNER_MODULE>();
        let table = unsafe { std::slice::from_raw_parts(first, count) };
        let port = |value: u32| u16::from_be(value as u16);
        Ok(table
            .iter()
            .filter(|r| {
                r.dwState == MIB_TCP_STATE_ESTAB as u32
                    && r.dwLocalAddr == LOOPBACK
                    && r.dwRemoteAddr == LOOPBACK
                    && port(r.dwLocalPort) == peer
                    && port(r.dwRemotePort) == own
            })
            .map(|r| Row {
                pid: r.dwOwningPid,
                created: r.liCreateTimestamp as u64,
            })
            .collect())
    }

    /// What Windows says of [pid]; `None` when it has exited or cannot be opened.
    fn read(pid: u32, this: &[u8]) -> Option<Process> {
        let (process, synchronize) = crate::ps::open_process(pid)?;
        let handle = process.as_raw_handle() as HANDLE;
        if crate::ps::process_exited(handle, synchronize) {
            return None;
        }
        Some(Process {
            started: crate::ps::process_started(handle).unwrap_or(0),
            parent: crate::ps::process_parent(handle),
            name: file_name(handle),
            this_account: user_of(handle).map(|user| same_sid(&user, this)),
        })
    }

    fn file_name(process: HANDLE) -> String {
        let mut path = vec![0u16; 1024];
        let mut size = path.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, path.as_mut_ptr(), &mut size)
        };
        if ok == 0 {
            return String::new();
        }
        let path = String::from_utf16_lossy(&path[..size as usize]);
        path.rsplit('\\').next().unwrap_or_default().to_string()
    }

    /// The `TOKEN_USER` of [process]'s token, in `u64` words as bytes; `None` when Windows will not
    /// give it, as for another account's process.
    fn user_of(process: HANDLE) -> Option<Vec<u8>> {
        let mut token: HANDLE = std::ptr::null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        let token = unsafe { OwnedHandle::from_raw_handle(token as _) };
        let mut size = 0u32;
        unsafe {
            GetTokenInformation(
                token.as_raw_handle() as HANDLE,
                TokenUser,
                std::ptr::null_mut(),
                0,
                &mut size,
            )
        };
        if size == 0 {
            return None;
        }
        let mut words = vec![0u64; (size as usize).div_ceil(8)];
        let ok = unsafe {
            GetTokenInformation(
                token.as_raw_handle() as HANDLE,
                TokenUser,
                words.as_mut_ptr().cast(),
                size,
                &mut size,
            )
        };
        if ok == 0 {
            return None;
        }
        let bytes =
            unsafe { std::slice::from_raw_parts(words.as_ptr().cast::<u8>(), words.len() * 8) };
        Some(sid_bytes(bytes))
    }

    /// The SID's own bytes out of a `TOKEN_USER` buffer.
    fn sid_bytes(buffer: &[u8]) -> Vec<u8> {
        let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
        let sid = user.User.Sid.cast::<u8>();
        // A SID: revision, sub-authority count, 6 bytes of authority, then 4 bytes per sub-authority.
        let count = unsafe { *sid.add(1) } as usize;
        unsafe { std::slice::from_raw_parts(sid, 8 + count * 4) }.to_vec()
    }

    fn same_sid(a: &[u8], b: &[u8]) -> bool {
        let (mut a, mut b) = (aligned(a), aligned(b));
        unsafe { EqualSid(a.as_mut_ptr().cast(), b.as_mut_ptr().cast()) != 0 }
    }

    fn aligned(bytes: &[u8]) -> Vec<u32> {
        let mut words = vec![0u32; bytes.len().div_ceil(4)];
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), words.as_mut_ptr().cast(), bytes.len())
        };
        words
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: u64 = 134_000_000_000_000_000;
    const LOOKUP: u32 = 50;
    const DAEMON: u32 = 60;
    const CALLER: u32 = 70;

    fn mine() -> Process {
        Process {
            started: T - 5 * TICKS_PER_SECOND,
            parent: Some(1),
            name: "node.exe".into(),
            this_account: Some(true),
        }
    }
    fn row(created: u64) -> Row {
        Row {
            pid: CALLER,
            created,
        }
    }
    fn asked(rows: &[Row], process: Option<Process>) -> Verdict {
        verdict(rows, LOOKUP, DAEMON, |pid| {
            let parent = process.as_ref().and_then(|p| p.parent);
            match pid {
                CALLER => process.clone(),
                // The parent of the process asked of, for the console-host rule.
                pid if Some(pid) == parent => Some(Process {
                    parent: Some(DAEMON),
                    name: "harness-pty.exe".into(),
                    ..mine()
                }),
                _ => None,
            }
        })
    }
    fn is_no(answer: Verdict, why: &str) {
        match answer {
            Verdict::No(said) => assert!(said.contains(why), "said {said:?}, wanted {why:?}"),
            Verdict::Yes => panic!("said yes, wanted no: {why}"),
        }
    }

    #[test]
    fn a_process_of_this_account_that_started_first_is_yes() {
        assert_eq!(asked(&[row(T)], Some(mine())), Verdict::Yes);
    }

    #[test]
    fn no_row_or_more_than_one_cannot_be_told_apart() {
        is_no(asked(&[], Some(mine())), "0 connections");
        is_no(asked(&[row(T), row(T)], Some(mine())), "2 connections");
    }

    #[test]
    fn another_account_or_an_owner_windows_will_not_give_is_no() {
        is_no(
            asked(
                &[row(T)],
                Some(Process {
                    this_account: Some(false),
                    ..mine()
                }),
            ),
            "another account",
        );
        is_no(
            asked(
                &[row(T)],
                Some(Process {
                    this_account: None,
                    ..mine()
                }),
            ),
            "will not give",
        );
    }

    #[test]
    fn a_process_gone_is_no() {
        is_no(asked(&[row(T)], None), "gone");
    }

    #[test]
    fn the_lookup_itself_is_never_the_caller() {
        is_no(
            verdict(
                &[Row {
                    pid: LOOKUP,
                    created: T,
                }],
                LOOKUP,
                DAEMON,
                |_| Some(mine()),
            ),
            "the lookup itself",
        );
    }

    #[test]
    fn a_process_started_after_its_connection_has_taken_a_freed_id() {
        is_no(
            asked(
                &[row(T)],
                Some(Process {
                    started: T + TICKS_PER_SECOND,
                    ..mine()
                }),
            ),
            "started after",
        );
    }

    #[test]
    fn a_time_windows_did_not_give_is_no() {
        is_no(asked(&[row(0)], Some(mine())), "no start time");
        is_no(
            asked(
                &[row(T)],
                Some(Process {
                    started: 0,
                    ..mine()
                }),
            ),
            "no start time",
        );
    }

    // Windows may give the connection's time to the second alone, as Get-NetTCPConnection did on
    // the runs of #2605: then a fresh process that connected at once must still read as yes.
    #[test]
    fn a_connection_time_to_the_second_compares_to_the_second() {
        let second = T - T % TICKS_PER_SECOND;
        assert_eq!(
            asked(
                &[row(second)],
                Some(Process {
                    started: second + 5,
                    ..mine()
                })
            ),
            Verdict::Yes
        );
        is_no(
            asked(
                &[row(second)],
                Some(Process {
                    started: second + TICKS_PER_SECOND,
                    ..mine()
                }),
            ),
            "started after",
        );
    }

    // A connection time finer than a second closes W1's gap: no reuse within its own second.
    #[test]
    fn a_finer_connection_time_compares_exactly() {
        let fine = T - T % TICKS_PER_SECOND + 7;
        assert_eq!(
            asked(
                &[row(fine)],
                Some(Process {
                    started: fine,
                    ..mine()
                })
            ),
            Verdict::Yes
        );
        is_no(
            asked(
                &[row(fine)],
                Some(Process {
                    started: fine + 1,
                    ..mine()
                }),
            ),
            "started after",
        );
    }

    // W1's rule, whichever way the lookups run: the daemon's PowerShell, this binary, or the console
    // host of either, as its child or its child's child (Remy's review of #2605). While a fallback
    // PowerShell runs, a helper that just refused the command is alive too.
    #[test]
    fn what_the_daemon_starts_for_lookups_may_have_taken_a_freed_id() {
        for name in [
            "harness-pty.exe",
            "powershell.exe",
            "conhost.exe",
            "HARNESS-PTY.EXE",
            "PowerShell.EXE",
        ] {
            for parent in [DAEMON, 80] {
                let process = Process {
                    parent: Some(parent),
                    name: name.into(),
                    ..mine()
                };
                is_no(asked(&[row(T)], Some(process)), "the daemon started");
            }
        }
    }

    #[test]
    fn a_powershell_the_daemon_did_not_start_is_yes() {
        let shell = Process {
            parent: Some(80),
            name: "powershell.exe".into(),
            ..mine()
        };
        let others = |pid| match pid {
            CALLER => Some(shell.clone()),
            80 => Some(Process {
                parent: Some(2),
                name: "explorer.exe".into(),
                ..mine()
            }),
            _ => None,
        };
        assert_eq!(verdict(&[row(T)], LOOKUP, DAEMON, others), Verdict::Yes);
        // Its parent gone, as for a shell whose launcher exited: nothing ties it to the daemon.
        let orphan = |pid| (pid == CALLER).then(|| shell.clone());
        assert_eq!(verdict(&[row(T)], LOOKUP, DAEMON, orphan), Verdict::Yes);
    }

    #[test]
    fn a_program_of_this_account_the_daemon_started_is_still_yes() {
        assert_eq!(
            asked(
                &[row(T)],
                Some(Process {
                    parent: Some(DAEMON),
                    name: "node.exe".into(),
                    ..mine()
                })
            ),
            Verdict::Yes
        );
    }
}
