//! The list behind every overlay (⌥O, ⌥P, needs input, machines, new harness…): a query line, rows
//! matched with nucleo (Helix's matcher — fzf's algorithm), a cursor that stays on the same ITEM when
//! the rows are rebuilt under it, and group headings in the unfiltered view.

use std::time::Instant;

use nucleo::pattern::{CaseMatching, Normalization, Pattern};
use nucleo::{Config, Matcher, Utf32Str};
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
    pub title: String,
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
    pub cursor_pos: Option<ratatui::layout::Position>,
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
    matcher: Matcher,
}

impl Picker {
    pub fn new(title: impl Into<String>, placeholder: impl Into<String>) -> Picker {
        Picker {
            title: title.into(),
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
            empty: "Nothing matches.".into(),
            scroll: 0,
            cursor_pos: None,
            prefixed: false,
            row_at: Vec::new(),
            armed: None,
            qcursor: 0,
            marked: Vec::new(),
            preview: true,
            preview_scroll: 0,
            matcher: Matcher::new(Config::DEFAULT),
        }
    }

    pub fn set_rows(&mut self, rows: Vec<Row>) {
        self.rows = rows;
        self.refilter();
    }

    pub fn refilter(&mut self) {
        let mut query = self.query.trim();
        if self.prefixed && query.starts_with(['>', '@', '#', ':', '*', '?']) { query = query[1..].trim() }
        if query.is_empty() {
            self.visible = self.rows.iter().enumerate().map(|(i, _)| (i, Vec::new())).collect();
        } else {
            // fzf's extended search: space-separated terms all match ('exact ^prefix suffix$ !not are
            // nucleo's own); `a | b` is one term that either side satisfies.
            let mut groups: Vec<Vec<Pattern>> = Vec::new();
            let mut or_next = false;
            for word in query.split_whitespace() {
                if word == "|" { or_next = true; continue }
                let p = Pattern::parse(word, CaseMatching::Smart, Normalization::Smart);
                match groups.last_mut() { Some(g) if or_next => g.push(p), _ => groups.push(vec![p]) }
                or_next = false;
            }
            let mut buf = Vec::new();
            let mut scored: Vec<(usize, u32, Vec<u32>)> = Vec::new();
            for (index, row) in self.rows.iter().enumerate() {
                if row.disabled { continue }
                let haystack = format!("{} {}", row.label, row.extra);
                let mut indices = Vec::new();
                let mut total = Some(0u32);
                for group in &groups {
                    let best = group.iter().filter_map(|p| { let mut hits = Vec::new(); p.indices(Utf32Str::new(&haystack, &mut buf), &mut self.matcher, &mut hits).map(|s| (s, hits)) }).max_by_key(|(s, _)| *s);
                    match best { Some((s, hits)) => { total = total.map(|t| t + s); indices.extend(hits) } None => { total = None; break } }
                }
                if let Some(score) = total {
                    let label_len = row.label.chars().count() as u32;
                    indices.sort_unstable();
                    indices.dedup();
                    indices.retain(|i| *i < label_len);
                    // A hit in the label outranks the same hit in the detail.
                    let bonus = if indices.is_empty() { 0 } else { 40 } + row.boost;
                    scored.push((index, score + bonus, indices));
                }
            }
            if !self.keep_order { scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0))) }
            self.visible = scored.into_iter().map(|(i, _, hits)| (i, hits)).collect();
        }
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
        self.cursor = (self.cursor as i64 + delta).clamp(0, max) as usize;
        self.skip_disabled(if delta >= 0 { 1 } else { -1 });
    }

    fn changed(&mut self) {
        self.cursor = 0;
        self.selected_id = None;
        self.preview_scroll = 0;
        self.refilter();
    }

    fn byte_at(&self, chars: usize) -> usize { self.query.char_indices().nth(chars).map(|(i, _)| i).unwrap_or(self.query.len()) }
    fn qlen(&self) -> usize { self.query.chars().count() }

    pub fn type_char(&mut self, c: char) {
        self.qcursor = self.qcursor.min(self.qlen());
        let at = self.byte_at(self.qcursor);
        self.query.insert(at, c);
        self.qcursor += 1;
        self.changed();
    }

    /// Backspace (or, with [word], C-w / M-BS: the word before the cursor).
    pub fn backspace(&mut self, word: bool) {
        self.qcursor = self.qcursor.min(self.qlen());
        if self.qcursor == 0 { return }
        let chars: Vec<char> = self.query.chars().collect();
        let mut from = self.qcursor - 1;
        if word {
            while from > 0 && chars[from].is_whitespace() { from -= 1 }
            while from > 0 && !chars[from - 1].is_whitespace() { from -= 1 }
        }
        self.query = chars[..from].iter().chain(chars[self.qcursor..].iter()).collect();
        self.qcursor = from;
        self.changed();
    }

    /// Delete / C-d: the character under the cursor.
    pub fn delete_forward(&mut self) {
        let chars: Vec<char> = self.query.chars().collect();
        if self.qcursor >= chars.len() { return }
        self.query = chars[..self.qcursor].iter().chain(chars[self.qcursor + 1..].iter()).collect();
        self.changed();
    }

    /// C-u: everything before the cursor.
    pub fn clear_query(&mut self) {
        let chars: Vec<char> = self.query.chars().collect();
        self.query = chars[self.qcursor.min(chars.len())..].iter().collect();
        self.qcursor = 0;
        self.changed();
    }

    /// Move the query cursor: by chars, or (word) to the previous / next word boundary.
    pub fn qmove(&mut self, by: i64, word: bool) {
        let chars: Vec<char> = self.query.chars().collect();
        let mut at = self.qcursor.min(chars.len()) as i64;
        if word {
            if by < 0 {
                while at > 0 && chars[(at - 1) as usize].is_whitespace() { at -= 1 }
                while at > 0 && !chars[(at - 1) as usize].is_whitespace() { at -= 1 }
            } else {
                let n = chars.len() as i64;
                while at < n && chars[at as usize].is_whitespace() { at += 1 }
                while at < n && !chars[at as usize].is_whitespace() { at += 1 }
            }
        } else { at = (at + by).clamp(0, chars.len() as i64) }
        self.qcursor = at as usize;
    }
    pub fn qhome(&mut self) { self.qcursor = 0 }
    pub fn qend(&mut self) { self.qcursor = self.qlen() }

    /// Tab: mark or unmark the row under the cursor (fzf --multi).
    pub fn toggle_mark(&mut self) {
        let Some(id) = self.current_id() else { return };
        if let Some(at) = self.marked.iter().position(|m| *m == id) { self.marked.remove(at); } else { self.marked.push(id) }
    }

    /// Replace the query outright (a mode switch, a history recall).
    pub fn set_query(&mut self, text: &str) {
        self.query = text.to_string();
        self.qcursor = self.qlen();
        self.changed();
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
