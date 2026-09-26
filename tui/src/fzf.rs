//! fzf's matcher, ported from fzf 0.67.0 (src/algo/algo.go, src/pattern.go, src/result.go): the
//! extended-search syntax, FuzzyMatchV2's scores and the characters it lights, the exact, prefix,
//! suffix and equal matches, and the tiebreak — so a list ranks and lights as fzf ranks and lights
//! the same lines.

const SCORE_MATCH: i32 = 16;
const SCORE_GAP_START: i32 = -3;
const SCORE_GAP_EXTENSION: i32 = -1;
const BONUS_BOUNDARY: i32 = SCORE_MATCH / 2;
const BONUS_NON_WORD: i32 = SCORE_MATCH / 2;
const BONUS_CAMEL123: i32 = BONUS_BOUNDARY + SCORE_GAP_EXTENSION;
const BONUS_CONSECUTIVE: i32 = -(SCORE_GAP_START + SCORE_GAP_EXTENSION);
const BONUS_FIRST_CHAR_MULTIPLIER: i32 = 2;
/// The "default" scheme's.
const BONUS_BOUNDARY_WHITE: i32 = BONUS_BOUNDARY + 2;
const BONUS_BOUNDARY_DELIMITER: i32 = BONUS_BOUNDARY + 1;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Class { White, NonWord, Delimiter, Lower, Upper, Letter, Number }

fn class_of(c: char) -> Class {
    if c.is_ascii() {
        return match c {
            'a'..='z' => Class::Lower,
            'A'..='Z' => Class::Upper,
            '0'..='9' => Class::Number,
            ' ' | '\t' | '\n' | '\x0b' | '\x0c' | '\r' => Class::White,
            '/' | ',' | ':' | ';' | '|' => Class::Delimiter,
            _ => Class::NonWord,
        };
    }
    if c.is_lowercase() { Class::Lower }
    else if c.is_uppercase() { Class::Upper }
    else if c.is_numeric() { Class::Number }
    else if c.is_alphabetic() { Class::Letter }
    else if c.is_whitespace() { Class::White }
    else { Class::NonWord }
}

fn bonus_for(prev: Class, class: Class) -> i32 {
    if class > Class::NonWord {
        match prev {
            Class::White => return BONUS_BOUNDARY_WHITE,
            Class::Delimiter => return BONUS_BOUNDARY_DELIMITER,
            Class::NonWord => return BONUS_BOUNDARY,
            _ => {}
        }
    }
    if (prev == Class::Lower && class == Class::Upper) || (prev != Class::Number && class == Class::Number) { return BONUS_CAMEL123 }
    match class {
        Class::NonWord | Class::Delimiter => BONUS_NON_WORD,
        Class::White => BONUS_BOUNDARY_WHITE,
        _ => 0,
    }
}

fn bonus_at(text: &[char], idx: usize) -> i32 {
    if idx == 0 { return BONUS_BOUNDARY_WHITE }
    bonus_for(class_of(text[idx - 1]), class_of(text[idx]))
}

/// Go's unicode.To(LowerCase, c): one character.
fn lower(c: char) -> char { if c.is_ascii() { c.to_ascii_lowercase() } else { c.to_lowercase().next().unwrap_or(c) } }

/// A character as a term compares it: folded when the term ignores case, normalized when it does.
fn fold(c: char, case_sensitive: bool, normalize: bool) -> char {
    let c = if case_sensitive { c } else if c.is_ascii_uppercase() { c.to_ascii_lowercase() } else if !c.is_ascii() { lower(c) } else { c };
    if normalize { normalize_char(c) } else { c }
}

