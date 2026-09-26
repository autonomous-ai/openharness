//! The copy-mode commands (window_copy_cmd_table and its window_copy_cmd_* functions), ported.

use super::*;

/// Where the mouse button went down for the key that ran a command, in the pane's cells.
#[derive(Clone, Copy, Debug)]
pub struct MousePos { pub lx: u32, pub ly: u32 }

/// What a command asks of the rest of hn.
#[derive(Clone, Debug, PartialEq)]
pub enum Out {
    /// window_copy_copy_buffer: the clipboard (set-clipboard) and a new paste buffer.
    Copy { prefix: Option<String>, text: String },
    /// window_copy_pipe_run: the text into a command (copy-command without one); with `copy`,
    /// the text into a paste buffer too (with that prefix).
    Pipe { cmd: Option<String>, text: String, copy: Option<Option<String>> },
    /// window_copy_append_selection: onto the newest automatic buffer.
    Append(String),
    /// A drag begun (window_copy_start_drag): the mouse's motion moves the selection's end.
    Drag,
    /// refresh-from-pane: a new copy of the pane.
    Refresh,
}

/// A command's arguments and what it reaches (window_copy_cmd_state).
pub struct Cs<'a> {
    /// The command's arguments, 0 its name (formats already expanded where tmux expands them).
    pub args: Vec<String>,
    pub ps: &'a mut PaneSearch,
    pub ctx: Ctx,
    pub mouse: Option<MousePos>,
    pub out: Vec<Out>,
}

impl Cs<'_> {
    fn arg(&self, i: usize) -> Option<&str> { self.args.get(i).map(String::as_str) }
    fn count(&self) -> usize { self.args.len() }
}

/// window_copy_cmd_clear: what a command does to the search marks.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Clear { Always, Never, EmacsOnly }

pub type CmdFn = fn(&mut Copy, &mut Cs) -> Action;

