//! Copy mode against what tmux 3.5a does with the same keys (the round-11 review's repros and
//! window-copy.c's own rules), driven through the command table as a binding would.

use super::*;

const WS: &str = "!\"#$%&'()*+,-./:;<=>?@[\\]^`{|}~";

/// A pane of [cols]×[rows] fed [text], put into copy mode.
struct T { c: Copy, ps: PaneSearch, ctx: Ctx, outs: Vec<Out> }

impl T {
    fn new(text: &str, cols: u16, rows: u16, vi: bool) -> T {
        let mut p = crate::pane::Pane::new(1, "m", "a", cols, rows);
        p.feed(text.as_bytes());
        let grid = from_term(&p.term, &p.times, false);
        let cur = p.term.grid().cursor.point;
        let c = Copy::copy(grid, (cur.column.0 as u32, cur.line.0.max(0) as u32), cols as u32, rows as u32, &PaneSearch::default(), !vi, false, false);
        T { c, ps: PaneSearch::default(), ctx: Ctx { vi, wrap: true, ws: WS.into() }, outs: Vec::new() }
    }
    fn run(&mut self, words: &[&str]) -> Action {
        let args = words.iter().map(|w| w.to_string()).collect();
        let (a, outs) = run(&mut self.c, &mut self.ps, &self.ctx, args, None);
        self.outs.extend(outs);
        a
    }
    fn n(&mut self, n: u32, words: &[&str]) -> Action { self.c.prefix = n; self.run(words) }
    fn at(&self) -> (u32, u32, u32) { (self.c.cx, self.c.cy, self.c.oy) }
    fn copied(&self) -> Option<String> {
        self.outs.iter().rev().find_map(|o| match o { Out::Copy { text, .. } => Some(text.clone()), Out::Pipe { text, copy: Some(_), .. } => Some(text.clone()), _ => None })
    }
}

/// The review's lines: `$ line NN alpha-beta gamma_delta foo.bar/baz NN`, 1..=n, then a prompt.
fn lines(n: u32) -> String {
    let mut s = String::new();
    for i in 1..=n { s.push_str(&format!("$ line {i:02} alpha-beta gamma_delta foo.bar/baz {i:02}\r\n")) }
    s.push_str("$ ");
    s
}

#[test]
fn forward_search_starts_at_the_cursor() {
    // C1: five lines up, the start of the line, /gamma: the match on that same line.
    let mut t = T::new(&lines(20), 60, 10, true);
    assert_eq!(t.at(), (2, 9, 0));
    t.n(5, &["cursor-up"]);
    // Sticky end of line (M1): from the prompt's end the cursor keeps to line ends.
    assert_eq!(t.at(), (47, 4, 0));
    t.run(&["start-of-line"]);
    t.run(&["search-forward", "gamma"]);
    assert_eq!(t.at(), (21, 4, 0));
    // n: the next one, a line down.
    t.run(&["search-again"]);
    assert_eq!(t.at(), (21, 5, 0));
    // Every match is counted; the header says how many.
    assert_eq!(t.c.searchcount, 20);
    assert_eq!(t.c.header().as_deref(), Some("(20 results) [0/11]"));
}

#[test]
fn emacs_forward_search_leaves_the_cursor_after_the_match() {
    let mut t = T::new(&lines(20), 60, 10, false);
    t.n(5, &["cursor-up"]);
    t.run(&["start-of-line"]);
    t.run(&["search-forward-incremental", "=gamma"]);
    assert_eq!(t.at(), (26, 4, 0));
}

#[test]
fn backward_search_lands_on_the_start_of_the_match() {
    let mut t = T::new(&lines(20), 60, 10, true);
    t.run(&["search-backward", "line 10"]);
    // Line 10 is in the history: the view scrolls to it (a quarter screen left below).
    let (cx, cy, oy) = t.at();
    assert_eq!(cx, 2);
    assert_eq!(t.c.backing.hsize + cy - oy, 9);
}

#[test]
fn emacs_end_of_line_copies_the_whole_line() {
    // C2: C-a C-Space C-e M-w — every character, no newline.
    let mut t = T::new(&lines(20), 60, 10, false);
    t.run(&["cursor-up"]);
    t.run(&["start-of-line"]);
    t.run(&["begin-selection"]);
    t.run(&["end-of-line"]);
    assert_eq!(t.at().0, 47);
    assert_eq!(t.run(&["copy-pipe-and-cancel"]), Action::Cancel);
    assert_eq!(t.copied().as_deref(), Some("$ line 20 alpha-beta gamma_delta foo.bar/baz 20"));
}