/// FuzzyMatchV2: the best-scoring alignment of `pattern` in `text` — (start, end, score, the
/// matched positions) — or None. Not `forward` (--tiebreak=end or pathname): of equal scores the
/// last one wins, as fzf searches from the end.
fn fuzzy_v2(case_sensitive: bool, normalize: bool, forward: bool, text: &[char], pattern: &[char]) -> Option<(usize, usize, i32, Vec<usize>)> {
    let m = pattern.len();
    if m == 0 { return Some((0, 0, 0, Vec::new())) }
    let n = text.len();
    if m > n { return None }
    // Phase 2: each character's bonus, the first place of each pattern character, row 0.
    let mut t: Vec<char> = Vec::with_capacity(n);
    let (mut h0, mut c0, mut b) = (vec![0i32; n], vec![0i32; n], vec![0i32; n]);
    let mut f = vec![0usize; m];
    let (mut max_score, mut max_pos) = (0i32, 0usize);
    let (mut pidx, mut last_idx) = (0usize, 0usize);
    let (pchar0, mut pchar) = (pattern[0], pattern[0]);
    let (mut prev_h0, mut prev_class, mut in_gap) = (0i32, Class::White, false);
    for off in 0..n {
        let mut ch = text[off];
        let class = class_of(ch);
        if ch.is_ascii() {
            if !case_sensitive && class == Class::Upper { ch = ch.to_ascii_lowercase() }
        } else {
            if !case_sensitive && class == Class::Upper { ch = lower(ch) }
            if normalize { ch = normalize_char(ch) }
        }
        t.push(ch);
        let bonus = bonus_for(prev_class, class);
        b[off] = bonus;
        prev_class = class;
        if ch == pchar {
            if pidx < m { f[pidx] = off; pidx += 1; pchar = pattern[pidx.min(m - 1)] }
            last_idx = off;
        }
        if ch == pchar0 {
            let score = SCORE_MATCH + bonus * BONUS_FIRST_CHAR_MULTIPLIER;
            h0[off] = score;
            c0[off] = 1;
            if m == 1 && (forward && score > max_score || !forward && score >= max_score) {
                max_score = score;
                max_pos = off;
                if forward && bonus >= BONUS_BOUNDARY { break }
            }
            in_gap = false;
        } else {
            h0[off] = (prev_h0 + if in_gap { SCORE_GAP_EXTENSION } else { SCORE_GAP_START }).max(0);
            c0[off] = 0;
            in_gap = true;
        }
        prev_h0 = h0[off];
    }
    if pidx != m { return None }
    if m == 1 { return Some((max_pos, max_pos + 1, max_score, vec![max_pos])) }
    // Phase 3: the score matrix, rows 1.., from each row's first possible column.
    let f0 = f[0];
    let width = last_idx - f0 + 1;
    let mut h = vec![0i32; width * m];
    h[..width].copy_from_slice(&h0[f0..=last_idx]);
    let mut c = vec![0i32; width * m];
    c[..width].copy_from_slice(&c0[f0..=last_idx]);
    for (off, &fi) in f[1..].iter().enumerate() {
        let pchar = pattern[off + 1];
        let pidx = off + 1;
        let row = pidx * width;
        let mut in_gap = false;
        h[row + fi - f0 - 1] = 0;
        for col in fi..=last_idx {
            let j = col - f0;
            let s2 = h[row + j - 1] + if in_gap { SCORE_GAP_EXTENSION } else { SCORE_GAP_START };
            let (mut s1, mut consecutive) = (0i32, 0i32);
            if pchar == t[col] {
                s1 = h[row - width + j - 1] + SCORE_MATCH;
                let mut bb = b[col];
                consecutive = c[row - width + j - 1] + 1;
                if consecutive > 1 {
                    let fb = b[col + 1 - consecutive as usize];
                    if bb >= BONUS_BOUNDARY && bb > fb { consecutive = 1 } else { bb = bb.max(BONUS_CONSECUTIVE.max(fb)) }
                }
                if s1 + bb < s2 { s1 += b[col]; consecutive = 0 } else { s1 += bb }
            }
            c[row + j] = consecutive;
            in_gap = s1 < s2;
            let score = s1.max(s2).max(0);
            if pidx == m - 1 && (forward && score > max_score || !forward && score >= max_score) { max_score = score; max_pos = col }
            h[row + j] = score;
        }
    }
    // Phase 4: back from the best end, the positions.
    let mut pos = Vec::with_capacity(m);
    let (mut i, mut j) = (m - 1, max_pos);
    let mut prefer_match = true;
    loop {
        let ii = i * width;
        let j0 = j - f0;
        let s = h[ii + j0];
        let s1 = if i > 0 && j >= f[i] { h[ii - width + j0 - 1] } else { 0 };
        let s2 = if j > f[i] { h[ii + j0 - 1] } else { 0 };
        if s > s1 && (s > s2 || (s == s2 && prefer_match)) {
            pos.push(j);
            if i == 0 { break }
            i -= 1;
        }
        prefer_match = c[ii + j0] > 1 || (ii + width + j0 + 1 < c.len() && c[ii + width + j0 + 1] > 0);
        if j == 0 || j <= f0 { break }
        j -= 1;
    }
    Some((j, max_pos + 1, max_score, pos))
}

/// fzf's calculateScore: a fixed alignment scored as V2 scores it.
fn calculate_score(case_sensitive: bool, normalize: bool, text: &[char], pattern: &[char], sidx: usize, eidx: usize) -> i32 {
    let (mut pidx, mut score, mut in_gap, mut consecutive, mut first_bonus) = (0usize, 0i32, false, 0i32, 0i32);
    let mut prev_class = if sidx > 0 { class_of(text[sidx - 1]) } else { Class::White };
    for &raw in &text[sidx..eidx] {
        let class = class_of(raw);
        let ch = fold(raw, case_sensitive, normalize);
        if pidx < pattern.len() && ch == pattern[pidx] {
            score += SCORE_MATCH;
            let mut bonus = bonus_for(prev_class, class);
            if consecutive == 0 { first_bonus = bonus } else {
                if bonus >= BONUS_BOUNDARY && bonus > first_bonus { first_bonus = bonus }
                bonus = bonus.max(first_bonus).max(BONUS_CONSECUTIVE);
            }
            score += if pidx == 0 { bonus * BONUS_FIRST_CHAR_MULTIPLIER } else { bonus };
            in_gap = false;
            consecutive += 1;
            pidx += 1;
        } else {
            score += if in_gap { SCORE_GAP_EXTENSION } else { SCORE_GAP_START };
            in_gap = true;
            consecutive = 0;
            first_bonus = 0;
        }
        prev_class = class;
    }
    score
}

