//! The list behind every overlay (C-b s, the palette, machines, new harness…): a query line, rows
//! matched as fzf matches them (fzf.rs), a cursor that stays on the same ITEM when the rows are
//! rebuilt under it, and group headings in the unfiltered view.

use std::time::Instant;

use std::collections::HashMap;

use ratatui::text::Span;

pub struct Row {
    pub id: String,
    /// The part drawn bold and highlighted where the query matched.
    pub label: String,
    /// Everything else typing should match (label is included automatically).
    pub extra: String,
    pub group: Option<String>,
    /// Drawn before the label (state dot, engine mark).
    pub lead: Vec<Span<'static>>,
    /// Drawn after the label, dim.
    pub detail: Vec<Span<'static>>,
    /// Right-aligned.
    pub right: String,
    pub disabled: bool,
    /// Ranked above equal matches (live harnesses over paused ones).
    pub boost: u32,
}

impl Row {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Row {
        Row { id: id.into(), label: label.into(), extra: String::new(), group: None, lead: vec![], detail: vec![], right: String::new(), disabled: false, boost: 0 }
    }
    pub fn extra(mut self, text: impl Into<String>) -> Row { self.extra = text.into(); self }
    pub fn group(mut self, text: impl Into<String>) -> Row { self.group = Some(text.into()); self }
    pub fn lead(mut self, spans: Vec<Span<'static>>) -> Row { self.lead = spans; self }
    pub fn detail(mut self, spans: Vec<Span<'static>>) -> Row { self.detail = spans; self }
    pub fn right(mut self, text: impl Into<String>) -> Row { self.right = text.into(); self }
    pub fn boost(mut self, by: u32) -> Row { self.boost = by; self }
}

pub struct Picker {
    /// Rows on screen, for PgUp/PgDn (a page is what you see).
    pub page_rows: std::cell::Cell<i64>,
    /// The kill buffer (C-w, M-BSpace, M-d), for C-y.
    pub kill: String,
    /// How far the preview can scroll, its lines and its height (the preview sets them as it
    /// draws): fzf's offset goes until the last line is at the top, a page is the window's height.
    pub preview_max: std::cell::Cell<u16>,
    pub preview_lines: std::cell::Cell<usize>,
    pub preview_rows: std::cell::Cell<u16>,
    pub title: String,
    /// Words that say what this list is for (a task about to be sent), at the head of the header
    /// line, as fzf's --header carries them.
    pub heading: Option<String>,
    pub placeholder: String,
    pub query: String,
    pub rows: Vec<Row>,
    /// (row index, label char indices matched)
    pub visible: Vec<(usize, Vec<u32>)>,
    pub cursor: usize,
    pub selected_id: Option<String>,
    pub status: String,
    pub hints: Vec<(&'static str, &'static str)>,
    pub keep_order: bool,
    pub busy: Option<String>,
    pub flash: Option<(String, Instant)>,
    pub empty: String,
    pub scroll: usize,
    /// Where the terminal cursor goes: the end of the query.
    /// The query starts with a mode character (`>` `@` `#` `:` `*` `?`) that is not part of the match.
    pub prefixed: bool,
    /// Screen row → visible index, from the last draw (for clicks).
    pub row_at: Vec<(u16, usize)>,
    /// A row whose action needs a second Enter (a big download).
    pub armed: Option<String>,
    /// The query's cursor, in chars (fzf edits the query like readline), and where a query wider
    /// than its line is shown from (fzf's xoffset).
    pub qcursor: usize,
    pub xoffset: std::cell::Cell<usize>,
    /// Rows marked with Tab (fzf --multi), by id, in the order marked.
    pub marked: Vec<String>,
    /// The preview window, and how far it is scrolled — for the row it shows: another row's
    /// preview starts at its top, as fzf runs the preview again.
    pub preview: bool,
    pub preview_scroll: std::cell::Cell<u16>,
    preview_of: Option<String>,
    /// A row's preview not drawn yet (it starts where --preview-window's +N or follow says), and
    /// whether it follows its end (follow, until scrolled up from it).
    pub preview_fresh: std::cell::Cell<bool>,
    pub preview_following: std::cell::Cell<bool>,
    /// fzf's --wrap, toggled by toggle-wrap (M-/): a long row goes on over the lines below it —
    /// and the columns it was last wrapped at (0 before it is drawn so), for the page keys.
    pub wrap: bool,
    pub wrap_width: std::cell::Cell<usize>,
    /// fzf's numLinesCache: a wrapped row's lines (with --gap's) by row, and the room they were
    /// counted in, for the width they were counted at — kept until the width, --wrap or the rows
    /// change, and trusted, as fzf trusts it, for any room at least as big.
    pub line_cache: std::cell::RefCell<(usize, HashMap<usize, (i64, usize)>)>,
    /// The list's scrollbar as last drawn — its column, the list's rows (top, bottom), whether
    /// they run top-down, the thumb's length and the lines a row averages — and whether the mouse
    /// is dragging it.
    pub bar: std::cell::Cell<Option<(u16, u16, u16, bool, usize, usize)>>,
    pub bar_drag: bool,
    /// The prompt's line and where the query starts on it, and the rows the list's box spans (from
    /// the last draw), for the mouse.
    pub prompt_at: std::cell::Cell<(u16, u16)>,
    pub box_rows: std::cell::Cell<(u16, u16)>,
}

impl Picker {
    pub fn new(title: impl Into<String>, placeholder: impl Into<String>) -> Picker {
        Picker {
            title: title.into(),
            heading: None,
            placeholder: placeholder.into(),
            query: String::new(),
            rows: Vec::new(),
            visible: Vec::new(),
            cursor: 0,
            selected_id: None,
            status: String::new(),
            hints: Vec::new(),
            keep_order: false,
            busy: None,
            flash: None,
            empty: String::new(),
            scroll: 0,
            prefixed: false,
            row_at: Vec::new(),
            armed: None,
            qcursor: 0,
            xoffset: Default::default(),
            marked: Vec::new(),
            preview: !crate::theme::fzf_opts().preview_window.hidden,
            preview_scroll: Default::default(),
            preview_of: None,
            preview_fresh: std::cell::Cell::new(true),
            preview_following: Default::default(),
            wrap: crate::theme::fzf_opts().wrap,
            wrap_width: Default::default(),
            line_cache: Default::default(),
            bar: Default::default(),
            bar_drag: false,
            prompt_at: Default::default(),
            box_rows: Default::default(),
            preview_max: Default::default(),
            preview_lines: Default::default(),
            preview_rows: Default::default(),
            kill: String::new(),
            page_rows: std::cell::Cell::new(10),
        }
    }

    pub fn set_rows(&mut self, mut rows: Vec<Row>) {
        // fzf's list stands still while you are in it: a refresh keeps the rows where they were
        // and adds new ones after them.
        if !self.rows.is_empty() {
            let old: HashMap<&str, usize> = self.rows.iter().enumerate().map(|(i, r)| (r.id.as_str(), i)).collect();
            rows.sort_by_key(|r| old.get(r.id.as_str()).copied().unwrap_or(usize::MAX));
        }
        self.rows = rows;
        self.line_cache.borrow_mut().1.clear();
        self.refilter();
    }

    /// toggle-wrap (M-/): fzf's clearNumLinesCache with it.
    pub fn toggle_wrap(&mut self) {
        self.wrap = !self.wrap;
        self.line_cache.borrow_mut().1.clear();
    }

    pub fn refilter(&mut self) {
        // The query as fzf's pattern reads it: leading blanks and trailing unescaped ones aside
        // (`pane\ ` keeps its escaped space).
        let mut query = self.query.as_str();
        if self.prefixed && query.trim_start().starts_with(['>', '@', '#', ':', '*', '?']) { query = &query.trim_start()[1..] }
        // fzf sorts only when a term asks for something (`!x` alone keeps the input order).
        let mut sorted = false;
        if query.trim().is_empty() {
            self.visible = self.rows.iter().enumerate().map(|(i, _)| (i, Vec::new())).collect();
        } else {
            // fzf itself (fzf.rs, ported from fzf 0.67): the extended-search terms, FuzzyMatchV2's
            // scores and lit characters, the tiebreak — over the line as it is drawn.
            let o = crate::theme::fzf_opts();
            let case = match o.case { Some(true) => crate::fzf::Case::Respect, Some(false) => crate::fzf::Case::Ignore, None => crate::fzf::Case::Smart };
            let q = crate::fzf::Query::parse(query, case, !o.exact, !o.literal).searching(&o.tiebreak);
            // (Each word's case read as fzf reads a term's: +i, -i, or smart — an upper-case letter.)
            let words: Vec<(String, bool)> = query.split_whitespace().map(|w| {
                let w = w.trim_start_matches('\'');
                let sensitive = o.case.unwrap_or(w != w.to_lowercase());
                (if sensitive { w.to_string() } else { w.to_lowercase() }, sensitive)
            }).collect();
            // `!word` (and `!'word`): not only a row whose line says it, but one whose keywords do.
            let negated: Vec<(String, bool)> = words.iter().filter_map(|(w, s)| w.strip_prefix('!').map(|r| (r.trim_start_matches(['\'', '^']).trim_end_matches('$').to_string(), *s))).filter(|(w, _)| !w.is_empty()).collect();
            let words: Vec<(String, bool)> = words.into_iter().filter(|(w, _)| !w.starts_with('!')).collect();
            let mut scored: Vec<(Vec<i64>, usize, Vec<u32>)> = Vec::new();
            let mut hidden: Vec<usize> = Vec::new();
            for (index, row) in self.rows.iter().enumerate() {
                if row.disabled { continue }
                let keywords = format!("{} {}", row.label, row.extra);
                if negated.iter().any(|(w, s)| w.chars().count() >= 3 && names_word(&keywords, w, *s)) { continue }
                let chars: Vec<char> = line(row).chars().collect();
                // (A keyword hit still has to keep out of what the query excludes from the line.)
                let seen = if negated.is_empty() { String::new() } else { line(row) };
                let clear = |w: &str, sensitive: bool| if sensitive { !seen.contains(w) } else { !seen.to_lowercase().contains(w) };
                match q.matches(&chars) {
                    Some(hit) => {
                        let mut rank = crate::fzf::rank(&hit, &chars, &o.tiebreak);
                        // --tac: the input read bottom-up, ties too.
                        rank.push(if o.tac { -(index as i64) } else { index as i64 });
                        scored.push((rank, index, hit.positions.iter().map(|p| *p as u32).collect()));
                    }
                    // The keywords behind a row (engine, machine, branch): whole words of three
                    // letters or more find it, after everything that matched what you see.
                    None if !words.is_empty() && words.iter().all(|(w, sensitive)| w.chars().count() >= 3 && names_word(&keywords, w, *sensitive)) && negated.iter().all(|(w, s)| clear(w, *s)) => hidden.push(index),
                    None => {}
                }
            }
            sorted = !self.keep_order && q.sortable() && !o.no_sort;
            if sorted { scored.sort_by(|a, b| a.0.cmp(&b.0)) }
            self.visible = scored.into_iter().map(|(_, i, hits)| (i, hits)).chain(hidden.into_iter().map(|i| (i, Vec::new()))).collect();
        }
        // --tac: the input order reversed (wherever the order is the input's).
        if crate::theme::fzf_opts().tac && !sorted { self.visible.reverse() }
        // Keep the cursor on the same item across a rebuild.
        let keep = self.selected_id.as_ref().and_then(|id| self.visible.iter().position(|(i, _)| &self.rows[*i].id == id));
        self.cursor = keep.unwrap_or(self.cursor.min(self.visible.len().saturating_sub(1)));
        self.skip_disabled(1);
    }

    fn skip_disabled(&mut self, direction: i64) {
        if self.visible.is_empty() { self.selected_id = None; self.preview_of = None; return }
        let n = self.visible.len() as i64;
        for _ in 0..n {
            if !self.rows[self.visible[self.cursor].0].disabled { break }
            self.cursor = ((self.cursor as i64 + direction).rem_euclid(n)) as usize;
        }
        self.selected_id = Some(self.rows[self.visible[self.cursor].0].id.clone());
        if self.selected_id != self.preview_of { self.preview_scroll.set(0); self.preview_fresh.set(true); self.preview_of = self.selected_id.clone() }
    }

    /// fzf's scrollPreviewBy: from the first line until the last one is at the top.
    pub fn preview_by(&mut self, by: i64) { self.preview_to(self.preview_scroll.get() as i64 + by) }

    /// scrollPreviewTo: kept in range, and following again once back at the end.
    pub fn preview_to(&mut self, to: i64) {
        let at = to.clamp(0, self.preview_max.get() as i64);
        self.preview_scroll.set(at as u16);
        self.preview_following.set(at >= self.preview_lines.get() as i64 - self.preview_rows.get() as i64);
    }

    /// preview-page-*: the window's height; preview-half-page-*: half of it.
    pub fn preview_page(&mut self, pages: i64, half: bool) {
        let rows = self.preview_rows.get() as i64;
        self.preview_by(pages * if half { rows / 2 } else { rows })
    }

    /// preview-bottom: the last line at the bottom.
    pub fn preview_bottom(&mut self) {
        let bottom = self.preview_lines.get().saturating_sub(self.preview_rows.get() as usize) as i64;
        self.preview_to(bottom);
    }

    /// fzf's vset: the cursor to [to], kept in the list (no --cycle), off a disabled row.
    pub fn vset(&mut self, to: i64, direction: i64) {
        if self.visible.is_empty() { return }
        self.cursor = to.clamp(0, self.visible.len() as i64 - 1) as usize;
        self.skip_disabled(if direction >= 0 { 1 } else { -1 });
    }

    pub fn move_by(&mut self, delta: i64) {
        if self.visible.is_empty() { return }
        let max = self.visible.len() as i64 - 1;
        let to = self.cursor as i64 + delta;
        // --cycle: one step past an end comes round to the other.
        self.cursor = if crate::theme::fzf_opts().cycle && delta.abs() == 1 && (to < 0 || to > max) { to.rem_euclid(max + 1) } else { to.clamp(0, max) } as usize;
        self.skip_disabled(if delta >= 0 { 1 } else { -1 });
    }

    /// The query was edited: the list is matched again. As fzf 0.67 does, the cursor keeps its
    /// place in the list (not the item it was on), kept within it; an edit that leaves the query
    /// as it was changes nothing.
    fn changed(&mut self, before: &str) {
        if self.query == before { return }
        self.selected_id = None;
        self.refilter();
    }

    fn byte_at(&self, chars: usize) -> usize { self.query.char_indices().nth(chars).map(|(i, _)| i).unwrap_or(self.query.len()) }

    /// Where editing starts: after the mode character (`>` `@` `#` `:` `*` `?`), which reads as
    /// part of the prompt — C-u, C-w, C-a and the arrows stop at it, as at fzf's prompt.
    fn floor(&self) -> usize { usize::from(self.prefixed && self.query.starts_with(['>', '@', '#', ':', '*', '?'])) }
    fn qlen(&self) -> usize { self.query.chars().count() }

    pub fn type_char(&mut self, c: char) {
        let before = self.query.clone();
        self.qcursor = self.qcursor.min(self.qlen());
        let at = self.byte_at(self.qcursor);
        self.query.insert(at, c);
        self.qcursor += 1;
        self.changed(&before);
    }

    /// Backspace (or, with [word], C-w / M-BS: the word before the cursor).
    /// Backspace; C-w (word: back to whitespace, as unix-word-rubout); what a word-kill takes goes
    /// to the kill buffer for C-y.
    pub fn backspace(&mut self, word: bool) {
        let before = self.query.clone();
        self.qcursor = self.qcursor.min(self.qlen());
        let floor = self.floor();
        // At the mode character: BSpace on an empty filter leaves the mode; anything else stops,
        // as at the start of fzf's query.
        if self.qcursor <= floor && !(floor == 1 && self.qcursor == 1 && !word && self.qlen() == 1) { return }
        let chars: Vec<char> = self.query.chars().collect();
        let mut from = self.qcursor - 1;
        if word {
            while from > floor && chars[from].is_whitespace() { from -= 1 }
            while from > floor && !chars[from - 1].is_whitespace() { from -= 1 }
            self.kill = chars[from..self.qcursor].iter().collect();
        }
        self.query = chars[..from].iter().chain(chars[self.qcursor..].iter()).collect();
        self.qcursor = from;
        self.changed(&before);
    }

    /// M-BSpace (back) and M-d (forward): kill an alphanumeric word, as readline and fzf do.
    pub fn kill_word(&mut self, forward: bool) {
        let before = self.query.clone();
        let chars: Vec<char> = self.query.chars().collect();
        let at = self.qcursor.min(chars.len());
        let to = word_edge(&chars, at, forward);
        let to = if forward { to } else { to.max(self.floor()) };
        let (a, b) = if forward { (at, to) } else { (to, at) };
        if a == b { return }
        self.kill = chars[a..b].iter().collect();
        self.query = chars[..a].iter().chain(chars[b..].iter()).collect();
        self.qcursor = a;
        self.changed(&before);
    }

    /// C-y: put back what was last killed.
    pub fn yank(&mut self) {
        let kill = self.kill.clone();
        for c in kill.chars() { self.type_char(c) }
    }

    /// Delete / C-d: the character under the cursor.
    pub fn delete_forward(&mut self) {
        let before = self.query.clone();
        let chars: Vec<char> = self.query.chars().collect();
        if self.qcursor >= chars.len() { return }
        self.query = chars[..self.qcursor].iter().chain(chars[self.qcursor + 1..].iter()).collect();
        self.changed(&before);
    }

    /// kill-line: from the cursor to the end, into the kill buffer (for C-y), as fzf's.
    pub fn kill_line(&mut self) {
        let before = self.query.clone();
        let chars: Vec<char> = self.query.chars().collect();
        let at = self.qcursor.min(chars.len());
        if at < chars.len() {
            self.kill = chars[at..].iter().collect();
            self.query = chars[..at].iter().collect();
        }
        self.changed(&before);
    }

    /// C-u: everything before the cursor (after the mode character).
    pub fn clear_query(&mut self) {
        let before = self.query.clone();
        let chars: Vec<char> = self.query.chars().collect();
        let (floor, at) = (self.floor(), self.qcursor.min(chars.len()));
        if at <= floor { return }
        self.kill = chars[floor..at].iter().collect();
        self.query = chars[..floor].iter().chain(chars[at..].iter()).collect();
        self.qcursor = floor;
        self.changed(&before);
    }

    /// Move the query cursor: by chars, or (word) to the previous / next word boundary.
    pub fn qmove(&mut self, by: i64, word: bool) {
        let chars: Vec<char> = self.query.chars().collect();
        let mut at = self.qcursor.min(chars.len()) as i64;
        if word { at = word_edge(&chars, at as usize, by > 0) as i64 } else { at = (at + by).clamp(0, chars.len() as i64) }
        self.qcursor = (at as usize).max(self.floor());
    }
    pub fn qhome(&mut self) { self.qcursor = self.floor() }
    pub fn qend(&mut self) { self.qcursor = self.qlen() }

    /// Tab: mark or unmark the row under the cursor (fzf --multi).
    pub fn toggle_mark(&mut self) {
        let Some(id) = self.current_id() else { return };
        if let Some(at) = self.marked.iter().position(|m| *m == id) { self.marked.remove(at); } else { self.marked.push(id) }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    /// Replace the query outright (a mode switch, a history recall).
    pub fn set_query(&mut self, text: &str) {
        let before = self.query.clone();
        self.query = text.to_string();
        self.qcursor = self.qlen();
        self.changed(&before);
    }

    pub fn current(&self) -> Option<&Row> {
        self.visible.get(self.cursor).map(|(i, _)| &self.rows[*i]).filter(|r| !r.disabled)
    }

    pub fn current_id(&self) -> Option<String> { self.current().map(|r| r.id.clone()) }

    /// Put the cursor on the row drawn at screen row [y]; false when there is none.
    pub fn click(&mut self, y: u16) -> bool {
        let Some((_, vi)) = self.row_at.iter().find(|(row, _)| *row == y).copied() else { return false };
        self.vset(vi as i64, 1);
        true
    }

    /// fzf's scrollbar dragging: the thumb's middle to the mouse's row, the offset from it, and the
    /// cursor moved as far as the offset did. False when the mouse is not on the bar's column.
    pub fn drag_bar(&mut self, x: u16, y: u16, start: bool) -> bool {
        let Some((bx, top, bottom, reverse, thumb, per_line)) = self.bar.get() else { return false };
        if start && (x != bx || y < top || y >= bottom) { return false }
        if thumb == 0 || self.visible.is_empty() { return true }
        let max_items = (bottom - top) as i64;
        let line = if reverse { y as i64 - top as i64 } else { bottom as i64 - 1 - y as i64 };
        let new_start = (line - thumb as i64 / 2).clamp(0, (max_items - thumb as i64).max(0));
        let total = self.visible.len() as i64;
        let denom = max_items * per_line as i64 - thumb as i64;
        if denom <= 0 { return true }
        let offset = ((new_start * (total * per_line as i64 - max_items)) as f64 / denom as f64).ceil() as i64;
        let prev = self.scroll as i64;
        self.scroll = offset.max(0) as usize;
        self.vset(offset + self.cursor as i64 - prev, 1);
        true
    }

    pub fn say(&mut self, text: impl Into<String>) { self.flash = Some((text.into(), Instant::now())) }
}

/// The length of the line a row shows (fzf's length tiebreak is the whole line's).
/// A row's line as it is drawn, and as fzf would read it: the title, then the detail and the right
/// column (two spaces before each that is there). Hit positions are places in this.
pub fn line(row: &Row) -> String {
    let detail: String = row.detail.iter().map(|s| s.content.as_ref()).collect();
    let mut out = row.label.clone();
    if !detail.is_empty() { out.push_str("  "); out.push_str(&detail) }
    if !row.right.is_empty() { out.push_str("  "); out.push_str(&row.right) }
    out
}

/// Where an alphanumeric word ends, going back or forward from `at` (readline's M-b / M-f).
fn word_edge(chars: &[char], mut at: usize, forward: bool) -> usize {
    let word = |c: char| c.is_alphanumeric();
    if forward {
        while at < chars.len() && !word(chars[at]) { at += 1 }
        while at < chars.len() && word(chars[at]) { at += 1 }
    } else {
        while at > 0 && !word(chars[at - 1]) { at -= 1 }
        while at > 0 && word(chars[at - 1]) { at -= 1 }
    }
    at
}

/// A hidden keyword this word names from its start (`codex`, `gpu-box`).
fn names_word(hidden: &str, word: &str, case_sensitive: bool) -> bool {
    let hidden = if case_sensitive { hidden.to_string() } else { hidden.to_lowercase() };
    hidden.split(|c: char| c.is_whitespace() || c == '/' || c == '·').any(|w| w.starts_with(word))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A keyword behind a row (its engine) finds it, and `!keyword` leaves it out.
    #[test]
    fn negated_keywords_leave_rows_out() {
        let mut p = Picker::new("t", "");
        p.set_rows(vec![Row::new("a", "Add rate limiting").extra("codex studio"), Row::new("b", "Fix flaky test").extra("claude studio")]);
        let ids = |p: &Picker| p.visible.iter().map(|(i, _)| p.rows[*i].id.clone()).collect::<Vec<_>>();
        p.set_query("codex");
        assert_eq!(ids(&p), ["a"]);
        p.set_query("!codex");
        assert_eq!(ids(&p), ["b"]);
        p.set_query("studio !flaky");
        assert_eq!(ids(&p), ["a"]);
    }

    #[test]
    fn fuzzy_and_sticky_cursor() {
        let mut p = Picker::new("t", "");
        p.set_rows(vec![Row::new("a", "landing page"), Row::new("b", "login flake"), Row::new("c", "docs")]);
        p.type_char('l');
        p.type_char('f');
        assert_eq!(p.current_id().as_deref(), Some("b"));
        p.set_rows(vec![Row::new("z", "zeta"), Row::new("b", "login flake")]);
        assert_eq!(p.current_id().as_deref(), Some("b"));
    }

    #[test]
    fn extended_search() {
        let mut p = Picker::new("t", "");
        p.set_rows(vec![Row::new("a", "landing page"), Row::new("b", "login flake"), Row::new("c", "docs site")]);
        let ids = |p: &Picker| { let mut v: Vec<String> = p.visible.iter().map(|(i, _)| p.rows[*i].id.clone()).collect(); v.sort(); v };
        p.set_query("docs | flake"); assert_eq!(ids(&p), ["b", "c"]);
        p.set_query("!docs"); assert_eq!(ids(&p), ["a", "b"]);
        p.set_query("^lo"); assert_eq!(ids(&p), ["b"]);
        p.set_query("page$"); assert_eq!(ids(&p), ["a"]);
        p.set_query("'site"); assert_eq!(ids(&p), ["c"]);
        p.set_rows(vec![Row::new("f", "Fix flaky login test").extra("webapp main"), Row::new("g", "fix it")]);
        p.set_query("^Fix"); assert_eq!(ids(&p), ["f"]);
        p.set_query("test$"); assert_eq!(ids(&p), ["f"]);
        p.set_query("main$"); assert!(ids(&p).is_empty());
        p.set_query("Fix\\ flaky"); assert_eq!(ids(&p), ["f"]);
        p.set_query("!^Fix"); assert_eq!(ids(&p), ["g"]);
    }
}

#[cfg(test)]
mod fzf_tests {
    use super::*;

    fn ids(p: &Picker) -> Vec<String> { p.visible.iter().map(|(i, _)| p.rows[*i].id.clone()).collect() }

    /// fzf 0.67's --filter keeps only "split pane below" for `pane\ ` (and `'pane\ `).
    #[test]
    fn a_trailing_escaped_space_stays() {
        let mut p = Picker::new("t", "");
        p.set_rows(["split pane below", "panes", "kill pane", "the pane", "pane"].iter().map(|l| Row::new(*l, *l)).collect());
        p.set_query("pane\\ ");
        assert_eq!(ids(&p), ["split pane below"]);
        p.set_query("'pane\\ ");
        assert_eq!(ids(&p), ["split pane below"]);
        p.set_query(" pane");
        assert_eq!(ids(&p).len(), 5);
    }

    /// fzf 0.67 (seen in tmux): Up five times, then C-u with nothing before the cursor, keeps the
    /// cursor; typing keeps its place in the new list (row 7 stays row 7), not the item.
    #[test]
    fn the_cursor_keeps_its_place_as_fzf_does() {
        let mut p = Picker::new("t", "");
        p.set_rows((1..=100).map(|n| Row::new(n.to_string(), n.to_string())).collect());
        p.move_by(6);
        assert_eq!(p.cursor, 6);
        p.clear_query();
        assert_eq!(p.cursor, 6);
        p.type_char('1');
        assert_eq!((p.cursor, p.current_id().as_deref()), (6, Some("15")));
        p.type_char('9');
        assert_eq!(p.cursor, 0, "one match left: the cursor kept within the list");
    }

    /// The words behind a row are read with each word's case as fzf reads a term's: smart case
    /// by default (an upper-case letter asks for that case), +i and -i when they are given.
    #[test]
    fn hidden_words_keep_their_case() {
        let mut p = Picker::new("t", "");
        p.set_rows(vec![Row::new("a", "landing page").extra("Codex"), Row::new("b", "docs").extra("codex")]);
        p.set_query("codex");
        assert_eq!(ids(&p), ["a", "b"]);
        p.set_query("Codex");
        assert_eq!(ids(&p), ["a"]);
    }
}

#[cfg(test)]
mod colon_tests {
    use super::*;
    #[test]
    fn matches_times() {
        let mut p = Picker::new("t", "");
        p.prefixed = true;
        p.set_rows(vec![Row::new("a", "Terminal harness 9-25 13:53")]);
        for c in "13:53".chars() { p.type_char(c) }
        assert_eq!(p.visible.len(), 1, "13:53");
    }
}

