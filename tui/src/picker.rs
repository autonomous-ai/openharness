//! The list behind every overlay (⌥O, ⌥P, needs input, machines, new harness…): a query line, rows
//! matched with nucleo (Helix's matcher — fzf's algorithm), a cursor that stays on the same ITEM when
//! the rows are rebuilt under it, and group headings in the unfiltered view.

use std::time::Instant;

use std::collections::HashMap;

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
    /// The kill buffer (C-w, M-BSpace, M-d), for C-y.
    pub kill: String,
    /// How far the preview can scroll (the preview sets it as it draws).
    pub preview_max: std::cell::Cell<u16>,
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
            prefixed: false,
            row_at: Vec::new(),
            armed: None,
            qcursor: 0,
            marked: Vec::new(),
            preview: true,
            preview_scroll: 0,
            matcher: Matcher::new(Config::DEFAULT),
            preview_max: Default::default(),
            kill: String::new(),
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
        let mut query = self.query.trim();
        if self.prefixed && query.starts_with(['>', '@', '#', ':', '*', '?']) { query = query[1..].trim() }
        if query.is_empty() {
            self.visible = self.rows.iter().enumerate().map(|(i, _)| (i, Vec::new())).collect();
        } else {
            // fzf's extended search: space-separated terms all match; `a | b` is one term either side
            // satisfies; 'exact and fuzzy are nucleo's; ^prefix, suffix$ and their !negations are
            // matched here against the title the row shows (nucleo's anchors miss uppercase).
            let mut groups: Vec<Vec<Term>> = Vec::new();
            let mut or_next = false;
            for word in terms(query) {
                if word == "|" { or_next = true; continue }
                let term = Term::parse(&word);
                match groups.last_mut() { Some(g) if or_next => g.push(term), _ => groups.push(vec![term]) }
                or_next = false;
            }
            let mut buf = Vec::new();
            let mut scored: Vec<(usize, u32, Vec<u32>)> = Vec::new();
            for (index, row) in self.rows.iter().enumerate() {
                if row.disabled { continue }
                // As fzf: the line you see is what matches. The hidden keywords (engine, branch, the
                // machine's id…) still find a row, but only below every visible match.
                let detail: String = row.detail.iter().map(|s| s.content.as_ref()).collect();
                // Laid out as the row draws it (two spaces between), so hit positions map back to cells.
                let visible = format!("{}  {}  {}", row.label, detail, row.right);
                let hidden = format!("{} {}", row.label, row.extra);
                let mut indices = Vec::new();
                let mut total = Some(0u32);
                for group in &groups {
                    // The title first (its hits are what gets highlighted), then the rest of the line
                    // you see, then — whole words only — the keywords behind it (engine, machine).
                    // (A negation must hold for the whole line you see, so it is only asked of that.)
                    let mut best = group.iter().filter(|t| !t.negative()).filter_map(|t| t.score(&row.label, &row.label, &mut buf, &mut self.matcher)).map(|(s, h)| (s + 40, h)).max_by_key(|(s, _)| *s);
                    if best.is_none() { best = group.iter().filter_map(|t| t.score(&row.label, &visible, &mut buf, &mut self.matcher)).max_by_key(|(s, _)| *s) }
                    if best.is_none() { best = group.iter().filter(|t| t.names_word(&hidden)).map(|_| (8u32, Vec::new())).next() }
                    match best { Some((s, hits)) => { total = total.map(|t| t + s); indices.extend(hits) } None => { total = None; break } }
                }
                if let Some(score) = total {
                    indices.sort_unstable();
                    indices.dedup();
                    // A row's boost (waiting, live) only breaks ties: once you type, the match decides.
                    scored.push((index, score, indices));
                }
            }
            // fzf's tiebreak: score, then the shorter line, then the original order.
            // Only negations (`!rate`): nothing scores, so the list keeps its order, as fzf's does.
            let positive = groups.iter().any(|g| g.iter().any(|t| !t.negative()));
            if !self.keep_order && positive { scored.sort_by(|a, b| b.1.cmp(&a.1).then(line_len(&self.rows[a.0]).cmp(&line_len(&self.rows[b.0]))).then(self.rows[b.0].boost.cmp(&self.rows[a.0].boost)).then(a.0.cmp(&b.0))) }
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
        let to = self.cursor as i64 + delta;
        // --cycle: one step past an end comes round to the other.
        self.cursor = if crate::theme::fzf_opts().cycle && delta.abs() == 1 && (to < 0 || to > max) { to.rem_euclid(max + 1) } else { to.clamp(0, max) } as usize;
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
    /// Backspace; C-w (word: back to whitespace, as unix-word-rubout); what a word-kill takes goes
    /// to the kill buffer for C-y.
    pub fn backspace(&mut self, word: bool) {
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
        self.changed();
    }

    /// M-BSpace (back) and M-d (forward): kill an alphanumeric word, as readline and fzf do.
    pub fn kill_word(&mut self, forward: bool) {
        let chars: Vec<char> = self.query.chars().collect();
        let at = self.qcursor.min(chars.len());
        let to = word_edge(&chars, at, forward);
        let (a, b) = if forward { (at, to) } else { (to, at) };
        if a == b { return }
        self.kill = chars[a..b].iter().collect();
        self.query = chars[..a].iter().chain(chars[b..].iter()).collect();
        self.qcursor = a;
        self.changed();
    }

    /// C-y: put back what was last killed.
    pub fn yank(&mut self) {
        let kill = self.kill.clone();
        for c in kill.chars() { self.type_char(c) }
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
        let at = self.qcursor.min(chars.len());
        if at > 0 { self.kill = chars[..at].iter().collect() }
        self.query = chars[at..].iter().collect();
        self.qcursor = 0;
        self.changed();
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

/// The length of the line a row shows (fzf's length tiebreak is the whole line's).
fn line_len(row: &Row) -> usize { row.label.chars().count() + row.detail.iter().map(|s| s.content.chars().count() + 2).sum::<usize>() }

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

/// Split a query into terms: whitespace separates, `\ ` is a literal space.
fn terms(query: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut chars = query.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&' ') => { word.push(' '); chars.next(); }
            c if c.is_whitespace() => { if !word.is_empty() { out.push(std::mem::take(&mut word)) } }
            c => word.push(c),
        }
    }
    if !word.is_empty() { out.push(word) }
    out
}

