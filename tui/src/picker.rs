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
            let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
            let mut buf = Vec::new();
            let mut scored: Vec<(usize, u32, Vec<u32>)> = Vec::new();
            for (index, row) in self.rows.iter().enumerate() {
                if row.disabled { continue }
                let haystack = format!("{} {}", row.label, row.extra);
                let mut indices = Vec::new();
                if let Some(score) = pattern.indices(Utf32Str::new(&haystack, &mut buf), &mut self.matcher, &mut indices) {
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

    pub fn type_char(&mut self, c: char) {
        self.query.push(c);
        self.cursor = 0;
        self.selected_id = None;
        self.refilter();
    }

    pub fn backspace(&mut self, word: bool) {
        if word {
            let trimmed = self.query.trim_end().to_string();
            let cut = trimmed.rfind(char::is_whitespace).map(|i| i + 1).unwrap_or(0);
            self.query.truncate(cut);
        } else {
            self.query.pop();
        }
        self.cursor = 0;
        self.selected_id = None;
        self.refilter();
    }

    pub fn clear_query(&mut self) {
        self.query.clear();
        self.cursor = 0;
        self.selected_id = None;
        self.refilter();
    }

    pub fn current(&self) -> Option<&Row> {
        self.visible.get(self.cursor).map(|(i, _)| &self.rows[*i]).filter(|r| !r.disabled)
    }

    pub fn current_id(&self) -> Option<String> { self.current().map(|r| r.id.clone()) }

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
}
