//! tmux's options: the table (table.rs, from tmux 3.5a's source), their defaults (as `tmux -f
//! /dev/null` prints them), what has been set — globally, for the session, a window or a pane — and
//! tmux's rules for setting and showing them: the checks and their messages, flags toggling,
//! `-a`/`-o`/`-u`, arrays, and the quoting `show-options` prints.

mod table;

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope { Server, Session, Window, Pane }

#[derive(Clone, Copy, Debug)]
pub enum Kind { Flag, Number(i64, i64), Choice(&'static [&'static str]), String, Colour, Key }

pub struct Opt { pub name: &'static str, pub scope: Scope, pub pane: bool, pub kind: Kind, pub array: bool }

/// The table's entry for `name` (or `name[3]`).
pub fn find(name: &str) -> Option<&'static Opt> {
    let base = name.split('[').next().unwrap_or(name);
    table::TABLE.iter().find(|o| o.name == base)
}

/// tmux's defaults, raw, by name (`name[i]` for an array's items). hn's own differ in one place,
/// on purpose: a harness pane is named, so pane-border-status is `top`. mode-keys and status-keys
/// follow $VISUAL or $EDITOR, as tmux's do: vi when it names a vi.
pub fn defaults() -> &'static BTreeMap<String, String> {
    static D: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    D.get_or_init(|| {
        let mut m = BTreeMap::new();
        for line in include_str!("../../tests/fixtures/tmux-3.5a-options.txt").lines() {
            let mut it = line.splitn(3, ' ');
            let (_, name, value) = (it.next(), it.next().unwrap_or(""), it.next().unwrap_or(""));
            if !name.is_empty() { m.insert(name.to_string(), unescape(value)); }
        }
        m.insert("pane-border-status".into(), "top".into());
        // A harness's name is its pane's title; a program's own (OSC 2) only if you say so.
        m.insert("allow-set-title".into(), "off".into());
        let editor = std::env::var("VISUAL").ok().filter(|s| !s.is_empty()).or_else(|| std::env::var("EDITOR").ok()).unwrap_or_default();
        let base = editor.rsplit('/').next().unwrap_or("");
        let keys = if base.contains("vi") { "vi" } else { "emacs" };
        m.insert("mode-keys".into(), keys.into());
        m.insert("status-keys".into(), keys.into());
        m
    })
}

/// Where a `set` lands, as tmux's flags choose it.
#[derive(Default, Clone, Debug)]
pub struct SetFlags { pub global: bool, pub server: bool, pub window: bool, pub pane: bool, pub unset: bool, pub append: bool, pub only_if_unset: bool }

/// Every value that has been set, by where.
#[derive(Default, Clone, Debug)]
pub struct Store {
    pub server: BTreeMap<String, String>,
    pub global_session: BTreeMap<String, String>,
    pub global_window: BTreeMap<String, String>,
    pub session: BTreeMap<String, String>,
    /// By window (the desk tab's id).
    pub windows: HashMap<String, BTreeMap<String, String>>,
    pub panes: HashMap<u64, BTreeMap<String, String>>,
}

/// The scope a name belongs to: the table's, or for a user option the flags'.
fn scope_of(name: &str, f: &SetFlags) -> Result<Scope, String> {
    if name.starts_with('@') {
        return Ok(if f.server { Scope::Server } else if f.pane { Scope::Pane } else if f.window { Scope::Window } else { Scope::Session });
    }
    match find(name) {
        Some(o) if f.pane && o.pane => Ok(Scope::Pane),
        Some(o) => Ok(o.scope),
        None => Err(format!("invalid option: {name}")),
    }
}

impl Store {
    /// The map a set or show with these flags means.
    fn map_mut(&mut self, scope: Scope, global: bool, window: &str, pane: u64) -> &mut BTreeMap<String, String> {
        match (scope, global) {
            (Scope::Server, _) => &mut self.server,
            (Scope::Session, true) => &mut self.global_session,
            (Scope::Session, false) => &mut self.session,
            (Scope::Window | Scope::Pane, true) => &mut self.global_window,
            (Scope::Window, false) => self.windows.entry(window.to_string()).or_default(),
            (Scope::Pane, false) => self.panes.entry(pane).or_default(),
        }
    }