/// tmux 3.5a's window_copy_cmd_table: name, fewest and most arguments, how it clears the marks.
pub const TABLE: &[(&str, usize, usize, Clear, CmdFn)] = &[
    ("append-selection", 0, 0, Clear::Always, Copy::cmd_append_selection),
    ("append-selection-and-cancel", 0, 0, Clear::Always, Copy::cmd_append_selection_and_cancel),
    ("back-to-indentation", 0, 0, Clear::Always, Copy::cmd_back_to_indentation),
    ("begin-selection", 0, 0, Clear::Always, Copy::cmd_begin_selection),
    ("bottom-line", 0, 0, Clear::EmacsOnly, Copy::cmd_bottom_line),
    ("cancel", 0, 0, Clear::Always, Copy::cmd_cancel),
    ("clear-selection", 0, 0, Clear::Always, Copy::cmd_clear_selection),
    ("copy-end-of-line", 0, 1, Clear::Always, Copy::cmd_copy_end_of_line),
    ("copy-end-of-line-and-cancel", 0, 1, Clear::Always, Copy::cmd_copy_end_of_line_and_cancel),
    ("copy-pipe-end-of-line", 0, 2, Clear::Always, Copy::cmd_copy_pipe_end_of_line),
    ("copy-pipe-end-of-line-and-cancel", 0, 2, Clear::Always, Copy::cmd_copy_pipe_end_of_line_and_cancel),
    ("copy-line", 0, 1, Clear::Always, Copy::cmd_copy_line),
    ("copy-line-and-cancel", 0, 1, Clear::Always, Copy::cmd_copy_line_and_cancel),
    ("copy-pipe-line", 0, 2, Clear::Always, Copy::cmd_copy_pipe_line),
    ("copy-pipe-line-and-cancel", 0, 2, Clear::Always, Copy::cmd_copy_pipe_line_and_cancel),
    ("copy-pipe-no-clear", 0, 2, Clear::Never, Copy::cmd_copy_pipe_no_clear),
    ("copy-pipe", 0, 2, Clear::Always, Copy::cmd_copy_pipe),
    ("copy-pipe-and-cancel", 0, 2, Clear::Always, Copy::cmd_copy_pipe_and_cancel),
    ("copy-selection-no-clear", 0, 1, Clear::Never, Copy::cmd_copy_selection_no_clear),
    ("copy-selection", 0, 1, Clear::Always, Copy::cmd_copy_selection),
    ("copy-selection-and-cancel", 0, 1, Clear::Always, Copy::cmd_copy_selection_and_cancel),
    ("cursor-down", 0, 0, Clear::EmacsOnly, Copy::cmd_cursor_down),
    ("cursor-down-and-cancel", 0, 0, Clear::Always, Copy::cmd_cursor_down_and_cancel),
    ("cursor-left", 0, 0, Clear::EmacsOnly, Copy::cmd_cursor_left),
    ("cursor-right", 0, 0, Clear::EmacsOnly, Copy::cmd_cursor_right),
    ("cursor-up", 0, 0, Clear::EmacsOnly, Copy::cmd_cursor_up),
    ("end-of-line", 0, 0, Clear::EmacsOnly, Copy::cmd_end_of_line),
    ("goto-line", 1, 1, Clear::EmacsOnly, Copy::cmd_goto_line),
    ("halfpage-down", 0, 0, Clear::EmacsOnly, Copy::cmd_halfpage_down),
    ("halfpage-down-and-cancel", 0, 0, Clear::Always, Copy::cmd_halfpage_down_and_cancel),
    ("halfpage-up", 0, 0, Clear::EmacsOnly, Copy::cmd_halfpage_up),
    ("history-bottom", 0, 0, Clear::EmacsOnly, Copy::cmd_history_bottom),
    ("history-top", 0, 0, Clear::EmacsOnly, Copy::cmd_history_top),
    ("jump-again", 0, 0, Clear::EmacsOnly, Copy::cmd_jump_again),
    ("jump-backward", 1, 1, Clear::EmacsOnly, Copy::cmd_jump_backward),
    ("jump-forward", 1, 1, Clear::EmacsOnly, Copy::cmd_jump_forward),
    ("jump-reverse", 0, 0, Clear::EmacsOnly, Copy::cmd_jump_reverse),
    ("jump-to-backward", 1, 1, Clear::EmacsOnly, Copy::cmd_jump_to_backward),
    ("jump-to-forward", 1, 1, Clear::EmacsOnly, Copy::cmd_jump_to_forward),
    ("jump-to-mark", 0, 0, Clear::Always, Copy::cmd_jump_to_mark),
    ("next-prompt", 0, 1, Clear::Always, Copy::cmd_next_prompt),
    ("previous-prompt", 0, 1, Clear::Always, Copy::cmd_previous_prompt),
    ("middle-line", 0, 0, Clear::EmacsOnly, Copy::cmd_middle_line),
    ("next-matching-bracket", 0, 0, Clear::Always, Copy::cmd_next_matching_bracket),
    ("next-paragraph", 0, 0, Clear::EmacsOnly, Copy::cmd_next_paragraph),
    ("next-space", 0, 0, Clear::EmacsOnly, Copy::cmd_next_space),
    ("next-space-end", 0, 0, Clear::EmacsOnly, Copy::cmd_next_space_end),
    ("next-word", 0, 0, Clear::EmacsOnly, Copy::cmd_next_word),
    ("next-word-end", 0, 0, Clear::EmacsOnly, Copy::cmd_next_word_end),
    ("other-end", 0, 0, Clear::EmacsOnly, Copy::cmd_other_end),
    ("page-down", 0, 0, Clear::EmacsOnly, Copy::cmd_page_down),
    ("page-down-and-cancel", 0, 0, Clear::Always, Copy::cmd_page_down_and_cancel),
    ("page-up", 0, 0, Clear::EmacsOnly, Copy::cmd_page_up),
    ("pipe-no-clear", 0, 1, Clear::Never, Copy::cmd_pipe_no_clear),
    ("pipe", 0, 1, Clear::Always, Copy::cmd_pipe),
    ("pipe-and-cancel", 0, 1, Clear::Always, Copy::cmd_pipe_and_cancel),
    ("previous-matching-bracket", 0, 0, Clear::Always, Copy::cmd_previous_matching_bracket),
    ("previous-paragraph", 0, 0, Clear::EmacsOnly, Copy::cmd_previous_paragraph),
    ("previous-space", 0, 0, Clear::EmacsOnly, Copy::cmd_previous_space),
    ("previous-word", 0, 0, Clear::EmacsOnly, Copy::cmd_previous_word),
    ("rectangle-on", 0, 0, Clear::Always, Copy::cmd_rectangle_on),
    ("rectangle-off", 0, 0, Clear::Always, Copy::cmd_rectangle_off),
    ("rectangle-toggle", 0, 0, Clear::Always, Copy::cmd_rectangle_toggle),
    ("refresh-from-pane", 0, 0, Clear::Always, Copy::cmd_refresh_from_pane),
    ("scroll-bottom", 0, 0, Clear::Always, Copy::cmd_scroll_bottom),
    ("scroll-down", 0, 0, Clear::EmacsOnly, Copy::cmd_scroll_down),
    ("scroll-down-and-cancel", 0, 0, Clear::Always, Copy::cmd_scroll_down_and_cancel),
    ("scroll-middle", 0, 0, Clear::Always, Copy::cmd_scroll_middle),
    ("scroll-top", 0, 0, Clear::Always, Copy::cmd_scroll_top),
    ("scroll-up", 0, 0, Clear::EmacsOnly, Copy::cmd_scroll_up),
    ("search-again", 0, 0, Clear::Always, Copy::cmd_search_again),
    ("search-backward", 0, 1, Clear::Always, Copy::cmd_search_backward),
    ("search-backward-text", 0, 1, Clear::Always, Copy::cmd_search_backward_text),
    ("search-backward-incremental", 1, 1, Clear::Always, Copy::cmd_search_backward_incremental),
    ("search-forward", 0, 1, Clear::Always, Copy::cmd_search_forward),
    ("search-forward-text", 0, 1, Clear::Always, Copy::cmd_search_forward_text),
    ("search-forward-incremental", 1, 1, Clear::Always, Copy::cmd_search_forward_incremental),
    ("search-reverse", 0, 0, Clear::Always, Copy::cmd_search_reverse),
    ("select-line", 0, 0, Clear::Always, Copy::cmd_select_line),
    ("select-word", 0, 0, Clear::Always, Copy::cmd_select_word),
    ("set-mark", 0, 0, Clear::Always, Copy::cmd_set_mark),
    ("start-of-line", 0, 0, Clear::EmacsOnly, Copy::cmd_start_of_line),
    ("stop-selection", 0, 0, Clear::Always, Copy::cmd_stop_selection),
    ("toggle-position", 0, 0, Clear::Never, Copy::cmd_toggle_position),
    ("top-line", 0, 0, Clear::EmacsOnly, Copy::cmd_top_line),
];

/// Commands whose arguments are formats (format_single against the pane): the copy and pipe
/// families' command and buffer prefix.
pub fn expands_args(name: &str) -> bool {
    name.starts_with("copy-pipe") || name.starts_with("copy-selection") || name.starts_with("copy-line") || name.starts_with("copy-end-of-line") || name.starts_with("pipe")
}

