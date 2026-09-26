//! tmux's formats, ported from tmux 3.5a's format.c: `#{…}` and its modifiers (`l: a: c: b: d: n:
//! w: q: E: T: S: W: P: L: N: C: t: m: s/// =N p e| == != < > <= >= && ||`), `#{?cond,a,b}`, `#()`
//! shell commands, `#S #W #I #P #D #F #H #T #h`, `##`, `#,`, `#}`; options, then variables, then the
//! environment, as tmux finds a name; strftime first for the formats tmux expands with the time
//! (the status line, display-message); then, when drawn, `#[…]` styles.

use std::time::{SystemTime, UNIX_EPOCH};

use ratatui::style::{Modifier, Style};
use ratatui::text::Span;
use unicode_width::UnicodeWidthChar;

use crate::app::App;
use crate::tmuxconf::colour;


/// The same for one pane (pane-border-format, list-panes -F).
pub fn spans_for_pane(app: &App, fmt: &str, window: usize, pane: u64, base: Style) -> Vec<Span<'static>> {
    draw(&expand(app, fmt, window, Some(pane), true), base)
}

/// A format expanded with the time, as display-message prints it: `#[…]` left in.
pub fn text(app: &App, fmt: &str, window: Option<usize>) -> String {
    expand(app, fmt, window.unwrap_or(app.active), None, true)
}

/// tmux's format_expand ([time]: format_expand_time) for a window and a pane.
pub fn expand(app: &App, fmt: &str, window: usize, pane: Option<u64>, time: bool) -> String {
    let mut es = Es { app, window, pane, time, nojobs: false, depth: 0, now: now_secs() };
    expand1(&mut es, fmt)
}

/// tmux's format_table, in its order: what display -a lists.
pub const TABLE_NAMES: &[&str] = &["active_window_index", "alternate_on", "alternate_saved_x", "alternate_saved_y", "buffer_created", "buffer_mode_format", "buffer_name", "buffer_sample", "buffer_size", "client_activity", "client_cell_height", "client_cell_width", "client_control_mode", "client_created", "client_discarded", "client_flags", "client_height", "client_key_table", "client_last_session", "client_mode_format", "client_name", "client_pid", "client_prefix", "client_readonly", "client_session", "client_termfeatures", "client_termname", "client_termtype", "client_tty", "client_uid", "client_user", "client_width", "client_written", "config_files", "cursor_character", "cursor_flag", "cursor_x", "cursor_y", "history_all_bytes", "history_bytes", "history_limit", "history_size", "host", "host_short", "insert_flag", "keypad_cursor_flag", "keypad_flag", "last_window_index", "mouse_all_flag", "mouse_any_flag", "mouse_button_flag", "mouse_hyperlink", "mouse_line", "mouse_pane", "mouse_sgr_flag", "mouse_standard_flag", "mouse_utf8_flag", "mouse_status_line", "mouse_status_range", "mouse_word", "mouse_x", "mouse_y", "next_session_id", "origin_flag", "pane_active", "pane_at_bottom", "pane_at_left", "pane_at_right", "pane_at_top", "pane_bg", "pane_bottom", "pane_current_command", "pane_current_path", "pane_dead", "pane_dead_signal", "pane_dead_status", "pane_dead_time", "pane_fg", "pane_format", "pane_height", "pane_id", "pane_in_mode", "pane_index", "pane_input_off", "pane_key_mode", "pane_last", "pane_left", "pane_marked", "pane_marked_set", "pane_mode", "pane_path", "pane_pid", "pane_pipe", "pane_right", "pane_search_string", "pane_start_command", "pane_start_path", "pane_synchronized", "pane_tabs", "pane_title", "pane_top", "pane_tty", "pane_unseen_changes", "pane_width", "pid", "scroll_region_lower", "scroll_region_upper", "server_sessions", "session_activity", "session_alerts", "session_attached", "session_attached_list", "session_created", "session_format", "session_group", "session_group_attached", "session_group_attached_list", "session_group_list", "session_group_many_attached", "session_group_size", "session_grouped", "session_id", "session_last_attached", "session_many_attached", "session_marked", "session_name", "session_path", "session_stack", "session_windows", "socket_path", "start_time", "tree_mode_format", "uid", "user", "version", "window_active", "window_active_clients", "window_active_clients_list", "window_active_sessions", "window_active_sessions_list", "window_activity", "window_activity_flag", "window_bell_flag", "window_bigger", "window_cell_height", "window_cell_width", "window_end_flag", "window_flags", "window_format", "window_height", "window_id", "window_index", "window_last_flag", "window_layout", "window_linked", "window_linked_sessions", "window_linked_sessions_list", "window_marked_flag", "window_name", "window_offset_x", "window_offset_y", "window_panes", "window_raw_flags", "window_silence_flag", "window_stack_index", "window_start_flag", "window_visible_layout", "window_width", "window_zoomed_flag", "wrap_flag"];

/// display -a: every variable with a value here, `name=value`, in format_table's order (those
/// with none in this context — a buffer's, a mouse event's, a dead pane's, a group's — left out),
/// then the command's name, as format_each lists them.
pub fn every(app: &App, window: usize, pane: Option<u64>) -> Vec<String> {
    let dead = pane.and_then(|p| app.panes.get(&p)).map(|p| matches!(p.phase, crate::pane::Phase::Card { .. })).unwrap_or(false);
    let skip = |n: &str| matches!(n, "buffer_created" | "buffer_name" | "buffer_sample" | "buffer_size") || (n.starts_with("mouse_") && !n.ends_with("_flag")) || (n.starts_with("pane_dead_") && !dead)
        || (n.starts_with("session_group") && n != "session_grouped") || matches!(n, "client_last_session" | "window_bigger" | "window_offset_x" | "window_offset_y" | "session_attached_list" | "window_active_clients_list" | "pane_mode");
    let mut out: Vec<String> = TABLE_NAMES.iter().filter(|n| !skip(n)).filter_map(|n| {
        let v = match table(app, n, window, pane)? { Val::Str(s) => s, Val::Time(t) => t.to_string() };
        Some(format!("{n}={v}"))
    }).collect();
    out.push("command=display-message".into());
    out
}

/// A format as a config's %if reads it: no #() jobs run (tmux's FORMAT_NOJOBS).
pub fn expand_nojobs(app: &App, fmt: &str) -> String {
    let mut es = Es { app, window: app.active, pane: app.focused(), time: true, nojobs: true, depth: 0, now: now_secs() };
    expand1(&mut es, fmt)
}

/// tmux's FORMAT_LOOP_LIMIT: formats that expand into themselves stop here.
const LOOP_LIMIT: u32 = 100;

struct Es<'a> {
    app: &'a App,
    window: usize,
    pane: Option<u64>,
    /// FORMAT_EXPAND_TIME: strftime first.
    time: bool,
    /// FORMAT_EXPAND_NOJOBS: `#()` expands to nothing (inside a `#()` command, and its output).
    nojobs: bool,
    depth: u32,
    now: i64,
}

impl<'a> Es<'a> {
    fn at(&self, window: usize, pane: Option<u64>) -> Es<'a> {
        Es { app: self.app, window, pane, time: self.time, nojobs: self.nojobs, depth: self.depth, now: self.now }
    }
}

// ── #() ─────────────────────────────────────────────────────────────────────

/// A `#()` command: its last output, and the run in flight (tmux's format_job).
#[derive(Default)]
pub struct Job { expanded: String, out: Option<String>, running: bool, started: i64, last: i64, generation: u64 }

