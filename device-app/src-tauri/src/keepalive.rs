//! The daemon rule: when to run `harness start --if-down`.

use crate::types::Daemon;

/// How long a watch that an old daemon or CLI turned away waits before it is tried again.
pub const RETRY_OLD_SECS: u64 = 60;

/// How often a daemon down twice in a row is looked at again, so one that comes back by itself is seen before the
/// slot or while the desktop app runs.
const LOOK_AGAIN_SECS: u64 = 15;

/// Seconds 10 to 19 of a minute: the desktop app's `inSpawnSlot`, clear of the CLI's update slot.
pub fn in_spawn_slot(now: u64) -> bool {
    (10..20).contains(&(now % 60))
}

/// What the caller does on a tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keep {
    SpawnWatch,
    RunStart,
    /// A start was due, and the desktop app runs: it supervises its own daemon.
    HoldBack,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Watch {
    Running,
    /// Ended with the daemon down at `since`: looked at again on the next tick, and from the second down in a row
    /// every 15 s.
    Down {
        since: u64,
    },
    /// Turned away by an old daemon or CLI, which updates itself.
    Old {
        since: u64,
    },
    /// The app closed its stdin.
    Closed,
}

pub struct KeepAlive {
    daemon: Daemon,
    watch: Watch,
    /// Down observations in a row.
    downs: u32,
    starting: bool,
    /// `now / 60` of the last start, so a start is asked at most once a minute.
    last_start_minute: Option<u64>,
    /// The last start exited 0: a down after it means the CLI refused (a flash, an uninstall).
    last_start_ok: bool,
}

impl KeepAlive {
    /// The caller has just spawned the watch.
    pub fn new() -> Self {
        KeepAlive {
            daemon: Daemon::Starting,
            watch: Watch::Running,
            downs: 0,
            starting: false,
            last_start_minute: None,
            last_start_ok: false,
        }
    }

    /// The watch connected: the daemon is up.
    pub fn watch_line(&mut self) {
        self.daemon = Daemon::Up;
        self.downs = 0;
        self.last_start_ok = false;
    }

    pub fn watch_exit(&mut self, code: Option<i32>, now: u64) {
        // A watch the app stopped answers with exit 0. An exit 0 nobody asked for is a down like any other end.
        if self.watch == Watch::Closed {
            return;
        }
        match code {
            // 4: a daemon older than `dial-watch`; 1: a CLI older than `watch` printing its usage.
            Some(1) | Some(4) => {
                self.watch = Watch::Old { since: now };
                self.downs = 0;
                self.daemon = Daemon::Updating;
            }
            _ => {
                self.watch = Watch::Down { since: now };
                self.downs += 1;
                self.daemon = if self.last_start_ok { Daemon::Stopped } else { Daemon::Starting };
            }
        }
    }

    pub fn tick(&mut self, now: u64, desktop_running: bool) -> Option<Keep> {
        if self.starting {
            return None;
        }
        match self.watch {
            Watch::Running | Watch::Closed => None,
            Watch::Old { since } => waited(now, since, RETRY_OLD_SECS).then(|| self.spawn_watch()),
            Watch::Down { since } => {
                // One down is not proof: a self-update leaves a gap. The desktop app supervises its own daemon.
                let start = self.downs >= 2 && in_spawn_slot(now) && self.last_start_minute != Some(now / 60);
                let wait = if self.downs < 2 { 0 } else { LOOK_AGAIN_SECS };
                if start && !desktop_running {
                    self.start_begun(now);
                    Some(Keep::RunStart)
                } else if waited(now, since, wait) {
                    Some(self.spawn_watch())
                } else if start {
                    // Counted as the minute's start, so it is held back, and told, once a minute.
                    self.last_start_minute = Some(now / 60);
                    Some(Keep::HoldBack)
                } else {
                    None
                }
            }
        }
    }

    /// The caller stops the watch: the exit that answers is not a down.
    pub fn stop_watch(&mut self) {
        self.watch = Watch::Closed;
    }

    /// A start the caller runs outside the slot, after an install.
    pub fn start_begun(&mut self, now: u64) {
        self.starting = true;
        self.last_start_minute = Some(now / 60);
    }

    /// The caller spawns the watch again.
    pub fn start_done(&mut self, ok: bool) {
        self.starting = false;
        self.downs = 0;
        self.last_start_ok = ok;
        self.watch = Watch::Running;
    }

    pub fn daemon(&self) -> Daemon {
        self.daemon
    }