    fn map(&self, scope: Scope, global: bool, window: &str, pane: u64) -> Option<&BTreeMap<String, String>> {
        match (scope, global) {
            (Scope::Server, _) => Some(&self.server),
            (Scope::Session, true) => Some(&self.global_session),
            (Scope::Session, false) => Some(&self.session),
            (Scope::Window | Scope::Pane, true) => Some(&self.global_window),
            (Scope::Window, false) => self.windows.get(window),
            (Scope::Pane, false) => self.panes.get(&pane),
        }
    }

    /// The value in force for `name` here: the pane's, the window's, the session's, the global one,
    /// then tmux's default. None for an option nobody set and tmux has no default for (`@x`).
    pub fn get(&self, name: &str, window: &str, pane: Option<u64>) -> Option<String> {
        let layers: Vec<Option<&BTreeMap<String, String>>> = if name.starts_with('@') {
            vec![pane.and_then(|p| self.panes.get(&p)), self.windows.get(window), Some(&self.global_window), Some(&self.session), Some(&self.global_session), Some(&self.server)]
        } else {
            match find(name).map(|o| o.scope) {
                Some(Scope::Server) => vec![Some(&self.server)],
                Some(Scope::Session) => vec![Some(&self.session), Some(&self.global_session)],
                Some(Scope::Window | Scope::Pane) => vec![pane.and_then(|p| self.panes.get(&p)), self.windows.get(window), Some(&self.global_window)],
                None => return None,
            }
        };
        layers.into_iter().flatten().find_map(|m| m.get(name).cloned()).or_else(|| defaults().get(name).cloned())
    }

    /// As tmux's formats read it (options_to_string, numeric): a flag is 1 or 0; an array its items
    /// joined by spaces.
    pub fn format_value(&self, name: &str, window: &str, pane: Option<u64>) -> Option<String> {
        let opt = find(name);
        if opt.map(|o| o.array).unwrap_or(false) && !name.contains('[') {
            let items: Vec<String> = (0..64).filter_map(|i| self.get(&format!("{name}[{i}]"), window, pane)).collect();
            return Some(items.join(" "));
        }
        let v = self.get(name, window, pane)?;
        Some(match opt.map(|o| o.kind) { Some(Kind::Flag) => if v == "on" { "1".into() } else { "0".into() }, _ => v })
    }