/// One search term.
enum Term {
    Anchored { text: String, prefix: bool, suffix: bool, negate: bool },
    Nucleo(Pattern, String),
}

impl Term {
    fn parse(word: &str) -> Term {
        let (negate, rest) = match word.strip_prefix('!') { Some(r) => (true, r), None => (false, word) };
        let prefix = rest.starts_with('^');
        let suffix = rest.ends_with('$') && !rest.ends_with("\\$") && rest.len() > 1;
        if prefix || suffix {
            let mut text = rest.trim_start_matches('^').to_string();
            if suffix { text.pop(); }
            return Term::Anchored { text, prefix, suffix, negate };
        }
        // FZF_DEFAULT_OPTS --exact turns 'x around (plain words exact, 'x fuzzy); -i / +i set the case.
        let o = crate::theme::fzf_opts();
        let word: String = if o.exact { match word.strip_prefix('\'') { Some(w) => w.to_string(), None if !word.starts_with('!') => format!("'{word}"), None => word.to_string() } } else { word.to_string() };
        let case = match o.case { Some(true) => CaseMatching::Respect, Some(false) => CaseMatching::Ignore, None => CaseMatching::Smart };
        Term::Nucleo(Pattern::parse(&word.replace(' ', "\\ "), case, Normalization::Smart), word.trim_start_matches('\'').to_lowercase())
    }

    fn negative(&self) -> bool {
        match self { Term::Anchored { negate, .. } => *negate, Term::Nucleo(_, raw) => raw.starts_with('!') }
    }

    /// A hidden keyword this term names from its start (`codex`, `gpu-box`): three letters or more.
    fn names_word(&self, hidden: &str) -> bool {
        let Term::Nucleo(_, raw) = self else { return false };
        raw.chars().count() >= 3 && !raw.starts_with('!') && hidden.to_lowercase().split(|c: char| c.is_whitespace() || c == '/' || c == '·').any(|w| w.starts_with(raw.as_str()))
    }

    /// A score and the matched character positions, or None when the row does not match.
    fn score(&self, label: &str, haystack: &str, buf: &mut Vec<char>, matcher: &mut Matcher) -> Option<(u32, Vec<u32>)> {
        match self {
            Term::Nucleo(p, _) => {
                let mut hits = Vec::new();
                p.indices(Utf32Str::new(haystack, buf), matcher, &mut hits).map(|s| (s, hits))
            }
            Term::Anchored { text, prefix, suffix, negate } => {
                // -i / +i from FZF_DEFAULT_OPTS, else smart case.
                let smart = match crate::theme::fzf_opts().case { Some(respect) => respect, None => text.chars().any(char::is_uppercase) };
                let (l, t) = if smart { (label.to_string(), text.clone()) } else { (label.to_lowercase(), text.to_lowercase()) };
                let n = l.chars().count() as u32;
                let k = t.chars().count() as u32;
                let hit = match (prefix, suffix) { (true, true) => l == t, (true, false) => l.starts_with(&t), _ => l.ends_with(&t) };
                // suffix$ also ends a column of the line (the detail): "main$" finds `webapp · main`.
                let column_end = if *suffix && !*prefix && !hit && haystack != label {
                    let h = if smart { haystack.to_string() } else { haystack.to_lowercase() };
                    let mut at = 0u32;
                    let mut found = None;
                    for part in h.split("  ") {
                        let len = part.chars().count() as u32;
                        if !part.is_empty() && part.ends_with(&t) { found = Some(at + len - k) }
                        at += len + 2;
                    }
                    found
                } else { None };
                if *negate { return (!hit && column_end.is_none()).then(|| (0, Vec::new())) }
                if !hit && column_end.is_none() { return None }
                let from = if let Some(f) = column_end { f } else if *prefix { 0 } else { n - k };
                Some((16 * k + 32, (from..from + k).collect()))
            }
        }
    }
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