/// The output of `cmd` (first line), running it if it is due: the first time, when its expanded
/// text changes, and every status-interval after the last run — tmux reruns a job each time the
/// status line is redrawn, which its timer does every status-interval.
fn job_get(es: &mut Es, cmd: &str) -> String {
    let app = es.app;
    let (saved_time, saved_jobs) = (es.time, es.nojobs);
    es.time = false;
    es.nojobs = true;
    let expanded = expand1(es, cmd);
    let interval: i64 = app.options.get("status-interval", "", None).and_then(|v| v.parse().ok()).unwrap_or(15);
    let now = es.now;
    let (run, out, generation) = {
        let mut jobs = app.jobs.borrow_mut();
        let job = jobs.entry(cmd.to_string()).or_default();
        let force = job.expanded != expanded;
        let due = !job.running && job.last != now && (job.generation == 0 || (interval > 0 && now - job.last >= interval));
        let run = force || due;
        if run {
            job.expanded = expanded.clone();
            job.running = true;
            job.started = now;
            job.last = now;
            job.generation += 1;
        } else if job.running && now - job.started > 1 && job.out.is_none() {
            job.out = Some(format!("<'{cmd}' not ready>"));
        }
        (run, job.out.clone(), job.generation)
    };
    if run {
        let key = cmd.to_string();
        let env = crate::ipc::job_env();
        app.spawn(async move {
            // As tmux runs one: /bin/sh -c, nothing on stdin, the client's folder; HN_SOCKET (and
            // a `tmux` that is hn) so a command inside it talks to this client.
            tokio::process::Command::new("/bin/sh").arg("-c").arg(&expanded).envs(env)
                .stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null())
                .output().await.map(|o| o.stdout).unwrap_or_default()
        }, move |app, stdout| {
            let text = String::from_utf8_lossy(&stdout);
            // The first line (tmux's evbuffer_readline), else all of it.
            let line = text.split(['\n', '\r']).next().unwrap_or("").to_string();
            let line = if text.contains(['\n', '\r']) { line } else { text.to_string() };
            if let Some(job) = app.jobs.borrow_mut().get_mut(&key) {
                if job.generation != generation { return }
                job.running = false;
                if !line.is_empty() || job.out.as_deref().map(|o| o.starts_with("<'")).unwrap_or(true) { job.out = Some(line) }
            }
        });
    }
    // The output is itself a format (a script may print `#[fg=red]`), without jobs or the time.
    let result = out.map(|o| expand1(es, &o)).unwrap_or_default();
    es.time = saved_time;
    es.nojobs = saved_jobs;
    result
}

// ── expansion (format_expand1) ─────────────────────────────────────────────

/// Where `end` (any of its bytes) first stands outside `#{…}`, skipping `#,` `##` `#{` `#}` `#:`
/// escapes (format_skip). None when it never does.
fn skip(s: &[u8], end: &[u8]) -> Option<usize> {
    let mut brackets = 0i32;
    let mut i = 0;
    while i < s.len() {
        if s[i] == b'#' && s.get(i + 1) == Some(&b'{') { brackets += 1 }
        if s[i] == b'#' && i + 1 < s.len() && b",#{}:".contains(&s[i + 1]) { i += 2; continue }
        if s[i] == b'}' { brackets -= 1 }
        if end.contains(&s[i]) && brackets == 0 { return Some(i) }
        i += 1;
    }
    None
}

/// The single-letter aliases (#S #W …).
fn alias(c: u8) -> Option<&'static str> {
    Some(match c {
        b'D' => "pane_id", b'F' => "window_flags", b'H' => "host", b'I' => "window_index", b'P' => "pane_index",
        b'S' => "session_name", b'T' => "pane_title", b'W' => "window_name", b'h' => "host_short",
        _ => return None,
    })
}

fn expand1(es: &mut Es, fmt: &str) -> String {
    if fmt.is_empty() || es.depth >= LOOP_LIMIT { return String::new() }
    es.depth += 1;
    let timed;
    let fmt = if es.time && fmt.contains('%') { timed = strftime(es.app, fmt, es.now); timed.as_str() } else { fmt };
    let b = fmt.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    let mut style_end: Option<usize> = None;
    while i < b.len() {
        if b[i] != b'#' {
            let len = utf8_len(b[i]);
            out.push_str(&fmt[i..(i + len).min(b.len())]);
            i += len;
            continue;
        }
        let Some(&ch) = b.get(i + 1) else { out.push('#'); break };
        let hash = i;
        i += 2;
        match ch {
            b'(' => {
                let mut depth = 1;
                let mut j = i;
                while j < b.len() {
                    if b[j] == b'(' { depth += 1 }
                    if b[j] == b')' { depth -= 1; if depth == 0 { break } }
                    j += 1;
                }
                if j >= b.len() { break }
                let name = &fmt[i..j];
                let value = if es.nojobs { String::new() } else { job_get(es, name) };
                out.push_str(&value);
                i = j + 1;
            }
            b'{' => {
                let Some(k) = skip(&b[hash..], b"}") else { break };
                let end = hash + k;
                match replace(es, &fmt[i..end]) { Some(v) => out.push_str(&v), None => break }
                i = end + 1;
            }
            b'[' | b'#' => {
                // `#[` and `##[` (and more #s): a style, left for drawing; ## alone is a #.
                let mut ptr = if ch == b'[' { i - 1 } else { i };
                let mut n = if ch == b'[' { 1 } else { 2 };
                while ptr < b.len() && b[ptr] == b'#' { ptr += 1; n += 1 }
                if ptr < b.len() && b[ptr] == b'[' {
                    style_end = skip(&b[hash..], b"]").map(|k| hash + k);
                    out.push_str(&fmt[hash..hash + n + 1]);
                    i = ptr + 1;
                } else {
                    out.push(ch as char);
                }
            }
            b'}' | b',' => out.push(ch as char),
            _ => {
                let name = if style_end.map(|e| i > e).unwrap_or(true) { alias(ch) } else { None };
                match name {
                    Some(name) => match replace(es, name) { Some(v) => out.push_str(&v), None => break },
                    None => {
                        out.push('#');
                        // Not an ASCII letter: the character goes out whole, from its first byte.
                        if ch < 0x80 { out.push(ch as char) } else { i -= 1 }
                    }
                }
            }
        }
    }
    es.depth -= 1;
    out
}

fn utf8_len(b: u8) -> usize { match b { 0x00..=0x7f => 1, 0xc0..=0xdf => 2, 0xe0..=0xef => 3, 0xf0..=0xf7 => 4, _ => 1 } }

// ── modifiers (format_build_modifiers, format_replace) ──────────────────────

struct Mod { m: String, argv: Vec<String> }

fn is_end(c: Option<&u8>) -> bool { matches!(c, Some(b';') | Some(b':')) }

/// The `mod;mod:` list at the front of a `#{…}` body, and where the rest starts. None when the
/// body has no modifiers.
fn build_modifiers(es: &mut Es, s: &str) -> Option<(Vec<Mod>, usize)> {
    let b = s.as_bytes();
    let mut cp = 0;
    let mut list = Vec::new();
    while cp < b.len() && b[cp] != b':' {
        if b[cp] == b';' { cp += 1 }
        let Some(&c0) = b.get(cp) else { break };
        let c1 = b.get(cp + 1);
        if b"labcdnwETSWPL<>".contains(&c0) && is_end(c1) {
            list.push(Mod { m: (c0 as char).to_string(), argv: vec![] });
            cp += 1;
            continue;
        }
        if cp + 2 <= b.len() && matches!(&b[cp..cp + 2], b"||" | b"&&" | b"!=" | b"==" | b"<=" | b">=") && is_end(b.get(cp + 2)) {
            list.push(Mod { m: s[cp..cp + 2].to_string(), argv: vec![] });
            cp += 2;
            continue;
        }
        if !b"mCNst=peq".contains(&c0) { break }
        if is_end(c1) {
            list.push(Mod { m: (c0 as char).to_string(), argv: vec![] });
            cp += 1;
            continue;
        }
        let Some(&c1) = c1 else { break };
        if !c1.is_ascii_punctuation() || c1 == b'-' {
            // One argument, no wrapper: `=21`, `p-8`.
            let Some(end) = skip(&b[cp + 1..], b":;").map(|k| cp + 1 + k) else { break };
            let arg = expand1(es, &s[cp + 1..end]);
            list.push(Mod { m: (c0 as char).to_string(), argv: vec![arg] });
            cp = end;
            continue;
        }
        // Several, wrapped: `s/a/b/`, `=/5/…/`, `e|+|f|2|`.
        let last = [c1, b';', b':'];
        cp += 1;
        let mut argv = Vec::new();
        loop {
            if b.get(cp) == Some(&c1) && is_end(b.get(cp + 1)) { cp += 1; break }
            let Some(end) = skip(&b[cp + 1..], &last).map(|k| cp + 1 + k) else { break };
            cp += 1;
            argv.push(expand1(es, &s[cp..end]));
            cp = end;
            if is_end(b.get(cp)) { break }
        }
        list.push(Mod { m: (c0 as char).to_string(), argv });
    }
    if b.get(cp) != Some(&b':') { return None }
    Some((list, cp + 1))
}