    /// `set-option`: check the value as tmux does and store it. Returns the value now in force.
    pub fn set(&mut self, name: &str, value: Option<&str>, f: &SetFlags, window: &str, pane: u64) -> Result<Option<String>, String> {
        if name.is_empty() { return Err("invalid option: ".into()) }
        let scope = scope_of(name, f)?;
        let global = f.global || scope == Scope::Server;
        let opt = find(name);
        if f.unset {
            let map = self.map_mut(scope, global, window, pane);
            if opt.map(|o| o.array).unwrap_or(false) && !name.contains('[') {
                map.retain(|k, _| !k.starts_with(&format!("{name}[")));
            } else { map.remove(name); }
            return Ok(self.get(name, window, Some(pane)));
        }
        let here = self.map(scope, global, window, pane).and_then(|m| m.get(name).cloned());
        if f.only_if_unset && here.is_some() { return Err(format!("already set: {name}")) }
        let now = self.get(name, window, Some(pane));
        let new = match (opt.map(|o| o.kind), value) {
            // A user option, or a string: as given (appended with -a).
            (None | Some(Kind::String), v) => {
                let v = v.unwrap_or("");
                if opt.map(|o| o.array).unwrap_or(false) && !name.contains('[') {
                    // An array: `set -a` adds an item, a plain set replaces them all with this one.
                    let map = self.map_mut(scope, global, window, pane);
                    let n = if f.append { (0..).find(|i| !map.contains_key(&format!("{name}[{i}]"))).unwrap_or(0) } else {
                        map.retain(|k, _| !k.starts_with(&format!("{name}[")));
                        0
                    };
                    map.insert(format!("{name}[{n}]"), v.to_string());
                    return Ok(Some(v.to_string()));
                }
                if f.append { format!("{}{v}", here.clone().or(now.clone()).unwrap_or_default()) } else { v.to_string() }
            }
            (Some(Kind::Flag), None | Some("")) => if now.as_deref() == Some("on") { "off".into() } else { "on".into() },
            (Some(Kind::Flag), Some(v)) => match v.to_ascii_lowercase().as_str() {
                "on" | "yes" | "1" => "on".into(),
                "off" | "no" | "0" => "off".into(),
                _ => return Err(format!("bad value: {v}")),
            },
            (Some(Kind::Choice(choices)), None | Some("")) => {
                // tmux toggles a choice whose value is its first or second.
                match choices.iter().position(|c| Some(*c) == now.as_deref()) {
                    Some(0) => choices[1].to_string(),
                    Some(1) => choices[0].to_string(),
                    _ => return Err("value is required".into()),
                }
            }
            (Some(Kind::Choice(choices)), Some(v)) => {
                if let Some(c) = choices.iter().find(|c| c.eq_ignore_ascii_case(v)) { c.to_string() }
                else if let Some(c) = v.parse::<usize>().ok().and_then(|i| choices.get(i)) { c.to_string() }
                else { return Err(format!("unknown value: {v}")) }
            }
            (Some(Kind::Number(lo, hi)), Some(v)) => {
                let n: i64 = v.trim().parse().map_err(|_| format!("value is invalid: {v}"))?;
                if n < lo { return Err(format!("value is too small: {v}")) }
                if n > hi { return Err(format!("value is too large: {v}")) }
                n.to_string()
            }
            (Some(Kind::Number(..) | Kind::Colour | Kind::Key), None) => return Err("value is required".into()),
            (Some(Kind::Colour), Some(v)) => {
                if crate::tmuxconf::colour(v).is_none() { return Err(format!("bad colour: {v}")) }
                v.to_string()
            }
            (Some(Kind::Key), Some(v)) => {
                if !v.eq_ignore_ascii_case("none") && crate::keys::parse(v).is_err() { return Err(format!("bad key: {v}")) }
                if v.eq_ignore_ascii_case("none") { "None".into() } else { crate::keys::name(&crate::keys::parse(v).map_err(|e| e.to_string())?) }
            }
        };
        self.map_mut(scope, global, window, pane).insert(name.to_string(), new.clone());
        Ok(Some(new))
    }

    /// Every option of a scope in force globally: tmux's defaults, then what was set with -g.
    fn global_rows(&self, scope: Scope) -> BTreeMap<String, String> {
        let in_scope = |o: &Opt| match scope { Scope::Server => o.scope == Scope::Server, Scope::Session => o.scope == Scope::Session, Scope::Window => matches!(o.scope, Scope::Window | Scope::Pane), Scope::Pane => false };
        let mut rows: BTreeMap<String, String> = defaults().iter().filter(|(k, _)| find(k).map(in_scope).unwrap_or(false)).map(|(k, v)| (k.clone(), v.clone())).collect();
        if let Some(map) = self.map(scope, true, "", 0) { overlay(&mut rows, map) }
        rows
    }

