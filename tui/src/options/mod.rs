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
pub enum Kind { Flag, Number(i64, i64), Choice(&'static [&'static str]), String, Colour, Key, Command }

pub struct Opt { pub name: &'static str, pub scope: Scope, pub pane: bool, pub kind: Kind, pub array: bool }

/// The table's entry for `name` (or `name[3]`).
pub fn find(name: &str) -> Option<&'static Opt> {
    let base = name.split('[').next().unwrap_or(name);
    table::TABLE.iter().chain(table::HOOKS.iter()).find(|o| o.name == base)
}

/// A hook (set-hook's, show-hooks'), not an option.
pub fn is_hook(name: &str) -> bool { let base = name.split('[').next().unwrap_or(name); table::HOOKS.iter().any(|o| o.name == base) }

/// Where options_array_assign splits a value into items: the table's separator (" ," when it
/// has none); a hook's is empty, so its value is one item.
fn separator(base: &str) -> &'static str {
    match base {
        "command-alias" | "terminal-overrides" | "terminal-features" | "user-keys" => ",",
        b if is_hook(b) => "",
        _ => " ,",
    }
}

/// A name and its index: `status-format[1]` → (`status-format`, Some(1)).
fn split_index(name: &str) -> (&str, Option<usize>) {
    match name.split_once('[') { Some((b, rest)) => (b, rest.strip_suffix(']').and_then(|n| n.parse().ok())), None => (name, None) }
}

/// A layer holds an array (all of it, however few items — tmux's options_array_clear leaves an
/// empty array there, not the defaults) when it has the array's own name as a key.
fn holds(map: &BTreeMap<String, String>, base: &str) -> bool { map.contains_key(base) }

