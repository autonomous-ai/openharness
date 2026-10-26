//! Pane ids that never repeat for a host home, across boots.
//!
//! A client names a pane by `<instance>:<id>`, and the instance is fixed per protocol (`p1`).
//! A host that died and was started again used to hand out `%1` once more, so the old daemon
//! record of `ptyhost:p1:%1` matched a new, unrelated pane (Task 15 review): its tile and its
//! input could reach another agent's pane before the reconciler had counted it missing twice.
//!
//! The counter lives in `<home>/run/pty-host-<instance>.panes`, as the decimal ceiling of the ids
//! reserved so far. Ids are reserved in blocks of `BLOCK`: the new ceiling is written (temporary
//! file, fsync, rename, owner-only) before any id of its block is handed out, so a crash at any
//! point leaves a ceiling at or above every id already used. A new boot starts after it. A
//! missing or unreadable file starts at 1.

use std::io;
use std::path::{Path, PathBuf};


/// How many ids one write of the counter file reserves.
pub const BLOCK: u64 = 1000;

pub fn file_path(run_dir: &Path) -> PathBuf {
    crate::instance::run_file(run_dir, &crate::instance::current(), "panes")
}

/// The next pane number, and the reservation that covers it.
#[derive(Debug)]
pub struct PaneIds {
    next: u64,
    /// The highest number reserved: `next` may be handed out only while it is at or below this.
    ceiling: u64,
    /// The counter file; none for a table that need not survive (tests).
    file: Option<PathBuf>,
}

impl PaneIds {
    /// Ids from 1, kept in memory only.
    pub fn in_memory() -> PaneIds {
        PaneIds {
            next: 1,
            ceiling: u64::MAX,
            file: None,
        }
    }

    /// The ids of the host serving `run_dir`: after every id an earlier boot may have used. The
    /// first block is reserved now, so a host that cannot keep its counter fails at start.
    pub fn persistent(run_dir: &Path) -> io::Result<PaneIds> {
        let file = file_path(run_dir);
        let previous = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| text.trim().parse::<u64>().ok())
            .unwrap_or(0);
        let mut ids = PaneIds {
            next: previous.saturating_add(1),
            ceiling: previous,
            file: Some(file),
        };
        ids.reserve()?;
        Ok(ids)
    }

    /// The next pane number, reserving a new block first when this one is used up.
    pub fn take(&mut self) -> io::Result<u64> {
        if self.next > self.ceiling {
            self.reserve()?;
        }
        let id = self.next;
        self.next += 1;
        Ok(id)
    }

    /// Persist a ceiling `BLOCK - 1` above `next`, then use it.
    fn reserve(&mut self) -> io::Result<()> {
        let ceiling = self.next.saturating_add(BLOCK - 1);
        if let Some(file) = &self.file {
            write_ceiling(file, ceiling)?;
        }
        self.ceiling = ceiling;
        Ok(())
    }
}

fn write_ceiling(path: &Path, ceiling: u64) -> io::Result<()> {
    let tmp = path.with_extension(format!("panes.{}.tmp", std::process::id()));
    crate::files::replace_private(&tmp, path, format!("{ceiling}\n").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ceiling_in(dir: &Path) -> String {
        std::fs::read_to_string(file_path(dir)).unwrap()
    }

    #[test]
    fn a_new_boot_starts_after_every_id_of_the_previous_one() {
        let dir = tempfile::tempdir().unwrap();
        let mut first = PaneIds::persistent(dir.path()).unwrap();
        // The first block is on disk before any id is handed out.
        assert_eq!(ceiling_in(dir.path()), format!("{BLOCK}\n"));
        let used: Vec<u64> = (0..BLOCK + 5).map(|_| first.take().unwrap()).collect();
        assert_eq!(used.first(), Some(&1));
        // Past the first block, the second was reserved before its first id.
        assert_eq!(ceiling_in(dir.path()), format!("{}\n", 2 * BLOCK));
        drop(first);
        let mut second = PaneIds::persistent(dir.path()).unwrap();
        let next = second.take().unwrap();
        assert!(used.iter().all(|&id| id < next), "{next}");
        assert_eq!(next, 2 * BLOCK + 1);
        assert_eq!(ceiling_in(dir.path()), format!("{}\n", 3 * BLOCK));
    }

    #[test]
    fn a_boot_that_handed_out_no_id_still_moves_the_next_one_on() {
        let dir = tempfile::tempdir().unwrap();
        let mut first = PaneIds::persistent(dir.path()).unwrap();
        let a = first.take().unwrap();
        drop(first);
        drop(PaneIds::persistent(dir.path()).unwrap());
        let b = PaneIds::persistent(dir.path()).unwrap().take().unwrap();
        assert!(b > a);
    }

    #[test]
    fn a_missing_or_corrupt_counter_starts_at_one_and_is_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(file_path(dir.path()), "not a number").unwrap();
        let mut ids = PaneIds::persistent(dir.path()).unwrap();
        assert_eq!(ids.take().unwrap(), 1);
        assert_eq!(ceiling_in(dir.path()), format!("{BLOCK}\n"));
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(
            PaneIds::persistent(empty.path()).unwrap().take().unwrap(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_counter_file_is_the_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        PaneIds::persistent(dir.path()).unwrap();
        let mode = std::fs::metadata(file_path(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        // No temporary file is left behind.
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
    }

    #[test]
    fn a_counter_that_cannot_be_written_fails_the_start() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("no-such-dir");
        assert!(PaneIds::persistent(&missing).is_err());
    }

    #[test]
    fn in_memory_ids_count_from_one() {
        let mut ids = PaneIds::in_memory();
        assert_eq!((ids.take().unwrap(), ids.take().unwrap()), (1, 2));
    }
}