    /// `show-options`: the lines tmux prints for these flags (every option in the scope, or `name`).
    /// [inherited] (-A) adds the values in force from further out, marked `*`.
    pub fn show(&self, name: Option<&str>, f: &SetFlags, inherited: bool, values_only: bool, window: &str, pane: u64) -> Result<Vec<String>, String> {
        let scope = match name { Some(n) => scope_of(n, f)?, None => if f.server { Scope::Server } else if f.pane { Scope::Pane } else if f.window { Scope::Window } else { Scope::Session } };
        let global = f.global || scope == Scope::Server;
        let mut rows: BTreeMap<String, (String, bool)> = BTreeMap::new();
        if global || inherited {
            for (k, v) in self.global_rows(if scope == Scope::Pane { Scope::Window } else { scope }) { rows.insert(k, (v, !global)); }
        }
        if !global {
            if let Some(map) = self.map(scope, false, window, pane) {
                let mut plain: BTreeMap<String, String> = rows.iter().map(|(k, (v, _))| (k.clone(), v.clone())).collect();
                overlay(&mut plain, map);
                rows = plain.into_iter().map(|(k, v)| { let local = map.contains_key(&k); (k, (v, inherited && !local)) }).collect();
            }
        }
        let mut out = Vec::new();
        match name {
            Some(n) => {
                let base = n.split('[').next().unwrap_or(n);
                let hits: Vec<(&String, &(String, bool))> = rows.iter().filter(|(k, _)| k.as_str() == n || (!n.contains('[') && k.starts_with(&format!("{base}[")))).collect();
                // A user option nobody set does not exist; tmux's own just has no value here.
                if hits.is_empty() && (n.starts_with('@') || find(n).is_none()) { return Err(format!("invalid option: {n}")) }
                for (k, (v, inh)) in hits { out.push(line(k, v, *inh, values_only)) }
            }
            None => for (k, (v, inh)) in &rows { out.push(line(k, v, *inh, values_only)) },
        }
        Ok(out)
    }
}

/// Values set over a list: an array set here replaces the list's items of that array.
fn overlay(rows: &mut BTreeMap<String, String>, map: &BTreeMap<String, String>) {
    let arrays: std::collections::HashSet<&str> = map.keys().filter_map(|k| k.split_once('[').map(|(b, _)| b)).collect();
    for a in arrays { rows.retain(|r, _| r != a && !r.starts_with(&format!("{a}["))) }
    for (k, v) in map { rows.insert(k.clone(), v.clone()); }
}

fn line(name: &str, value: &str, inherited: bool, values_only: bool) -> String {
    let star = if inherited { "*" } else { "" };
    if values_only { return value.to_string() }
    if value.is_empty() && find(name).map(|o| o.array).unwrap_or(false) && !name.contains('[') { return format!("{name}{star}") }
    format!("{name}{star} {}", escape(value))
}

/// tmux's args_escape: a value as `show-options` prints it, so it reads back the same.
pub fn escape(s: &str) -> String {
    if s.is_empty() { return "''".into() }
    let quotes = if s.chars().any(|c| " #';${}%".contains(c)) { Some('"') } else if s.chars().any(|c| " \"".contains(c)) { Some('\'') } else { None };
    let mut chars = s.chars();
    if let (Some(c0), None) = (chars.next(), chars.next()) {
        if c0 != ' ' && (quotes.is_some() || c0 == '~') { return format!("\\{c0}") }
    }
    let mut esc = String::new();
    for c in s.chars() {
        match c {
            '\t' => esc.push_str("\\t"),
            '\n' => esc.push_str("\\n"),
            '\r' => esc.push_str("\\r"),
            '\\' => esc.push_str("\\\\"),
            '"' | '$' if quotes == Some('"') => { esc.push('\\'); esc.push(c) }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => esc.push_str(&format!("\\{:03o}", c as u32)),
            c => esc.push(c),
        }
    }
    match quotes {
        Some('\'') => format!("'{esc}'"),
        Some(_) => if esc.starts_with('~') { format!("\"\\{esc}\"") } else { format!("\"{esc}\"") },
        None => if esc.starts_with('~') { format!("\\{esc}") } else { esc },
    }
}

