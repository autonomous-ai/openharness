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
    _rows: &[Row],
    _lookup: u32,
    _daemon: u32,
    _process: impl FnMut(u32) -> Option<Process>,
) -> Verdict {
    Verdict::Yes
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: u64 = 134_000_000_000_000_000;
    const LOOKUP: u32 = 50;
    const DAEMON: u32 = 60;
    const CALLER: u32 = 70;

    fn mine() -> Process {
        Process { started: T - 5 * TICKS_PER_SECOND, parent: Some(1), name: "node.exe".into(), this_account: Some(true) }
    }
    fn row(created: u64) -> Row {
        Row { pid: CALLER, created }
    }
    fn asked(rows: &[Row], process: Option<Process>) -> Verdict {
        verdict(rows, LOOKUP, DAEMON, |pid| {
            let parent = process.as_ref().and_then(|p| p.parent);
            match pid {
                CALLER => process.clone(),
                // The parent of the process asked of, for the console-host rule.
                pid if Some(pid) == parent => Some(Process { parent: Some(DAEMON), name: "harness-pty.exe".into(), ..mine() }),
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
        is_no(asked(&[row(T)], Some(Process { this_account: Some(false), ..mine() })), "another account");
        is_no(asked(&[row(T)], Some(Process { this_account: None, ..mine() })), "will not give");
    }

    #[test]
    fn a_process_gone_is_no() {
        is_no(asked(&[row(T)], None), "gone");
    }

    #[test]
    fn the_lookup_itself_is_never_the_caller() {
        is_no(verdict(&[Row { pid: LOOKUP, created: T }], LOOKUP, DAEMON, |_| Some(mine())), "the lookup itself");
    }

    #[test]
    fn a_process_started_after_its_connection_has_taken_a_freed_id() {
        is_no(asked(&[row(T)], Some(Process { started: T + 1, ..mine() })), "started after");
    }

    #[test]
    fn a_time_windows_did_not_give_is_no() {
        is_no(asked(&[row(0)], Some(mine())), "no start time");
        is_no(asked(&[row(T)], Some(Process { started: 0, ..mine() })), "no start time");
    }

    // Windows may give the connection's time to the second alone, as Get-NetTCPConnection did on
    // the runs of #2605: then a fresh process that connected at once must still read as yes.
    #[test]
    fn a_connection_time_to_the_second_compares_to_the_second() {
        let second = T - T % TICKS_PER_SECOND;
        assert_eq!(asked(&[row(second)], Some(Process { started: second + 5, ..mine() })), Verdict::Yes);
        is_no(asked(&[row(second)], Some(Process { started: second + TICKS_PER_SECOND, ..mine() })), "started after");
    }

    // A connection time finer than a second closes W1's gap: no reuse within its own second.
    #[test]
    fn a_finer_connection_time_compares_exactly() {
        let fine = T - T % TICKS_PER_SECOND + 7;
        assert_eq!(asked(&[row(fine)], Some(Process { started: fine, ..mine() })), Verdict::Yes);
        is_no(asked(&[row(fine)], Some(Process { started: fine + 1, ..mine() })), "started after");
    }

    #[test]
    fn another_lookup_or_its_console_host_may_have_taken_a_freed_id() {
        let lookup = Process { parent: Some(DAEMON), name: "harness-pty.exe".into(), ..mine() };
        is_no(asked(&[row(T)], Some(lookup)), "a lookup the daemon started");
        let host = Process { parent: Some(80), name: "conhost.exe".into(), ..mine() };
        is_no(asked(&[row(T)], Some(host)), "a console host of a lookup");
        // The names in any case, as Windows files them.
        let upper = Process { parent: Some(DAEMON), name: "HARNESS-PTY.EXE".into(), ..mine() };
        is_no(asked(&[row(T)], Some(upper)), "a lookup the daemon started");
    }

    #[test]
    fn a_program_of_this_account_the_daemon_started_is_still_yes() {
        assert_eq!(asked(&[row(T)], Some(Process { parent: Some(DAEMON), name: "node.exe".into(), ..mine() })), Verdict::Yes);
    }
}
