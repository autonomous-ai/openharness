//! When `Harness.exe` goes back to the version before an update (desktop spec section 3.4, Review Focus 3).
//!
//! The launcher starts the app and exits, so it never sees the app end. It learns what became of a start at the
//! next one, from two facts:
//! - whether the version folder holds `.started`, which the app writes once its first frame is drawn
//!   (desktop/lib/update/started_marker.dart). It is written once per version folder: a version that has drawn a
//!   window once is a working version, and is never rolled back for a later crash.
//! - whether the process that start created is still running: the pid and its creation time are recorded, so a pid
//!   Windows has given to another process since reads as ended.
//!
//! Each recorded start of a version that has no `.started` is then:
//! - `Running`: its process is still there (still starting, or a slow first frame). Never a failure: a second
//!   launch while the first is still starting must not count (Review Focus 4).
//! - `Failed`: its process has ended without a first frame. When the process could not be looked at (`Unknown`),
//!   the start counts as failed once it is [START_WINDOW_MS] old with no `.started`, the spec's 10 s.
//!
//! The state machine, run on every launch over `current`, `previous`, the version folders and the recorded starts:
//!
//! ```text
//! current unreadable, or app\<current> has no harness-desktop.exe
//!     -> RollBack to previous, if previous has its exe; else Broken
//! an instance from this install is already running
//!     -> Launch, recording nothing (the new process hands its link to the open window and ends)
//! app\<current>\.started exists
//!     -> Launch, and forget the recorded starts
//! the last two recorded starts are both current's, and both Failed
//!     -> RollBack to previous, if previous has its exe; else Launch, recording the start
//! otherwise
//!     -> Launch, recording the start (two are kept)
//! ```
//!
//! A rollback writes `current` = previous, removes `previous` and the recorded starts, and logs why; the next pass
//! of the machine then launches the version gone back to. So `current` names a broken folder for at most two
//! starts, and the third start is the working version.

use serde::{Deserialize, Serialize};

/// How long a start whose process cannot be looked at has to draw its first frame.
pub const START_WINDOW_MS: u64 = 10_000;
/// How many starts are kept, and how many failures in a row roll back.
pub const KEPT_STARTS: usize = 2;

/// A start the launcher made: the version, when (ms since the Unix epoch), and the process it created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Start {
    pub version: String,
    pub at_ms: u64,
    pub pid: u32,
    /// The process's creation time (a FILETIME), 0 when unknown.
    pub created: u64,
}

/// Whether a recorded start's process is still there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    Running,
    Ended,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Looked {
    pub start: Start,
    pub liveness: Liveness,
}

/// Everything [decide] reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchHistory {
    pub now_ms: u64,
    /// The version `current` names; None when it is missing or does not name one folder.
    pub current: Option<String>,
    pub current_exe: bool,
    pub current_started: bool,
    pub previous: Option<String>,
    pub previous_exe: bool,
    /// An app from this install is running now.
    pub instance_running: bool,
    /// The recorded starts, oldest first.
    pub starts: Vec<Looked>,
}