const OPEN: [char; 3] = ['{', '[', '('];
const CLOSE: [char; 3] = ['}', ']', ')'];

impl Copy {
    fn np(&self) -> u32 { self.prefix }

    /// window_copy_copy_selection: the selection into a paste buffer (and the clipboard).
    fn copy_selection(&self, cs: &mut Cs, prefix: Option<String>) {
        if let Some(text) = self.get_selection(&cs.ctx) { cs.out.push(Out::Copy { prefix, text }) }
    }
    /// window_copy_copy_pipe: into a command (or copy-command), then a paste buffer.
    fn copy_pipe(&self, cs: &mut Cs, prefix: Option<String>, cmd: Option<String>) {
        let text = self.get_selection(&cs.ctx);
        let copy = text.is_some().then_some(prefix);
        cs.out.push(Out::Pipe { cmd, text: text.unwrap_or_default(), copy });
    }
    /// window_copy_pipe: into a command only.
    fn pipe(&self, cs: &mut Cs, cmd: Option<String>) {
        let text = self.get_selection(&cs.ctx).unwrap_or_default();
        cs.out.push(Out::Pipe { cmd, text, copy: None });
    }

    pub(super) fn cmd_append_selection(&mut self, cs: &mut Cs) -> Action {
        if let Some(text) = self.get_selection(&cs.ctx) { cs.out.push(Out::Append(text)) }
        self.clear_selection();
        Action::Redraw
    }
    pub(super) fn cmd_append_selection_and_cancel(&mut self, cs: &mut Cs) -> Action {
        if let Some(text) = self.get_selection(&cs.ctx) { cs.out.push(Out::Append(text)) }
        self.clear_selection();
        Action::Cancel
    }
    pub(super) fn cmd_back_to_indentation(&mut self, cs: &mut Cs) -> Action { self.cursor_back_to_indentation(&cs.ctx); Action::Nothing }
    pub(super) fn cmd_begin_selection(&mut self, cs: &mut Cs) -> Action {
        if let Some(m) = cs.mouse {
            self.start_drag(m.lx, m.ly, &cs.ctx);
            cs.out.push(Out::Drag);
            return Action::Nothing;
        }
        self.lineflag = LineSel::None;
        self.selflag = SelFlag::Char;
        self.start_selection(&cs.ctx);
        Action::Redraw
    }
    pub(super) fn cmd_stop_selection(&mut self, _: &mut Cs) -> Action {
        self.cursordrag = Drag::None;
        self.lineflag = LineSel::None;
        self.selflag = SelFlag::Char;
        Action::Nothing
    }
    pub(super) fn cmd_bottom_line(&mut self, cs: &mut Cs) -> Action {
        self.cx = 0;
        self.cy = self.sy - 1;
        self.update_selection(false, &cs.ctx);
        Action::Redraw
    }
    pub(super) fn cmd_cancel(&mut self, _: &mut Cs) -> Action { Action::Cancel }
    pub(super) fn cmd_clear_selection(&mut self, _: &mut Cs) -> Action { self.clear_selection(); Action::Redraw }

    /// The copy family's (command, prefix) from its arguments.
    fn pipe_args(cs: &Cs, pipe: bool) -> (Option<String>, Option<String>) {
        let count = cs.count();
        let (mut prefix, mut command) = (None, None);
        if pipe {
            if count == 3 { prefix = cs.arg(2).map(str::to_string) }
            if count > 1 && cs.arg(1).map(|a| !a.is_empty()).unwrap_or(false) { command = cs.arg(1).map(str::to_string) }
        } else if count == 2 {
            prefix = cs.arg(1).map(str::to_string);
        }
        (command, prefix)
    }

    /// window_copy_do_copy_end_of_line.
    fn do_copy_end_of_line(&mut self, cs: &mut Cs, pipe: bool, cancel: bool) -> Action {
        let np = self.np();
        let (command, prefix) = Copy::pipe_args(cs, pipe);
        let (ocx, ocy, ooy) = (self.cx, self.cy, self.oy);
        self.start_selection(&cs.ctx);
        for _ in 1..np { self.cursor_down(false, &cs.ctx) }
        self.cursor_end_of_line(&cs.ctx);
        if pipe { self.copy_pipe(cs, prefix, command) } else { self.copy_selection(cs, prefix) }
        if cancel { return Action::Cancel }
        self.clear_selection();
        self.cx = ocx;
        self.cy = ocy;
        self.oy = ooy;
        Action::Redraw
    }
    pub(super) fn cmd_copy_end_of_line(&mut self, cs: &mut Cs) -> Action { self.do_copy_end_of_line(cs, false, false) }
    pub(super) fn cmd_copy_end_of_line_and_cancel(&mut self, cs: &mut Cs) -> Action { self.do_copy_end_of_line(cs, false, true) }
    pub(super) fn cmd_copy_pipe_end_of_line(&mut self, cs: &mut Cs) -> Action { self.do_copy_end_of_line(cs, true, false) }
    pub(super) fn cmd_copy_pipe_end_of_line_and_cancel(&mut self, cs: &mut Cs) -> Action { self.do_copy_end_of_line(cs, true, true) }

