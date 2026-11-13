//! The daemon rule: when to run `harness start --if-down`.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Daemon;

    /// Second 0 of a minute.
    const B: u64 = 1794556800;

    /// Ticks every 5 s from `from` to `to`, both included; each must give nothing.
    fn quiet(keep: &mut KeepAlive, from: u64, to: u64) {
        for now in (from..=to).step_by(5) {
            assert_eq!(keep.tick(now, false), None, "tick at B+{}", now - B);
        }
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
        let mut keep = two_downs();
        assert_eq!(keep.tick(B + 10, true), Some(Keep::SpawnWatch));
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
        assert_eq!(keep.tick(B + 15, false), None);
        quiet(&mut keep, B + 20, B + 65);
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
        keep.watch_exit(Some(0), B);
        quiet(&mut keep, B + 5, B + 120);
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