#[derive(Default)]
struct Flags { literal: bool, character: bool, colour: bool, basename: bool, dirname: bool, length: bool, width: bool, timestring: bool, pretty: bool, quote_shell: bool, quote_style: bool, expand: bool, expandtime: bool, window_name: bool, session_name: bool, sessions: bool, windows: bool, panes: bool, clients: bool }

/// One `#{…}` body; None when it fails (tmux then stops the whole expansion there).
fn replace(es: &mut Es, key: &str) -> Option<String> {
    let (list, off) = build_modifiers(es, key).unwrap_or_default();
    let copy = &key[off..];
    let mut f = Flags::default();
    let (mut cmp, mut search, mut subs, mut mexp): (Option<&Mod>, Option<&Mod>, Vec<&Mod>, Option<&Mod>) = (None, None, Vec::new(), None);
    let (mut limit, mut marker, mut width, mut time_format) = (0i64, None::<String>, 0i64, None::<String>);
    for fm in &list {
        match fm.m.as_str() {
            "m" | "<" | ">" => cmp = Some(fm),
            "C" => search = Some(fm),
            "s" => { if fm.argv.len() >= 2 { subs.push(fm) } }
            "=" => { if let Some(a) = fm.argv.first() { limit = a.trim().parse().unwrap_or(0); marker = fm.argv.get(1).cloned() } }
            "p" => { if let Some(a) = fm.argv.first() { width = a.trim().parse().unwrap_or(0) } }
            "w" => f.width = true,
            "e" => { if (1..=3).contains(&fm.argv.len()) { mexp = Some(fm) } }
            "l" => f.literal = true,
            "a" => f.character = true,
            "b" => f.basename = true,
            "c" => f.colour = true,
            "d" => f.dirname = true,
            "n" => f.length = true,
            "t" => {
                f.timestring = true;
                if let Some(a) = fm.argv.first() {
                    if a.contains('p') { f.pretty = true } else if fm.argv.len() >= 2 && a.contains('f') { time_format = Some(strip(&fm.argv[1])) }
                }
            }
            "q" => { if fm.argv.is_empty() { f.quote_shell = true } else if fm.argv[0].contains('e') || fm.argv[0].contains('h') { f.quote_style = true } }
            "E" => f.expand = true,
            "T" => f.expandtime = true,
            "N" => { if fm.argv.is_empty() || fm.argv[0].contains('w') { f.window_name = true } else if fm.argv[0].contains('s') { f.session_name = true } }
            "S" => f.sessions = true,
            "W" => f.windows = true,
            "P" => f.panes = true,
            "L" => f.clients = true,
            "||" | "&&" | "==" | "!=" | ">=" | "<=" => cmp = Some(fm),
            _ => {}
        }
    }
    let mut value = if f.literal {
        unescape(copy)
    } else if f.character {
        let n = expand1(es, copy);
        n.trim_start().parse::<i64>().ok().filter(|c| (32..=126).contains(c)).map(|c| (c as u8 as char).to_string()).unwrap_or_default()
    } else if f.colour {
        let n = expand1(es, copy);
        colour_hex(&n).unwrap_or_default()
    } else if f.sessions || f.clients {
        // One session, one client (this one).
        let mut next = es.at(es.app.active, None);
        let v = expand1(&mut next, copy);
        v
    } else if f.windows {
        let (all, active) = match choose(es, copy, false) { Some((a, b)) => (a, Some(b)), None => (copy.to_string(), None) };
        let mut v = String::new();
        for w in 0..es.app.tabs.len() {
            let use_ = if w == es.app.active { active.as_deref().unwrap_or(&all) } else { &all };
            let mut next = es.at(w, None);
            v.push_str(&expand1(&mut next, use_));
        }
        v
    } else if f.panes {
        let (all, active) = match choose(es, copy, false) { Some((a, b)) => (a, Some(b)), None => (copy.to_string(), None) };
        let tab = es.app.tabs.get(es.window);
        let focus = tab.and_then(|t| t.focus);
        let mut v = String::new();
        for p in tab.map(|t| t.panes()).unwrap_or_default() {
            let use_ = if Some(p) == focus { active.as_deref().unwrap_or(&all) } else { &all };
            let mut next = es.at(es.window, Some(p));
            v.push_str(&expand1(&mut next, use_));
        }
        v
    } else if f.window_name {
        let name = expand1(es, copy);
        if es.app.tabs.iter().any(|t| t.name == name) { "1".into() } else { "0".into() }
    } else if f.session_name {
        let name = expand1(es, copy);
        if es.app.session_name() == name { "1".into() } else { "0".into() }
    } else if let Some(fm) = search {
        let term = expand1(es, copy);
        search_pane(es, fm, &term)
    } else if let Some(fm) = cmp {
        let (left, right) = choose(es, copy, true)?;
        let t = |b: bool| if b { "1".to_string() } else { "0".to_string() };
        match fm.m.as_str() {
            "||" => t(truthy(&left) || truthy(&right)),
            "&&" => t(truthy(&left) && truthy(&right)),
            "==" => t(left == right),
            "!=" => t(left != right),
            "<" => t(left < right),
            ">" => t(left > right),
            "<=" => t(left <= right),
            ">=" => t(left >= right),
            _ => matches(fm, &left, &right),
        }
    } else if let Some(rest) = copy.strip_prefix('?') {
        let k = skip(rest.as_bytes(), b",")?;
        let condition = &rest[..k];
        let found = match find(es, condition, &f, time_format.as_deref()) {
            Some(v) => v,
            // Not a name: expanded; if that changes nothing, false.
            None => { let v = expand1(es, condition); if v == condition { String::new() } else { v } }
        };
        let (left, right) = choose(es, &rest[k + 1..], false)?;
        if truthy(&found) { expand1(es, &left) } else { expand1(es, &right) }
    } else if let Some(fm) = mexp {
        expression(es, fm, copy).unwrap_or_default()
    } else if copy.contains("#{") {
        expand1(es, copy)
    } else {
        find(es, copy, &f, time_format.as_deref()).unwrap_or_default()
    };
    if f.expand { value = expand1(es, &value) }
    else if f.expandtime { let saved = es.time; es.time = true; value = expand1(es, &value); es.time = saved }
    for fm in subs {
        let (pat, with) = (expand1(es, &fm.argv[0]), expand1(es, &fm.argv[1]));
        let icase = fm.argv.get(2).map(|a| a.contains('i')).unwrap_or(false);
        if let Some(v) = regsub(&pat, &with, &value, icase) { value = v }
    }
    if limit > 0 {
        let new = trim_left(&value, limit as usize);
        value = match &marker { Some(m) if new != value => format!("{new}{m}"), _ => new };
    } else if limit < 0 {
        let new = trim_right(&value, limit.unsigned_abs() as usize);
        value = match &marker { Some(m) if new != value => format!("{m}{new}"), _ => new };
    }
    if width > 0 { value = pad(&value, width as usize, false) } else if width < 0 { value = pad(&value, width.unsigned_abs() as usize, true) }
    if f.length { value = value.len().to_string() }
    if f.width { value = format_width(&value).to_string() }
    Some(value)
}

/// `a,b`: the two sides at the first comma outside `#{…}`, expanded when asked (format_choose).
fn choose(es: &mut Es, s: &str, expand: bool) -> Option<(String, String)> {
    let k = skip(s.as_bytes(), b",")?;
    let (l, r) = (&s[..k], &s[k + 1..]);
    Some(if expand { (expand1(es, l), expand1(es, r)) } else { (l.to_string(), r.to_string()) })
}

fn truthy(v: &str) -> bool { !v.is_empty() && v != "0" }