/// ExactMatchNaive / ExactMatchBoundary: the occurrence with the best bonus at its start — looked
/// for from the end when not `forward` (--tiebreak=end or pathname), as fzf does.
fn exact(case_sensitive: bool, normalize: bool, forward: bool, boundary: bool, text: &[char], pattern: &[char]) -> Option<(usize, usize, i32)> {
    let m = pattern.len();
    if m == 0 { return Some((0, 0, 0)) }
    let n = text.len();
    if n < m { return None }
    // indexAt: an index counted from the end when searching backward.
    let at = |i: usize, max: usize| if forward { i } else { max - i - 1 };
    let (mut pidx, mut best_pos, mut bonus, mut bbonus, mut best_bonus) = (0usize, None::<usize>, 0i32, 0i32, -1i32);
    let mut index = 0isize;
    while (index as usize) < n {
        let idx = at(index as usize, n);
        let ch = fold(text[idx], case_sensitive, normalize);
        let p = at(pidx, m);
        let mut ok = pattern[p] == ch;
        if ok {
            if p == 0 { bonus = bonus_at(text, idx) }
            if boundary {
                if forward && p == 0 { bbonus = bonus }
                else if !forward && p == m - 1 { bbonus = if idx < n - 1 { bonus_at(text, idx + 1) } else { BONUS_BOUNDARY_WHITE } }
                ok = bbonus >= BONUS_BOUNDARY;
                if ok && p == 0 { ok = idx == 0 || class_of(text[idx - 1]) <= Class::Delimiter }
                if ok && p == m - 1 { ok = idx == n - 1 || class_of(text[idx + 1]) <= Class::Delimiter }
            }
        }
        if ok {
            pidx += 1;
            if pidx == m {
                if bonus > best_bonus { best_pos = Some(index as usize); best_bonus = bonus }
                if bonus >= BONUS_BOUNDARY { break }
                index -= (pidx - 1) as isize;
                pidx = 0;
                bonus = 0;
            }
        } else {
            index -= pidx as isize;
            pidx = 0;
            bonus = 0;
        }
        index += 1;
    }
    let best = best_pos?;
    let (sidx, eidx) = if forward { (best + 1 - m, best + 1) } else { (n - (best + 1), n - (best + 1 - m)) };
    let score = if boundary {
        // As fzf: the bonus the loop ended on; underscore boundaries rank below the others.
        let mut score = bonus;
        let mut deduct = bonus - BONUS_BOUNDARY + 1;
        if sidx > 0 && text[sidx - 1] == '_' { score -= deduct + 1; deduct = 1 }
        if eidx < n && text[eidx] == '_' { score -= deduct }
        score + SCORE_MATCH * m as i32 + BONUS_BOUNDARY_WHITE * (m as i32 + 1)
    } else { calculate_score(case_sensitive, normalize, text, pattern, sidx, eidx) };
    Some((sidx, eidx, score))
}

fn leading_ws(text: &[char]) -> usize { text.iter().take_while(|c| c.is_whitespace()).count() }
fn trailing_ws(text: &[char]) -> usize { text.iter().rev().take_while(|c| c.is_whitespace()).count() }

/// PrefixMatch (`^term`): at the start, past leading spaces.
fn prefix(case_sensitive: bool, normalize: bool, text: &[char], pattern: &[char]) -> Option<(usize, usize, i32)> {
    let m = pattern.len();
    if m == 0 { return Some((0, 0, 0)) }
    let trimmed = if !pattern[0].is_whitespace() { leading_ws(text) } else { 0 };
    if text.len() < trimmed + m { return None }
    for (i, &r) in pattern.iter().enumerate() {
        let mut ch = text[trimmed + i];
        if !case_sensitive { ch = lower(ch) }
        if normalize { ch = normalize_char(ch) }
        if ch != r { return None }
    }
    Some((trimmed, trimmed + m, calculate_score(case_sensitive, normalize, text, pattern, trimmed, trimmed + m)))
}

/// SuffixMatch (`term$`): at the end, before trailing spaces.
fn suffix(case_sensitive: bool, normalize: bool, text: &[char], pattern: &[char]) -> Option<(usize, usize, i32)> {
    let m = pattern.len();
    let mut trimmed = text.len();
    if m == 0 || !pattern[m - 1].is_whitespace() { trimmed -= trailing_ws(text) }
    if m == 0 { return Some((trimmed, trimmed, 0)) }
    if trimmed < m { return None }
    let diff = trimmed - m;
    for (i, &r) in pattern.iter().enumerate() {
        let mut ch = text[diff + i];
        if !case_sensitive { ch = lower(ch) }
        if normalize { ch = normalize_char(ch) }
        if ch != r { return None }
    }
    Some((diff, trimmed, calculate_score(case_sensitive, normalize, text, pattern, diff, trimmed)))
}