    /// window_copy_do_copy_line.
    fn do_copy_line(&mut self, cs: &mut Cs, pipe: bool, cancel: bool) -> Action {
        let np = self.np();
        let (command, prefix) = Copy::pipe_args(cs, pipe);
        let (ocx, ocy, ooy) = (self.cx, self.cy, self.oy);
        self.selflag = SelFlag::Char;
        self.cursor_start_of_line(&cs.ctx);
        self.start_selection(&cs.ctx);
        for _ in 1..np { self.cursor_down(false, &cs.ctx) }
        self.cursor_end_of_line(&cs.ctx);
        if pipe { self.copy_pipe(cs, prefix, command) } else { self.copy_selection(cs, prefix) }
        if cancel { return Action::Cancel }
        self.clear_selection();
        self.cx = ocx;
        self.cy = ocy;
        self.oy = ooy;
        Action::Redraw
    }
    pub(super) fn cmd_copy_line(&mut self, cs: &mut Cs) -> Action { self.do_copy_line(cs, false, false) }
    pub(super) fn cmd_copy_line_and_cancel(&mut self, cs: &mut Cs) -> Action { self.do_copy_line(cs, false, true) }
    pub(super) fn cmd_copy_pipe_line(&mut self, cs: &mut Cs) -> Action { self.do_copy_line(cs, true, false) }
    pub(super) fn cmd_copy_pipe_line_and_cancel(&mut self, cs: &mut Cs) -> Action { self.do_copy_line(cs, true, true) }

    pub(super) fn cmd_copy_selection_no_clear(&mut self, cs: &mut Cs) -> Action {
        let prefix = cs.arg(1).map(str::to_string);
        self.copy_selection(cs, prefix);
        Action::Nothing
    }
    pub(super) fn cmd_copy_selection(&mut self, cs: &mut Cs) -> Action { self.cmd_copy_selection_no_clear(cs); self.clear_selection(); Action::Redraw }
    pub(super) fn cmd_copy_selection_and_cancel(&mut self, cs: &mut Cs) -> Action { self.cmd_copy_selection_no_clear(cs); self.clear_selection(); Action::Cancel }

    pub(super) fn cmd_cursor_down(&mut self, cs: &mut Cs) -> Action { for _ in 0..self.np() { self.cursor_down(false, &cs.ctx) } Action::Nothing }
    pub(super) fn cmd_cursor_down_and_cancel(&mut self, cs: &mut Cs) -> Action {
        let cy = self.cy;
        for _ in 0..self.np() { self.cursor_down(false, &cs.ctx) }
        if cy == self.cy && self.oy == 0 { return Action::Cancel }
        Action::Nothing
    }
    pub(super) fn cmd_cursor_left(&mut self, cs: &mut Cs) -> Action { for _ in 0..self.np() { self.cursor_left(&cs.ctx) } Action::Nothing }
    pub(super) fn cmd_cursor_right(&mut self, cs: &mut Cs) -> Action {
        for _ in 0..self.np() { let all = self.sel.is_some() && self.rectflag; self.cursor_right(all, &cs.ctx) }
        Action::Nothing
    }

    /// window_copy_cmd_scroll_to: the cursor's line scrolled to row [to].
    fn cmd_scroll_to(&mut self, cs: &mut Cs, to: u32) -> Action {
        let scroll_up = self.cy as i64 - to as i64;
        let delta = scroll_up.unsigned_abs() as u32;
        let oy = self.backing.hsize - self.oy;
        if scroll_up > 0 && self.oy >= delta {
            self.scroll_up(delta, &cs.ctx);
            self.cy -= delta;
        } else if scroll_up < 0 && oy >= delta {
            self.scroll_down(delta, &cs.ctx);
            self.cy += delta;
        }
        self.update_selection(false, &cs.ctx);
        Action::Redraw
    }
    pub(super) fn cmd_scroll_bottom(&mut self, cs: &mut Cs) -> Action { let b = self.sy - 1; self.cmd_scroll_to(cs, b) }
    pub(super) fn cmd_scroll_middle(&mut self, cs: &mut Cs) -> Action { let m = (self.sy - 1) / 2; self.cmd_scroll_to(cs, m) }
    pub(super) fn cmd_scroll_top(&mut self, cs: &mut Cs) -> Action { self.cmd_scroll_to(cs, 0) }