    fn spawn_watch(&mut self) -> Keep {
        self.watch = Watch::Running;
        Keep::SpawnWatch
    }
}

/// `wait` seconds have passed since `since`, or the clock was set back before it: a time that would never come.
fn waited(now: u64, since: u64, wait: u64) -> bool {
    now < since || now - since >= wait
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Second 0 of a minute.
    const B: u64 = 1794556800;

    /// Ticks every 5 s from `from` to `to`, both included; each must give nothing.
    fn quiet(keep: &mut KeepAlive, from: u64, to: u64) {
        for now in (from..=to).step_by(5) {
            assert_eq!(keep.tick(now, false), None, "tick at B+{}", now - B);
        }
    }

    /// Ticks every 5 s from `from` to `to`, both included, each watch it looks at ending down at once: what the ticks
    /// gave, by second after B.
    fn ticks(keep: &mut KeepAlive, from: u64, to: u64, desktop_running: bool) -> Vec<(u64, Keep)> {
        let mut gave = Vec::new();
        for now in (from..=to).step_by(5) {
            if let Some(kept) = keep.tick(now, desktop_running) {
                if kept == Keep::SpawnWatch {
                    keep.watch_exit(Some(3), now);
                }
                gave.push((now - B, kept));
            }
        }
        gave
    }

    /// Two downs in a row at B, with the watch looked at again at B+5 in between.
    fn two_downs() -> KeepAlive {
        let mut keep = KeepAlive::new();
        keep.watch_exit(Some(3), B);
        assert_eq!(keep.tick(B + 5, false), Some(Keep::SpawnWatch));
        keep.watch_exit(Some(3), B + 5);
        keep
    }

    #[test]
    fn the_slot_is_seconds_10_to_19() {
        assert!(in_spawn_slot(B + 10));
        assert!(in_spawn_slot(B + 19));
        assert!(!in_spawn_slot(B + 9));
        assert!(!in_spawn_slot(B + 20));
    }

    #[test]
    fn a_running_watch_is_a_daemon_that_is_up() {
        let mut keep = KeepAlive::new();
        assert_eq!(keep.daemon(), Daemon::Starting);
        keep.watch_line();
        assert_eq!(keep.daemon(), Daemon::Up);
        quiet(&mut keep, B, B + 120);
    }

    #[test]
    fn one_down_looks_again_on_the_next_tick() {
        let mut keep = KeepAlive::new();
        keep.watch_exit(Some(3), B);
        assert_eq!(keep.daemon(), Daemon::Starting);
        assert_eq!(keep.tick(B + 5, false), Some(Keep::SpawnWatch));
        assert_eq!(keep.tick(B + 10, false), None);
    }

    #[test]
    fn two_downs_in_a_row_start_it_in_the_slot() {
        let mut keep = two_downs();
        assert_eq!(keep.tick(B + 9, false), None);
        assert_eq!(keep.tick(B + 10, false), Some(Keep::RunStart));
        quiet(&mut keep, B + 15, B + 100);
        keep.start_done(true);
        keep.watch_exit(Some(3), B + 101);
        assert_eq!(keep.daemon(), Daemon::Stopped);
    }

    #[test]
    fn after_two_downs_it_looks_again_every_15_s_until_the_slot() {
        let mut keep = KeepAlive::new();
        keep.watch_exit(Some(3), B + 20);
        assert_eq!(keep.tick(B + 25, false), Some(Keep::SpawnWatch));
        keep.watch_exit(Some(3), B + 25);
        assert_eq!(ticks(&mut keep, B + 30, B + 65, false), [40, 55].map(|at| (at, Keep::SpawnWatch)));
        assert_eq!(keep.tick(B + 70, false), Some(Keep::RunStart));
    }

    #[test]
    fn a_watch_that_connects_resets_the_count() {
        let mut keep = KeepAlive::new();
        keep.watch_exit(Some(3), B);
        assert_eq!(keep.tick(B + 5, false), Some(Keep::SpawnWatch));
        keep.watch_line();
        keep.watch_exit(Some(3), B + 6);
        assert_eq!(keep.tick(B + 10, false), Some(Keep::SpawnWatch));
    }

    #[test]
    fn never_while_the_desktop_app_runs() {
        use Keep::{HoldBack, SpawnWatch};
        let mut keep = two_downs();
        // It still watches the dial, 15 s after each down, and holds back the start in each minute's slot.
        let kept = [(10, HoldBack), (20, SpawnWatch), (35, SpawnWatch), (50, SpawnWatch), (65, SpawnWatch)];
        assert_eq!(ticks(&mut keep, B + 10, B + 65, true), kept);
        let kept = [(70, HoldBack), (80, SpawnWatch), (95, SpawnWatch), (110, SpawnWatch), (125, SpawnWatch)];
        assert_eq!(ticks(&mut keep, B + 70, B + 125, true), kept);
        assert_eq!(keep.daemon(), Daemon::Starting);
    }

    #[test]
    fn an_old_daemon_or_cli_is_updating_and_is_never_started() {
        for code in [4, 1] {
            let mut keep = KeepAlive::new();
            keep.watch_exit(Some(code), B);
            assert_eq!(keep.daemon(), Daemon::Updating, "exit {code}");
            quiet(&mut keep, B + 5, B + 59);
            assert_eq!(keep.tick(B + 60, false), Some(Keep::SpawnWatch), "exit {code}");
            keep.watch_exit(Some(code), B + 61);
            quiet(&mut keep, B + 65, B + 120);
            assert_eq!(keep.tick(B + 121, false), Some(Keep::SpawnWatch), "exit {code}");
            assert_eq!(keep.daemon(), Daemon::Updating, "exit {code}");
        }
    }

    #[test]
    fn a_clock_set_back_ends_the_wait() {
        let mut keep = KeepAlive::new();
        keep.watch_exit(Some(4), B + 3600);
        assert_eq!(keep.tick(B, false), Some(Keep::SpawnWatch));

        let mut keep = KeepAlive::new();
        keep.watch_exit(Some(3), B + 3600);
        assert_eq!(keep.tick(B + 3605, false), Some(Keep::SpawnWatch));
        keep.watch_exit(Some(3), B + 3605);
        assert_eq!(keep.tick(B + 5, false), Some(Keep::SpawnWatch));
    }

    #[test]
    fn a_start_that_changes_nothing_reads_stopped_until_the_watch_connects() {
        let mut keep = two_downs();
        assert_eq!(keep.tick(B + 10, false), Some(Keep::RunStart));
        keep.start_done(true);
        keep.watch_exit(Some(3), B + 11);
        assert_eq!(keep.daemon(), Daemon::Stopped);
        assert_eq!(keep.tick(B + 15, false), Some(Keep::SpawnWatch));
        keep.watch_line();
        assert_eq!(keep.daemon(), Daemon::Up);
    }

    #[test]
    fn a_failed_start_waits_for_the_next_slot() {
        let mut keep = two_downs();
        assert_eq!(keep.tick(B + 10, false), Some(Keep::RunStart));
        keep.start_done(false);
        keep.watch_exit(Some(3), B + 11);
        assert_eq!(keep.tick(B + 12, false), Some(Keep::SpawnWatch));
        keep.watch_exit(Some(3), B + 13);
        // In the slot, but the same minute: it only looks again, 15 s after each down.
        assert_eq!(ticks(&mut keep, B + 15, B + 65, false), [30, 45, 60].map(|at| (at, Keep::SpawnWatch)));
        assert_eq!(keep.tick(B + 70, false), Some(Keep::RunStart));
        assert_eq!(keep.daemon(), Daemon::Starting);
    }

    #[test]
    fn any_other_end_is_a_down_observation() {
        let mut keep = KeepAlive::new();
        keep.watch_exit(None, B);
        assert_eq!(keep.daemon(), Daemon::Starting);
        assert_eq!(keep.tick(B + 5, false), Some(Keep::SpawnWatch));
        keep.watch_exit(Some(143), B + 6);
        assert_eq!(keep.tick(B + 10, false), Some(Keep::RunStart));
    }

    #[test]
    fn exit_0_is_the_app_closing_it() {
        let mut keep = KeepAlive::new();
        keep.stop_watch();
        keep.watch_exit(Some(0), B);
        quiet(&mut keep, B + 5, B + 120);
    }

    #[test]
    fn an_exit_0_the_app_did_not_ask_for_is_a_down() {
        let mut keep = KeepAlive::new();
        keep.watch_exit(Some(0), B);
        assert_eq!(keep.daemon(), Daemon::Starting);
        assert_eq!(keep.tick(B + 5, false), Some(Keep::SpawnWatch));
    }

    #[test]
    fn a_start_after_an_install_is_not_started_twice() {
        let mut keep = KeepAlive::new();
        keep.start_begun(B + 30);
        keep.watch_exit(Some(3), B + 31);
        keep.watch_exit(Some(3), B + 32);
        quiet(&mut keep, B + 35, B + 135);
        keep.start_done(true);
        quiet(&mut keep, B + 140, B + 200);
    }
}