/// EqualMatch (`^term$`): the whole line, spaces around it aside.
fn equal(case_sensitive: bool, normalize: bool, text: &[char], pattern: &[char]) -> Option<(usize, usize, i32)> {
    let m = pattern.len();
    if m == 0 { return None }
    let lead = if !pattern[0].is_whitespace() { leading_ws(text) } else { 0 };
    let trail = if !pattern[m - 1].is_whitespace() { trailing_ws(text) } else { 0 };
    if text.len() as isize - lead as isize - trail as isize != m as isize { return None }
    let same = (0..m).all(|i| {
        let ch = if case_sensitive { text[lead + i] } else { lower(text[lead + i]) };
        if normalize { normalize_char(pattern[i]) == normalize_char(ch) } else { pattern[i] == ch }
    });
    same.then(|| (lead, lead + m, (SCORE_MATCH + BONUS_BOUNDARY_WHITE) * m as i32 + (BONUS_FIRST_CHAR_MULTIPLIER - 1) * BONUS_BOUNDARY_WHITE))
}

// ── the query (pattern.go) ──────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind { Fuzzy, Exact, ExactBoundary, Prefix, Suffix, Equal }

#[derive(Clone, Debug)]
struct Term { kind: Kind, inv: bool, text: Vec<char>, case_sensitive: bool, normalize: bool }

/// How a term's case is read: fzf's --smart-case (the default), +i, -i.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Case { Smart, Respect, Ignore }

/// A query in fzf's extended-search syntax: terms that must all match, `|` between the ones any
/// of which will do.
#[derive(Clone, Debug)]
pub struct Query { sets: Vec<Vec<Term>>, forward: bool }

/// A line's match: its score, where the terms matched (for the tiebreaks: the first begin, the
/// first and the last end), and the characters lit.
pub struct Hit { pub score: i32, pub begin: usize, pub min_end: usize, pub end: usize, pub positions: Vec<usize> }

impl Query {
    /// fzf's parseTerms. `fuzzy`: false under --exact; `normalize`: false under --literal.
    pub fn parse(query: &str, case: Case, fuzzy: bool, normalize: bool) -> Query {
        let mut s = query.trim_start_matches(' ').to_string();
        while s.ends_with(' ') && !s.ends_with("\\ ") { s.pop(); }
        let s = s.replace("\\ ", "\t");
        let (mut sets, mut set): (Vec<Vec<Term>>, Vec<Term>) = (Vec::new(), Vec::new());
        let (mut switch_set, mut after_bar) = (false, false);
        for token in s.split(' ').filter(|t| !t.is_empty()) {
            let mut text = token.replace('\t', " ");
            let lower_text = text.to_lowercase();
            let case_sensitive = case == Case::Respect || (case == Case::Smart && text != lower_text);
            let normalize_term = normalize && lower_text.chars().map(normalize_char).collect::<String>() == lower_text;
            if !case_sensitive { text = lower_text }
            let mut kind = if fuzzy { Kind::Fuzzy } else { Kind::Exact };
            if !set.is_empty() && !after_bar && text == "|" { switch_set = false; after_bar = true; continue }
            after_bar = false;
            let mut inv = false;
            if let Some(rest) = text.strip_prefix('!') { inv = true; kind = Kind::Exact; text = rest.to_string() }
            if text != "$" && text.ends_with('$') { kind = Kind::Suffix; text.pop(); }
            if text.len() > 2 && text.starts_with('\'') && text.ends_with('\'') {
                kind = Kind::ExactBoundary;
                text = text[1..text.len() - 1].to_string();
            } else if let Some(rest) = text.strip_prefix('\'') {
                kind = if fuzzy && !inv { Kind::Exact } else { Kind::Fuzzy };
                text = rest.to_string();
            } else if let Some(rest) = text.strip_prefix('^') {
                kind = if kind == Kind::Suffix { Kind::Equal } else { Kind::Prefix };
                text = rest.to_string();
            }
            if !text.is_empty() {
                if switch_set { sets.push(std::mem::take(&mut set)) }
                let mut chars: Vec<char> = text.chars().collect();
                if normalize_term { chars = chars.into_iter().map(normalize_char).collect() }
                set.push(Term { kind, inv, text: chars, case_sensitive, normalize: normalize_term });
                switch_set = true;
            }
        }
        if !set.is_empty() { sets.push(set) }
        Query { sets, forward: true }
    }

    /// The direction fzf searches in for these tiebreaks (core.go): backward when the first of
    /// end, begin and pathname given is end or pathname.
    pub fn searching(mut self, criteria: &[Tiebreak]) -> Query {
        for c in criteria.iter().rev() {
            match c { Tiebreak::End | Tiebreak::Pathname => self.forward = false, Tiebreak::Begin => self.forward = true, _ => {} }
        }
        self
    }

    /// Some term asks for something (not only `!x`): fzf sorts only then.
    pub fn sortable(&self) -> bool { self.sets.iter().any(|s| s.iter().any(|t| !t.inv)) }