    pub(super) fn cmd_cursor_up(&mut self, cs: &mut Cs) -> Action { for _ in 0..self.np() { self.cursor_up(false, &cs.ctx) } Action::Nothing }
    pub(super) fn cmd_end_of_line(&mut self, cs: &mut Cs) -> Action { self.cursor_end_of_line(&cs.ctx); Action::Nothing }
    pub(super) fn cmd_halfpage_down(&mut self, cs: &mut Cs) -> Action {
        for _ in 0..self.np() { if self.pagedown1(true, self.scroll_exit, &cs.ctx) { return Action::Cancel } }
        Action::Nothing
    }
    pub(super) fn cmd_halfpage_down_and_cancel(&mut self, cs: &mut Cs) -> Action {
        for _ in 0..self.np() { if self.pagedown1(true, true, &cs.ctx) { return Action::Cancel } }
        Action::Nothing
    }
    pub(super) fn cmd_halfpage_up(&mut self, cs: &mut Cs) -> Action { for _ in 0..self.np() { self.pageup1(true, &cs.ctx) } Action::Nothing }
    pub(super) fn cmd_toggle_position(&mut self, _: &mut Cs) -> Action { self.hide_position = !self.hide_position; Action::Redraw }
    pub(super) fn cmd_history_bottom(&mut self, cs: &mut Cs) -> Action {
        let oy = self.abs_cy();
        if self.lineflag == LineSel::RightLeft && oy == self.endsely { self.other_end(&cs.ctx) }
        self.cy = self.sy - 1;
        self.cx = self.find_length(self.backing.hsize + self.cy);
        self.oy = 0;
        if self.searchmark.is_some() && !self.timeout { self.search_marks(None, self.searchregex, true) }
        self.update_selection(false, &cs.ctx);
        Action::Redraw
    }
    pub(super) fn cmd_history_top(&mut self, cs: &mut Cs) -> Action {
        let oy = self.abs_cy();
        if self.lineflag == LineSel::LeftRight && oy == self.sely { self.other_end(&cs.ctx) }
        self.cy = 0;
        self.cx = 0;
        self.oy = self.backing.hsize;
        if self.searchmark.is_some() && !self.timeout { self.search_marks(None, self.searchregex, true) }
        self.update_selection(false, &cs.ctx);
        Action::Redraw
    }
    pub(super) fn cmd_jump_again(&mut self, cs: &mut Cs) -> Action {
        for _ in 0..self.np() {
            match self.jumptype {
                Jump::Forward => self.cursor_jump(&cs.ctx),
                Jump::Backward => self.cursor_jump_back(&cs.ctx),
                Jump::ToForward => self.cursor_jump_to(&cs.ctx),
                Jump::ToBackward => self.cursor_jump_to_back(&cs.ctx),
                Jump::Off => {}
            }
        }
        Action::Nothing
    }
    pub(super) fn cmd_jump_reverse(&mut self, cs: &mut Cs) -> Action {
        for _ in 0..self.np() {
            match self.jumptype {
                Jump::Forward => self.cursor_jump_back(&cs.ctx),
                Jump::Backward => self.cursor_jump(&cs.ctx),
                Jump::ToForward => self.cursor_jump_to_back(&cs.ctx),
                Jump::ToBackward => self.cursor_jump_to(&cs.ctx),
                Jump::Off => {}
            }
        }
        Action::Nothing
    }
    pub(super) fn cmd_middle_line(&mut self, cs: &mut Cs) -> Action {
        self.cx = 0;
        self.cy = (self.sy - 1) / 2;
        self.update_selection(false, &cs.ctx);
        Action::Redraw
    }

    /// The one byte a cell holds, if that is all it holds (`gc.data.size == 1`, not padding).
    fn byte_at(&self, px: u32, py: u32) -> Option<char> {
        let gc = self.backing.get(px, py);
        gc.one_byte().then_some(gc.c)
    }

    pub(super) fn cmd_previous_matching_bracket(&mut self, cs: &mut Cs) -> Action {
        let close: String = CLOSE.iter().collect();
        for _ in 0..self.np() {
            // Get cursor position and line length.
            let mut px = self.cx;
            let mut py = self.abs_cy();
            let mut xx = self.find_length(py);
            if xx == 0 { break }
            // The current character; if not a bracket, the one before (emacs); else back a word.
            let mut tried = false;
            let (found, start) = loop {
                let hit = self.byte_at(px, py).and_then(|c| CLOSE.iter().position(|x| *x == c).map(|i| (c, OPEN[i])));
                match hit {
                    Some(h) => break (Some(h.0), h.1),
                    None => {
                        if self.emacs {
                            if !tried && px > 0 { px -= 1; tried = true; continue }
                            self.cursor_previous_word(&close, true, &cs.ctx);
                        }
                        break (None, ' ');
                    }
                }
            };
            let Some(found) = found else { continue };
            // Walk backward until the matching bracket is reached.
            let mut n = 1;
            let mut failed = false;
            loop {
                if px == 0 {
                    if py == 0 { failed = true; break }
                    loop {
                        py -= 1;
                        xx = self.find_length(py);
                        if !(xx == 0 && py > 0) { break }
                    }
                    if xx == 0 && py == 0 { failed = true; break }
                    px = xx - 1;
                } else {
                    px -= 1;
                }
                if let Some(c) = self.byte_at(px, py) { if c == found { n += 1 } else if c == start { n -= 1 } }
                if n == 0 { break }
            }
            // Move the cursor to the found location if any.
            if !failed { self.scroll_to(px, py, false, &cs.ctx) }
        }
        Action::Nothing
    }