/// The value an escaped one stands for (the defaults' file is printed by tmux in that form).
pub fn unescape(s: &str) -> String {
    let s = s.trim_end_matches('\r');
    if s == "''" { return String::new() }
    if s.len() >= 2 && s.starts_with('\'') && s.ends_with('\'') { return s[1..s.len() - 1].to_string() }
    let inner = if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') { &s[1..s.len() - 1] } else { s };
    let mut out = String::new();
    let mut it = inner.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\\' { out.push(c); continue }
        match it.next() {
            Some('t') => out.push('\t'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some(d) if d.is_digit(8) => {
                let mut n = d.to_digit(8).unwrap_or(0);
                for _ in 0..2 { if let Some(e) = it.peek().and_then(|e| e.to_digit(8)) { n = n * 8 + e; it.next(); } }
                if let Some(ch) = char::from_u32(n) { out.push(ch) }
            }
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_as_tmux_prints_it() {
        assert_eq!(escape("a$b\"c\\d"), r#""a\$b\"c\\d""#);
        assert_eq!(escape("it's"), "\"it's\"");
        assert_eq!(escape(""), "''");
        assert_eq!(escape("~/x"), "\\~/x");
        assert_eq!(escape("a#b"), "\"a#b\"");
        assert_eq!(escape("a\tb"), "a\\tb");
        assert_eq!(escape("hello"), "hello");
        for v in ["a$b\"c\\d", "it's", "", "~/x", "a#b", "a\tb", "[#{session_name}] "] { assert_eq!(unescape(&escape(v)), v) }
    }

    #[test]
    fn every_default_is_in_the_table() {
        for name in defaults().keys() { assert!(find(name).is_some(), "{name}") }
        assert_eq!(defaults().get("status-left").map(String::as_str), Some("[#{session_name}] "));
        assert_eq!(defaults().get("status-interval").map(String::as_str), Some("15"));
    }

    #[test]
    fn set_checks_as_tmux_does() {
        let mut s = Store::default();
        let g = SetFlags { global: true, ..Default::default() };
        assert_eq!(s.set("status-keys", Some("bogus"), &g, "w", 1), Err("unknown value: bogus".into()));
        assert_eq!(s.set("base-index", Some("x"), &g, "w", 1), Err("value is invalid: x".into()));
        assert_eq!(s.set("nosuch", Some("1"), &g, "w", 1), Err("invalid option: nosuch".into()));
        assert_eq!(s.set("mouse", None, &g, "w", 1), Ok(Some("on".into())));
        assert_eq!(s.format_value("mouse", "w", None).as_deref(), Some("1"));
        assert_eq!(s.set("status", None, &g, "w", 1), Ok(Some("off".into())));
        s.set("@y", Some("a"), &g, "w", 1).unwrap();
        assert_eq!(s.set("@y", Some("z"), &SetFlags { only_if_unset: true, ..g.clone() }, "w", 1), Err("already set: @y".into()));
        s.set("@y", Some("!"), &SetFlags { append: true, ..g.clone() }, "w", 1).unwrap();
        assert_eq!(s.show(Some("@y"), &g, false, false, "w", 1), Ok(vec!["@y a!".into()]));
        s.set("@y", None, &SetFlags { unset: true, ..g.clone() }, "w", 1).unwrap();
        assert_eq!(s.show(Some("@y"), &g, false, false, "w", 1), Err("invalid option: @y".into()));
        // Local to the session: not in the global list.
        s.set("@l", Some("2"), &SetFlags::default(), "w", 1).unwrap();
        assert_eq!(s.show(Some("@l"), &SetFlags::default(), false, false, "w", 1), Ok(vec!["@l 2".into()]));
        assert!(s.show(Some("@l"), &g, false, false, "w", 1).is_err());
        assert_eq!(s.show(Some("status-left"), &g, false, true, "w", 1), Ok(vec!["[#{session_name}] ".into()]));
        assert_eq!(s.show(Some("status-left"), &SetFlags::default(), false, false, "w", 1), Ok(vec![]));
    }
}