    /// fzf's extendedMatch over one line: every set satisfied (a set by its first term that
    /// matches; a `!term` by its absence), the scores summed.
    pub fn matches(&self, line: &[char]) -> Option<Hit> {
        let (mut total, mut positions) = (0i32, Vec::new());
        let (mut begin, mut min_end, mut end, mut valid) = (usize::MAX, usize::MAX, 0usize, false);
        for set in &self.sets {
            let mut matched = false;
            let (mut score, mut off, mut pos): (i32, (usize, usize), Vec<usize>) = (0, (0, 0), Vec::new());
            for term in set {
                match run(term, line, self.forward) {
                    Some((s, e, sc, p)) => {
                        if term.inv { continue }
                        score = sc;
                        off = (s, e);
                        pos = p.unwrap_or_else(|| (s..e).collect());
                        matched = true;
                        break;
                    }
                    None if term.inv => { score = 0; off = (0, 0); pos.clear(); matched = true; }
                    None => {}
                }
            }
            if !matched { return None }
            total += score;
            positions.extend(pos);
            if off.0 < off.1 { begin = begin.min(off.0); min_end = min_end.min(off.1); end = end.max(off.1); valid = true }
        }
        positions.sort_unstable();
        positions.dedup();
        Some(Hit { score: total, begin: if valid { begin } else { 0 }, min_end: if valid { min_end } else { 0 }, end: if valid { end } else { 0 }, positions })
    }
}

/// One term against a line: (start, end, score, positions when the algorithm knows them).
fn run(term: &Term, line: &[char], forward: bool) -> Option<(usize, usize, i32, Option<Vec<usize>>)> {
    let (cs, nz, p) = (term.case_sensitive, term.normalize, &term.text[..]);
    match term.kind {
        Kind::Fuzzy => fuzzy_v2(cs, nz, forward, line, p).map(|(s, e, sc, pos)| (s, e, sc, Some(pos))),
        Kind::Exact => exact(cs, nz, forward, false, line, p).map(|(s, e, sc)| (s, e, sc, None)),
        Kind::ExactBoundary => exact(cs, nz, forward, true, line, p).map(|(s, e, sc)| (s, e, sc, None)),
        Kind::Prefix => prefix(cs, nz, line, p).map(|(s, e, sc)| (s, e, sc, None)),
        Kind::Suffix => suffix(cs, nz, line, p).map(|(s, e, sc)| (s, e, sc, None)),
        Kind::Equal => equal(cs, nz, line, p).map(|(s, e, sc)| (s, e, sc, None)),
    }
}

/// fzf's --tiebreak criteria after the score.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tiebreak { Length, Chunk, Pathname, Begin, End }

/// The rank fzf gives a matched line: lower first — buildResult's points (each a uint16, as fzf
/// keeps them), then the input order.
pub fn rank(hit: &Hit, line: &[char], criteria: &[Tiebreak]) -> Vec<i64> {
    const MAX: i64 = u16::MAX as i64;
    let u16 = |v: i64| v.clamp(0, MAX);
    let mut out = vec![MAX - u16(hit.score as i64)];
    let n = line.len();
    let trim_len = || { let l = leading_ws(line); if l == n { 0 } else { (n - l - trailing_ws(line)) as i64 } };
    let valid = hit.begin < hit.end;
    for c in criteria {
        out.push(match c {
            Tiebreak::Length => u16(trim_len()),
            Tiebreak::Chunk if valid => {
                let mut b = hit.begin;
                while b >= 1 && !line[b - 1].is_whitespace() { b -= 1 }
                let mut e = hit.end;
                while e < n && !line[e].is_whitespace() { e += 1 }
                u16((e - b) as i64)
            }
            // The last delimiter as fzf finds it: a byte index in the line's text.
            Tiebreak::Pathname if valid => {
                let text: String = line.iter().collect();
                let last = text.bytes().rposition(|b| b == b'/' || b == b'\\').map(|i| i as i64).unwrap_or(-1);
                if last <= hit.begin as i64 { u16(hit.begin as i64 - last) } else { MAX }
            }
            Tiebreak::Begin | Tiebreak::End if valid => {
                // Leading blanks don't count (up to where the match begins).
                let mut white = 0usize;
                for (idx, ch) in line.iter().enumerate() { white = idx; if idx == hit.begin || !ch.is_whitespace() { break } }
                if *c == Tiebreak::Begin { u16(hit.min_end as i64 - white as i64) } else { u16(MAX - MAX * (hit.end as i64 - white as i64) / (trim_len() + 1)) }
            }
            _ => MAX,
        });
    }
    out
}