/// A name's value: an option, a variable, else the environment (format_find), with b: d: q: t:.
fn find(es: &mut Es, key: &str, f: &Flags, time_format: Option<&str>) -> Option<String> {
    let app = es.app;
    let window_id = app.tabs.get(es.window).map(|t| t.id.clone()).unwrap_or_default();
    let mut found = app.options.format_value(key, &window_id, es.pane);
    let mut t: i64 = 0;
    if found.is_none() {
        match table(app, key, es.window, es.pane) {
            Some(Val::Time(v)) => t = v,
            Some(Val::Str(v)) => found = Some(v),
            None => {
                // format_find: the session's environment, then the global one.
                if !f.timestring { found = app.session_env.get(key).or_else(|| app.global_env.get(key)).and_then(|e| e.value.clone()) }
                found.as_ref()?;
            }
        }
    }
    if f.timestring {
        if t == 0 { t = found.as_deref().and_then(|v| v.trim().parse().ok()).unwrap_or(0) }
        if t == 0 { return None }
        return Some(if f.pretty { pretty_time(app, t, es.now) } else if let Some(tf) = time_format { strftime(app, tf, t) } else { strftime(app, "%a %b %e %H:%M:%S %Y", t) });
    }
    let mut v = if t != 0 { t.to_string() } else { found? };
    if f.basename { v = basename(&v) }
    if f.dirname { v = dirname(&v) }
    if f.quote_shell { v = v.chars().map(|c| if "|&;<>()$`\\\"'*?[# =%".contains(c) { format!("\\{c}") } else { c.to_string() }).collect() }
    if f.quote_style { v = v.replace('#', "##") }
    Some(v)
}

fn basename(p: &str) -> String {
    if p.is_empty() { return ".".into() }
    let t = p.trim_end_matches('/');
    if t.is_empty() { return "/".into() }
    t.rsplit('/').next().unwrap_or(t).to_string()
}

fn dirname(p: &str) -> String {
    let t = p.trim_end_matches('/');
    if t.is_empty() { return if p.starts_with('/') { "/".into() } else { ".".into() } }
    match t.rfind('/') {
        None => ".".into(),
        Some(i) => { let d = t[..i].trim_end_matches('/'); if d.is_empty() { "/".into() } else { d.to_string() } }
    }
}

