//! capture-pane's text lives in the `harness-term` crate (shared with the PTY host); this module
//! keeps hn's `Pane`-taking signatures over it.

#[cfg(test)]
use alacritty_terminal::index::{Column, Line};
#[cfg(test)]
use alacritty_terminal::term::cell::Flags;

pub use harness_term::capture::{Flags2, cell_style, cell_style_change};
use crate::pane::Pane;

pub fn history(pane: &Pane, top: i32, bottom: i32, f: Flags2) -> String {
    harness_term::capture::history(pane.term.grid(), top, bottom, f)
}

pub fn line_of(pane: &Pane, value: Option<&str>, start: bool) -> i32 {
    harness_term::capture::line_bounds(pane.term.grid(), value, start,
        |v| crate::commands::strtonum(v, i32::MIN as i64, i16::MAX as i64).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmux_attributes_survive_chunked_output_and_reconnect() {
        let mut source = Pane::new(1, "local", "source", 20, 4);
        source.enable_local();
        for byte in b"\x1b[1;21mDOUBLE\x1b[0m\r\n\x1b[5mBLINK\x1b[25mPLAIN\r\n\x1b[53mOVER\x1b[55mPLAIN\r\n\x1b[21;6;53mALL" {
            source.feed(&[*byte]);
        }
        let grid = source.term.grid();
        assert!(grid[Line(0)][Column(0)].flags.contains(Flags::BOLD | Flags::DOUBLE_UNDERLINE));
        assert!(grid[Line(1)][Column(0)].flags.contains(Flags::BLINK));
        assert!(!grid[Line(1)][Column(5)].flags.contains(Flags::BLINK));
        assert!(grid[Line(2)][Column(0)].flags.contains(Flags::OVERLINE));
        assert!(!grid[Line(2)][Column(4)].flags.contains(Flags::OVERLINE));
        assert!(grid[Line(3)][Column(0)].flags.contains(Flags::DOUBLE_UNDERLINE | Flags::BLINK | Flags::OVERLINE));
        let f = Flags2 { sequences: true, empty_cells: true, trim: true, ..Default::default() };
        let before = history(&source, 0, 3, f);
        assert!(before.starts_with("\x1b[1;4:2mDOUBLE\x1b[0m"));
        assert!(before.contains("\x1b[5mBLINK\x1b[0mPLAIN"));
        assert!(before.contains("\x1b[5:3mOVER\x1b[0mPLAIN"));
        let mut mirror = Pane::new(2, "local", "mirror", 20, 4);
        mirror.keyframe(20, 4, &source.local_snapshot(b""));
        assert_eq!(before, history(&mirror, 0, 3, f));
        // The cursor's attributes, not just already-painted cells, survive a snapshot.
        source.feed(b"NEXT\x1b[0mPLAIN");
        mirror.feed(b"NEXT\x1b[0mPLAIN");
        assert_eq!(history(&source, 0, 3, f), history(&mirror, 0, 3, f));
    }
}