/// fzf's latin-script normalization (src/algo/normalize.go): an accented letter matches its base.
fn normalize_char(c: char) -> char {
    let n = c as u32;
    if !(0x00C0..=0xFF61).contains(&n) { return c }
    match n {
        0xFF01 => '!',
        0xFF02 => '"',
        0xFF03 => '#',
        0xFF04 => '$',
        0xFF05 => '%',
        0xFF06 => '&',
        0xFF08 => '(',
        0xFF09 => ')',
        0xFF0A => '*',
        0xFF0B => '+',
        0xFF0C => ',',
        0xFF0D => '-',
        0xFF0E | 0xFF61 => '.',
        0xFF0F => '/',
        0xFF10 => '0',
        0xFF11 => '1',
        0xFF12 => '2',
        0xFF13 => '3',
        0xFF14 => '4',
        0xFF15 => '5',
        0xFF16 => '6',
        0xFF17 => '7',
        0xFF18 => '8',
        0xFF19 => '9',
        0xFF1A => ':',
        0xFF1B => ';',
        0xFF1C => '<',
        0xFF1D => '=',
        0xFF1E => '>',
        0xFF1F => '?',
        0xFF20 => '@',
        0x00C0 | 0x00C1 | 0x00C2 | 0x00C3 | 0x00C4 | 0x00C5 | 0x023A | 0x1D00 | 0xFF21 => 'A',
        0x0181 | 0x0243 | 0x0299 | 0x1D03 | 0xFF22 => 'B',
        0x00C7 | 0x023B | 0x1D04 | 0xFF23 => 'C',
        0x0189 | 0x018A | 0x1D05 | 0xFF24 => 'D',
        0x00C8 | 0x00C9 | 0x00CA | 0x00CB | 0x018E | 0x0190 | 0x0246 | 0x1D07 | 0xFF25 => 'E',
        0xFF26 => 'F',
        0x0193 | 0x0262 | 0x029B | 0xFF27 => 'G',
        0x029C | 0xFF28 => 'H',
        0x00CC | 0x00CD | 0x00CE | 0x00CF | 0x0130 | 0x0197 | 0x026A | 0xFF29 => 'I',
        0x0248 | 0x1D0A | 0xFF2A => 'J',
        0x1D0B | 0xFF2B => 'K',
        0x023D | 0x029F | 0x1D0C | 0xFF2C => 'L',
        0x019C | 0x1D0D | 0xFF2D => 'M',
        0x00D1 | 0x019D | 0x0220 | 0x0274 | 0x1D0E | 0xFF2E => 'N',
        0x00D2 | 0x00D3 | 0x00D4 | 0x00D5 | 0x00D6 | 0x00D8 | 0x0186 | 0x019F | 0x1D0F | 0x1D10 | 0xFF2F => 'O',
        0x1D18 | 0xFF30 => 'P',
        0x024A | 0xFF31 => 'Q',
        0x024C | 0x0280 | 0x0281 | 0x1D19 | 0x1D1A | 0xFF32 => 'R',
        0xFF33 => 'S',
        0x01AE | 0x023E | 0x1D1B | 0xFF34 => 'T',
        0x00D9 | 0x00DA | 0x00DB | 0x00DC | 0x0244 | 0x1D1C | 0xFF35 => 'U',
        0x01B2 | 0x0245 | 0x1D20 | 0xFF36 => 'V',
        0x1D21 | 0xFF37 => 'W',
        0xFF38 => 'X',
        0x00DD | 0x0178 | 0x024E | 0x028F | 0xFF39 => 'Y',
        0x1D22 | 0xFF3A => 'Z',
        0xFF3B => '[',
        0xFF07 => '\'',
        0xFF3C => '\\',
        0xFF3D => ']',
        0xFF3E => '^',
        0xFF3F => '_',
        0xFF40 => '`',
        0x00E0 | 0x00E1 | 0x00E2 | 0x00E3 | 0x00E4 | 0x00E5 | 0x0101 | 0x0103 | 0x0105 | 0x01CE | 0x0201 | 0x0203 | 0x0227 | 0x0250 | 0x0251 | 0x0363 | 0x1E01 | 0x1E9A | 0x1EA1 | 0x1EA3 | 0xFF41 => 'a',
        0x0180 | 0x0183 | 0x0253 | 0x1E03 | 0x1E05 | 0x1E07 | 0xFF42 => 'b',
        0x00E7 | 0x0107 | 0x0109 | 0x010B | 0x010D | 0x0188 | 0x023C | 0x0255 | 0x0297 | 0x0368 | 0x2184 | 0xFF43 => 'c',
        0x010F | 0x0111 | 0x018C | 0x0221 | 0x0256 | 0x0257 | 0x0369 | 0x1E0B | 0x1E0D | 0x1E0F | 0x1E11 | 0x1E13 | 0xFF44 => 'd',
        0x00E8 | 0x00E9 | 0x00EA | 0x00EB | 0x0113 | 0x0115 | 0x0117 | 0x0119 | 0x011B | 0x01DD | 0x0205 | 0x0207 | 0x0229 | 0x0247 | 0x0258 | 0x025B | 0x025C | 0x025D | 0x025E | 0x029A | 0x0364 | 0x1D08 | 0x1E19 | 0x1E1B | 0x1EB9 | 0x1EBB | 0x1EBD | 0xFF45 => 'e',
        0x0192 | 0x1E1F | 0xFF46 => 'f',
        0x011D | 0x011F | 0x0121 | 0x0123 | 0x01E5 | 0x01E7 | 0x01F5 | 0x0260 | 0x0261 | 0x1E21 | 0xFF47 => 'g',
        0x0125 | 0x0127 | 0x021F | 0x0265 | 0x0266 | 0x02AE | 0x036A | 0x1E23 | 0x1E25 | 0x1E27 | 0x1E29 | 0x1E2B | 0x1E96 | 0x2095 | 0xFF48 => 'h',
        0x00EC | 0x00ED | 0x00EE | 0x00EF | 0x0129 | 0x012B | 0x012D | 0x012F | 0x0131 | 0x01D0 | 0x0209 | 0x020B | 0x0268 | 0x0365 | 0x1D09 | 0x1D62 | 0x1E2D | 0x1EC9 | 0x1ECB | 0x2071 | 0xFF49 => 'i',
        0x0135 | 0x01F0 | 0x0237 | 0x0249 | 0x025F | 0x029D | 0xFF4A => 'j',
        0x0137 | 0x0199 | 0x01E9 | 0x029E | 0x1E31 | 0x1E33 | 0x1E35 | 0x2096 | 0xFF4B => 'k',
        0x013A | 0x013C | 0x013E | 0x0140 | 0x0142 | 0x019A | 0x0234 | 0x026B | 0x026C | 0x026D | 0x1E37 | 0x1E3B | 0x1E3D | 0x2097 | 0xFF4C => 'l',
        0x026F | 0x0270 | 0x0271 | 0x036B | 0x1D1F | 0x1E3F | 0x1E41 | 0x1E43 | 0x2098 | 0xFF4D => 'm',
        0x00F1 | 0x0144 | 0x0146 | 0x0148 | 0x019E | 0x01F9 | 0x0235 | 0x0272 | 0x0273 | 0x1E45 | 0x1E47 | 0x1E49 | 0x1E4B | 0x2099 | 0xFF4E => 'n',
        0x00F2 | 0x00F3 | 0x00F4 | 0x00F5 | 0x00F6 | 0x00F8 | 0x014D | 0x014F | 0x0151 | 0x01A1 | 0x01D2 | 0x01EB | 0x020D | 0x020F | 0x022F | 0x0254 | 0x0275 | 0x0366 | 0x1D11 | 0x1D12 | 0x1D13 | 0x1D16 | 0x1D17 | 0x1ECD | 0x1ECF | 0xFF4F => 'o',
        0x01A5 | 0x1E55 | 0x1E57 | 0x209A | 0xFF50 => 'p',
        0x024B | 0x02A0 | 0xFF51 => 'q',
        0x0155 | 0x0157 | 0x0159 | 0x0211 | 0x0213 | 0x024D | 0x0279 | 0x027A | 0x027B | 0x027C | 0x027D | 0x027E | 0x027F | 0x036C | 0x1D63 | 0x1E59 | 0x1E5B | 0x1E5F | 0xFF52 => 'r',
        0x00DF | 0x015B | 0x015D | 0x015F | 0x0161 | 0x017F | 0x0219 | 0x023F | 0x0282 | 0x1E61 | 0x1E63 | 0x1E9B | 0x209B | 0xFF53 => 's',
        0x0163 | 0x0165 | 0x0167 | 0x01AB | 0x01AD | 0x021B | 0x0236 | 0x0287 | 0x0288 | 0x036D | 0x1E6B | 0x1E6D | 0x1E6F | 0x1E71 | 0x1E97 | 0x209C | 0xFF54 => 't',
        0x00F9 | 0x00FA | 0x00FB | 0x00FC | 0x0169 | 0x016B | 0x016D | 0x016F | 0x0171 | 0x0173 | 0x01B0 | 0x01D4 | 0x0215 | 0x0217 | 0x0289 | 0x0367 | 0x1D1D | 0x1D1E | 0x1D64 | 0x1E73 | 0x1E75 | 0x1E77 | 0x1EE5 | 0x1EE7 | 0xFF55 => 'u',
        0x028B | 0x028C | 0x036E | 0x1D65 | 0x1E7D | 0x1E7F | 0xFF56 => 'v',
        0x0175 | 0x028D | 0x1E81 | 0x1E83 | 0x1E85 | 0x1E87 | 0x1E89 | 0x1E98 | 0xFF57 => 'w',
        0x036F | 0x1E8B | 0x1E8D | 0xFF58 => 'x',
        0x00FD | 0x00FF | 0x0177 | 0x01B4 | 0x0233 | 0x024F | 0x028E | 0x1E8F | 0x1E99 | 0x1EF3 | 0x1EF5 | 0x1EF7 | 0x1EF9 | 0xFF59 => 'y',
        0x017A | 0x017C | 0x017E | 0x01B6 | 0x0225 | 0x0240 | 0x0290 | 0x0291 | 0x1E91 | 0x1E93 | 0x1E95 | 0xFF5A => 'z',
        0xFF5B => '{',
        0xFF5C => '|',
        0xFF5D => '}',
        0xFF5E => '~',
        _ => c,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(q: &str, line: &str) -> Option<Hit> { Query::parse(q, Case::Smart, true, true).matches(&line.chars().collect::<Vec<_>>()) }

    #[test]
    fn ties_light_the_first_occurrence_as_fzf_does() {
        // "copy" in `C-b [  copy-mode  Enter copy mode`: fzf lights copy-mode, not the note.
        let line = "C-b [  copy-mode  Enter copy mode";
        let h = hit("copy", line).unwrap();
        assert_eq!(h.positions, vec![7, 8, 9, 10]);
    }

    #[test]
    fn one_letter_on_a_line_with_a_middle_dot() {
        // Word starts count after `·` too (nucleo lost them on non-ASCII lines).
        let h = hit("e", "Train tokenizer on the new corpus  ml-lab · exp/tokenizer-v3").unwrap();
        let line: Vec<char> = "Train tokenizer on the new corpus  ml-lab · exp/tokenizer-v3".chars().collect();
        assert_eq!(line[h.positions[0]], 'e');
        assert_eq!(h.positions[0], 44);
    }

    /// Real fzf 0.67's order for 30 queries over 186 lines (tests/fixtures/fzf: `fzf --filter`).
    #[test]
    fn ranks_as_fzf_does() {
        use Tiebreak::*;
        // fzf 0.67's own --filter output over the same lines, for each --tiebreak.
        let fixtures: [(&str, &[Tiebreak]); 11] = [
            (include_str!("../tests/fixtures/fzf/expected.txt"), &[Length]),
            (include_str!("../tests/fixtures/fzf/expected-end.txt"), &[End]),
            (include_str!("../tests/fixtures/fzf/expected-begin.txt"), &[Begin]),
            (include_str!("../tests/fixtures/fzf/expected-pathname.txt"), &[Pathname]),
            (include_str!("../tests/fixtures/fzf/expected-chunk.txt"), &[Chunk]),
            (include_str!("../tests/fixtures/fzf/expected-index.txt"), &[]),
            (include_str!("../tests/fixtures/fzf/expected-end-length.txt"), &[End, Length]),
            (include_str!("../tests/fixtures/fzf/expected-begin-length.txt"), &[Begin, Length]),
            (include_str!("../tests/fixtures/fzf/expected-length-end.txt"), &[Length, End]),
            (include_str!("../tests/fixtures/fzf/expected-pathname-length.txt"), &[Pathname, Length]),
            (include_str!("../tests/fixtures/fzf/expected-chunk-begin.txt"), &[Chunk, Begin]),
        ];
        let lines: Vec<&str> = include_str!("../tests/fixtures/fzf/lines.txt").lines().collect();
        let mut wrong = Vec::new();
        for (fixture, criteria) in fixtures {
            for block in fixture.split("### ").filter(|b| !b.is_empty()) {
                let mut it = block.lines();
                let q = it.next().unwrap_or("");
                let want: Vec<&str> = it.collect();
                let query = Query::parse(q, Case::Smart, true, true).searching(criteria);
                let mut got: Vec<(Vec<i64>, &str)> = lines.iter().enumerate().filter_map(|(i, l)| {
                    let chars: Vec<char> = l.chars().collect();
                    query.matches(&chars).map(|h| { let mut r = rank(&h, &chars, criteria); r.push(i as i64); (r, *l) })
                }).collect();
                if query.sortable() { got.sort_by(|a, b| a.0.cmp(&b.0)) }
                let got: Vec<&str> = got.into_iter().map(|(_, l)| l).collect();
                if got != want { wrong.push(format!("{criteria:?} {q:?}: fzf {} lines, hn {}; first difference at {}", want.len(), got.len(), got.iter().zip(&want).position(|(a, b)| a != b).unwrap_or(got.len().min(want.len())))) }
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    /// The characters fzf lights when it searches from the end (--tiebreak=end): the last of the
    /// best, as fzf 0.67 draws them.
    #[test]
    fn lights_from_the_end_for_tiebreak_end() {
        let lit = |q: &str, line: &str, criteria: &[Tiebreak]| { let chars: Vec<char> = line.chars().collect(); Query::parse(q, Case::Smart, true, true).searching(criteria).matches(&chars).unwrap().positions };
        let line = "C-b E  select-layout -E  Spread panes out evenly";
        assert_eq!(lit("e", line, &[Tiebreak::End]), vec![42]);
        assert_eq!(lit("e", line, &[Tiebreak::Length]), vec![4]);
        assert_eq!(lit("'lay", line, &[Tiebreak::End]), vec![14, 15, 16]);
    }

    #[test]
    fn extended_search() {
        assert!(hit("'site", "docs site").is_some());
        assert!(hit("!docs", "docs site").is_none());
        assert!(hit("^docs", "docs site").is_some() && hit("^site", "docs site").is_none());
        assert!(hit("site$", "docs site").is_some() && hit("docs$", "docs site").is_none());
        // Two terms, as fzf reads it: ^docs and site$.
        assert!(hit("^docs site$", "docs site").is_some());
        assert!(hit("docs | nope", "docs site").is_some() && hit("nope | none", "docs site").is_none());
        assert!(hit("Docs", "docs site").is_none() && hit("docs", "Docs site").is_some());
        assert!(hit("cafe", "Café").is_some());
    }
}