/// `#{l:…}`: the text as written, its `#,` `##` `#{` `#}` `#:` escapes undone outside `#{…}`.
fn unescape(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    let (mut out, mut brackets, mut i) = (String::new(), 0i32, 0);
    while i < b.len() {
        if b[i] == '#' && b.get(i + 1) == Some(&'{') { brackets += 1 }
        if brackets == 0 && b[i] == '#' && b.get(i + 1).map(|c| ",#{}:".contains(*c)).unwrap_or(false) { out.push(b[i + 1]); i += 2; continue }
        if b[i] == '}' { brackets -= 1 }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// The escapes of a time format taken out (format_strip).
fn strip(s: &str) -> String {
    let b: Vec<char> = s.chars().collect();
    let (mut out, mut brackets, mut i) = (String::new(), 0i32, 0);
    while i < b.len() {
        if b[i] == '#' && b.get(i + 1) == Some(&'{') { brackets += 1 }
        if b[i] == '#' && b.get(i + 1).map(|c| ",#{}:".contains(*c)).unwrap_or(false) { if brackets != 0 { out.push('#') } i += 1; continue }
        if b[i] == '}' { brackets -= 1 }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// `#{m:pattern,text}`: fnmatch, or with /r a regular expression; /i ignores case.
fn matches(fm: &Mod, pattern: &str, text: &str) -> String {
    let flags = fm.argv.first().map(String::as_str).unwrap_or("");
    let icase = flags.contains('i');
    let hit = if flags.contains('r') {
        regex::RegexBuilder::new(pattern).case_insensitive(icase).build().map(|r| r.is_match(text)).unwrap_or(false)
    } else if icase { glob(&pattern.to_lowercase(), &text.to_lowercase()) } else { glob(pattern, text) };
    if hit { "1".into() } else { "0".into() }
}

/// fnmatch(3): `*`, `?`, `[…]` (and `[!…]`), `\` quoting.
fn glob(pat: &str, s: &str) -> bool {
    fn m(p: &[char], t: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') => (0..=t.len()).any(|i| m(&p[1..], &t[i..])),
            Some('?') => !t.is_empty() && m(&p[1..], &t[1..]),
            Some('[') => {
                let Some(close) = p.iter().skip(2).position(|c| *c == ']').map(|k| k + 2) else { return t.first() == Some(&'[') && m(&p[1..], &t[1..]) };
                let Some(&c) = t.first() else { return false };
                let set = &p[1..close];
                let (neg, set) = if matches!(set.first(), Some('!' | '^')) { (true, &set[1..]) } else { (false, set) };
                let mut hit = false;
                let mut i = 0;
                while i < set.len() {
                    if i + 2 < set.len() && set[i + 1] == '-' { if set[i] <= c && c <= set[i + 2] { hit = true } i += 3 } else { if set[i] == c { hit = true } i += 1 }
                }
                hit != neg && m(&p[close + 1..], &t[1..])
            }
            Some('\\') if p.len() > 1 => t.first() == Some(&p[1]) && m(&p[2..], &t[1..]),
            Some(c) => t.first() == Some(c) && m(&p[1..], &t[1..]),
        }
    }
    let (p, t): (Vec<char>, Vec<char>) = (pat.chars().collect(), s.chars().collect());
    m(&p, &t)
}

/// `#{C:text}`: the line of the pane's screen it is on, from 1; 0 when it is not there.
fn search_pane(es: &Es, fm: &Mod, term: &str) -> String {
    let flags = fm.argv.first().map(String::as_str).unwrap_or("");
    let tab = es.app.tabs.get(es.window);
    let Some(pane) = es.pane.or_else(|| tab.and_then(|t| t.focus)).and_then(|p| es.app.panes.get(&p)) else { return "0".into() };
    let icase = flags.contains('i');
    let re = if flags.contains('r') { regex::RegexBuilder::new(term).case_insensitive(icase).build().ok() } else { None };
    for (i, line) in pane.text_range(Some(0), None).lines().enumerate() {
        let hit = match &re { Some(r) => r.is_match(line), None => if icase { glob(&format!("*{}*", term.to_lowercase()), &line.to_lowercase()) } else { glob(&format!("*{term}*"), line) } };
        if hit { return (i + 1).to_string() }
    }
    "0".into()
}

/// `#{e|op|f|prec:a,b}`: arithmetic and comparisons, whole numbers unless `f`.
fn expression(es: &mut Es, fm: &Mod, copy: &str) -> Option<String> {
    let op = fm.argv.first()?.as_str();
    if !["+", "-", "*", "/", "%", "m", "==", "!=", ">", "<", ">=", "<="].contains(&op) { return None }
    let fp = fm.argv.get(1).map(|a| a.contains('f')).unwrap_or(false);
    let mut prec: usize = if fp { 2 } else { 0 };
    if let Some(p) = fm.argv.get(2) { prec = p.trim().parse().ok()? }
    let (l, r) = choose(es, copy, true)?;
    let num = |s: &str| -> Option<f64> { if s.is_empty() { Some(0.0) } else { s.trim_start().parse::<f64>().ok() } };
    let (mut a, mut b) = (num(&l)?, num(&r)?);
    if !fp { a = a.trunc(); b = b.trunc() }
    let t = |x: bool| if x { 1.0 } else { 0.0 };
    let v = match op {
        "+" => a + b, "-" => a - b, "*" => a * b, "/" => a / b, "%" | "m" => a % b,
        "==" => t((a - b).abs() < 1e-9), "!=" => t((a - b).abs() > 1e-9),
        ">" => t(a > b), "<" => t(a < b), ">=" => t(a >= b), _ => t(a <= b),
    };
    Some(if fp { format!("{v:.prec$}") } else { format!("{:.prec$}", v.trunc()) })
}

/// tmux's regsub: every match replaced; `\0`–`\9` in the replacement are the groups.
fn regsub(pattern: &str, with: &str, text: &str, icase: bool) -> Option<String> {
    if text.is_empty() { return Some(String::new()) }
    let re = regex::RegexBuilder::new(pattern).case_insensitive(icase).build().ok()?;
    let (mut start, mut last, end) = (0usize, 0usize, text.len());
    let mut empty = false;
    let mut buf = String::new();
    while start <= end {
        let Some(caps) = re.captures(&text[start..]) else { buf.push_str(&text[start..end]); break };
        let m0 = caps.get(0)?;
        let (so, eo) = (m0.start(), m0.end());
        buf.push_str(&text[last..start + so]);
        if empty || start + so != last || so != eo {
            let mut it = with.chars().peekable();
            while let Some(c) = it.next() {
                if c == '\\' {
                    match it.next() {
                        Some(d) if d.is_ascii_digit() => {
                            let g = d.to_digit(10).unwrap_or(0) as usize;
                            match caps.get(g) { Some(m) if !m.as_str().is_empty() => buf.push_str(m.as_str()), _ => buf.push(d) }
                        }
                        Some(o) => buf.push(o),
                        None => {}
                    }
                } else { buf.push(c) }
            }
            last = start + eo;
            start += eo;
            empty = false;
        } else {
            last = start + eo;
            // One character on, whole.
            start += eo + text[start + eo..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
            empty = true;
        }
        if pattern.starts_with('^') { if start < end { buf.push_str(&text[start..end]) } break }
    }
    Some(buf)
}

// ── widths: `#[…]` takes no room, `##` is one # (format-draw.c) ──────────────

/// How many #s lead here, the cells they take, and whether a style follows.
fn hashes(b: &[char], i: usize) -> (usize, usize, bool) {
    let mut n = 0;
    while b.get(i + n) == Some(&'#') { n += 1 }
    if b.get(i + n) != Some(&'[') { return (n, n.div_ceil(2), false) }
    (n, n / 2, n % 2 == 1)
}

fn format_width(s: &str) -> usize {
    let b: Vec<char> = s.chars().collect();
    let (mut i, mut w) = (0, 0);
    while i < b.len() {
        if b[i] == '#' {
            let (n, cells, style) = hashes(&b, i);
            w += cells;
            i += n;
            if style { i -= 1; i = style_close(&b, i) }
        } else {
            let c = b[i];
            if (c as u32) >= 0x20 { w += c.width().unwrap_or(0) }
            i += 1;
        }
    }
    w
}

/// Past the `]` of the style whose `#` is at `i`.
/// format_skip for a terminator: its index in characters, #{…} and escapes passed over.
pub fn skip_to(s: &str, end: char) -> Option<usize> {
    let mut buf = [0u8; 4];
    let k = skip(s.as_bytes(), end.encode_utf8(&mut buf).as_bytes())?;
    Some(s[..k].chars().count())
}

fn style_close(b: &[char], i: usize) -> usize {
    let s: String = b[i..].iter().collect();
    match skip(s.as_bytes(), b"]") { Some(k) => i + s[..k].chars().count() + 1, None => b.len() }
}

/// The first `limit` cells, styles kept (format_trim_left).
fn trim_left(s: &str, limit: usize) -> String {
    let b: Vec<char> = s.chars().collect();
    let (mut i, mut w, mut out) = (0, 0, String::new());
    while i < b.len() && w < limit {
        if b[i] == '#' {
            let (n, cells, style) = hashes(&b, i);
            let take = cells.min(limit - w);
            if take > 0 { if n == 1 { out.push('#') } else { out.push_str(&"#".repeat(2 * take)) } w += take }
            i += n;
            if style { i -= 1; let e = style_close(&b, i); out.extend(&b[i..e]); i = e }
        } else {
            let c = b[i];
            let cw = if (c as u32) >= 0x20 { c.width().unwrap_or(0) } else { 0 };
            if w + cw <= limit { out.push(c) }
            w += cw;
            i += 1;
        }
    }
    out
}

/// The last `limit` cells, styles kept (format_trim_right).
fn trim_right(s: &str, limit: usize) -> String {
    let total = format_width(s);
    if total <= limit { return s.to_string() }
    let skip_cells = total - limit;
    let b: Vec<char> = s.chars().collect();
    let (mut i, mut w, mut out) = (0, 0, String::new());
    while i < b.len() {
        if b[i] == '#' {
            let (n, cells, style) = hashes(&b, i);
            let mut copy = cells;
            if w <= skip_cells { copy = if skip_cells - w >= copy { 0 } else { copy - (skip_cells - w) } }
            if copy > 0 { if n == 1 { out.push('#') } else { out.push_str(&"#".repeat(2 * copy)) } }
            w += cells;
            i += n;
            if style { i -= 1; let e = style_close(&b, i); out.extend(&b[i..e]); i = e }
        } else {
            let c = b[i];
            let cw = if (c as u32) >= 0x20 { c.width().unwrap_or(0) } else { 0 };
            if w >= skip_cells { out.push(c) }
            w += cw;
            i += 1;
        }
    }
    out
}

/// Padded to `width` cells with spaces: after the text, or before it ([left]).
fn pad(s: &str, width: usize, left: bool) -> String {
    let w: usize = s.chars().map(|c| c.width().unwrap_or(0)).sum();
    if w >= width { return s.to_string() }
    let fill = " ".repeat(width - w);
    if left { format!("{fill}{s}") } else { format!("{s}{fill}") }
}

/// `#{c:red}`: the colour as six hex digits (tmux's 256-colour palette for the numbered ones).
fn colour_hex(name: &str) -> Option<String> {
    use ratatui::style::Color;
    let n: u8 = match colour(name)? {
        Color::Rgb(r, g, b) => return Some(format!("{r:02x}{g:02x}{b:02x}")),
        Color::Indexed(i) => i,
        Color::Black => 0, Color::Red => 1, Color::Green => 2, Color::Yellow => 3, Color::Blue => 4, Color::Magenta => 5, Color::Cyan => 6, Color::Gray => 7,
        Color::DarkGray => 8, Color::LightRed => 9, Color::LightGreen => 10, Color::LightYellow => 11, Color::LightBlue => 12, Color::LightMagenta => 13, Color::LightCyan => 14, Color::White => 15,
        Color::Reset => return None,
    };
    const BASE: [u32; 16] = [0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff];
    let rgb = if n < 16 { BASE[n as usize] } else if n < 232 {
        let i = n as u32 - 16;
        let step = |v: u32| if v == 0 { 0 } else { 55 + v * 40 };
        (step(i / 36) << 16) | (step((i / 6) % 6) << 8) | step(i % 6)
    } else { let g = 8 + (n as u32 - 232) * 10; (g << 16) | (g << 8) | g };
    Some(format!("{rgb:06x}"))
}

// ── drawing: `#[…]` styles, `##` (format_draw) ─────────────────────────────

/// An expanded format as styled spans: `#[…]` changes the style, `##` is a #.
pub fn draw(s: &str, base: Style) -> Vec<Span<'static>> {
    let b: Vec<char> = s.chars().collect();
    let mut out: Vec<Span<'static>> = Vec::new();
    let mut run = String::new();
    let mut style = base;
    let mut ignore = false;
    let mut i = 0;
    while i < b.len() {
        if b[i] == '#' && b.get(i + 1) != Some(&'[') && i + 1 < b.len() {
            let mut n = 1;
            while b.get(i + n) == Some(&'#') { n += 1 }
            let even = n % 2 == 0;
            if b.get(i + n) != Some(&'[') {
                run.push_str(&"#".repeat(if even { n / 2 } else { n / 2 + 1 }));
                i += n;
                continue;
            }
            run.push_str(&"#".repeat(n / 2));
            if even { run.push('['); i += n + 1 } else { i += n - 1 }
            continue;
        }
        if b[i] == '#' && b.get(i + 1) == Some(&'[') {
            let e = style_close(&b, i);
            let spec: String = b[(i + 2).min(e)..e.saturating_sub(1).max(i + 2)].iter().collect();
            if !run.is_empty() { out.push(Span::styled(std::mem::take(&mut run), style)) }
            for part in spec.split([',', ' ']) { match part { "ignore" => ignore = true, "noignore" => ignore = false, _ => {} } }
            style = restyle(style, base, &spec);
            i = e;
            continue;
        }
        if !ignore && (b[i] as u32) >= 0x20 && b[i] != '\u{7f}' { run.push(b[i]) }
        i += 1;
    }
    if !run.is_empty() { out.push(Span::styled(run, style)) }
    out
}

// ── time ────────────────────────────────────────────────────────────────────

pub fn now_secs() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) }

/// When this client started, in seconds since the epoch.
fn started(app: &App) -> i64 { now_secs() - app.started.elapsed().as_secs() as i64 }

/// localtime(3): a time's parts in this computer's zone, for the date the time is on (its DST).
fn local_tm(t: i64) -> libc::tm {
    // SAFETY: localtime_r only writes the struct it is given.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let tt = t as libc::time_t;
    unsafe { libc::localtime_r(&tt, &mut tm) };
    tm
}

/// strftime(3) itself, over a whole format, as tmux runs it first (its 8192-byte buffer: a longer
/// result, or an empty one, is nothing).
fn strftime(_app: &App, fmt: &str, t: i64) -> String {
    let tm = local_tm(t);
    let Ok(cfmt) = std::ffi::CString::new(fmt) else { return fmt.to_string() };
    let mut buf = vec![0u8; 8192];
    // SAFETY: the buffer's length is passed, and strftime writes at most that.
    let n = unsafe { libc::strftime(buf.as_mut_ptr() as *mut libc::c_char, buf.len(), cfmt.as_ptr(), &tm) };
    buf.truncate(n);
    String::from_utf8_lossy(&buf).into_owned()
}

/// `#{t/p:…}`: tmux's short form — the time today, the day this month, the date this year.
fn pretty_time(app: &App, t: i64, now: i64) -> String {
    let now = now.max(t);
    let age = now - t;
    let (n, w) = (local_tm(now), local_tm(t));
    let (ny, nm, y, m) = (n.tm_year, n.tm_mon, w.tm_year, w.tm_mon);
    if age < 24 * 3600 { return strftime(app, "%H:%M", t) }
    if (y == ny && m == nm) || age < 28 * 24 * 3600 { return strftime(app, "%a%d", t) }
    if (y == ny && m < nm) || (y == ny - 1 && m > nm) { return strftime(app, "%d%b", t) }
    strftime(app, "%h%y", t)
}

enum Val { Str(String), Time(i64) }

/// A pane's tile in its window's layout, in the client's cells (title row included).
fn tab_rect(app: &App, window: usize, pane: u64) -> Option<ratatui::layout::Rect> {
    if window == app.active { if let Some((_, r)) = app.rects.iter().find(|(id, _)| *id == pane) { return Some(*r) } }
    let mut out = Vec::new();
    app.tabs.get(window)?.root.as_ref()?.rects(app.body(), &mut out);
    out.into_iter().find(|(id, _)| *id == pane).map(|(_, r)| r)
}

/// tmux's #{pane_title}: what select-pane -T set, or the program (OSC 0/2) when allow-set-title
/// is on (hn's default is off: a harness's name is its title), else the harness's name.
pub fn pane_title(app: &App, window: usize, pane: u64) -> String {
    let Some(p) = app.panes.get(&pane) else { return crate::app::hostname() };
    let tab_id = app.tabs.get(window).map(|t| t.id.clone()).unwrap_or_default();
    if !p.osc_title.is_empty() && app.options.get("allow-set-title", &tab_id, Some(pane)).as_deref() == Some("on") { return p.osc_title.clone() }
    if !p.title.is_empty() { return p.title.clone() }
    app.fleet.agent(&p.machine_id, &p.agent_id).map(|a| a.name.clone()).unwrap_or_else(|| p.agent_id.chars().take(8).collect())
}

/// The pane's own cells, from its window's top-left corner: tmux's pane_left/top/width/height.
pub fn content_rect(app: &App, window: usize, pane: u64) -> Option<ratatui::layout::Rect> {
    let r = tab_rect(app, window, pane)?;
    let body = app.body();
    let c = app.content_of(app.tabs.get(window)?, r);
    Some(ratatui::layout::Rect { x: c.x - body.x, y: c.y - body.y, width: c.width, height: c.height })
}

/// tmux's format table: a variable's value for a window (and a pane: else the window's active
/// one), or None when there is no such variable. Times are seconds since the epoch.
fn table(app: &App, name: &str, window: usize, pane_id: Option<u64>) -> Option<Val> {
    let tab = app.tabs.get(window);
    // list-commands -F's.
    if let Some((n, a, u)) = &app.format_command {
        match name { "command_list_name" => return Some(Val::Str(n.clone())), "command_list_alias" => return Some(Val::Str(a.clone())), "command_list_usage" => return Some(Val::Str(u.clone())), _ => {} }
    }
    // A paste buffer's (list-buffers -F, choose-buffer).
    if let Some(b) = app.format_buffer.as_ref().and_then(|n| app.paste.get(n)) {
        match name {
            "buffer_name" => return Some(Val::Str(b.name.clone())),
            "buffer_size" => return Some(Val::Str(b.data.len().to_string())),
            "buffer_sample" => return Some(Val::Str(crate::paste::sample(b))),
            "buffer_created" => return Some(Val::Time(b.created)),
            _ => {}
        }
    }
    // No window (a target tmux could not find): its window and pane have nothing to say.
    if tab.is_none() && (name.starts_with("window_") || name.starts_with("pane_")) { return Some(Val::Str(String::new())) }
    let focus = pane_id.or_else(|| tab.and_then(|t| t.focus));
    let pane = focus.and_then(|f| app.panes.get(&f));
    let agent = pane.and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id));
    let host = crate::app::hostname();
    let v: String = match name {
        "session_name" => app.session_name(),
        "window_index" => tab.map(|_| app.win_num(window).to_string()).unwrap_or_default(),
        "window_name" => tab.map(|t| t.name.clone()).unwrap_or_default(),
        "window_flags" => flags(app, window),
        "window_raw_flags" => flags(app, window),
        "window_active" => (window == app.active).then_some("1").unwrap_or("0").into(),
        "window_last_flag" => (tab.map(|t| app.last_tab.as_ref() == Some(&t.id)).unwrap_or(false)).then_some("1").unwrap_or("0").into(),
        "window_zoomed_flag" => (tab.map(|t| t.zoomed).unwrap_or(false)).then_some("1").unwrap_or("0").into(),
        "window_panes" => tab.map(|t| t.panes().len().to_string()).unwrap_or_default(),
        "window_bell_flag" => flags(app, window).contains('!').then_some("1").unwrap_or("0").into(),
        "pane_active" => (focus == tab.and_then(|t| t.focus)).then_some("1").unwrap_or("0").into(),
        "pane_index" => focus.and_then(|f| tab.and_then(|t| t.panes().iter().position(|p| *p == f))).map(|i| (i + app.pane_base_index).to_string()).unwrap_or_default(),
        "pane_title" => focus.map(|f| pane_title(app, window, f)).unwrap_or_else(|| host.clone()),
        "pane_id" => focus.map(|f| format!("%{f}")).unwrap_or_default(),
        // What tmux on the pane's machine says (terminal_info), then what the shell said (OSC 7),
        // then where the harness started.
        "pane_current_path" => pane.and_then(|p| p.live_path.clone().or_else(|| p.cwd.clone())).or_else(|| agent.map(|a| a.cwd.clone())).unwrap_or_default(),
        "pane_current_command" => pane.and_then(|p| p.fg_command.clone()).or_else(|| agent.map(|a| a.engine.clone())).unwrap_or_default(),
        "pane_pid" => pane.and_then(|p| p.remote_pid).map(|n| n.to_string()).unwrap_or_default(),
        "pane_tty" => pane.and_then(|p| p.remote_tty.clone()).unwrap_or_default(),
        // The pane's cells in its window, its title row not among them (tmux's pane_* with
        // pane-border-status top): any window's, not only the one on screen.
        "pane_width" | "pane_height" | "pane_left" | "pane_top" | "pane_right" | "pane_bottom" => {
            let Some(r) = focus.and_then(|f| content_rect(app, window, f)) else { return Some(Val::Str(String::new())) };
            match name { "pane_width" => r.width, "pane_height" => r.height, "pane_left" => r.x, "pane_top" => r.y, "pane_right" => r.x + r.width.saturating_sub(1), _ => (r.y + r.height).saturating_sub(1) }.to_string()
        }
        "pane_in_mode" => pane.map(|p| p.copy.is_some()).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        "session_windows" => app.tabs.len().to_string(),
        "session_attached" => "1".into(),
        "client_width" => app.size.0.to_string(),
        "client_height" => app.size.1.to_string(),
        "window_width" => app.body().width.to_string(),
        "window_height" => app.body().height.to_string(),
        // At an edge of the window (vim-tmux-navigator style configs ask).
        "pane_at_top" | "pane_at_bottom" | "pane_at_left" | "pane_at_right" => {
            let body = app.body();
            let r = focus.and_then(|f| tab_rect(app, window, f));
            r.map(|r| match name { "pane_at_top" => r.y <= body.y, "pane_at_bottom" => r.y + r.height >= body.y + body.height, "pane_at_left" => r.x <= body.x, _ => r.x + r.width >= body.x + body.width })
                .map(|b| if b { "1" } else { "0" }.to_string()).unwrap_or_default()
        }
        "window_layout" | "window_visible_layout" => tab.and_then(|t| t.root.as_ref()).map(|r| r.to_tmux()).unwrap_or_default(),
        "history_size" => pane.map(|p| { use alacritty_terminal::grid::Dimensions; p.term.grid().history_size().to_string() }).unwrap_or_default(),
        "history_limit" => crate::pane::HISTORY.load(std::sync::atomic::Ordering::Relaxed).to_string(),
        // format_cb_history_bytes: what the pane's lines take — its cells (five bytes each, as
        // tmux's grid_cell_entry) and a line's own bookkeeping.
        "history_bytes" => pane.map(|p| {
            use alacritty_terminal::grid::Dimensions;
            let g = p.term.grid();
            let lines = g.history_size() + g.screen_lines();
            (lines * g.columns() * 5 + lines * 48).to_string()
        }).unwrap_or_default(),
        "line" => app.format_line.map(|n| n.to_string()).unwrap_or_default(),
        "uid" | "client_uid" => unsafe { libc::getuid() }.to_string(),
        "client_user" | "user" => { let pw = unsafe { libc::getpwuid(libc::getuid()) }; if pw.is_null() { String::new() } else { unsafe { std::ffi::CStr::from_ptr((*pw).pw_name) }.to_string_lossy().into_owned() } }
        "pane_marked" => (focus.is_some() && app.marked == focus).then_some("1").unwrap_or("0").into(),
        "pane_marked_set" => app.marked.is_some().then_some("1").unwrap_or("0").into(),
        "window_id" => tab.map(|t| format!("@{}", t.wid)).unwrap_or_default(),
        "pane_synchronized" => tab.map(|t| t.sync).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        // The tmux level hn speaks (version-gated configs ask); hn's own is #{hn_version}.
        "version" => crate::tmuxconf::TMUX_VERSION.into(),
        "hn_version" => env!("CARGO_PKG_VERSION").into(),
        "pid" => std::process::id().to_string(),
        "socket_path" => crate::ipc::here().map(|p| p.display().to_string()).unwrap_or_default(),
        "client_session" => app.session_name(),
        "client_name" | "client_tty" => crate::app::tty_name(),
        "pane_mode" => pane.filter(|p| p.copy.is_some()).map(|_| "copy-mode").unwrap_or("").into(),
        "copy_cursor_x" => pane.and_then(|p| p.copy).map(|c| c.point.column.0.to_string()).unwrap_or_default(),
        "copy_cursor_y" => pane.and_then(|p| p.copy.map(|c| (c.point.line.0 + p.scrolled() as i32).to_string())).unwrap_or_default(),
        "copy_cursor_line" => pane.map(|p| p.copy_line()).unwrap_or_default(),
        "copy_cursor_word" => pane.map(|p| p.copy_word_under(&app.options.get("word-separators", "", None).unwrap_or_default())).unwrap_or_default(),
        "selection_present" => pane.and_then(|p| p.copy).map(|c| if c.selecting { "1" } else { "0" }.to_string()).unwrap_or_default(),
        "scroll_position" => pane.map(|p| p.scrolled().to_string()).unwrap_or_default(),
        "pane_search_string" => app.last_search.clone().unwrap_or_default(),
        "client_prefix" => app.prefix.then_some("1").unwrap_or("0").into(),
        "host" => host,
        "host_short" => host.split('.').next().unwrap_or("").to_string(),
        // Harness's own: the machine a pane is on, and how many harnesses wait on you.
        "machine" => pane.map(|p| app.fleet.machine_name(&p.machine_id)).unwrap_or_default(),
        "waiting" => app.fleet.waiting().to_string(),
        // tim's face, for a status-right of your own: "#{tim} %H:%M".
        // tim's face, in its own colour (a status-right of your own: "#{tim} %H:%M").
        "tim" => crate::tim::face(app).map(|(f, st)| { let s = crate::draw::style_text(st); if s.is_empty() { f } else { format!("#[{s}]{f}#[default]") } }).unwrap_or_default(),
        "daemon_down" => app.daemon_down.then_some("1").unwrap_or("0").into(),
        // The pane is another window's to type in (this one watches), when it is the only one.
        "pane_watching" => (pane.map(|p| matches!(p.phase, crate::pane::Phase::Watching(_))).unwrap_or(false) && tab.map(|t| t.panes().len() < 2).unwrap_or(false)).then_some("1").unwrap_or("0").into(),
        "pane_machine" => pane.map(|p| app.fleet.machine_name(&p.machine_id)).unwrap_or_default(),
        "pane_far" => pane.map(|p| p.machine_id != app.fleet.local_id).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        "session_id" => "$0".into(),
        "session_path" => std::env::current_dir().map(|d| d.display().to_string()).unwrap_or_default(),
        "session_group" | "client_last_session" | "pane_dead_status" | "pane_start_command" => String::new(),
        "pane_input_off" => pane.map(|p| p.input_off).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        "session_grouped" | "session_many_attached" | "window_linked" | "window_bigger" | "window_offset_x" | "window_offset_y"
        | "window_activity_flag" | "window_silence_flag" | "client_readonly" | "pane_pipe" => "0".into(),
        "server_sessions" | "session_attached_list" | "client_utf8" => "1".into(),
        "window_start_flag" => (window == 0).then_some("1").unwrap_or("0").into(),
        "window_end_flag" => (window.checked_add(1) == Some(app.tabs.len())).then_some("1").unwrap_or("0").into(),
        "client_termname" => std::env::var("TERM").unwrap_or_default(),
        "client_pid" => std::process::id().to_string(),
        "client_key_table" => app.key_table.clone().unwrap_or_else(|| if app.prefix { "prefix".into() } else { "root".into() }),
        "client_flags" => if app.terminal_focused { "attached,focused,UTF-8".into() } else { "attached,UTF-8".into() },
        "pane_last" => (focus.is_some() && focus == tab.and_then(|t| t.last_focus())).then_some("1").unwrap_or("0").into(),
        "pane_dead" => pane.map(|p| matches!(p.phase, crate::pane::Phase::Card { .. })).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        "pane_start_path" => agent.map(|a| a.cwd.clone()).unwrap_or_default(),
        "alternate_on" => pane.map(|p| p.mode().contains(alacritty_terminal::term::TermMode::ALT_SCREEN)).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        // The pane's terminal modes, as tmux keeps them (MODE_INSERT, MODE_KCURSOR …).
        "insert_flag" | "keypad_cursor_flag" | "keypad_flag" | "origin_flag" | "wrap_flag" | "cursor_flag"
        | "mouse_standard_flag" | "mouse_button_flag" | "mouse_all_flag" | "mouse_any_flag" | "mouse_sgr_flag" | "mouse_utf8_flag" => {
            use alacritty_terminal::term::TermMode as M;
            let m = pane?.mode();
            let on = match name {
                "insert_flag" => m.contains(M::INSERT), "keypad_cursor_flag" => m.contains(M::APP_CURSOR), "keypad_flag" => m.contains(M::APP_KEYPAD),
                "origin_flag" => m.contains(M::ORIGIN), "wrap_flag" => m.contains(M::LINE_WRAP), "cursor_flag" => m.contains(M::SHOW_CURSOR),
                "mouse_standard_flag" => m.contains(M::MOUSE_REPORT_CLICK), "mouse_button_flag" => m.contains(M::MOUSE_DRAG), "mouse_all_flag" => m.contains(M::MOUSE_MOTION),
                "mouse_any_flag" => m.intersects(M::MOUSE_REPORT_CLICK | M::MOUSE_DRAG | M::MOUSE_MOTION), "mouse_sgr_flag" => m.contains(M::SGR_MOUSE), _ => m.contains(M::UTF8_MOUSE),
            };
            if on { "1".into() } else { "0".into() }
        }
        "cursor_character" => pane.map(|p| { let c = p.term.grid().cursor.point; p.term.grid()[c].c }).map(|c| if c == '\0' { " ".to_string() } else { c.to_string() }).unwrap_or_default(),
        "scroll_region_upper" => pane.map(|_| "0".to_string()).unwrap_or_default(),
        "scroll_region_lower" => pane.map(|p| { use alacritty_terminal::grid::Dimensions; p.term.grid().screen_lines().saturating_sub(1).to_string() }).unwrap_or_default(),
        "pane_tabs" => pane.map(|p| { use alacritty_terminal::grid::Dimensions; (1..).map(|i| i * 8).take_while(|x| *x < p.term.grid().columns()).map(|x| x.to_string()).collect::<Vec<_>>().join(",") }).unwrap_or_default(),
        "history_all_bytes" => pane.map(|p| {
            use alacritty_terminal::grid::Dimensions;
            let g = p.term.grid();
            let lines = g.history_size() + g.screen_lines();
            let cells: usize = (0..lines).map(|i| { let row = &g[alacritty_terminal::index::Line(i as i32 - g.history_size() as i32)]; (0..g.columns()).rev().find(|x| { let c = row[alacritty_terminal::index::Column(*x)].c; c != ' ' && c != '\0' }).map(|x| x + 1).unwrap_or(0) }).sum();
            format!("{lines},{},{cells},{},0,0", lines * 40, cells * 5)
        }).unwrap_or_default(),
        "pane_key_mode" => pane.map(|_| "VT10x".to_string()).unwrap_or_default(),
        "alternate_saved_x" | "alternate_saved_y" => pane.map(|_| "0".to_string()).unwrap_or_default(),
        "pane_unseen_changes" => pane.map(|_| "0".to_string()).unwrap_or_default(),
        "window_marked_flag" => tab.map(|t| app.marked.map(|m| t.panes().contains(&m)).unwrap_or(false)).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        "pane_fg" | "pane_bg" => pane.map(|_| "default".to_string()).unwrap_or_default(),
        "pane_path" => pane.and_then(|p| p.cwd.clone()).unwrap_or_default(),
        "pane_format" => (pane_id.is_some() || focus.is_some()).then_some("1").unwrap_or("0").into(),
        "window_format" | "session_format" | "session_marked" => "0".into(),
        "active_window_index" => app.win_num(app.active).to_string(),
        "last_window_index" => (0..app.tabs.len()).map(|i| app.win_num(i)).max().map(|n| n.to_string()).unwrap_or_default(),
        "next_session_id" => "$1".into(),
        "buffer_mode_format" => "#{t/p:buffer_created}: #{buffer_sample}".into(),
        "client_mode_format" => "#{t/p:client_activity}: session #{session_name}".into(),
        "tree_mode_format" => "#{?pane_format,#{?pane_marked,#[reverse],}#{pane_current_command}#{?pane_active,*,}#{?pane_marked,M,}#{?#{&&:#{pane_title},#{!=:#{pane_title},#{host_short}}},: \"#{pane_title}\",},#{?window_format,#{?window_marked_flag,#[reverse],}#{window_name}#{window_flags}#{?#{&&:#{==:#{window_panes},1},#{&&:#{pane_title},#{!=:#{pane_title},#{host_short}}}},: \"#{pane_title}\",},#{session_windows} windows#{?session_grouped, (group #{session_group}: #{session_group_list}),}#{?session_attached, (attached),}}}".into(),
        "config_files" => app.config_files.join(","),
        "session_alerts" => String::new(),
        // The session's windows in the order they were last current (the current first).
        "session_stack" => { let mut v = vec![app.win_num(app.active)]; if let Some(l) = app.last_tab.as_ref().and_then(|id| app.tabs.iter().position(|t| &t.id == id)) { v.push(app.win_num(l)) } v.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(",") }
        "window_stack_index" => (if window == app.active { "0" } else if tab.map(|t| app.last_tab.as_ref() == Some(&t.id)).unwrap_or(false) { "1" } else { "0" }).into(),
        "window_active_clients" => (window == app.active).then_some("1").unwrap_or("0").into(),
        "window_active_sessions" => "1".into(),
        "window_active_sessions_list" | "window_linked_sessions_list" => app.session_name(),
        "window_linked_sessions" => "1".into(),
        "window_cell_width" | "window_cell_height" | "client_cell_width" | "client_cell_height" => "0".into(),
        "cursor_x" | "cursor_y" => pane.map(|p| { let c = p.term.grid().cursor.point; if name == "cursor_x" { c.column.0.to_string() } else { c.line.0.to_string() } }).unwrap_or_default(),
        // Times: when this client started, and when a window last had something happen.
        "session_created" | "session_last_attached" | "client_created" | "start_time" => return Some(Val::Time(started(app))),
        "session_activity" | "client_activity" => return Some(Val::Time(now_secs())),
        "window_activity" => {
            let last = tab.map(|t| t.panes()).unwrap_or_default().iter().filter_map(|id| app.panes.get(id)).filter_map(|p| app.fleet.agent(&p.machine_id, &p.agent_id)).map(|a| (a.active_at / 1000) as i64).max();
            return Some(Val::Time(last.filter(|t| *t > 0).unwrap_or_else(|| started(app))));
        }
        _ => return None,
    };
    Some(Val::Str(v))
}