#[test]
fn vi_end_of_line_copies_the_newline_too() {
    // Low 6: vi's Space $ Enter keeps the line's newline.
    let mut t = T::new(&lines(20), 60, 10, true);
    t.run(&["cursor-up"]);
    t.run(&["start-of-line"]);
    t.run(&["begin-selection"]);
    t.run(&["end-of-line"]);
    assert_eq!(t.at().0, 47);
    t.run(&["copy-pipe-and-cancel"]);
    assert_eq!(t.copied().as_deref(), Some("$ line 20 alpha-beta gamma_delta foo.bar/baz 20\n"));
}

#[test]
fn emacs_next_word_end_stops_after_each_word() {
    // H1: M-f from column 0 of `$ line 58 alpha…`: 1, 6, 9, 15.
    let mut t = T::new(&lines(20), 60, 10, false);
    t.run(&["cursor-up"]);
    t.run(&["start-of-line"]);
    let mut seen = Vec::new();
    for _ in 0..4 { t.run(&["next-word-end"]); seen.push(t.at().0) }
    assert_eq!(seen, vec![1, 6, 9, 15]);
}

#[test]
fn vi_words() {
    let mut t = T::new("utilization.gpu name, x", 40, 12, true);
    t.run(&["start-of-line"]);
    t.run(&["next-word-end"]);
    assert_eq!(t.at().0, 10, "e stops before the dot");
    t.run(&["next-word"]);
    assert_eq!(t.at().0, 11, "w to the dot");
    t.run(&["next-space"]);
    assert_eq!(t.at().0, 16, "W past it to name");
}

#[test]
fn selections_either_way() {
    let mut t = T::new("abcdefghij", 40, 12, true);
    t.run(&["start-of-line"]);
    t.n(2, &["cursor-right"]);
    t.run(&["begin-selection"]);
    t.n(3, &["cursor-right"]);
    assert_eq!(t.c.get_selection(&t.ctx).as_deref(), Some("cdef"));
    // o: the cursor to the other end, the same cells.
    t.run(&["other-end"]);
    assert_eq!(t.at().0, 2);
    assert_eq!(t.c.get_selection(&t.ctx).as_deref(), Some("cdef"));
    t.run(&["cursor-left"]);
    assert_eq!(t.c.get_selection(&t.ctx).as_deref(), Some("bcdef"));
    // emacs: the region stops short of the cursor's cell.
    let mut e = T::new("abcdefghij", 40, 12, false);
    e.run(&["start-of-line"]);
    e.n(2, &["cursor-right"]);
    e.run(&["begin-selection"]);
    e.n(3, &["cursor-right"]);
    assert_eq!(e.c.get_selection(&e.ctx).as_deref(), Some("cde"));
}

#[test]
fn rectangles() {
    let mut t = T::new("abcdef\r\nghijkl\r\nmnopqr", 40, 12, true);
    t.run(&["history-top"]);
    t.n(1, &["cursor-right"]);
    t.run(&["begin-selection"]);
    t.run(&["rectangle-toggle"]);
    t.n(2, &["cursor-down"]);
    t.n(2, &["cursor-right"]);
    assert_eq!(t.c.get_selection(&t.ctx).as_deref(), Some("bcd\nhij\nnop"));
}

#[test]
fn select_word_and_line() {
    let mut t = T::new("foo.bar baz", 40, 12, true);
    t.run(&["start-of-line"]);
    t.n(5, &["cursor-right"]);
    t.run(&["select-word"]);
    assert_eq!(t.c.get_selection(&t.ctx).as_deref(), Some("bar"));
    t.run(&["select-line"]);
    assert_eq!(t.c.get_selection(&t.ctx).as_deref(), Some("foo.bar baz\n"));
}

#[test]
fn jumps_and_repeats() {
    let mut t = T::new("a,b,c,d,e", 40, 12, true);
    t.run(&["start-of-line"]);
    t.run(&["jump-forward", ","]);
    assert_eq!(t.at().0, 1);
    t.n(2, &["jump-again"]);
    assert_eq!(t.at().0, 5);
    t.run(&["jump-reverse"]);
    assert_eq!(t.at().0, 3);
    t.run(&["jump-to-forward", "e"]);
    assert_eq!(t.at().0, 7);
}