    pub(super) fn cmd_next_matching_bracket(&mut self, cs: &mut Cs) -> Action {
        let open: String = OPEN.iter().collect();
        'outer: for _ in 0..self.np() {
            let mut px = self.cx;
            let mut py = self.abs_cy();
            let mut xx = self.find_length(py);
            let yy = self.backing.hsize + self.backing.sy - 1;
            if xx == 0 { break }
            // The current character; if not a bracket, the next (emacs) or on to the end of the
            // line (vi); else on a word.
            let mut tried = false;
            let (found, end) = loop {
                if let Some(c) = self.byte_at(px, py) {
                    // vi: a closing bracket found first goes back to its opening one, or back
                    // where the cursor was.
                    if CLOSE.contains(&c) && !self.emacs {
                        let (sx, sy) = (self.cx, self.abs_cy());
                        self.scroll_to(px, py, false, &cs.ctx);
                        self.cmd_previous_matching_bracket(cs);
                        let (px2, py2) = (self.cx, self.abs_cy());
                        if self.byte_at(px2, py2).map(|c| CLOSE.contains(&c)).unwrap_or(false) { self.scroll_to(sx, sy, false, &cs.ctx) }
                        break 'outer;
                    }
                    if let Some(i) = OPEN.iter().position(|x| *x == c) { break (c, CLOSE[i]) }
                }
                if self.emacs {
                    if !tried && px <= xx { px += 1; tried = true; continue }
                    self.cursor_next_word_end(&open, false, &cs.ctx);
                    continue 'outer;
                }
                // For vi, continue searching for bracket until EOL.
                if px > xx {
                    if py == yy { continue 'outer }
                    let gl = self.backing.line(py);
                    if !gl.wrapped || gl.cells.len() as u32 > self.backing.sx { continue 'outer }
                    px = 0;
                    py += 1;
                    xx = self.find_length(py);
                } else {
                    px += 1;
                }
            };
            // Walk forward until the matching bracket is reached.
            let mut n = 1;
            let mut failed = false;
            loop {
                if px > xx {
                    if py == yy { failed = true; break }
                    px = 0;
                    py += 1;
                    xx = self.find_length(py);
                } else {
                    px += 1;
                }
                if let Some(c) = self.byte_at(px, py) { if c == found { n += 1 } else if c == end { n -= 1 } }
                if n == 0 { break }
            }
            if !failed { self.scroll_to(px, py, false, &cs.ctx) }
        }
        Action::Nothing
    }

    pub(super) fn cmd_next_paragraph(&mut self, cs: &mut Cs) -> Action { for _ in 0..self.np() { self.next_paragraph(&cs.ctx) } Action::Nothing }
    pub(super) fn cmd_next_space(&mut self, cs: &mut Cs) -> Action { for _ in 0..self.np() { self.cursor_next_word("", &cs.ctx) } Action::Nothing }
    pub(super) fn cmd_next_space_end(&mut self, cs: &mut Cs) -> Action { for _ in 0..self.np() { self.cursor_next_word_end("", false, &cs.ctx) } Action::Nothing }
    pub(super) fn cmd_next_word(&mut self, cs: &mut Cs) -> Action { let ws = cs.ctx.ws.clone(); for _ in 0..self.np() { self.cursor_next_word(&ws, &cs.ctx) } Action::Nothing }
    pub(super) fn cmd_next_word_end(&mut self, cs: &mut Cs) -> Action { let ws = cs.ctx.ws.clone(); for _ in 0..self.np() { self.cursor_next_word_end(&ws, false, &cs.ctx) } Action::Nothing }
    pub(super) fn cmd_other_end(&mut self, cs: &mut Cs) -> Action {
        self.selflag = SelFlag::Char;
        if self.np() % 2 != 0 { self.other_end(&cs.ctx) }
        Action::Nothing
    }
    pub(super) fn cmd_page_down(&mut self, cs: &mut Cs) -> Action {
        for _ in 0..self.np() { if self.pagedown1(false, self.scroll_exit, &cs.ctx) { return Action::Cancel } }
        Action::Nothing
    }
    pub(super) fn cmd_page_down_and_cancel(&mut self, cs: &mut Cs) -> Action {
        for _ in 0..self.np() { if self.pagedown1(false, true, &cs.ctx) { return Action::Cancel } }
        Action::Nothing
    }
    pub(super) fn cmd_page_up(&mut self, cs: &mut Cs) -> Action { for _ in 0..self.np() { self.pageup1(false, &cs.ctx) } Action::Nothing }
    pub(super) fn cmd_previous_paragraph(&mut self, cs: &mut Cs) -> Action { for _ in 0..self.np() { self.previous_paragraph(&cs.ctx) } Action::Nothing }
    pub(super) fn cmd_previous_space(&mut self, cs: &mut Cs) -> Action { for _ in 0..self.np() { self.cursor_previous_word("", true, &cs.ctx) } Action::Nothing }
    pub(super) fn cmd_previous_word(&mut self, cs: &mut Cs) -> Action { let ws = cs.ctx.ws.clone(); for _ in 0..self.np() { self.cursor_previous_word(&ws, true, &cs.ctx) } Action::Nothing }
    pub(super) fn cmd_rectangle_on(&mut self, cs: &mut Cs) -> Action { self.lineflag = LineSel::None; self.rectangle_set(true, &cs.ctx); Action::Nothing }
    pub(super) fn cmd_rectangle_off(&mut self, cs: &mut Cs) -> Action { self.lineflag = LineSel::None; self.rectangle_set(false, &cs.ctx); Action::Nothing }
    pub(super) fn cmd_rectangle_toggle(&mut self, cs: &mut Cs) -> Action { self.lineflag = LineSel::None; let r = !self.rectflag; self.rectangle_set(r, &cs.ctx); Action::Nothing }
    pub(super) fn cmd_scroll_down(&mut self, cs: &mut Cs) -> Action {
        for _ in 0..self.np() { self.cursor_down(true, &cs.ctx) }
        if self.scroll_exit && self.oy == 0 { return Action::Cancel }
        Action::Nothing
    }
    pub(super) fn cmd_scroll_down_and_cancel(&mut self, cs: &mut Cs) -> Action {
        for _ in 0..self.np() { self.cursor_down(true, &cs.ctx) }
        if self.oy == 0 { return Action::Cancel }
        Action::Nothing
    }
    pub(super) fn cmd_scroll_up(&mut self, cs: &mut Cs) -> Action { for _ in 0..self.np() { self.cursor_up(true, &cs.ctx) } Action::Nothing }
    pub(super) fn cmd_search_again(&mut self, cs: &mut Cs) -> Action {
        let regex = self.searchregex;
        match self.searchtype {
            SearchType::Up => { for _ in 0..self.np() { self.search_up(regex, cs.ps, &cs.ctx); } }
            SearchType::Down => { for _ in 0..self.np() { self.search_down(regex, cs.ps, &cs.ctx); } }
            SearchType::Off => {}
        }
        Action::Nothing
    }
    pub(super) fn cmd_search_reverse(&mut self, cs: &mut Cs) -> Action {
        let regex = self.searchregex;
        match self.searchtype {
            SearchType::Up => { for _ in 0..self.np() { self.search_down(regex, cs.ps, &cs.ctx); } }
            SearchType::Down => { for _ in 0..self.np() { self.search_up(regex, cs.ps, &cs.ctx); } }
            SearchType::Off => {}
        }
        Action::Nothing
    }
    pub(super) fn cmd_select_line(&mut self, cs: &mut Cs) -> Action {
        let np = self.np();
        self.lineflag = LineSel::LeftRight;
        self.rectflag = false;
        self.selflag = SelFlag::Line;
        self.dx = self.cx;
        self.dy = self.abs_cy();
        self.cursor_start_of_line(&cs.ctx);
        self.selrx = self.cx;
        self.selry = self.abs_cy();
        self.endselry = self.selry;
        self.start_selection(&cs.ctx);
        self.cursor_end_of_line(&cs.ctx);
        self.endselry = self.abs_cy();
        self.endselrx = self.find_length(self.endselry);
        for _ in 1..np {
            self.cursor_down(false, &cs.ctx);
            self.cursor_end_of_line(&cs.ctx);
        }
        Action::Redraw
    }
    pub(super) fn cmd_select_word(&mut self, cs: &mut Cs) -> Action {
        self.lineflag = LineSel::LeftRight;
        self.rectflag = false;
        self.selflag = SelFlag::Word;
        self.dx = self.cx;
        self.dy = self.abs_cy();
        let ws = cs.ctx.ws.clone();
        self.separators = Some(ws.clone());
        self.cursor_previous_word(&ws, false, &cs.ctx);
        let px = self.cx;
        let py = self.abs_cy();
        self.selrx = px;
        self.selry = py;
        self.start_selection(&cs.ctx);
        // Handle single character words.
        let (mut nextx, mut nexty) = (px + 1, py);
        if self.backing.line(nexty).wrapped && nextx > self.backing.sx - 1 { nextx = 0; nexty += 1 }
        if px >= self.find_length(py) || !self.in_set(nextx, nexty, WHITESPACE) {
            self.cursor_next_word_end(&ws, true, &cs.ctx);
        } else {
            self.update_cursor(px, self.cy);
            self.update_selection(true, &cs.ctx);
        }
        self.endselrx = self.cx;
        self.endselry = self.abs_cy();
        if self.dy > self.endselry { self.dy = self.endselry; self.dx = self.endselrx } else if self.dx > self.endselrx { self.dx = self.endselrx }
        Action::Redraw
    }
    pub(super) fn cmd_set_mark(&mut self, _: &mut Cs) -> Action {
        self.mx = self.cx;
        self.my = self.abs_cy();
        self.showmark = true;
        Action::Redraw
    }
    pub(super) fn cmd_start_of_line(&mut self, cs: &mut Cs) -> Action { self.cursor_start_of_line(&cs.ctx); Action::Nothing }
    pub(super) fn cmd_top_line(&mut self, cs: &mut Cs) -> Action {
        self.cx = 0;
        self.cy = 0;
        self.update_selection(false, &cs.ctx);
        Action::Redraw
    }
    pub(super) fn cmd_copy_pipe_no_clear(&mut self, cs: &mut Cs) -> Action {
        let prefix = cs.arg(2).map(str::to_string);
        let command = cs.arg(1).filter(|a| !a.is_empty()).map(str::to_string);
        self.copy_pipe(cs, prefix, command);
        Action::Nothing
    }
    pub(super) fn cmd_copy_pipe(&mut self, cs: &mut Cs) -> Action { self.cmd_copy_pipe_no_clear(cs); self.clear_selection(); Action::Redraw }
    pub(super) fn cmd_copy_pipe_and_cancel(&mut self, cs: &mut Cs) -> Action { self.cmd_copy_pipe_no_clear(cs); self.clear_selection(); Action::Cancel }
    pub(super) fn cmd_pipe_no_clear(&mut self, cs: &mut Cs) -> Action {
        let command = cs.arg(1).filter(|a| !a.is_empty()).map(str::to_string);
        self.pipe(cs, command);
        Action::Nothing
    }
    pub(super) fn cmd_pipe(&mut self, cs: &mut Cs) -> Action { self.cmd_pipe_no_clear(cs); self.clear_selection(); Action::Redraw }
    pub(super) fn cmd_pipe_and_cancel(&mut self, cs: &mut Cs) -> Action { self.cmd_pipe_no_clear(cs); self.clear_selection(); Action::Cancel }
    pub(super) fn cmd_goto_line(&mut self, cs: &mut Cs) -> Action {
        let arg = cs.arg(1).unwrap_or("").to_string();
        if !arg.is_empty() { self.goto_line(&arg, &cs.ctx) }
        Action::Nothing
    }
    /// A jump's character (the first of its argument): false for none.
    fn jump_arg(&mut self, cs: &Cs, jt: Jump) -> bool {
        let Some(c) = cs.arg(1).and_then(|a| a.chars().next()) else { return false };
        self.jumptype = jt;
        self.jumpchar = Some(c.to_string());
        true
    }
    pub(super) fn cmd_jump_backward(&mut self, cs: &mut Cs) -> Action { if self.jump_arg(cs, Jump::Backward) { for _ in 0..self.np() { self.cursor_jump_back(&cs.ctx) } } Action::Nothing }
    pub(super) fn cmd_jump_forward(&mut self, cs: &mut Cs) -> Action { if self.jump_arg(cs, Jump::Forward) { for _ in 0..self.np() { self.cursor_jump(&cs.ctx) } } Action::Nothing }
    pub(super) fn cmd_jump_to_backward(&mut self, cs: &mut Cs) -> Action { if self.jump_arg(cs, Jump::ToBackward) { for _ in 0..self.np() { self.cursor_jump_to_back(&cs.ctx) } } Action::Nothing }
    pub(super) fn cmd_jump_to_forward(&mut self, cs: &mut Cs) -> Action { if self.jump_arg(cs, Jump::ToForward) { for _ in 0..self.np() { self.cursor_jump_to(&cs.ctx) } } Action::Nothing }
    pub(super) fn cmd_jump_to_mark(&mut self, cs: &mut Cs) -> Action { self.jump_to_mark(&cs.ctx); Action::Nothing }
    pub(super) fn cmd_next_prompt(&mut self, cs: &mut Cs) -> Action { let a = cs.arg(1).map(str::to_string); self.cursor_prompt(true, a.as_deref(), &cs.ctx); Action::Nothing }
    pub(super) fn cmd_previous_prompt(&mut self, cs: &mut Cs) -> Action { let a = cs.arg(1).map(str::to_string); self.cursor_prompt(false, a.as_deref(), &cs.ctx); Action::Nothing }

    /// window_copy_expand_search_string (the caller expanded it already with -F).
    fn expand_search_string(&mut self, cs: &Cs) -> bool {
        let Some(ss) = cs.arg(1).filter(|s| !s.is_empty()) else { return false };
        self.searchstr = Some(ss.to_string());
        true
    }
    fn search_cmd(&mut self, cs: &mut Cs, down: bool, regex: bool) -> Action {
        if !self.expand_search_string(cs) { return Action::Nothing }
        if self.searchstr.is_some() {
            self.searchtype = if down { SearchType::Down } else { SearchType::Up };
            self.searchregex = regex;
            self.timeout = false;
            for _ in 0..self.np() { self.search(down, regex, cs.ps, &cs.ctx); }
        }
        Action::Nothing
    }
    pub(super) fn cmd_search_backward(&mut self, cs: &mut Cs) -> Action { self.search_cmd(cs, false, true) }
    pub(super) fn cmd_search_backward_text(&mut self, cs: &mut Cs) -> Action { self.search_cmd(cs, false, false) }
    pub(super) fn cmd_search_forward(&mut self, cs: &mut Cs) -> Action { self.search_cmd(cs, true, true) }
    pub(super) fn cmd_search_forward_text(&mut self, cs: &mut Cs) -> Action { self.search_cmd(cs, true, false) }

    /// window_copy_cmd_search_*_incremental: the prompt's text on every change, after `=` (as
    /// typed), `+` (C-s: on, down) or `-` (C-r: on, up).
    fn incremental(&mut self, cs: &mut Cs, down: bool) -> Action {
        self.timeout = false;
        let arg = cs.arg(1).unwrap_or("").to_string();
        let mut chars = arg.chars();
        let prefix = chars.next().unwrap_or('=');
        let text: String = chars.collect();
        let mut action = Action::Nothing;
        if self.searchx == -1 || self.searchy == -1 {
            self.searchx = self.cx as i64;
            self.searchy = self.cy as i64;
            self.searcho = self.oy as i64;
        } else if self.searchstr.as_deref().map(|ss| ss != text).unwrap_or(false) {
            self.cx = self.searchx as u32;
            self.cy = self.searchy as u32;
            self.oy = self.searcho as u32;
            action = Action::Redraw;
        }
        if text.is_empty() { self.clear_marks(); return Action::Redraw }
        let go_down = match prefix { '=' => down, '+' => true, '-' => false, _ => return action };
        self.searchtype = if go_down { SearchType::Down } else { SearchType::Up };
        self.searchregex = false;
        self.searchstr = Some(text);
        let found = self.search(go_down, false, cs.ps, &cs.ctx);
        if !found { self.clear_marks(); return Action::Redraw }
        action
    }
    pub(super) fn cmd_search_backward_incremental(&mut self, cs: &mut Cs) -> Action { self.incremental(cs, false) }
    pub(super) fn cmd_search_forward_incremental(&mut self, cs: &mut Cs) -> Action { self.incremental(cs, true) }

    pub(super) fn cmd_refresh_from_pane(&mut self, cs: &mut Cs) -> Action {
        if self.view { return Action::Nothing }
        cs.out.push(Out::Refresh);
        Action::Redraw
    }

    /// The formats a pane in the mode has (window_copy_formats), word-separators [ws].
    pub fn format(&self, name: &str, ws: &str) -> Option<String> {
        let b = |v: bool| if v { "1".to_string() } else { "0".to_string() };
        Some(match name {
            "scroll_position" => self.oy.to_string(),
            "rectangle_toggle" => b(self.rectflag),
            "copy_cursor_x" => self.cx.to_string(),
            "copy_cursor_y" => self.cy.to_string(),
            "selection_start_x" => { self.sel?; self.selx.to_string() }
            "selection_start_y" => { self.sel?; self.sely.to_string() }
            "selection_end_x" => { self.sel?; self.endselx.to_string() }
            "selection_end_y" => { self.sel?; self.endsely.to_string() }
            "selection_active" => b(self.sel.is_some() && self.cursordrag != Drag::None),
            "selection_present" => b(self.sel.is_some() && (self.endselx != self.selx || self.endsely != self.sely)),
            "search_present" => b(self.searchmark.is_some()),
            "search_count" => { if self.searchcount == -1 { return None } self.searchcount.to_string() }
            "search_count_partial" => { if self.searchcount == -1 { return None } b(self.searchmore) }
            "search_match" => self.match_at_cursor()?,
            "copy_cursor_word" => self.word_at(self.cx, self.cy, ws)?,
            "copy_cursor_line" => self.line_at(self.cy)?,
            "copy_cursor_hyperlink" => self.hyperlink_at(self.cx, self.cy)?,
            _ => return None,
        })
    }
}