/// `#{window_flags}`: `*` current, `-` last, `!` waiting on you, `#` finished, `Z` zoomed.
pub fn flags(app: &App, window: usize) -> String {
    let Some(tab) = app.tabs.get(window) else { return String::new() };
    // tmux's order: alerts (# !), then * or -, then Z.
    let mut out = String::new();
    let (mut bell, mut activity) = (false, false);
    for id in tab.panes() {
        let Some(agent) = app.panes.get(&id).and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id)) else { continue };
        match app.fleet.state_of(agent) { crate::fleet::State::NeedsInput => bell = true, crate::fleet::State::Done => activity = true, _ => {} }
    }
    if activity && !bell { out.push('#') }
    if bell { out.push('!') }
    if window == app.active { out.push('*') } else if app.last_tab.as_ref() == Some(&tab.id) { out.push('-') }
    if tab.zoomed { out.push('Z') }
    out
}


/// `#[fg=colour136,bg=default,bold,nobold,reverse,default]`.
fn restyle(mut style: Style, base: Style, spec: &str) -> Style {
    for part in spec.split([',', ' ']).filter(|p| !p.is_empty()) {
        match part {
            "default" => style = base,
            "bold" | "bright" => style = style.add_modifier(Modifier::BOLD),
            "nobold" | "nobright" => style = style.remove_modifier(Modifier::BOLD),
            "dim" => style = style.add_modifier(Modifier::DIM),
            "nodim" => style = style.remove_modifier(Modifier::DIM),
            "italics" => style = style.add_modifier(Modifier::ITALIC),
            "noitalics" => style = style.remove_modifier(Modifier::ITALIC),
            "underscore" => style = style.add_modifier(Modifier::UNDERLINED),
            "nounderscore" => style = style.remove_modifier(Modifier::UNDERLINED),
            "reverse" => style = style.add_modifier(Modifier::REVERSED),
            "noreverse" => style = style.remove_modifier(Modifier::REVERSED),
            "blink" => style = style.add_modifier(Modifier::SLOW_BLINK),
            "noblink" => style = style.remove_modifier(Modifier::SLOW_BLINK),
            "hidden" => style = style.add_modifier(Modifier::HIDDEN),
            "nohidden" => style = style.remove_modifier(Modifier::HIDDEN),
            "strikethrough" => style = style.add_modifier(Modifier::CROSSED_OUT),
            "nostrikethrough" => style = style.remove_modifier(Modifier::CROSSED_OUT),
            "double-underscore" | "curly-underscore" | "dotted-underscore" | "dashed-underscore" => style = style.add_modifier(Modifier::UNDERLINED),
            "none" => style = Style { add_modifier: Modifier::empty(), sub_modifier: Modifier::all(), ..style },
            p => {
                if let Some(c) = p.strip_prefix("fg=") { style = match c { "default" => style.fg(base.fg.unwrap_or(ratatui::style::Color::Reset)), c => colour(c).map(|c| style.fg(c)).unwrap_or(style) } }
                if let Some(c) = p.strip_prefix("bg=") { style = match c { "default" => style.bg(base.bg.unwrap_or(ratatui::style::Color::Reset)), c => colour(c).map(|c| style.bg(c)).unwrap_or(style) } }
            }
        }
    }
    style
}