/// An array's items in a layer, in index order.
fn items(map: &BTreeMap<String, String>, base: &str) -> Vec<(usize, String)> {
    let prefix = format!("{base}[");
    let mut v: Vec<(usize, String)> = map.iter().filter_map(|(k, val)| k.strip_prefix(&prefix).and_then(|r| r.strip_suffix(']')).and_then(|n| n.parse().ok()).map(|n| (n, val.clone()))).collect();
    v.sort_by_key(|(n, _)| *n);
    v
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
        // The status line: tmux's, with what Harness adds — the name reversed while the prefix
        // waits; on the right, harnesses waiting on you, the focused pane's machine (a far one, as
        // scp writes it: gpu-box:ml-lab), project and branch (as zsh's robbyrussell prompt writes
        // them) where tmux has the pane's title (in the pane's own title row here), tim, the clock;
        // a space first, so a full window list never runs into it.
        m.insert("status-left".into(), "#{?client_prefix,#[reverse],}[#{session_name}]#{?client_prefix,#[noreverse],} ".into());
        m.insert("status-right".into(), " #{?daemon_down,#[reverse]daemon down#[noreverse] ,}#{?#{>:#{waiting},0},#[reverse]#{waiting} waiting#[noreverse] ,}#{?pane_watching,[watching] ,}#{?pane_far,#{pane_machine}#{?pane_project,:, },}#{?pane_project,#{=/16/…:pane_project} ,}#{?pane_branch,git:(#{=/24/…:pane_branch}) ,}#{?#{tim},#{tim} ,}%H:%M".into());
        // Each window's most urgent harness at a glance (the symbol its pane titles show) and its
        // name in a few whole words (#{window_short_name}): a harness is named for its task.
        for name in ["window-status-format", "window-status-current-format"] {
            m.insert(name.into(), "#I:#{?window_agent_icon,#{window_agent_icon} ,}#{window_short_name}#{?window_flags,#{window_flags}, }".into());
        }
        // A session is a machine, named as the machine is (tmux's are 0, 1, …): room for its name.
        m.insert("status-left-length".into(), "24".into());
        m.insert("status-right-length".into(), "60".into());
        // Agents print a lot: ten thousand lines of scrollback (tmux keeps two).
        m.insert("history-limit".into(), "10000".into());
        // A harness's name is its pane's title; a program's own (OSC 2) only if you say so.
        m.insert("allow-set-title".into(), "off".into());
        // The mouse on: clicks choose panes and windows, the wheel scrolls (tmux's mouse keys).
        m.insert("mouse".into(), "on".into());
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
    /// A global array option's items in index order (command-alias, update-environment): the
    /// defaults, as set over them.
    pub fn array(&self, name: &str) -> Vec<String> {
        for m in [&self.server, &self.global_session, &self.global_window] { if holds(m, name) { return items(m, name).into_iter().map(|(_, v)| v).collect() } }
        items(defaults(), name).into_iter().map(|(_, v)| v).collect()
    }

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
        // An array's item: from the nearest layer holding the array (none there is none).
        if find(name).map(|o| o.array).unwrap_or(false) {
            let (base, index) = split_index(name);
            index?;
            return match layers.into_iter().flatten().find(|m| holds(m, base)) { Some(m) => m.get(name).cloned(), None => defaults().get(name).cloned() };
        }
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
        let array = opt.map(|o| o.array).unwrap_or(false);
        let (base, index) = split_index(name);
        // An array changed in a layer is all there: the global one starts from tmux's defaults
        // (its items), another from nothing.
        if array && (!f.unset || index.is_some()) {
            let from: Vec<(usize, String)> = if global { items(defaults(), base) } else { Vec::new() };
            let map = self.map_mut(scope, global, window, pane);
            if !holds(map, base) {
                map.insert(base.to_string(), String::new());
                for (i, v) in from { map.insert(format!("{base}[{i}]"), v); }
            }
        }
        if f.unset {
            let map = self.map_mut(scope, global, window, pane);
            match (array, index) {
                // The whole array: back to what is further out (tmux's defaults, globally).
                (true, None) => { map.remove(base); map.retain(|k, _| !k.starts_with(&format!("{base}["))); }
                _ => { map.remove(name); }
            }
            return Ok(self.get(name, window, Some(pane)));
        }
        // cmd_set_option: a user option needs a value.
        if name.starts_with('@') && value.is_none() { return Err("empty value".into()) }
        let here = self.map(scope, global, window, pane).and_then(|m| m.get(name).cloned());
        if f.only_if_unset && here.is_some() { return Err(format!("already set: {name}")) }
        let now = self.get(name, window, Some(pane));
        let new = match (opt.map(|o| o.kind), value) {
            // A user option, or a string: as given (appended with -a).
            (None | Some(Kind::String) | Some(Kind::Command), v) => {
                let v = v.unwrap_or("");
                if array {
                    if value.is_none() { return Err("empty value".into()) }
                    let map = self.map_mut(scope, global, window, pane);
                    match index {
                        // options_array_assign: the value split at the array's separator, each
                        // piece at the next free index — after the items there with -a, else in
                        // place of them.
                        None => {
                            if !f.append { map.retain(|k, _| !k.starts_with(&format!("{base}["))) }
                            let sep = separator(base);
                            let pieces: Vec<&str> = if sep.is_empty() { vec![v] } else { v.split(|c| sep.contains(c)).collect() };
                            for piece in pieces.into_iter().filter(|p| !p.is_empty()) {
                                let n = (0..).find(|i| !map.contains_key(&format!("{base}[{i}]"))).unwrap_or(0);
                                map.insert(format!("{base}[{n}]"), piece.to_string());
                            }
                        }
                        // options_array_set: that item (-a adds to a string's).
                        Some(i) => {
                            let key = format!("{base}[{i}]");
                            let v = if f.append && opt.map(|o| !matches!(o.kind, Kind::Command)).unwrap_or(true) { format!("{}{v}", map.get(&key).cloned().unwrap_or_default()) } else { v.to_string() };
                            map.insert(key, v);
                        }
                    }
                    return Ok(Some(v.to_string()));
                }
                let v = if f.append { format!("{}{v}", here.clone().or(now.clone()).unwrap_or_default()) } else { v.to_string() };
                // options_from_string_check: a style option's value must parse as a style (formats aside).
                if name.ends_with("-style") && !v.contains("#{") && !crate::draw::valid_style(&v) { return Err(format!("invalid style: {v}")) }
                v
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

    /// Every option of a scope in force globally: tmux's defaults (its hooks empty arrays), then
    /// what was set with -g.
    fn global_rows(&self, scope: Scope) -> BTreeMap<String, String> {
        let in_scope = |o: &Opt| match scope { Scope::Server => o.scope == Scope::Server, Scope::Session => o.scope == Scope::Session, Scope::Window => matches!(o.scope, Scope::Window | Scope::Pane), Scope::Pane => false };
        let mut rows: BTreeMap<String, String> = defaults().iter().filter(|(k, _)| find(k).map(in_scope).unwrap_or(false)).map(|(k, v)| (k.clone(), v.clone())).collect();
        for h in table::HOOKS.iter().filter(|o| in_scope(o)) { rows.insert(h.name.to_string(), String::new()); }
        if let Some(map) = self.map(scope, true, "", 0) { overlay(&mut rows, map) }
        rows
    }

    /// `show-options`: the lines tmux prints for these flags (every option in the scope, or `name`).
    /// [inherited] (-A) adds the values in force from further out, marked `*`.
    pub fn show(&self, name: Option<&str>, f: &SetFlags, inherited: bool, values_only: bool, which: Which, window: &str, pane: u64) -> Result<Vec<String>, String> {
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
        // cmd_show_options_all's order: user options by name, then the table's (the options,
        // then the hooks), an array's items by index — its own name alone only while it is empty.
        let rank = |k: &str| {
            let (base, idx) = split_index(k);
            let item = idx.map(|i| i + 1).unwrap_or(0);
            if base.starts_with('@') { return (0, 0, 0, k.to_string()) }
            match table::TABLE.iter().position(|o| o.name == base) {
                Some(p) => (1, p, item, String::new()),
                None => (2, table::HOOKS.iter().position(|o| o.name == base).unwrap_or(usize::MAX), item, String::new()),
            }
        };
        let empty = |k: &str| find(k).map(|o| o.array).unwrap_or(false) && !k.contains('[') && !rows.keys().any(|r| r.starts_with(&format!("{k}[")));
        let shown = |k: &str| (find(k).map(|o| o.array).unwrap_or(false) && !k.contains('[')).then(|| empty(k)).unwrap_or(true) && !(values_only && empty(k));
        let mut keys: Vec<&String> = rows.keys().collect();
        keys.sort_by_key(|k| rank(k));
        let mut out = Vec::new();
        match name {
            Some(n) => {
                let base = n.split('[').next().unwrap_or(n);
                let hits: Vec<&String> = keys.into_iter().filter(|k| (k.as_str() == n || (!n.contains('[') && k.starts_with(&format!("{base}[")))) && shown(k)).collect();
                // A user option nobody set does not exist; tmux's own just has no value here.
                if hits.is_empty() && (n.starts_with('@') || find(n).is_none()) { return Err(format!("invalid option: {n}")) }
                for k in hits { let (v, inh) = &rows[k]; out.push(line(k, v, *inh, values_only)) }
            }
            None => for k in keys {
                let hook = is_hook(k);
                if (which == Which::Options && hook) || (which == Which::Hooks && !hook) || !shown(k) { continue }
                let (v, inh) = &rows[k];
                out.push(line(k, v, *inh, values_only))
            },
        }
        Ok(out)
    }
}

/// Values set over a list: an array a layer holds replaces the list's items of that array.
fn overlay(rows: &mut BTreeMap<String, String>, map: &BTreeMap<String, String>) {
    let arrays: std::collections::HashSet<&str> = map.keys().filter_map(|k| { let (b, i) = split_index(k); (i.is_some() || find(b).map(|o| o.array).unwrap_or(false)).then_some(b) }).collect();
    for a in arrays { rows.retain(|r, _| r != a && !r.starts_with(&format!("{a}["))) }
    for (k, v) in map { rows.insert(k.clone(), v.clone()); }
}

/// What `show` lists: a scope's options (show-options), with its hooks (-H), or its hooks
/// (show-hooks).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Which { Options, All, Hooks }

fn line(name: &str, value: &str, inherited: bool, values_only: bool) -> String {
    let star = if inherited { "*" } else { "" };
    if values_only { return value.to_string() }
    if value.is_empty() && find(name).map(|o| o.array).unwrap_or(false) && !name.contains('[') { return format!("{name}{star}") }
    // A hook's commands print as commands (cmd_list_print), not as a quoted string.
    if find(name).map(|o| matches!(o.kind, Kind::Command)).unwrap_or(false) { return format!("{name}{star} {value}") }
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
    let all: Vec<char> = s.chars().collect();
    for (i, &c) in all.iter().enumerate() {
        match c {
            '\t' => esc.push_str("\\t"),
            '\n' => esc.push_str("\\n"),
            '\r' => esc.push_str("\\r"),
            '\\' => esc.push_str("\\\\"),
            '"' if quotes == Some('"') => { esc.push('\\'); esc.push(c) }
            // utf8_strvis: a `$` a variable could follow ($HOME, $_x, ${x}) is escaped, another not.
            '$' if quotes == Some('"') && all.get(i + 1).map(|n| n.is_ascii_alphabetic() || *n == '_' || *n == '{').unwrap_or(false) => { esc.push('\\'); esc.push(c) }
            // vis(3) VIS_CSTYLE: the C escapes by name, \0 (\000 before an octal digit), else octal.
            '\x07' => esc.push_str("\\a"),
            '\x08' => esc.push_str("\\b"),
            '\x0b' => esc.push_str("\\v"),
            '\x0c' => esc.push_str("\\f"),
            '\0' => esc.push_str(if all.get(i + 1).map(|n| ('0'..='7').contains(n)).unwrap_or(false) { "\\000" } else { "\\0" }),
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
        // tmux's own default, in the fixture; hn's status-left adds the prefix's reverse.
        assert!(include_str!("../../tests/fixtures/tmux-3.5a-options.txt").contains("session status-left \"[#{session_name}] \""));
        assert_eq!(defaults().get("status-left").map(String::as_str), Some("#{?client_prefix,#[reverse],}[#{session_name}]#{?client_prefix,#[noreverse],} "));
        assert_eq!(defaults().get("status-interval").map(String::as_str), Some("15"));
    }

    #[test]
    fn arrays_and_hooks_as_tmux_keeps_them() {
        let mut s = Store::default();
        let g = SetFlags { global: true, ..Default::default() };
        let ga = SetFlags { global: true, append: true, ..Default::default() };
        // -a: split at the array's separator, after the defaults; the leading comma is no item.
        s.set("terminal-overrides", Some(",xterm-256color:Tc"), &ga, "w", 1).unwrap();
        assert_eq!(s.array("terminal-overrides"), vec!["linux*:AX@".to_string(), "xterm-256color:Tc".to_string()]);
        // A plain set replaces them all; an empty one leaves an empty array, not the defaults.
        s.set("command-alias", Some("x=y"), &g, "w", 1).unwrap();
        assert_eq!(s.array("command-alias"), vec!["x=y".to_string()]);
        s.set("command-alias", Some(""), &g, "w", 1).unwrap();
        assert!(s.array("command-alias").is_empty());
        assert_eq!(s.show(Some("command-alias"), &g, false, false, Which::Options, "w", 1), Ok(vec!["command-alias".into()]));
        // -u: back to the defaults.
        s.set("command-alias", None, &SetFlags { global: true, unset: true, ..Default::default() }, "w", 1).unwrap();
        assert_eq!(s.array("command-alias").len(), 6);
        // Hooks: arrays of commands, one item per set (no separator), listed by show-hooks.
        s.set("after-new-window", Some("display-message a"), &ga, "w", 1).unwrap();
        s.set("after-new-window", Some("display-message b, c"), &ga, "w", 1).unwrap();
        assert_eq!(s.show(Some("after-new-window"), &g, false, false, Which::Hooks, "w", 1), Ok(vec!["after-new-window[0] display-message a".into(), "after-new-window[1] display-message b, c".into()]));
        let hooks = s.show(None, &g, false, false, Which::Hooks, "w", 1).unwrap();
        assert_eq!(hooks.len(), 56);
        assert_eq!(hooks[0], "after-bind-key");
        assert!(s.show(None, &g, false, false, Which::Options, "w", 1).unwrap().iter().all(|l| !l.starts_with("after-")));
    }

    #[test]
    fn show_lists_in_tmux_order() {
        let s = Store::default();
        let w = SetFlags { global: true, window: true, ..Default::default() };
        let rows = s.show(None, &w, false, false, Which::Options, "w", 1).unwrap();
        assert_eq!(rows.iter().take(3).map(|r| r.split(' ').next().unwrap_or("")).collect::<Vec<_>>(), vec!["cursor-colour", "cursor-style", "menu-style"]);
    }

    #[test]
    fn set_checks_as_tmux_does() {
        let mut s = Store::default();
        let g = SetFlags { global: true, ..Default::default() };
        assert_eq!(s.set("status-keys", Some("bogus"), &g, "w", 1), Err("unknown value: bogus".into()));
        assert_eq!(s.set("base-index", Some("x"), &g, "w", 1), Err("value is invalid: x".into()));
        assert_eq!(s.set("nosuch", Some("1"), &g, "w", 1), Err("invalid option: nosuch".into()));
        // A flag with no value toggles (hn's mouse is on to begin with).
        assert_eq!(s.set("mouse", None, &g, "w", 1), Ok(Some("off".into())));
        assert_eq!(s.format_value("mouse", "w", None).as_deref(), Some("0"));
        assert_eq!(s.set("status", None, &g, "w", 1), Ok(Some("off".into())));
        s.set("@y", Some("a"), &g, "w", 1).unwrap();
        assert_eq!(s.set("@y", Some("z"), &SetFlags { only_if_unset: true, ..g.clone() }, "w", 1), Err("already set: @y".into()));
        s.set("@y", Some("!"), &SetFlags { append: true, ..g.clone() }, "w", 1).unwrap();
        assert_eq!(s.show(Some("@y"), &g, false, false, Which::Options, "w", 1), Ok(vec!["@y a!".into()]));
        s.set("@y", None, &SetFlags { unset: true, ..g.clone() }, "w", 1).unwrap();
        assert_eq!(s.show(Some("@y"), &g, false, false, Which::Options, "w", 1), Err("invalid option: @y".into()));
        // Local to the session: not in the global list.
        s.set("@l", Some("2"), &SetFlags::default(), "w", 1).unwrap();
        assert_eq!(s.show(Some("@l"), &SetFlags::default(), false, false, Which::Options, "w", 1), Ok(vec!["@l 2".into()]));
        assert!(s.show(Some("@l"), &g, false, false, Which::Options, "w", 1).is_err());
        assert_eq!(s.show(Some("status-interval"), &g, false, true, Which::Options, "w", 1), Ok(vec!["15".into()]));
        assert_eq!(s.show(Some("status-interval"), &SetFlags::default(), false, false, Which::Options, "w", 1), Ok(vec![]));
    }
}