#[test]
fn brackets() {
    let mut t = T::new("x (a [b] c) y", 40, 12, true);
    t.run(&["start-of-line"]);
    t.run(&["next-matching-bracket"]);
    assert_eq!(t.at().0, 10, "vi: on to the first bracket, then its match");
    t.run(&["next-matching-bracket"]);
    assert_eq!(t.at().0, 2, "on a closing one: back to its opening one");
}

#[test]
fn pages_and_the_history() {
    let mut t = T::new(&lines(40), 60, 10, true);
    let hsize = t.c.backing.hsize;
    t.run(&["page-up"]);
    assert_eq!(t.c.oy, 8);
    t.run(&["halfpage-up"]);
    assert_eq!(t.c.oy, 13);
    t.run(&["history-top"]);
    assert_eq!((t.c.oy, t.c.cy, t.c.cx), (hsize, 0, 0));
    t.run(&["history-bottom"]);
    assert_eq!((t.c.oy, t.c.cy, t.c.cx), (0, 9, 1));
    // -e: scrolled back to the bottom, the mode ends.
    t.c.scroll_exit = true;
    t.run(&["scroll-up"]);
    assert_eq!(t.run(&["scroll-down"]), Action::Cancel);
    t.run(&["goto-line", "25"]);
    assert_eq!(t.c.oy, 25);
}

#[test]
fn marks() {
    let mut t = T::new(&lines(20), 60, 10, true);
    t.run(&["set-mark"]);
    t.run(&["history-top"]);
    t.run(&["jump-to-mark"]);
    assert_eq!(t.at(), (2, 9, 0));
    assert!(t.c.showmark);
}

#[test]
fn search_marks_go_with_the_next_command() {
    // M2's cousin: a command that clears (emacs cursor-up) takes the marks; vi keeps them.
    let mut e = T::new(&lines(20), 60, 10, false);
    e.run(&["search-backward-text", "alpha"]);
    assert!(e.c.searchmark.is_some());
    e.run(&["cursor-up"]);
    assert!(e.c.searchmark.is_none());
    let mut v = T::new(&lines(20), 60, 10, true);
    v.run(&["search-backward", "alpha"]);
    v.run(&["cursor-up"]);
    assert!(v.c.searchmark.is_some());
}

#[test]
fn regex_search() {
    let mut t = T::new(&lines(20), 60, 10, true);
    t.run(&["search-backward", "line 1[0-9]"]);
    let y = t.c.backing.hsize + t.c.cy - t.c.oy;
    assert_eq!((t.c.cx, y), (2, 18), "the nearest match above: line 19");
    assert_eq!(t.c.searchcount, 10);
}

#[test]
fn view_mode_keeps_the_top_in_view() {
    let mut v = Copy::view(20, 3, &PaneSearch::default(), false);
    for l in ["one", "two", "three", "four", "five"] { v.add_text(l) }
    assert_eq!(v.backing.hsize, 2);
    assert_eq!(v.oy, 2);
    // Row 0 carries the position (and the top line's time: it went into the history).
    assert!(v.line_at(0).unwrap().starts_with("one "));
    assert!(v.header().unwrap().ends_with(" [2/2]"));
    assert_eq!(v.line_at(1).as_deref(), Some("two"));
    // A line longer than the view wraps onto the next.
    let mut w = Copy::view(5, 3, &PaneSearch::default(), false);
    w.add_text("abcdefgh");
    assert!(w.backing.line(0).wrapped);
    assert_eq!(w.line_at(1).as_deref(), Some("fgh"));
}

#[test]
fn wide_characters() {
    let mut t = T::new("ab日本cd", 40, 12, true);
    t.run(&["start-of-line"]);
    t.n(3, &["cursor-right"]);
    assert_eq!(t.at().0, 4, "a wide character is one step");
    t.run(&["begin-selection"]);
    t.run(&["cursor-right"]);
    assert_eq!(t.c.get_selection(&t.ctx).as_deref(), Some("本c"));
}

#[test]
fn a_wrapped_line_is_one_line() {
    // 10 columns: `abcdefghijklmno` wraps; start-of-line and end-of-line cross it.
    let mut t = T::new("abcdefghijklmno", 10, 5, true);
    assert_eq!(t.at(), (5, 1, 0));
    t.run(&["start-of-line"]);
    assert_eq!(t.at(), (0, 0, 0));
    t.run(&["begin-selection"]);
    t.run(&["end-of-line"]);
    assert_eq!(t.at(), (5, 1, 0));
    t.run(&["copy-selection"]);
    assert_eq!(t.copied().as_deref(), Some("abcdefghijklmno\n"));
}