/// What a launch does with the recorded starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Record {
    /// Add this start (keeping the last [KEPT_STARTS]).
    Append,
    /// Forget them: the version has drawn its window.
    Clear,
    /// Leave them: this start only hands a link to the open window.
    Keep,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Choice {
    Launch { version: String, record: Record },
    RollBack { to: String, reason: String },
    Broken { reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Running,
    Failed,
    Waiting,
}

/// What became of [looked], a start of a version with no `.started`.
pub fn outcome(looked: &Looked, now_ms: u64) -> Outcome {
    match looked.liveness {
        Liveness::Running => Outcome::Running,
        Liveness::Ended => Outcome::Failed,
        Liveness::Unknown if now_ms.saturating_sub(looked.start.at_ms) >= START_WINDOW_MS => {
            Outcome::Failed
        }
        Liveness::Unknown => Outcome::Waiting,
    }
}

pub fn decide(history: &LaunchHistory) -> Choice {
    let fallback = history
        .previous
        .as_ref()
        .filter(|previous| history.previous_exe && Some(*previous) != history.current.as_ref());
    let go_back = |reason: String| match fallback {
        Some(previous) => Choice::RollBack {
            to: previous.clone(),
            reason,
        },
        None => Choice::Broken {
            reason: format!("{reason}, and there is no earlier version to go back to"),
        },
    };
    let Some(current) = history.current.as_ref() else {
        return go_back("`current` is missing or does not name one version folder".to_owned());
    };
    if !history.current_exe {
        return go_back(format!("app\\{current} has no {}", super::APP_EXE));
    }
    if history.instance_running {
        return Choice::Launch {
            version: current.clone(),
            record: Record::Keep,
        };
    }
    if history.current_started {
        return Choice::Launch {
            version: current.clone(),
            record: Record::Clear,
        };
    }
    let last = &history.starts[history.starts.len().saturating_sub(KEPT_STARTS)..];
    let failed = last.len() == KEPT_STARTS
        && last.iter().all(|looked| {
            &looked.start.version == current && outcome(looked, history.now_ms) == Outcome::Failed
        });
    if failed && fallback.is_some() {
        return go_back(format!(
            "{current} ended {KEPT_STARTS} times in a row before it drew its first window"
        ));
    }
    Choice::Launch {
        version: current.clone(),
        record: Record::Append,
    }
}

/// [starts] after a launch: [record] applied to the [start] just made.
pub fn recorded(mut starts: Vec<Start>, start: Option<Start>, record: Record) -> Vec<Start> {
    match (record, start) {
        (Record::Clear, _) => Vec::new(),
        (Record::Keep, _) | (Record::Append, None) => starts,
        (Record::Append, Some(start)) => {
            starts.push(start);
            let drop = starts.len().saturating_sub(KEPT_STARTS);
            starts.drain(..drop);
            starts
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_000_000;

    fn start(version: &str, ago_ms: u64, liveness: Liveness) -> Looked {
        Looked {
            start: Start {
                version: version.into(),
                at_ms: NOW - ago_ms,
                pid: 10,
                created: 1,
            },
            liveness,
        }
    }

    /// An updated install: current 2.0.0 and previous 1.0.0, both with their exe, nothing running, no `.started`.
    fn updated(starts: Vec<Looked>) -> LaunchHistory {
        LaunchHistory {
            now_ms: NOW,
            current: Some("2.0.0".into()),
            current_exe: true,
            current_started: false,
            previous: Some("1.0.0".into()),
            previous_exe: true,
            instance_running: false,
            starts,
        }
    }

    fn launch(record: Record) -> Choice {
        Choice::Launch {
            version: "2.0.0".into(),
            record,
        }
    }

    #[test]
    fn a_missing_exe_goes_back_at_once() {
        let history = LaunchHistory {
            current_exe: false,
            ..updated(vec![])
        };
        assert!(
            matches!(decide(&history), Choice::RollBack { ref to, ref reason } if to == "1.0.0" && reason.contains("has no harness-desktop.exe"))
        );
        let history = LaunchHistory {
            current: None,
            ..updated(vec![])
        };
        assert!(matches!(decide(&history), Choice::RollBack { ref to, .. } if to == "1.0.0"));
    }

    #[test]
    fn with_nothing_to_go_back_to_a_missing_exe_is_broken() {
        let history = LaunchHistory {
            current_exe: false,
            previous: None,
            ..updated(vec![])
        };
        assert!(
            matches!(decide(&history), Choice::Broken { ref reason } if reason.contains("no earlier version"))
        );
        let history = LaunchHistory {
            current_exe: false,
            previous_exe: false,
            ..updated(vec![])
        };
        assert!(matches!(decide(&history), Choice::Broken { .. }));
        // previous naming the broken current is no way back either.
        let history = LaunchHistory {
            current_exe: false,
            previous: Some("2.0.0".into()),
            ..updated(vec![])
        };
        assert!(matches!(decide(&history), Choice::Broken { .. }));
    }

    #[test]
    fn two_starts_that_ended_without_a_first_frame_go_back() {
        let history = updated(vec![
            start("2.0.0", 60_000, Liveness::Ended),
            start("2.0.0", 2_000, Liveness::Ended),
        ]);
        assert!(
            matches!(decide(&history), Choice::RollBack { ref to, ref reason } if to == "1.0.0" && reason.contains("2 times in a row"))
        );
    }

    #[test]
    fn one_failed_start_is_not_enough() {
        assert_eq!(
            decide(&updated(vec![start("2.0.0", 2_000, Liveness::Ended)])),
            launch(Record::Append)
        );
        assert_eq!(decide(&updated(vec![])), launch(Record::Append));
    }

    #[test]
    fn a_start_still_running_never_counts_against_its_version() {
        let history = updated(vec![
            start("2.0.0", 2_000, Liveness::Ended),
            start("2.0.0", 1_000, Liveness::Running),
        ]);
        assert_eq!(decide(&history), launch(Record::Append));
        let history = updated(vec![
            start("2.0.0", 90_000, Liveness::Running),
            start("2.0.0", 1_000, Liveness::Ended),
        ]);
        assert_eq!(decide(&history), launch(Record::Append));
    }

    #[test]
    fn a_running_instance_takes_the_launch_and_nothing_is_recorded() {
        // Review Focus 4: a second launch while the first is starting, or a link clicked while it runs.
        let history = LaunchHistory {
            instance_running: true,
            ..updated(vec![
                start("2.0.0", 3_000, Liveness::Ended),
                start("2.0.0", 2_000, Liveness::Ended),
            ])
        };
        assert_eq!(decide(&history), launch(Record::Keep));
    }

    #[test]
    fn a_version_that_drew_its_window_once_is_never_rolled_back() {
        let history = LaunchHistory {
            current_started: true,
            ..updated(vec![
                start("2.0.0", 3_000, Liveness::Ended),
                start("2.0.0", 2_000, Liveness::Ended),
            ])
        };
        assert_eq!(decide(&history), launch(Record::Clear));
    }

    #[test]
    fn when_a_start_cannot_be_looked_at_it_has_ten_seconds() {
        let young = updated(vec![
            start("2.0.0", 30_000, Liveness::Unknown),
            start("2.0.0", 9_999, Liveness::Unknown),
        ]);
        assert_eq!(decide(&young), launch(Record::Append));
        let old = updated(vec![
            start("2.0.0", 30_000, Liveness::Unknown),
            start("2.0.0", START_WINDOW_MS, Liveness::Unknown),
        ]);
        assert!(matches!(decide(&old), Choice::RollBack { .. }));
    }

    #[test]
    fn only_two_failures_of_current_in_a_row_count() {
        // The older failure was the previous version's.
        let history = updated(vec![
            start("1.0.0", 60_000, Liveness::Ended),
            start("2.0.0", 2_000, Liveness::Ended),
        ]);
        assert_eq!(decide(&history), launch(Record::Append));
    }

    #[test]
    fn a_first_install_that_keeps_failing_keeps_launching_its_only_version() {
        let history = LaunchHistory {
            previous: None,
            previous_exe: false,
            ..updated(vec![
                start("2.0.0", 3_000, Liveness::Ended),
                start("2.0.0", 2_000, Liveness::Ended),
            ])
        };
        assert_eq!(decide(&history), launch(Record::Append));
    }

    #[test]
    fn a_rollback_leaves_a_working_app_by_the_third_start() {
        // The whole sequence, as launch.rs runs it: two failed starts of 2.0.0, then the third goes back.
        let mut starts: Vec<Start> = Vec::new();
        let mut current = "2.0.0".to_owned();
        let mut previous = Some("1.0.0".to_owned());
        let mut launched = Vec::new();
        for n in 0..3u64 {
            let looked = starts
                .iter()
                .map(|s| Looked {
                    start: s.clone(),
                    liveness: Liveness::Ended,
                })
                .collect();
            let history = LaunchHistory {
                now_ms: NOW + n * 1_000,
                current: Some(current.clone()),
                current_exe: true,
                current_started: current == "1.0.0",
                previous: previous.clone(),
                previous_exe: previous.is_some(),
                instance_running: false,
                starts: looked,
            };
            let choice = match decide(&history) {
                Choice::RollBack { to, .. } => {
                    current = to;
                    previous = None;
                    starts.clear();
                    let history = LaunchHistory {
                        current: Some(current.clone()),
                        current_started: true,
                        previous: None,
                        previous_exe: false,
                        starts: vec![],
                        ..history
                    };
                    decide(&history)
                }
                other => other,
            };
            let Choice::Launch { version, record } = choice else {
                panic!("{choice:?}")
            };
            let made = Start {
                version: version.clone(),
                at_ms: NOW + n * 1_000,
                pid: n as u32 + 1,
                created: n + 1,
            };
            starts = recorded(starts, Some(made), record);
            launched.push(version);
        }
        assert_eq!(launched, ["2.0.0", "2.0.0", "1.0.0"]);
    }

    #[test]
    fn records_keep_the_last_two_starts() {
        let s = |n: u64| Start {
            version: "2.0.0".into(),
            at_ms: n,
            pid: n as u32,
            created: n,
        };
        assert_eq!(
            recorded(vec![s(1), s(2)], Some(s(3)), Record::Append),
            vec![s(2), s(3)]
        );
        assert_eq!(recorded(vec![s(1)], Some(s(2)), Record::Keep), vec![s(1)]);
        assert_eq!(recorded(vec![s(1)], Some(s(2)), Record::Clear), vec![]);
        assert_eq!(recorded(vec![s(1)], None, Record::Append), vec![s(1)]);
    }
    #[test]
    fn future_unknown_start_waits_and_only_the_last_two_starts_count() {
        let looked = Looked {
            start: Start {
                version: "2.0.0".into(),
                at_ms: NOW + 1,
                pid: 1,
                created: 0,
            },
            liveness: Liveness::Unknown,
        };
        assert_eq!(outcome(&looked, NOW), Outcome::Waiting);
        let history = updated(vec![
            start("2.0.0", 60_000, Liveness::Ended),
            start("2.0.0", 30_000, Liveness::Ended),
            start("2.0.0", 1, Liveness::Running),
        ]);
        assert_eq!(decide(&history), launch(Record::Append));
    }
}
