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
    /// How far the preview can scroll (the preview sets it as it draws).
    pub preview_max: std::cell::Cell<u16>,
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
    /// The query's cursor, in chars (fzf edits the query like readline).
    pub qcursor: usize,
    /// Rows marked with Tab (fzf --multi), by id, in the order marked.
    pub marked: Vec<String>,
    /// The preview window, and how far it is scrolled.
    pub preview: bool,
    pub preview_scroll: u16,
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
            marked: Vec::new(),
            preview: true,
            preview_scroll: 0,
            preview_max: Default::default(),
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
        self.refilter();
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
            let q = crate::fzf::Query::parse(query, case, !o.exact, true).searching(&o.tiebreak);
            let words: Vec<String> = query.split_whitespace().map(|w| w.trim_start_matches('\'').to_lowercase()).collect();
            let mut scored: Vec<(Vec<i64>, usize, Vec<u32>)> = Vec::new();
            let mut hidden: Vec<usize> = Vec::new();
            for (index, row) in self.rows.iter().enumerate() {
                if row.disabled { continue }
                let chars: Vec<char> = line(row).chars().collect();
                match q.matches(&chars) {
                    Some(hit) => {
                        let mut rank = crate::fzf::rank(&hit, &chars, &o.tiebreak);
                        // --tac: the input read bottom-up, ties too.
                        rank.push(if o.tac { -(index as i64) } else { index as i64 });
                        scored.push((rank, index, hit.positions.iter().map(|p| *p as u32).collect()));
                    }
                    // The keywords behind a row (engine, machine, branch): whole words of three
                    // letters or more find it, after everything that matched what you see.
                    None if !words.is_empty() && words.iter().all(|w| w.chars().count() >= 3 && names_word(&format!("{} {}", row.label, row.extra), w)) => hidden.push(index),
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
        if self.visible.is_empty() { self.selected_id = None; return }
        let n = self.visible.len() as i64;
        for _ in 0..n {
            if !self.rows[self.visible[self.cursor].0].disabled { break }
            self.cursor = ((self.cursor as i64 + direction).rem_euclid(n)) as usize;
        }
        self.selected_id = Some(self.rows[self.visible[self.cursor].0].id.clone());
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
        self.preview_scroll = 0;
        self.refilter();
    }

    fn byte_at(&self, chars: usize) -> usize { self.query.char_indices().nth(chars).map(|(i, _)| i).unwrap_or(self.query.len()) }
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
        if self.qcursor == 0 { return }
        let chars: Vec<char> = self.query.chars().collect();
        let mut from = self.qcursor - 1;
        if word {
            while from > 0 && chars[from].is_whitespace() { from -= 1 }
            while from > 0 && !chars[from - 1].is_whitespace() { from -= 1 }
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

    /// C-u: everything before the cursor.
    pub fn clear_query(&mut self) {
        let before = self.query.clone();
        let chars: Vec<char> = self.query.chars().collect();
        let at = self.qcursor.min(chars.len());
        if at > 0 { self.kill = chars[..at].iter().collect() }
        self.query = chars[at..].iter().collect();
        self.qcursor = 0;
        self.changed(&before);
    }

    /// Move the query cursor: by chars, or (word) to the previous / next word boundary.
    pub fn qmove(&mut self, by: i64, word: bool) {
        let chars: Vec<char> = self.query.chars().collect();
        let mut at = self.qcursor.min(chars.len()) as i64;
        if word { at = word_edge(&chars, at as usize, by > 0) as i64 } else { at = (at + by).clamp(0, chars.len() as i64) }
        self.qcursor = at as usize;
    }
    pub fn qhome(&mut self) { self.qcursor = 0 }
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
        self.cursor = vi;
        self.selected_id = self.visible.get(vi).map(|(i, _)| self.rows[*i].id.clone());
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
fn names_word(hidden: &str, word: &str) -> bool {
    hidden.to_lowercase().split(|c: char| c.is_whitespace() || c == '/' || c == '·').any(|w| w.starts_with(word))
}

#[cfg(test)]
mod tests {
    use super::*;

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

