//! tmux's formats, ported from tmux 3.5a's format.c: `#{…}` and its modifiers (`l: a: c: b: d: n:
//! w: q: E: T: S: W: P: L: N: C: t: m: s/// =N p e| == != < > <= >= && ||`), `#{?cond,a,b}`, `#()`
//! shell commands, `#S #W #I #P #D #F #H #T #h`, `##`, `#,`, `#}`; options, then variables, then the
//! environment, as tmux finds a name; strftime first for the formats tmux expands with the time
//! (the status line, display-message); then, when drawn, `#[…]` styles.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
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
    match window {
        Some(w) => expand(app, fmt, w, None, true),
        None => match app.current() { Some((w, p)) => expand(app, fmt, w, Some(p), true), None => expand(app, fmt, app.active, None, true) },
    }
}

/// tmux's format_expand ([time]: format_expand_time) for a window and a pane.
pub fn expand(app: &App, fmt: &str, window: usize, pane: Option<u64>, time: bool) -> String {
    let mut es = Es { app, window, pane, time, nojobs: false, depth: 0, now: now_secs(), session: None, window_of: None, format_type: None, trace: None, values: Rc::default() };
    expand1(&mut es, fmt)
}

/// display-message -v prints the expansion decisions as tmux's FORMAT_VERBOSE does.
pub fn verbose(app: &App, fmt: &str, window: usize, pane: Option<u64>) -> (String, Vec<String>) {
    let trace = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let mut es = Es { app, window, pane, time: true, nojobs: false, depth: 0, now: now_secs(), session: None, window_of: None, format_type: None, trace: Some(trace.clone()), values: Rc::default() };
    let out = expand1(&mut es, fmt);
    let lines = trace.borrow().clone();
    (out, lines)
}

/// tmux's format_table, in its order: what display -a lists.
pub const TABLE_NAMES: &[&str] = &["active_window_index", "alternate_on", "alternate_saved_x", "alternate_saved_y", "buffer_created", "buffer_mode_format", "buffer_name", "buffer_sample", "buffer_size", "client_activity", "client_cell_height", "client_cell_width", "client_control_mode", "client_created", "client_discarded", "client_flags", "client_height", "client_key_table", "client_last_session", "client_mode_format", "client_name", "client_pid", "client_prefix", "client_readonly", "client_session", "client_termfeatures", "client_termname", "client_termtype", "client_tty", "client_uid", "client_user", "client_width", "client_written", "config_files", "cursor_character", "cursor_flag", "cursor_x", "cursor_y", "history_all_bytes", "history_bytes", "history_limit", "history_size", "host", "host_short", "insert_flag", "keypad_cursor_flag", "keypad_flag", "last_window_index", "mouse_all_flag", "mouse_any_flag", "mouse_button_flag", "mouse_hyperlink", "mouse_line", "mouse_pane", "mouse_sgr_flag", "mouse_standard_flag", "mouse_utf8_flag", "mouse_status_line", "mouse_status_range", "mouse_word", "mouse_x", "mouse_y", "next_session_id", "origin_flag", "pane_active", "pane_at_bottom", "pane_at_left", "pane_at_right", "pane_at_top", "pane_bg", "pane_bottom", "pane_current_command", "pane_current_path", "pane_dead", "pane_dead_signal", "pane_dead_status", "pane_dead_time", "pane_fg", "pane_format", "pane_height", "pane_id", "pane_in_mode", "pane_index", "pane_input_off", "pane_key_mode", "pane_last", "pane_left", "pane_marked", "pane_marked_set", "pane_mode", "pane_path", "pane_pid", "pane_pipe", "pane_right", "pane_search_string", "pane_start_command", "pane_start_path", "pane_synchronized", "pane_tabs", "pane_title", "pane_top", "pane_tty", "pane_unseen_changes", "pane_width", "pid", "scroll_region_lower", "scroll_region_upper", "server_sessions", "session_activity", "session_alerts", "session_attached", "session_attached_list", "session_created", "session_format", "session_group", "session_group_attached", "session_group_attached_list", "session_group_list", "session_group_many_attached", "session_group_size", "session_grouped", "session_id", "session_last_attached", "session_many_attached", "session_marked", "session_name", "session_path", "session_stack", "session_windows", "socket_path", "start_time", "tree_mode_format", "uid", "user", "version", "window_active", "window_active_clients", "window_active_clients_list", "window_active_sessions", "window_active_sessions_list", "window_activity", "window_activity_flag", "window_bell_flag", "window_bigger", "window_cell_height", "window_cell_width", "window_end_flag", "window_flags", "window_format", "window_height", "window_id", "window_index", "window_last_flag", "window_layout", "window_linked", "window_linked_sessions", "window_linked_sessions_list", "window_marked_flag", "window_name", "window_offset_x", "window_offset_y", "window_panes", "window_raw_flags", "window_silence_flag", "window_stack_index", "window_start_flag", "window_visible_layout", "window_width", "window_zoomed_flag", "wrap_flag"];

/// display -a: every variable with a value here, `name=value`, in format_table's order (those
/// with none in this context — a buffer's, a mouse event's, a dead pane's, a group's — left out),
/// then the command's name, as format_each lists them.
pub fn every(app: &App, window: usize, pane: Option<u64>) -> Vec<String> {
    let dead = pane.and_then(|p| app.panes.get(&p)).map(|p| matches!(p.phase, crate::pane::Phase::Card { .. })).unwrap_or(false);
    let skip = |n: &str| matches!(n, "buffer_created" | "buffer_name" | "buffer_sample" | "buffer_size") || (n.starts_with("mouse_") && !n.ends_with("_flag")) || (n.starts_with("pane_dead_") && !dead)
        || (n.starts_with("session_group") && n != "session_grouped" && app.session_group.is_none()) || matches!(n, "client_last_session" | "window_bigger" | "window_offset_x" | "window_offset_y" | "session_attached_list" | "window_active_clients_list" | "pane_mode");
    let mut out: Vec<String> = TABLE_NAMES.iter().filter(|n| !skip(n)).filter_map(|n| {
        let v = match table(app, n, window, pane)? { Val::Str(s) => s, Val::Time(t) => t.to_string() };
        Some(format!("{n}={v}"))
    }).collect();
    out.push("command=display-message".into());
    out
}

/// A format as a config's %if reads it: no #() jobs run (tmux's FORMAT_NOJOBS).
/// A format for a session not in front (another client's, or a list's row): its session_*
/// values its own, as a #{S:} loop expands them.
pub fn expand_session(app: &App, fmt: &str, session: u32) -> String {
    let mut es = Es { app, window: app.active, pane: None, time: false, nojobs: false, depth: 0, now: now_secs(), session: (session != app.session_id).then_some(session), window_of: None, format_type: Some(crate::tree::FORMAT_SESSION), trace: None, values: Rc::default() };
    expand1(&mut es, fmt)
}

/// A format for window [k] (of session_windows) of a session not in front (another client's).
pub fn expand_session_window(app: &App, fmt: &str, session: u32, k: usize) -> String {
    let mut es = Es { app, window: app.active, pane: None, time: false, nojobs: false, depth: 0, now: now_secs(), session: Some(session), window_of: Some(k), format_type: Some(crate::tree::FORMAT_WINDOW), trace: None, values: Rc::default() };
    expand1(&mut es, fmt)
}

pub fn expand_nojobs(app: &App, fmt: &str) -> String {
    let mut es = Es { app, window: app.active, pane: app.focused(), time: false, nojobs: true, depth: 0, now: now_secs(), session: None, window_of: None, format_type: None, trace: None, values: Rc::default() };
    expand1(&mut es, fmt)
}

/// tmux's FORMAT_LOOP_LIMIT: formats that expand into themselves stop here.
const LOOP_LIMIT: u32 = 100;

// One expansion borrows an immutable App. Reuse its raw values within that
// expansion only; the next render observes all model, option and job changes.
type LookupContext = (usize, Option<u64>, Option<u32>, Option<usize>, Option<u8>, bool);
type Values = HashMap<LookupContext, HashMap<String, Option<Val>>>;

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
    /// In a #{S:} loop: the session (another than the one in front) whose session_* these are;
    /// in a #{W:} loop inside it, which of its windows (session_windows) the window_* are.
    session: Option<u32>,
    window_of: Option<usize>,
    format_type: Option<u8>,
    trace: Option<std::rc::Rc<std::cell::RefCell<Vec<String>>>>,
    values: Rc<RefCell<Values>>,
}

impl<'a> Es<'a> {
    fn at(&self, window: usize, pane: Option<u64>) -> Es<'a> {
        Es { app: self.app, window, pane, time: self.time, nojobs: self.nojobs, depth: self.depth, now: self.now, session: self.session, window_of: self.window_of, format_type: self.format_type, trace: self.trace.clone(), values: self.values.clone() }
    }
    fn log(&self, text: std::fmt::Arguments<'_>) {
        if let Some(trace) = &self.trace { trace.borrow_mut().push(format!("#{}{}", " ".repeat(self.depth.min(10) as usize), text)) }
    }
}

// ── #() ─────────────────────────────────────────────────────────────────────

/// A `#()` command: its last output, and the run in flight (tmux's format_job): the process
/// group running it (killed when it is run again for new text, or when hn goes), whether it has
/// said anything yet.
#[derive(Default)]
pub struct Job { expanded: String, out: Option<String>, running: bool, started: i64, last: i64, generation: u64, pub pid: Option<i32>, updated: bool }

unsafe extern "C" { fn kill(pid: i32, sig: i32) -> i32; }

/// Every `#()` job still running, ended (job_free's SIGTERM, to its process group), as tmux's
/// server ends its jobs when it goes.
pub fn kill_jobs(app: &crate::app::App) {
    for job in app.jobs.borrow_mut().values_mut() { if let Some(pid) = job.pid.take() { unsafe { kill(-pid, 15); } } }
}

/// The output of `cmd` (its latest line), running it if it is due: the first time, when its
/// expanded text changes, and every status-interval after the last run — tmux reruns a job each
/// time the status line is redrawn, which its timer does every status-interval; one still running
/// (a `while :; do …; sleep 60; done`) is not run again, its lines shown as they come.
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
            // (New text for it: the run before ends, as format_job_get frees it.)
            if force { if let Some(pid) = job.pid.take() { unsafe { kill(-pid, 15); } } }
            job.expanded = expanded.clone();
            job.running = true;
            job.updated = false;
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
        let env = crate::ipc::job_environ(&app.global_env, &app.session_env);
        let sink = app.sink.clone();
        // As tmux runs one: /bin/sh -c, nothing on stdin, the client's folder, the server's
        // environment; HN_SOCKET (and a `tmux` that is hn) so a command inside it talks to
        // this client. A group of its own, so ending it ends what it started.
        let mut c = tokio::process::Command::new("/bin/sh");
        c.arg("-c").arg(&expanded);
        crate::ipc::set_job_env(&mut c, &env);
        c.stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).process_group(0).kill_on_drop(false);
        match c.spawn() {
            Ok(mut child) => {
                if let Some(job) = app.jobs.borrow_mut().get_mut(&key) { job.pid = child.id().map(|p| p as i32) }
                let stdout = child.stdout.take();
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt;
                    // format_job_update: each time whole lines come, the last of them; at the end
                    // (format_job_complete) what is left after them, if anything or nothing came.
                    let mut buf: Vec<u8> = Vec::new();
                    if let Some(mut out) = stdout {
                        let mut chunk = [0u8; 4096];
                        loop {
                            let n = match out.read(&mut chunk).await { Ok(0) | Err(_) => break, Ok(n) => n };
                            buf.extend_from_slice(&chunk[..n]);
                            let Some(end) = buf.iter().rposition(|b| *b == b'\n') else { continue };
                            let lines: Vec<u8> = buf.drain(..=end).collect();
                            let text = String::from_utf8_lossy(&lines[..lines.len() - 1]).to_string();
                            let line = text.rsplit('\n').next().unwrap_or("").trim_end_matches('\r').to_string();
                            let key = key.clone();
                            let _ = sink.send(crate::event::Event::Apply(Box::new(move |app: &mut crate::app::App| {
                                if let Some(job) = app.jobs.borrow_mut().get_mut(&key) { if job.generation == generation { job.out = Some(line); job.updated = true } }
                                app.status_redraws += 1;
                            })));
                        }
                    }
                    let _ = child.wait().await;
                    let rest = String::from_utf8_lossy(&buf).trim_end_matches('\r').to_string();
                    let _ = sink.send(crate::event::Event::Apply(Box::new(move |app: &mut crate::app::App| {
                        if let Some(job) = app.jobs.borrow_mut().get_mut(&key) {
                            if job.generation != generation { return }
                            job.running = false;
                            job.pid = None;
                            if !rest.is_empty() || !job.updated { job.out = Some(rest) }
                        }
                        app.status_redraws += 1;
                    })));
                });
            }
            Err(_) => { if let Some(job) = app.jobs.borrow_mut().get_mut(&key) { job.running = false; job.out = Some(format!("<'{cmd}' didn't start>")) } }
        }
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
    es.log(format_args!("expanding format: {fmt}"));
    let timed;
    let fmt = if es.time && fmt.contains('%') { timed = strftime(es.app, fmt, es.now); if timed != fmt { es.log(format_args!("after time expanded: {timed}")) } timed.as_str() } else { fmt };
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
                es.log(format_args!("found #{{}}: {}", &fmt[i..end]));
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
                    Some(name) => { es.log(format_args!("found #{}: {name}", ch as char)); match replace(es, name) { Some(v) => out.push_str(&v), None => break } },
                    None => {
                        out.push('#');
                        // Not an ASCII letter: the character goes out whole, from its first byte.
                        if ch < 0x80 { out.push(ch as char) } else { i -= 1 }
                    }
                }
            }
        }
    }
    es.log(format_args!("result is: {out}"));
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
    } else if f.sessions {
        // Unlike W: and P:, tmux's S: loop has one template; commas remain literal.
        let mut v = String::new();
        for (id, _) in es.app.session_list() {
            let mut next = es.at(es.app.active, None);
            next.session = (id != es.app.session_id).then_some(id);
            next.format_type = Some(crate::tree::FORMAT_SESSION);
            v.push_str(&expand1(&mut next, copy));
        }
        v
    } else if f.clients {
        // format_loop_clients: this client, then the other terminals of this name, each expanding
        // it as its own (asked for a command's output — never while drawing, which must not wait).
        let mut next = es.at(es.app.active, None);
        let mut v = expand1(&mut next, copy);
        if es.app.capture.is_some() && !crate::ipc::forwarded() {
            for other in crate::commands::other_clients() {
                if let Some((out, _, 0)) = crate::ipc::ask(&other, &["hn-list-clients".into(), "-F".into(), copy.to_string()]) { v.push_str(&out.concat()) }
            }
        }
        v
    } else if f.windows && es.session.is_some() {
        // format_loop_windows in a session not in front (a #{S:} loop's): its own windows.
        let (all, active) = match choose(copy) { Some((a, b)) => (a, Some(b)), None => (copy, None) };
        let sid = es.session.unwrap_or_default();
        let current = es.app.stash_value(sid, "window_index");
        let mut v = String::new();
        for (k, (num, _, _)) in es.app.session_windows(sid).into_iter().enumerate() {
            let use_ = if Some(num.to_string()) == current { active.unwrap_or(all) } else { all };
            let mut next = es.at(es.window, None);
            next.window_of = Some(k);
            next.format_type = Some(crate::tree::FORMAT_WINDOW);
            v.push_str(&expand1(&mut next, use_));
        }
        v
    } else if f.windows {
        let (all, active) = match choose(copy) { Some((a, b)) => (a, Some(b)), None => (copy, None) };
        let mut v = String::new();
        for w in 0..es.app.tabs.len() {
            let use_ = if w == es.app.active { active.unwrap_or(all) } else { all };
            let mut next = es.at(w, None);
            next.format_type = Some(crate::tree::FORMAT_WINDOW);
            v.push_str(&expand1(&mut next, use_));
        }
        v
    } else if f.panes && es.session.and_then(|id| es.app.stash_panes(id, es.window_of)).is_some() {
        // format_loop_panes in a session not in front (a #{S:} loop's): its window's own panes.
        let (all, active) = match choose(copy) { Some((a, b)) => (a, Some(b)), None => (copy, None) };
        let (panes, focus, _) = es.session.and_then(|id| es.app.stash_panes(id, es.window_of)).unwrap_or_default();
        let mut v = String::new();
        for p in panes {
            let use_ = if Some(p) == focus { active.unwrap_or(all) } else { all };
            let mut next = es.at(es.window, Some(p));
            next.format_type = Some(crate::tree::FORMAT_PANE);
            v.push_str(&expand1(&mut next, use_));
        }
        v
    } else if f.panes {
        let (all, active) = match choose(copy) { Some((a, b)) => (a, Some(b)), None => (copy, None) };
        let tab = es.app.tabs.get(es.window);
        let focus = tab.and_then(|t| t.focus);
        let mut v = String::new();
        for p in tab.map(|t| t.panes()).unwrap_or_default() {
            let use_ = if Some(p) == focus { active.unwrap_or(all) } else { all };
            let mut next = es.at(es.window, Some(p));
            next.format_type = Some(crate::tree::FORMAT_PANE);
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
        let (left, right) = choose_expanded(es, copy)?;
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
        let (left, right) = choose(&rest[k + 1..])?;
        if truthy(&found) { expand1(es, left) } else { expand1(es, right) }
    } else if let Some(fm) = mexp {
        expression(es, fm, copy).unwrap_or_default()
    } else if copy.contains("#{") {
        expand1(es, copy)
    } else {
        let found = find(es, copy, &f, time_format.as_deref());
        match &found { Some(value) => es.log(format_args!("format '{copy}' found: {value}")), None => es.log(format_args!("format '{copy}' not found")) }
        found.unwrap_or_default()
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
    es.log(format_args!("replaced '{key}' with '{value}'"));
    Some(value)
}

/// `a,b`: borrow the two templates at the first comma outside `#{…}`. Conditions
/// and loops expand only the selected template, without copying either side.
fn choose(s: &str) -> Option<(&str, &str)> {
    let k = skip(s.as_bytes(), b",")?;
    Some((&s[..k], &s[k + 1..]))
}

fn choose_expanded(es: &mut Es, s: &str) -> Option<(String, String)> {
    let (l, r) = choose(s)?;
    Some((expand1(es, l), expand1(es, r)))
}

fn truthy(v: &str) -> bool { !v.is_empty() && v != "0" }

/// A name's raw value: an option, a variable, else the environment (format_find).
fn value(es: &Es, key: &str, timestring: bool) -> Option<Val> {
    let context = (es.window, es.pane, es.session, es.window_of, es.format_type, timestring);
    if let Some(found) = es.values.borrow().get(&context).and_then(|values| values.get(key)) { return found.clone() }
    let app = es.app;
    let window_id = app.tabs.get(es.window).map(|t| t.id.clone()).unwrap_or_default();
    let kind = match key { "session_format" => Some(crate::tree::FORMAT_SESSION), "window_format" => Some(crate::tree::FORMAT_WINDOW), "pane_format" => Some(crate::tree::FORMAT_PANE), _ => None };
    let typed = es.format_type.zip(kind).map(|(context, kind)| (context == kind).then_some("1").unwrap_or("0").to_string());
    let mut found = typed.or_else(|| es.session.and_then(|id| match (es.window_of, es.pane) {
        // A #{P:} loop's pane there: its index and whether it is active are its window's.
        (k, Some(p)) if matches!(key, "pane_index" | "pane_active") => app.stash_pane_value(id, k, p, key),
        // A #{W:} loop's window there: its active pane's id.
        (Some(k), None) if key == "pane_id" => app.session_active_pane(id, k).map(crate::pane::tag).or_else(|| app.stash_value(id, key)),
        // (Which kind of line it is — window_format — is the tree's to say.)
        (Some(k), _) if key.starts_with("window_") && key != "window_format" => Some(app.stash_window_value(id, k, key).unwrap_or_default()),
        _ => app.stash_value(id, key),
    }));
    if found.is_none() { found = app.options.format_value(key, &window_id, es.pane) }
    let found = found.map(Val::Str).or_else(|| table(app, key, es.window, es.pane)).or_else(|| {
        // format_find: the session's environment, then the global one. Time
        // modifiers do not resolve environment variables in tmux's format_find.
        if timestring { None } else { app.session_env.get(key).or_else(|| app.global_env.get(key)).and_then(|e| e.value.clone()).map(Val::Str) }
    });
    es.values.borrow_mut().entry(context).or_default().insert(key.to_string(), found.clone());
    found
}

/// Apply modifiers after lookup: one raw value may be quoted, shortened or timed
/// differently at each occurrence of the same name.
fn find(es: &mut Es, key: &str, f: &Flags, time_format: Option<&str>) -> Option<String> {
    let app = es.app;
    let (found, mut t) = match value(es, key, f.timestring)? {
        Val::Str(v) => (Some(v), 0),
        Val::Time(v) => (None, v),
    };
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
        posix_match(pattern, text, icase)
    } else if icase { glob(&pattern.to_lowercase(), &text.to_lowercase()) } else { glob(pattern, text) };
    if hit { "1".into() } else { "0".into() }
}

/// tmux uses the platform's POSIX extended expressions, including its escape rules.
fn posix_match(pattern: &str, text: &str, icase: bool) -> bool {
    let (Ok(pattern), Ok(text)) = (std::ffi::CString::new(pattern), std::ffi::CString::new(text)) else { return false };
    let mut re = std::mem::MaybeUninit::<libc::regex_t>::uninit();
    // regcomp initializes regex_t on success; regexec and regfree then use that object.
    unsafe {
        if libc::regcomp(re.as_mut_ptr(), pattern.as_ptr(), libc::REG_EXTENDED | if icase { libc::REG_ICASE } else { 0 }) != 0 { return false }
        let mut re = re.assume_init();
        let hit = libc::regexec(&re, text.as_ptr(), 0, std::ptr::null_mut(), 0) == 0;
        libc::regfree(&mut re);
        hit
    }
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
    for (i, line) in pane.text_range(Some(0), None).lines().enumerate() {
        let hit = if flags.contains('r') { posix_match(term, line, icase) } else if icase { glob(&format!("*{}*", term.to_lowercase()), &line.to_lowercase()) } else { glob(&format!("*{term}*"), line) };
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
    let (l, r) = choose_expanded(es, copy)?;
    let num = |s: &str| -> Option<f64> { if s.is_empty() { Some(0.0) } else { s.trim_start().parse::<f64>().ok() } };
    let (mut a, mut b) = (num(&l)?, num(&r)?);
    if !fp { a = (a as i64) as f64; b = (b as i64) as f64 }
    let t = |x: bool| if x { 1.0 } else { 0.0 };
    let v = match op {
        "+" => a + b, "-" => a - b, "*" => a * b, "/" => a / b, "%" | "m" => a % b,
        "==" => t((a - b).abs() < 1e-9), "!=" => t((a - b).abs() > 1e-9),
        ">" => t(a > b), "<" => t(a < b), ">=" => t(a >= b), _ => t(a <= b),
    };
    Some(if fp { format!("{v:.prec$}") } else { format!("{:.prec$}", (v as i64) as f64) })
}

type Substitutions = std::collections::VecDeque<(String, bool, Option<Rc<regex::Regex>>)>;
thread_local! {
    static SUBSTITUTIONS: RefCell<Substitutions> = RefCell::new(Default::default());
}

/// Status formats reuse their patterns on every frame. Keep a small LRU of
/// compiled expressions, never their match results. Larger expressions retain
/// the original compiler limits and run uncached rather than growing the cache.
fn substitution_regex(pattern: &str, icase: bool) -> Option<Rc<regex::Regex>> {
    let uncached = || regex::RegexBuilder::new(pattern).case_insensitive(icase).build().ok().map(Rc::new);
    if pattern.len() > 2048 { return uncached() }
    SUBSTITUTIONS.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(at) = cache.iter().position(|(p, i, _)| p == pattern && *i == icase) {
            let entry = cache.remove(at).unwrap();
            let re = entry.2.clone();
            cache.push_front(entry);
            return re;
        }
        let re = match regex::RegexBuilder::new(pattern).case_insensitive(icase)
            .size_limit(32 * 1024).dfa_size_limit(32 * 1024).build() {
            Ok(re) => Some(Rc::new(re)),
            Err(regex::Error::CompiledTooBig(_)) => return uncached(),
            Err(_) => None,
        };
        if cache.len() == 8 { cache.pop_back(); }
        cache.push_front((pattern.to_string(), icase, re.clone()));
        re
    })
}

/// tmux's regsub: every match replaced; `\0`–`\9` in the replacement are the groups.
fn regsub(pattern: &str, with: &str, text: &str, icase: bool) -> Option<String> {
    if text.is_empty() { return Some(String::new()) }
    let re = substitution_regex(pattern, icase)?;
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
pub(crate) fn local_tm(t: i64) -> libc::tm {
    // SAFETY: localtime_r only writes the struct it is given.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let tt = t as libc::time_t;
    unsafe { libc::localtime_r(&tt, &mut tm) };
    tm
}

/// strftime(3) itself, over a whole format, as tmux runs it first (its 8192-byte buffer: a longer
/// result, or an empty one, is nothing).
fn strftime(_app: &App, fmt: &str, t: i64) -> String { strftime_at(fmt, t) }

/// strftime(3) of a time in seconds, in local time.
pub fn strftime_at(fmt: &str, t: i64) -> String {
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

#[derive(Clone)]
enum Val { Str(String), Time(i64) }

/// A pane's tile in its window's layout, in the client's cells (title row included).
fn tab_rect(app: &App, window: usize, pane: u64) -> Option<ratatui::layout::Rect> {
    if window == app.active { if let Some((_, r)) = app.rects.iter().find(|(id, _)| *id == pane) { return Some(*r) } }
    let mut out = Vec::new();
    let tab = app.tabs.get(window)?;
    tab.root.as_ref()?.rects(app.window_area(tab), &mut out);
    out.into_iter().find(|(id, _)| *id == pane).map(|(_, r)| r)
}

/// tmux's #{pane_title}: what select-pane -T set, or the program (OSC 0/2) when allow-set-title
/// is on (hn's default is off: a harness's name is its title), else the harness's name.
/// A harness state's symbol with its style, for a format: its colour (the terminal's own 16),
/// dim for the quiet ones (idle, paused, offline), bold when it needs you; no colour
/// under NO_COLOR.
pub fn agent_mark(state: crate::fleet::State, tick: u64) -> String {
    let (glyph, _, colour) = crate::theme::state_mark(state, tick);
    let (mut on, mut off): (Vec<String>, Vec<&str>) = (Vec::new(), Vec::new());
    if colour == crate::theme::MUTED { on.push("dim".into()); off.push("nodim") }
    else if colour != ratatui::style::Color::Reset { on.push(format!("fg={}", crate::tmuxconf::colour_name(colour))); off.push("fg=default") }
    if state == crate::fleet::State::NeedsInput { on.push("bold".into()); off.push("nobold") }
    if on.is_empty() { glyph.to_string() } else { format!("#[{}]{glyph}#[{}]", on.join(","), off.join(",")) }
}


/// One remaining figure per subscription, across every machine with a reading. The local
/// reading wins when machines share an account; unnamed accounts cannot safely be merged.
/// Machine labels distinguish additional subscriptions without repeating them for shared ones.
fn quota_remaining<'a>(readings: impl Iterator<Item = (&'a str, &'a crate::fleet::Usage)>, local: &str, machine_name: impl Fn(&str) -> String, marked: bool, icons: bool) -> String {
    let mut readings: Vec<_> = readings.filter(|(_, u)| !u.windows.is_empty()).collect();
    readings.sort_by(|(am, a), (bm, b)| (&a.provider, *am != local, machine_name(am), am).cmp(&(&b.provider, *bm != local, machine_name(bm), bm)));
    let mut seen = std::collections::HashSet::new();
    readings.retain(|(_, u)| u.account.as_deref().filter(|a| !a.is_empty()).map(|a| seen.insert((u.provider.as_str(), a))).unwrap_or(true));
    readings.iter().filter_map(|(machine, u)| {
        let used = u.windows.iter().map(|w| w.used).filter(|u| u.is_finite()).reduce(f64::max)?.clamp(0.0, 100.0);
        let remaining = 100.0 - used;
        // A little allowance remains: don't round it to a misleading exhausted 0%.
        let number = if remaining > 0.0 && remaining < 1.0 { "<1%".into() } else { format!("{remaining:.0}%") };
        let mut label = if icons { quota_icon(&u.provider) } else { quota_provider(&u.provider) };
        if *machine != local && readings.iter().filter(|(_, other)| other.provider == u.provider).count() > 1 {
            label.push('@'); label.push_str(&clip_middle(&machine_name(machine), 12));
        }
        if marked && used >= 80.0 && !crate::theme::no_color() {
            Some(format!("{label} #[fg={}]{number}#[fg=default]", quota_color(used)))
        } else { Some(format!("{label} {number}")) }
    }).collect::<Vec<_>>().join("  ")
}

/// A subscription's provider as its engine's icon, in the engine's colour (`✳` Claude, `◎`
/// Codex/OpenAI…); a provider with no engine of its own, its name.
fn quota_icon(provider: &str) -> String {
    let engine = match provider.to_ascii_lowercase().as_str() { "anthropic" | "claude" => "claude", "openai" | "chatgpt" | "codex" => "codex", _ => return quota_provider(provider) };
    let (mark, colour) = crate::theme::engine_mark(engine);
    if crate::theme::no_color() { return mark.to_string() }
    format!("#[fg={}]{mark}#[fg=default]", crate::tmuxconf::colour_name(crate::theme::paint(colour)))
}

fn quota_provider(provider: &str) -> String {
    let mut chars = provider.chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

fn quota_color(used: f64) -> &'static str {
    match (crate::term_out::terminal_is_light().unwrap_or(false), used >= 100.0) {
        (false, false) => "#f3cc76", (false, true) => "#ff9b8e",
        (true, false) => "#875600", (true, true) => "#a53028",
    }
}

/// Compact quota warning: provider plus percentage, with color only on the number.
/// The raw format retains the reset window for scripts and custom status lines.
fn quota_warning<'a>(readings: impl Iterator<Item = &'a crate::fleet::Usage>, marked: bool) -> String {
    let mut worst: Option<(&crate::fleet::Usage, &crate::fleet::Window)> = None;
    for u in readings { for w in &u.windows {
        if w.used >= 80.0 && worst.map(|(_, old)| w.used > old.used).unwrap_or(true) { worst = Some((u, w)); }
    } }
    let Some((u, w)) = worst else { return String::new() };
    if !marked { return format!("{} {} {:.0}%", u.provider, w.label, w.used) }
    let provider = quota_provider(&u.provider);
    let color = quota_color(w.used);
    format!("{provider} #[fg={color}]{:.0}%#[fg=default]", w.used)
}

pub fn pane_title(app: &App, window: usize, pane: u64) -> String {
    let Some(p) = app.panes.get(&pane) else { return app.fleet.local_machine_name() };
    let tab_id = app.tabs.get(window).map(|t| t.id.clone()).unwrap_or_default();
    if !p.osc_title.is_empty() && app.options.get("allow-set-title", &tab_id, Some(pane)).as_deref() == Some("on") { return p.osc_title.clone() }
    if !p.title.is_empty() { return p.title.clone() }
    let agent = app.fleet.agent(&p.machine_id, &p.agent_id);
    // tmux's look: a plain shell's title is tmux's own — its host's name (a program's own title,
    // allow-set-title on there, above).
    if app.options.tmux_look() && agent.map(|a| a.engine == "terminal").unwrap_or(false) {
        return if p.machine_id == app.fleet.local_id { crate::app::full_hostname() } else { app.fleet.machine_name(&p.machine_id) };
    }
    // A harness not heard of yet (another terminal's new one, before the list comes): what runs
    // in it, else the machine's app name.
    agent.map(|a| a.name.clone()).or_else(|| p.fg_command.clone()).unwrap_or_else(|| app.fleet.machine_name(&p.machine_id))
}

/// Keep a distinguishing suffix, such as "(3)", visible when a title is long.
pub fn clip_middle(text: &str, cols: usize) -> String {
    use unicode_segmentation::UnicodeSegmentation;
    use unicode_width::UnicodeWidthStr;
    if text.width() <= cols { return text.to_string() }
    if cols == 0 { return String::new() }
    let left_room = cols / 2;
    let right_room = cols - 1 - left_room;
    let mut left = String::new();
    for g in text.graphemes(true) {
        if left.width() + g.width() > left_room { break }
        left.push_str(g);
    }
    let mut right = Vec::new();
    let mut width = 0;
    for g in text.graphemes(true).rev() {
        if width + g.width() > right_room { break }
        right.push(g);
        width += g.width();
    }
    format!("{}…{}", left.trim_end(), right.into_iter().rev().collect::<String>().trim_start())
}

/// Columns available to pane-border-format inside its frame.
fn pane_heading_columns(app: &App, window: usize, pane: u64) -> usize {
    let columns = if app.options.pane_look() {
        let Some(tab) = app.tabs.get(window) else { return 0 };
        let Some(tile) = tab_rect(app, window, pane) else { return 0 };
        crate::pane_frame::frame(tile, app.window_area(tab), app.box_inner(tab), app.pane_status(tab)).title
            .map(|r| r.width.saturating_sub(2) as usize).unwrap_or(0)
    } else {
        content_rect(app, window, pane).map(|r| r.width.saturating_sub(4) as usize).unwrap_or(0)
    };
    columns.saturating_sub(crate::workspace_controls::title_reserve(app, window, pane, columns as u16) as usize)
}

fn pane_heading(app: &App, window: usize, pane: u64) -> String {
    let watcher = app.panes.get(&pane).and_then(|p| match &p.phase {
        crate::pane::Phase::Watching(who) => Some(who.as_str()), _ => None,
    });
    let columns = pane_heading_columns(app, window, pane).saturating_sub(1);
    let title = pane_title(app, window, pane);
    // ── models: what its model says when it will not answer now (Starting up…, offline, not
    // served), after the name — the name keeps a dozen columns, the note is cut to what is left ──
    if let Some(note) = app.panes.get(&pane).and_then(|p| crate::models::pane_note(app, &p.machine_id, &p.agent_id)) {
        use unicode_width::UnicodeWidthStr;
        let keep = title.width().min(12) + 4;
        if columns > keep + 12 {
            let note = clip_middle(&note, (columns - keep - 1).min(note.width()));
            let head = compact_pane_heading(&title, app.pane_state(pane), watcher, columns - note.width() - 1, app.tick);
            return format!("{head} #[fg=yellow]{note}#[fg=default]");
        }
    }
    compact_pane_heading(&title, app.pane_state(pane), watcher, columns, app.tick)
}

/// Keep state visible after the name. Watcher detail yields before the pane's identity;
/// a narrow title keeps both ends, so otherwise identical tasks retain their suffixes.
fn compact_pane_heading(title: &str, state: Option<crate::fleet::State>, watcher: Option<&str>, columns: usize, tick: u64) -> String {
    use unicode_width::UnicodeWidthStr;
    let mark = state.filter(|s| *s != crate::fleet::State::Ready).map(|s| agent_mark(s, tick)).unwrap_or_default();
    let mark_width = crate::draw::format_width(&mark);
    if columns <= mark_width { return if columns == mark_width { mark } else { String::new() } }
    let state_room = if mark.is_empty() { 0 } else { mark_width + 1 };
    let available = columns.saturating_sub(state_room);
    let full_watch = watcher.map(|who| if who.is_empty() { "[watching]".to_string() } else { format!("[watching — {who} has it]") });
    let watch = full_watch.map(|full| {
        if full.width() + 1 <= available.saturating_sub(title.width().min(12)) { full }
        else if "[watching]".width() + 1 <= available.saturating_sub(title.width().min(4)) { "[watching]".to_string() }
        else { String::new() }
    }).unwrap_or_default();
    let watch_room = if watch.is_empty() { 0 } else { watch.width() + 1 };
    let mut out = clip_middle(title, available.saturating_sub(watch_room));
    if !mark.is_empty() { if !out.is_empty() { out.push(' ') } out.push_str(&mark) }
    if !watch.is_empty() {
        if !out.is_empty() { out.push(' ') }
        out.push_str(&format!("#[fg=yellow]{watch}#[fg=default]"));
    }
    out
}

/// The pane's own cells, from its window's top-left corner: tmux's pane_left/top/width/height.
/// The clients showing the session in front: this one (not hn with no terminal, nor while a
/// command has another session in front) and those showing it as this one has it — or, for a
/// session shown here as another client has it, that client's count.
/// How many terminals show session [id] (the one in front, the one a command is in for a moment,
/// another of this client's).
fn attached(app: &App) -> usize { app.session_attached(app.session_id) }

/// Structural dimensions for split percentages, including a zoomed pane before it unzooms.
/// Presentation padding must not change the split tree that the same command creates.
pub fn layout_rect(app: &App, window: usize, pane: u64) -> Option<ratatui::layout::Rect> {
    let r = tab_rect(app, window, pane)?;
    let tab = app.tabs.get(window)?;
    let body = app.window_area(tab);
    let c = app.layout_content_of(tab, r);
    Some(ratatui::layout::Rect { x: c.x - body.x, y: c.y - body.y, width: c.width, height: c.height })
}

pub fn content_rect(app: &App, window: usize, pane: u64) -> Option<ratatui::layout::Rect> {
    let r = tab_rect(app, window, pane)?;
    let body = app.window_area(app.tabs.get(window)?);
    let c = app.content_of(app.tabs.get(window)?, r);
    Some(ratatui::layout::Rect { x: c.x - body.x, y: c.y - body.y, width: c.width, height: c.height })
}

/// tmux's format table: a variable's value for a window (and a pane: else the window's active
/// one), or None when there is no such variable. Times are seconds since the epoch.
/// clock-mode on this pane (the mode on top of its others).
fn clock_on(app: &App, pane: Option<u64>) -> bool { pane.and_then(|p| app.panes.get(&p)).map(|p| p.clock).unwrap_or(false) }

fn table(app: &App, name: &str, window: usize, pane_id: Option<u64>) -> Option<Val> {
    let tab = app.tabs.get(window);
    // A hook's (#{hook}, #{hook_pane}, #{hook_flag_t} …), as cmdq_add_formats adds them.
    if let Some((_, v)) = app.hook_state.as_ref().and_then(|h| h.formats.iter().find(|(k, _)| k == name)) { return Some(Val::Str(v.clone())) }
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
    // A harness's own (list-harnesses -F), in a pane or not.
    if let Some((m, a)) = &app.format_agent {
        if let Some(v) = name.strip_prefix("harness_").and_then(|k| harness_value(app, m, a, k)) { return Some(v) }
    }
    // No window (a target tmux could not find): its window and pane have nothing to say.
    if tab.is_none() && (name.starts_with("window_") || name.starts_with("pane_")) { return Some(Val::Str(String::new())) }
    // …nor its session, when there was no target at all (display -t nosuch).
    if window == usize::MAX && name.starts_with("session_") { return Some(Val::Str(String::new())) }
    let focus = pane_id.or_else(|| tab.and_then(|t| t.focus));
    let pane = focus.and_then(|f| app.panes.get(&f));
    let agent = pane.and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id));
    let host = crate::app::hostname();
    let v: String = match name {
        "session_name" => app.session_name(),
        "window_index" => tab.map(|_| app.win_num(window).to_string()).unwrap_or_default(),
        "window_name" => tab.map(|t| t.name.clone()).unwrap_or_default(),
        // The name in whole words within 20 columns, … after what is cut: a harness is named for its
        // task, and the window list has room for a few words of each.
        "window_short_name" => tab.map(|t| short_name(&t.name, 20)).unwrap_or_default(),
        // Named by auto rename now (autoname.rs): its repo and its work.
        "window_auto_named" => (tab.is_some() && crate::autoname::named(app, window)).then_some("1").unwrap_or("0").into(),
        "window_flags" => flags(app, window).replacen('#', "##", 1),
        "window_raw_flags" => flags(app, window),
        "window_active" => (window == app.active).then_some("1").unwrap_or("0").into(),
        "window_last_flag" => (tab.map(|t| app.last_tab() == Some(&t.id)).unwrap_or(false)).then_some("1").unwrap_or("0").into(),
        "window_zoomed_flag" => (tab.map(|t| t.zoomed).unwrap_or(false)).then_some("1").unwrap_or("0").into(),
        "window_panes" => tab.map(|t| t.panes().len().to_string()).unwrap_or_default(),
        "window_bell_flag" => flags(app, window).contains('!').then_some("1").unwrap_or("0").into(),
        "pane_active" => (focus == tab.and_then(|t| t.focus)).then_some("1").unwrap_or("0").into(),
        "pane_index" => focus.and_then(|f| tab.and_then(|t| t.panes().iter().position(|p| *p == f))).map(|i| (i + app.pane_base(window)).to_string()).unwrap_or_default(),
        "pane_title" => focus.map(|f| pane_title(app, window, f)).unwrap_or_else(|| host.clone()),
        "pane_heading" => focus.map(|f| pane_heading(app, window, f)).unwrap_or_default(),
        "hn_controls" => crate::workspace_controls::status(app),
        "shell_context" => crate::shell_context::status(app, focus),
        "pane_id" => focus.map(crate::pane::tag).unwrap_or_default(),
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
        // format_cb_pane_in_mode: how many modes the pane is in.
        "pane_in_mode" => pane.map(|p| (p.mode_count() + clock_on(app, focus) as usize).to_string()).unwrap_or_else(|| "0".into()),
        "session_windows" => app.tabs.len().to_string(),
        // The session in front is this client's; one a command reaches for a moment is not.
        // The client's own session is attached to it (hn with no terminal is no client).
        // This client, when it shows the session (hn with no terminal is no client), and the
        // clients showing it as this one has it (mirror.rs).
        "session_attached" => attached(app).to_string(),
        "session_many_attached" => ((attached(app) > 1) as u8).to_string(),
        "client_width" => app.size.0.to_string(),
        "client_height" => app.size.1.to_string(),
        "window_width" => tab.map(|t| app.window_area(t).width).unwrap_or(app.body().width).to_string(),
        "window_height" => tab.map(|t| app.window_area(t).height).unwrap_or(app.body().height).to_string(),
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
        "pane_marked" => (focus.is_some() && app.marked == focus && app.marked_session == Some(app.session_id)).then_some("1").unwrap_or("0").into(),
        "pane_marked_set" => app.marked.is_some().then_some("1").unwrap_or("0").into(),
        "window_id" => tab.map(|t| format!("@{}", t.wid())).unwrap_or_default(),
        "pane_synchronized" => tab.map(|t| t.sync).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        // The tmux level hn speaks (version-gated configs ask); hn's own is #{hn_version}.
        "version" => crate::tmuxconf::TMUX_VERSION.into(),
        "hn_version" => env!("CARGO_PKG_VERSION").into(),
        "pid" => std::process::id().to_string(),
        "socket_path" => crate::ipc::here().map(|p| p.display().to_string()).unwrap_or_default(),
        "client_session" => app.session_name(),
        "client_name" | "client_tty" => crate::app::tty_name(),
        "pane_mode" => pane.and_then(|p| if clock_on(app, focus) { Some("clock-mode") } else if p.tree_top() { Some(crate::tree::MODE_NAME) } else if p.files_top() { Some(crate::files::MODE_NAME) } else { p.modes.last().map(|m| if m.view { "view-mode" } else { "copy-mode" }) }).unwrap_or("").into(),
        // window_copy_formats: a pane in copy or view mode has them (some only with a selection
        // or a search); others none.
        "scroll_position" | "rectangle_toggle" | "copy_cursor_x" | "copy_cursor_y" | "selection_start_x" | "selection_start_y" | "selection_end_x" | "selection_end_y"
        | "selection_active" | "selection_present" | "search_present" | "search_count" | "search_count_partial" | "search_match" | "copy_cursor_word" | "copy_cursor_line" | "copy_cursor_hyperlink" => {
            let ws = app.options.get("word-separators", "", None).unwrap_or_default();
            pane.and_then(|p| p.modes.last()).and_then(|m| m.format(name, &ws)).unwrap_or_default()
        }
        "pane_search_string" => pane.and_then(|p| p.search.str.clone()).unwrap_or_default(),
        // 1 whenever the client's table is not its default one (the prefix, or one of your own).
        "client_prefix" => (app.prefix || app.key_table.is_some()).then_some("1").unwrap_or("0").into(),
        // gethostname(3): the whole name (mac.lan); #{host_short} is it up to the first dot.
        "host" => crate::app::full_hostname(),
        "host_short" => crate::app::full_hostname().split('.').next().unwrap_or("").to_string(),
        // This computer's name in Harness, including app renames; never the focused pane's.
        "local_machine" => app.fleet.local_machine_name(),
        // Harness's own: the machine a pane is on, and how many harnesses wait on you.
        "machine" => pane.map(|p| app.fleet.machine_name(&p.machine_id)).unwrap_or_default(),
        "waiting" => app.fleet.waiting().to_string(),
        // The fleet in counts (shells aside): needs you, failed, done and unread, working, idle —
        // and #{fleet}, the status line's: the ones that ask something of you, each with its
        // symbol (the needs-you count bold), a state with none left out.
        "fleet_needs" => app.fleet.count(crate::fleet::State::NeedsInput).to_string(),
        "fleet_failed" => app.fleet.count(crate::fleet::State::Failed).to_string(),
        "fleet_done" => app.fleet.count(crate::fleet::State::Done).to_string(),
        "fleet_working" => app.fleet.count(crate::fleet::State::Working).to_string(),
        "fleet_idle" => app.fleet.count(crate::fleet::State::Ready).to_string(),
        "fleet" => {
            use crate::fleet::State::*;
            let mut parts = Vec::new();
            let n = app.fleet.count(NeedsInput);
            if n > 0 { parts.push(format!("#[bold]?{n}#[nobold]")) }
            for state in [Failed, Done, Working] {
                let n = app.fleet.count(state);
                if n > 0 {
                    let glyph = match state { Failed => "✗", Done => "✓", _ => crate::theme::spinner(app.tick) };
                    parts.push(format!("{glyph}{n}"));
                }
            }
            parts.join(" ")
        }
        // The spinner's frame now, for a format of your own.
        "spinner" => crate::theme::spinner(app.tick).to_string(),
        "daemon_down" => app.daemon_down.then_some("1").unwrap_or("0").into(),
        // A model being got for a harness, while it is: `↻ qwen3-coder 42%` (empty otherwise).
        "model_progress" => crate::models::status_text(app).unwrap_or_default(),
        // The pane is another window's to type in (this one watches), when it is the only one.
        "pane_watching" => (pane.map(|p| matches!(p.phase, crate::pane::Phase::Watching(_))).unwrap_or(false) && tab.map(|t| t.panes().len() < 2).unwrap_or(false)).then_some("1").unwrap_or("0").into(),
        // However many panes the window has: whether another window has the pane to type in, and who.
        "pane_watched" => pane.map(|p| matches!(p.phase, crate::pane::Phase::Watching(_))).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        "pane_watcher" => pane.and_then(|p| match &p.phase { crate::pane::Phase::Watching(who) => Some(who.clone()), _ => None }).unwrap_or_default(),
        "pane_machine" => pane.map(|p| app.fleet.machine_name(&p.machine_id)).unwrap_or_default(),
        // The harness's symbol as its title draws it (#{pane_agent_icon}, styled): in its state's
        // colour, needs you bold, idle dim.
        "pane_agent_mark" => pane.and_then(|p| app.pane_state(p.id)).map(|s| agent_mark(s, app.tick)).unwrap_or_default(),
        // Where the harness works: `machine:project ⎇ branch`, then progressively shorter context
        // as the pane narrows. The Unicode branch marker needs no patched icon font. A folder with
        // no git shows its name.
        "pane_where" => pane.zip(agent).and_then(|(p, a)| {
            if a.branch.is_empty() && a.project.is_empty() { return None }
            let room = pane_heading_columns(app, window, p.id);
            let width = |s: &str| unicode_width::UnicodeWidthStr::width(s);
            let left = 1 + crate::draw::format_width(&pane_heading(app, window, p.id));
            let pr = a.pr.as_ref().map(|p| format!(" {}", p.label())).unwrap_or_default();
            // Both local and remote panes name their machine when there is room.
            // Drop it before project, branch or PR context as the pane narrows.
            let machine = app.fleet.machine_name(&p.machine_id);
            let qualified_project = (!machine.is_empty() && !a.project.is_empty()).then(|| format!("{machine}:{}", a.project));
            if a.branch.is_empty() { return [qualified_project, Some(a.project.clone())].into_iter().flatten().find(|c| room >= left + width(c) + 3) }
            [qualified_project.as_ref().filter(|_| !pr.is_empty()).map(|p| format!("{p} ⎇ {}{pr}", a.branch)),
                (!a.project.is_empty() && !pr.is_empty()).then(|| format!("{} ⎇ {}{pr}", a.project, a.branch)),
                qualified_project.as_ref().map(|p| format!("{p} ⎇ {}", a.branch)), (!a.project.is_empty()).then(|| format!("{} ⎇ {}", a.project, a.branch)),
                (!pr.is_empty()).then(|| format!("⎇ {}{pr}", a.branch)), Some(format!("⎇ {}", a.branch)), Some(a.branch.clone())]
                .into_iter().flatten().find(|c| room >= left + width(c) + 3)
        }).unwrap_or_default(),
        // A pane's harness at a glance, as its title shows it (empty for a plain shell), and what it
        // works on; a window's most urgent harness state, as the window list shows it.
        "pane_agent_state" => pane.and_then(|p| app.pane_state(p.id)).map(state_word).unwrap_or("").into(),
        "pane_agent_icon" => pane.and_then(|p| app.pane_state(p.id)).map(|s| crate::theme::state_mark(s, app.tick).0).unwrap_or("").into(),
        "pane_project" => agent.map(|a| a.project.clone()).unwrap_or_default(),
        // Its pull request (#123, its state and link), what it has cost (tokens, 1.2M) and changed
        // (+340 −52), what it was last asked, and what its last turn came to.
        "pane_pr" => agent.and_then(|a| a.pr.as_ref()).map(|p| format!("#{}", p.number)).unwrap_or_default(),
        "pane_pr_state" => agent.and_then(|a| a.pr.as_ref()).map(|p| p.state.clone()).unwrap_or_default(),
        "pane_pr_url" => agent.and_then(|a| a.pr.as_ref()).map(|p| p.url.clone()).unwrap_or_default(),
        "pane_tokens" => agent.filter(|a| a.tokens > 0).map(|a| crate::fleet::compact(a.tokens)).unwrap_or_default(),
        "pane_lines" => agent.filter(|a| a.added + a.removed > 0).map(|a| format!("+{} −{}", a.added, a.removed)).unwrap_or_default(),
        "pane_asked" => agent.and_then(|a| a.asked.clone()).unwrap_or_default(),
        // Its plan's progress (3/7) and how many sub-agents it has running.
        "pane_todos" => agent.filter(|a| !a.todos.is_empty()).map(|a| format!("{}/{}", a.todos.iter().filter(|(_, s)| s == "completed").count(), a.todos.len())).unwrap_or_default(),
        "pane_subagents" => agent.map(|a| a.subagents.len().to_string()).unwrap_or_else(|| "0".into()),
        "pane_did" => agent.and_then(|a| a.did.clone()).unwrap_or_default(),
        // The agent accounts' rate limits: the focused pane's machine's (`claude 5h 42% week
        // 18%`), and the one nearest its limit anywhere, once it is at 80% or more.
        "usage" => {
            let m = pane.map(|p| p.machine_id.clone()).unwrap_or_else(|| app.fleet.local_id.clone());
            app.usage.get(&m).map(|u| u.iter().map(|x| x.line()).collect::<Vec<_>>().join(" · ")).unwrap_or_default()
        }
        // Compact remaining allowance for every subscription, not just the one in danger.
        "usage_remaining" | "usage_remaining_mark" => quota_remaining(
            app.usage.iter().flat_map(|(machine, readings)| readings.iter().map(move |u| (machine.as_str(), u))),
            &app.fleet.local_id, |id| app.fleet.machine_name(id), name == "usage_remaining_mark", false),
        // The same, each subscription by its engine's icon (`✳ 43%  ◎ 80%`): the side bar's.
        "usage_remaining_icons" => quota_remaining(
            app.usage.iter().flat_map(|(machine, readings)| readings.iter().map(move |u| (machine.as_str(), u))),
            &app.fleet.local_id, |id| app.fleet.machine_name(id), true, true),
        "usage_high" | "usage_high_mark" => quota_warning(app.usage.values().flatten(), name == "usage_high_mark"),
        "fleet_tokens" => { let t: u64 = app.fleet.agents.values().map(|a| a.tokens).sum(); if t > 0 { crate::fleet::compact(t) } else { String::new() } }
        "pane_branch" => agent.map(|a| a.branch.clone()).unwrap_or_default(),
        "window_agent_state" => tab.and_then(|_| app.window_state(window)).map(state_word).unwrap_or("").into(),
        "window_agent_icon" => tab.and_then(|_| app.window_state(window)).map(|s| crate::theme::state_mark(s, app.tick).0).unwrap_or("").into(),
        "pane_far" => pane.map(|p| p.machine_id != app.fleet.local_id).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        "session_id" => format!("${}", app.session_id),
        "session_path" => app.session_path.clone().unwrap_or_else(|| std::env::current_dir().map(|d| d.display().to_string()).unwrap_or_default()),
        // The session the client was in before this one.
        "client_last_session" => app.last_session.and_then(|l| app.session_list().into_iter().find(|(i, _)| *i == l)).map(|(_, n)| n).unwrap_or_default(),
        "pane_dead_status" => pane.and_then(|p| p.dead.as_ref()).and_then(|e| e.status).map(|s| s.to_string()).unwrap_or_default(),
        "pane_dead_signal" => pane.and_then(|p| p.dead.as_ref()).and_then(|e| e.signal).map(|s| crate::local::signal_name(s)).unwrap_or_default(),
        "pane_dead_time" => pane.and_then(|p| p.dead.as_ref()).map(|e| e.time.to_string()).unwrap_or_default(),
        "pane_start_command" => pane.and_then(|p| p.start_command.as_deref()).map(crate::options::escape).unwrap_or_default(),
        // Its session group (new -t): none when it is in none (tmux's NULL), but _grouped.
        "session_group" | "session_group_size" | "session_group_list" | "session_group_attached" | "session_group_many_attached" | "session_group_attached_list" | "session_grouped" => app.session_group_value(app.session_id, name).unwrap_or_default(),
        // The sessions its window is in (link-window, a group).
        "window_linked" | "window_linked_sessions" | "window_linked_sessions_list" => {
            let list = tab.map(|t| app.window_sessions(&t.id)).unwrap_or_default();
            // (session_is_linked: in a session outside its group — a group's own sessions all have it.)
            let group = app.session_group.as_deref().map(|g| app.group_sessions(g).len()).unwrap_or(1);
            match name { "window_linked" => ((list.len() > group) as u8).to_string(), "window_linked_sessions" => list.len().to_string(), _ => list.join(",") }
        }
        "pane_input_off" => pane.map(|p| p.input_off).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        "window_activity_flag" => flags(app, window).contains('#').then_some("1").unwrap_or("0").into(),
        "window_silence_flag" => flags(app, window).contains('~').then_some("1").unwrap_or("0").into(),
        "window_bigger" | "window_offset_x" | "window_offset_y" | "client_control_mode" => "0".into(),
        // What went to the terminal (bytes), and what was dropped (none: hn never drops output).
        "client_written" if !app.headless => crate::term_out::WRITTEN.load(std::sync::atomic::Ordering::Relaxed).to_string(),
        "client_discarded" if !app.headless => "0".into(),
        // attach -r: read-only (and its size ignored, as tmux flags it).
        "client_readonly" => app.read_only().then_some("1").unwrap_or("0").into(),
        "pane_pipe" => pane.map(|p| app.pipes.contains_key(&p.id)).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        "server_sessions" => app.session_list().len().to_string(),
        "client_utf8" => "1".into(),
        "session_attached_list" => app.session_attached_ttys(app.session_id).join(","),
        "window_start_flag" => (window == 0).then_some("1").unwrap_or("0").into(),
        "window_end_flag" => (window.checked_add(1) == Some(app.tabs.len())).then_some("1").unwrap_or("0").into(),
        "client_termname" => std::env::var("TERM").unwrap_or_default(),
        "client_pid" => std::process::id().to_string(),
        "client_key_table" => app.key_table.clone().unwrap_or_else(|| if app.prefix { "prefix".into() } else { app.options.get("key-table", "", None).unwrap_or_else(|| "root".into()) }),
        // server_client_get_flags, in its order.
        "client_flags" => {
            let has = |f: &str| app.client_flags.iter().any(|x| x == f);
            let ro = app.read_only();
            let mut out = String::from("attached,");
            if app.terminal_focused { out.push_str("focused,") }
            if has("ignore-size") || app.mirror.as_ref().is_some_and(|m| m.readonly) { out.push_str("ignore-size,") }
            for f in ["no-output", "wait-exit", "pause-after"] { if has(f) { out.push_str(f); out.push(',') } }
            if ro { out.push_str("read-only,") }
            if has("active-pane") { out.push_str("active-pane,") }
            out.push_str("UTF-8");
            out
        }
        "pane_last" => (focus.is_some() && focus == tab.and_then(|t| t.last_focus())).then_some("1").unwrap_or("0").into(),
        "pane_dead" => pane.map(|p| p.dead.is_some() || matches!(p.phase, crate::pane::Phase::Card { .. })).unwrap_or(false).then_some("1").unwrap_or("0").into(),
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
        "pane_unseen_changes" => pane.map(|p| if p.unseen { "1" } else { "0" }.to_string()).unwrap_or_default(),
        "window_marked_flag" => tab.map(|t| app.marked_session == Some(app.session_id) && app.marked.map(|m| t.panes().contains(&m)).unwrap_or(false)).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        "pane_fg" | "pane_bg" => pane.map(|_| "default".to_string()).unwrap_or_default(),
        "pane_path" => pane.and_then(|p| p.osc7_url.clone()).unwrap_or_default(),
        // format_defaults' type: a pane's format, a window's or a session's (choose-tree's items).
        "pane_format" => match app.format_type { Some(t) => (t == crate::tree::FORMAT_PANE).then_some("1").unwrap_or("0").into(), None => (pane_id.is_some() || focus.is_some()).then_some("1").unwrap_or("0").into() },
        "window_format" => (app.format_type == Some(crate::tree::FORMAT_WINDOW)).then_some("1").unwrap_or("0").into(),
        "session_format" => (app.format_type == Some(crate::tree::FORMAT_SESSION)).then_some("1").unwrap_or("0").into(),
        "session_marked" => (app.marked.is_some() && app.marked_session == Some(app.session_id)).then_some("1").unwrap_or("0").into(),
        "active_window_index" => app.win_num(app.active).to_string(),
        "last_window_index" => (0..app.tabs.len()).map(|i| app.win_num(i)).max().map(|n| n.to_string()).unwrap_or_default(),
        "next_session_id" => format!("${}", crate::ids::peek(crate::ids::Kind::Session)),
        "buffer_mode_format" => "#{t/p:buffer_created}: #{buffer_sample}".into(),
        "client_mode_format" => "#{t/p:client_activity}: session #{session_name}".into(),
        "tree_mode_format" => crate::tree::default_format(app.options.tmux_look()),
        "config_files" => app.config_files.join(","),
        // The file whose commands are running (cfg.c's current_file): a sourced file's, as its
        // `source -F "#{d:current_file}/…"` reads it.
        "current_file" => app.origin.as_ref().map(|(f, _)| f.to_string()).unwrap_or_default(),
        // format_cb_session_alerts: each window with an alert, its number and its # ! ~.
        "session_alerts" => app.session_alerts(app.session_id),
        // The session's windows in the order they were last current (the current first).
        // The current window's number, then the lastw stack's.
        "session_stack" => std::iter::once(app.win_num(app.active)).chain(app.lastw.iter().filter_map(|id| app.tabs.iter().position(|t| &t.id == id)).map(|p| app.win_num(p))).map(|n| n.to_string()).collect::<Vec<_>>().join(","),
        // Where the window is on the lastw stack, from 1; 0 when it isn't (the current one).
        "window_stack_index" => tab.and_then(|t| app.lastw.iter().position(|id| *id == t.id)).map(|i| (i + 1).to_string()).unwrap_or_else(|| "0".into()),
        // Every client of the session shows its current window.
        "window_active_sessions" | "window_active_sessions_list" | "window_active_clients" | "window_active_clients_list" => tab.map(|t| app.active_window_value(t.wid(), name)).unwrap_or_default(),
        // A cell's pixels (TIOCGWINSZ's over its cells, as tty_resize has them): the client's (0
        // when the terminal does not say; none with no terminal), the window's (16x32, tmux's
        // DEFAULT_XPIXEL/YPIXEL, then).
        "window_cell_width" | "window_cell_height" | "client_cell_width" | "client_cell_height" => {
            let cell = (!app.headless).then(|| crossterm::terminal::window_size().ok()).flatten()
                .map(|w| (if w.columns > 0 { w.width / w.columns } else { 0 }, if w.rows > 0 { w.height / w.rows } else { 0 }));
            let wide = name.ends_with("width");
            match (name.starts_with("client"), cell) {
                (true, None) => return Some(Val::Str(String::new())),
                (true, Some((x, y))) => if wide { x } else { y }.to_string(),
                (false, Some((x, y))) if x > 0 && y > 0 => if wide { x } else { y }.to_string(),
                (false, _) => if wide { "16".into() } else { "32".into() },
            }
        }
        "cursor_x" | "cursor_y" => pane.map(|p| { let c = p.term.grid().cursor.point; if name == "cursor_x" { c.column.0.to_string() } else { c.line.0.to_string() } }).unwrap_or_default(),
        // Times: when this client started, and when a window last had something happen.
        "session_created" => return Some(Val::Time(app.session_created)),
        "session_last_attached" => return Some(if app.session_last_attached > 0 { Val::Time(app.session_last_attached) } else { Val::Str(String::new()) }),
        "client_created" | "start_time" => return Some(Val::Time(started(app))),
        // The client's session is in use now; one a command has in front, when it last was.
        "session_activity" if app.swap_back.is_some_and(|b| b != app.session_id) => return Some(Val::Time(app.session_activity)),
        "session_activity" | "client_activity" => return Some(Val::Time(now_secs())),
        "window_activity" => {
            // The last output seen here, or the harness's own last activity when that is later
            // (a pane not streaming yet).
            let last = tab.map(|t| t.panes()).unwrap_or_default().iter().filter_map(|id| app.panes.get(id)).filter_map(|p| app.fleet.agent(&p.machine_id, &p.agent_id)).map(|a| (a.active_at / 1000) as i64).max();
            return Some(Val::Time(last.into_iter().chain(tab.map(|t| t.activity)).max().unwrap_or_else(|| started(app))));
        }
        // The mouse event of the key being run (none from a shell).
        "mouse_x" | "mouse_y" | "mouse_word" | "mouse_line" | "mouse_pane" | "mouse_status_line" | "mouse_status_range" | "mouse_hyperlink" => return crate::mouse::format(app, name).map(Val::Str),
        _ => return None,
    };
    Some(Val::Str(v))
}


/// [name] in whole words within [max] columns, then `…` if any were left out (one word longer
/// than that is cut where it reaches it).
pub fn short_name(name: &str, max: usize) -> String {
    let width = |s: &str| s.chars().map(|c| c.width().unwrap_or(0)).sum::<usize>();
    if width(name) <= max { return name.to_string() }
    // A last word that tells it from its namesakes — `(2)`, `v2`, `#4812` — stays, after the
    // ellipsis: three windows read `Fix the flaky… (2)`, `(3)`, `(4)`, not `Fix the flaky…` thrice.
    let tail = name.rsplit(' ').next().filter(|w| *w != name && w.chars().count() <= 6 && w.chars().any(|c| c.is_ascii_digit())).unwrap_or("");
    let head = name[..name.len() - tail.len()].trim_end();
    let room = if tail.is_empty() { max } else { max.saturating_sub(width(tail) + 2) };
    let mut out = String::new();
    for word in head.split(' ') {
        let next = if out.is_empty() { word.to_string() } else { format!("{out} {word}") };
        if width(&next) > room { break }
        out = next;
    }
    if out.is_empty() {
        let mut used = 0;
        out = head.chars().take_while(|c| { used += c.width().unwrap_or(0); used <= room }).collect();
    }
    if tail.is_empty() { format!("{}…", out.trim_end()) } else { format!("{}… {tail}", out.trim_end()) }
}

#[cfg(test)]
mod short_name_tests {
    use super::short_name;
    #[test]
    fn keeps_what_tells_namesakes_apart() {
        assert_eq!(short_name("Fix the flaky checkout test (2)", 20), "Fix the flaky… (2)");
        assert_eq!(short_name("Fix the flaky checkout test", 20), "Fix the flaky…");
        assert_eq!(short_name("Refactor billing service", 20), "Refactor billing…");
        assert_eq!(short_name("Short (2)", 20), "Short (2)");
        assert_eq!(short_name("Upgrade React to 19", 20), "Upgrade React to 19");
        assert_eq!(short_name("Review the pull request #4812", 20), "Review the… #4812");
    }
}

/// #{harness_*}: a harness's name, id, engine, machine, project, branch, cwd, state (a word),
/// line (what C-b s shows: its question, what it is doing, what it did, why it failed), question,
/// doing, did, error, pr, pr_state, pr_url, tokens, since (when its state began), age (how long
/// ago), open (in a pane of this client).
fn harness_value(app: &App, machine: &str, id: &str, key: &str) -> Option<Val> {
    let a = app.fleet.agent(machine, id)?;
    let state = app.fleet.state_of(a);
    let question = a.question.as_ref().map(|q| q.prompt.clone()).unwrap_or_default();
    Some(Val::Str(match key {
        "name" => a.name.clone(),
        "id" => a.id.clone(),
        "engine" => a.engine.clone(),
        "machine" => app.fleet.machine_name(&a.machine_id),
        "machine_id" => a.machine_id.clone(),
        "project" => a.project.clone(),
        "branch" => a.branch.clone(),
        "cwd" => a.cwd.clone(),
        "state" => state_word(state).into(),
        "line" => {
            use crate::fleet::State::*;
            match state {
                NeedsInput => question,
                Working => a.doing.clone().unwrap_or_default(),
                Failed => Some(a.launch_error.clone()).filter(|e| !e.is_empty()).or_else(|| a.did.clone()).unwrap_or_default(),
                _ => a.did.clone().unwrap_or_default(),
            }
        }
        "question" => question,
        // Its question's choices, as answer-harness takes them by number (1 is the first).
        "options" => a.question.as_ref().map(|q| q.options.iter().enumerate().map(|(i, o)| format!("{}) {o}", i + 1)).collect::<Vec<_>>().join("  ")).unwrap_or_default(),
        "doing" => a.doing.clone().unwrap_or_default(),
        "did" => a.did.clone().unwrap_or_default(),
        // Why it failed: to start, else its last turn's error (the ✗ line).
        "error" => if !a.launch_error.is_empty() { a.launch_error.clone() } else if a.errored { a.did.clone().unwrap_or_default() } else { String::new() },
        "pr" => a.pr.as_ref().map(|p| format!("#{}", p.number)).unwrap_or_default(),
        "pr_state" => a.pr.as_ref().map(|p| p.state.to_lowercase()).unwrap_or_default(),
        "pr_url" => a.pr.as_ref().map(|p| p.url.clone()).unwrap_or_default(),
        "tokens" => if a.tokens > 0 { crate::fleet::compact(a.tokens) } else { String::new() },
        "since" => return Some(Val::Time((a.state_since(state) / 1000) as i64)),
        "age" => crate::fleet::ago(a.state_since(state)),
        "open" => (app.find_pane(machine, id).is_some() as u8).to_string(),
        _ => return None,
    }))
}

/// A harness state as one word (#{pane_agent_state}): needs, working, done, idle, starting,
/// failed, paused, offline.
fn state_word(s: crate::fleet::State) -> &'static str {
    use crate::fleet::State::*;
    match s { NeedsInput => "needs", Working => "working", Done => "done", Unknown => "unknown", Ready => "idle", Starting => "starting", Failed => "failed", Paused => "paused", Offline => "offline" }
}

/// `#{window_raw_flags}`: `#` activity, `!` bell, `~` silence, `*` current, `-` last, `M` the
/// marked pane's, `Z` zoomed.
pub fn alert_flags(app: &App, tab: &crate::app::Tab, active: bool) -> String {
    let mut out = String::new();
    let (mut bell, mut activity) = (tab.alerts & crate::app::BELL != 0, tab.alerts & crate::app::ACTIVITY != 0);
    if !active {
        for id in tab.panes() {
            let Some(agent) = app.panes.get(&id).and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id)) else { continue };
            match app.fleet.state_of(agent) { crate::fleet::State::NeedsInput => bell = true, crate::fleet::State::Done => activity = true, _ => {} }
        }
    }
    if activity { out.push('#') }
    if bell { out.push('!') }
    if tab.alerts & crate::app::SILENCE != 0 { out.push('~') }
    out
}

pub fn flags(app: &App, window: usize) -> String {
    let Some(tab) = app.tabs.get(window) else { return String::new() };
    let mut out = alert_flags(app, tab, window == app.active);
    if window == app.active { out.push('*') } else if app.last_tab() == Some(&tab.id) { out.push('-') }
    if app.marked_session == Some(app.session_id) && app.marked.map(|m| tab.panes().contains(&m)).unwrap_or(false) { out.push('M') }
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

#[cfg(test)]
mod tests {
    #[test]
    fn fleet_only_requests_animation_while_working_and_motion_is_enabled() {
        let mut app = status_fixture(1, 1);
        for working in [false, true, false] {
            app.fleet.agents.values_mut().next().unwrap().working = working;
            crate::theme::begin_animation_frame(true);
            super::expand(&app, "#{fleet}/#{fleet}", 0, Some(1), false);
            assert_eq!(crate::theme::needs_animation_frame(), working);
        }
        app.fleet.agents.values_mut().next().unwrap().working = true;
        crate::theme::begin_animation_frame(false);
        assert_eq!(super::expand(&app, "#{fleet}", 0, Some(1), false), "⠋1");
        assert!(!crate::theme::needs_animation_frame());
    }

    fn status_fixture(windows: usize, agents: usize) -> crate::app::App {
        let (sink, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = crate::app::App::new(19789, sink, (200, 60));
        app.fleet.local_id = "render-test".into();
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: "render-test".into(), name: "Render test".into(), local: true, status: "running".into(), reach: crate::fleet::Reach::Ready });
        for i in 0..agents {
            let row = serde_json::json!({ "id": format!("agent-{i}"), "name": format!("Review project {i}"), "engine": "codex", "status": "active" });
            let mut agent = crate::fleet::agent_from("render-test", &row, None);
            agent.working = true;
            app.fleet.agents.insert(agent.key(), agent);
        }
        app.tabs = (0..windows).map(|i| {
            let mut tab = crate::app::Tab::with_wid(&format!("Project {i}"), i as u64);
            tab.focus = Some(i as u64 + 1);
            let mut pane = crate::pane::Pane::new(i as u64 + 1, "render-test", &format!("agent-{i}"), 80, 24);
            pane.phase = crate::pane::Phase::Live;
            app.panes.insert(pane.id, pane);
            tab
        }).collect();
        app
    }

    /// An opt-in, repeatable CPU workload; no daemon, real sessions, or terminal is opened.
    #[test]
    #[ignore = "run with cargo test --release benchmark_status_formats -- --ignored --nocapture"]
    fn benchmark_status_formats() {
        for (windows, agents) in [(6, 32), (24, 512)] {
            let app = status_fixture(windows, agents);
            let fmt = app.options.get("status-format[0]", &app.tabs[0].id, None).unwrap();
            let iterations = 2000;
            let start = std::time::Instant::now();
            for _ in 0..iterations {
                std::hint::black_box(super::expand(&app, &fmt, 0, Some(1), true));
            }
            eprintln!("status windows={windows} agents={agents}: {:.1} us/expansion", start.elapsed().as_micros() as f64 / iterations as f64);
        }
    }

    #[test]
    fn repeated_values_keep_window_pane_and_loop_type_context() {
        let mut app = status_fixture(2, 2);
        for (i, tab) in app.tabs.iter_mut().enumerate() {
            tab.root = Some(crate::layout::Node::new(i as u64 + 1, 80, 24));
            app.options.windows.entry(tab.id.clone()).or_default().insert("@label".into(), format!("label-{i}"));
        }
        let fmt = "#{W:#{window_name}=#{@label}/#{window_format}/#{P:#{window_name}=#{@label}/#{window_format}/#{pane_format}/#{pane_id};}}";
        assert_eq!(super::expand(&app, fmt, 0, Some(1), false),
            "Project 0=label-0/1/Project 0=label-0/0/1/%0;Project 1=label-1/1/Project 1=label-1/0/1/%1;");
        app.active = 1;
        assert_eq!(super::expand(&app, "#{window_name}/#{window_active}/#{pane_id}", 1, Some(2), false), "Project 1/1/%1");
    }

    /// What the status line renders when the current window is `filled` and the tab name is `pane`.
    #[test]
    fn default_tab_format_includes_the_working_state_after_its_name() {
        let mut app = status_fixture(1, 1);
        app.tabs[0].root = Some(crate::layout::Node::new(1, 80, 24));
        let fmt = crate::options::status_window_format("tmux", true);
        let mark = super::expand(&app, "#{window_agent_icon}", 0, Some(1), false);
        assert!(!mark.is_empty());
        assert_eq!(super::expand(&app, &fmt, 0, Some(1), false), format!("0:Project 0* {mark}"));
    }

    #[test]
    fn window_status_overrides_reach_the_status_line() {
        let mut app = status_fixture(2, 2);
        let global = crate::options::SetFlags { global: true, ..Default::default() };
        let overrides = crate::options::window_status_overrides("pane", "filled");
        for (o, v) in &overrides { let _ = app.options.set(o, Some(v), &global, "", 0); }
        let fmt = app.options.get("status-format[0]", &app.tabs[0].id, None).unwrap();
        let out = super::expand(&app, &fmt, 0, Some(1), true);
        // The current window is marked filled: no `*`, its cell takes the swapped status-line
        // colours (the theme's background on the theme's foreground), and in `pane` mode it is
        // named for its active pane — not the window's auto-renamed name.
        assert!(!out.contains('*'), "no star marker: {out}");
        assert!(out.contains("list=focus") && out.contains("bg="), "the current window is filled: {out}");
        assert!(out.contains("Review project 0") && !out.contains("0:Project 0"), "the pane's title, not the window's: {out}");
    }

    #[test]
    fn loop_alternatives_keep_nested_commas_and_only_expand_the_selected_branch() {
        let mut app = status_fixture(2, 2);
        app.options.global_session.insert("@selected".into(), "live,✓".into());
        let fmt = "#{W:#{window_name},#{?window_active,#{@selected},#(printf unexpected)}}";
        assert_eq!(super::expand(&app, fmt, 0, None, false), "live,✓Project 1");
        app.active = 1;
        app.options.global_session.insert("@selected".into(), "changed,✓".into());
        assert_eq!(super::expand(&app, fmt, 0, None, false), "Project 0changed,✓");
        assert!(app.jobs.borrow().is_empty(), "the untaken branch must not run its shell command");
    }

    #[test]
    fn compiled_substitutions_keep_fresh_text_replacements_and_case_flags() {
        assert_eq!(super::regsub("(foo)", "[\\1]", "foo FOO", false).as_deref(), Some("[foo] FOO"));
        assert_eq!(super::regsub("(foo)", "new", "FOO foo", false).as_deref(), Some("FOO new"));
        assert_eq!(super::regsub("(foo)", "new", "FOO foo", true).as_deref(), Some("new new"));
        assert_eq!(super::regsub("^foo", "✓", "foo foo", false).as_deref(), Some("✓ foo"));
        assert_eq!(super::regsub("(", "x", "text", false), None);
        assert_eq!(super::regsub("(", "x", "", false).as_deref(), Some(""));
    }

    #[test]
    fn substitution_cache_stays_bounded_without_rejecting_larger_expressions() {
        super::SUBSTITUTIONS.with(|cache| cache.borrow_mut().clear());
        for n in 0..32 {
            let pattern = format!("a{n}");
            assert_eq!(super::regsub(&pattern, "hit", &pattern, false).as_deref(), Some("hit"));
        }
        assert_eq!(super::regsub("a0", "again", "a0", false).as_deref(), Some("again"));
        super::SUBSTITUTIONS.with(|cache| assert!(cache.borrow().len() <= 8));
        // Unicode word classes exceed the cache's small compiled-size budget.
        assert_eq!(super::regsub(r"\w+", "word", "café 東京", false).as_deref(), Some("word word"));
        let long = "a".repeat(2049);
        assert_eq!(super::regsub(&long, "long", &long, false).as_deref(), Some("long"));
        super::SUBSTITUTIONS.with(|cache| {
            let cache = cache.borrow();
            assert!(cache.len() <= 8);
            assert!(!cache.iter().any(|(pattern, _, _)| pattern == r"\w+" || pattern == &long));
        });
    }

    #[test]
    fn each_expansion_observes_new_agent_option_and_environment_values() {
        let mut app = status_fixture(1, 2);
        app.options.global_session.insert("@label".into(), "first".into());
        app.session_env.insert("RENDER_TEST".into(), crate::app::EnvVar { value: Some("before".into()), hidden: false });
        let fmt = "#{fleet_working}/#{fleet_working}/#{@label}/#{@label}/#{RENDER_TEST}/#{RENDER_TEST}";
        assert_eq!(super::expand(&app, fmt, 0, Some(1), false), "2/2/first/first/before/before");
        app.fleet.agents.values_mut().next().unwrap().working = false;
        app.options.global_session.insert("@label".into(), "second".into());
        app.session_env.get_mut("RENDER_TEST").unwrap().value = Some("after".into());
        assert_eq!(super::expand(&app, fmt, 0, Some(1), false), "1/1/second/second/after/after");
    }

    #[test]
    fn repeated_raw_values_keep_distinct_modifiers_and_time_lookup_rules() {
        let mut app = status_fixture(1, 1);
        app.options.global_session.insert("@path".into(), "/tmp/project name".into());
        app.options.global_session.insert("@clock".into(), "1700000000".into());
        app.session_env.insert("RENDER_CLOCK".into(), crate::app::EnvVar { value: Some("1700000000".into()), hidden: false });
        let fmt = "#{@path}|#{b:@path}|#{d:@path}|#{q:@path}|#{RENDER_CLOCK}|#{t:RENDER_CLOCK}|#{@clock}|#{t/f/%Y:@clock}";
        assert_eq!(super::expand(&app, fmt, 0, Some(1), false), "/tmp/project name|project name|/tmp|/tmp/project\\ name|1700000000||1700000000|2023");
        let (out, trace) = super::verbose(&app, "#{@path}/#{@path}", 0, Some(1));
        assert_eq!(out, "/tmp/project name//tmp/project name");
        assert_eq!(trace.iter().filter(|line| line.contains("format '@path' found: /tmp/project name")).count(), 2);
    }

    #[test]
    fn shell_format_output_is_current_on_each_expansion() {
        let mut app = status_fixture(1, 1);
        app.options.global_session.insert("status-interval".into(), "0".into());
        app.jobs.borrow_mut().insert("fixture".into(), super::Job {
            expanded: "fixture".into(), out: Some("first".into()), generation: 1, ..Default::default()
        });
        assert_eq!(super::expand(&app, "#(fixture)/#(fixture)", 0, Some(1), false), "first/first");
        app.jobs.borrow_mut().get_mut("fixture").unwrap().out = Some("second".into());
        assert_eq!(super::expand(&app, "#(fixture)/#(fixture)", 0, Some(1), false), "second/second");
    }

    #[test]
    fn compact_headings_reserve_state_and_keep_names_distinct() {
        use crate::fleet::State;
        let title = "Investigate checkout failures across browser versions (2)";
        let header = super::compact_pane_heading(title, Some(State::NeedsInput), None, 32, 0);
        assert!(header.starts_with("Investigate"), "{header}");
        assert!(header.contains("(2) ") && header.contains('?'), "{header}");
        assert!(header.contains('…'));
        assert_eq!(crate::draw::format_width(&header), 32);
        assert_eq!(super::compact_pane_heading("Idle", Some(State::Ready), None, 20, 0), "Idle");
        for name in [title, "日本語の長いタスクを確認する (3)", "Cafe\u{301} checkout investigation (4)"] {
            for columns in 0..80 {
                let header = super::compact_pane_heading(name, Some(State::NeedsInput), Some("another terminal"), columns, 0);
                assert!(crate::draw::format_width(&header) <= columns, "{columns}: {header}");
                assert_eq!(header.contains('?'), columns > 0, "{columns}: {header}");
                assert_eq!(header.contains("[watching"), header.contains("watching]") || header.contains("has it]"));
            }
        }
        let compact = super::compact_pane_heading(title, Some(State::NeedsInput), Some("another terminal"), 32, 0);
        assert!(compact.contains("[watching]") && !compact.contains("another terminal"));
        let wide = super::compact_pane_heading("Review", None, Some("another terminal"), 80, 0);
        assert!(wide.contains("[watching — another terminal has it]"));
    }

    fn quota(provider: &str, account: Option<&str>, used: &[f64]) -> crate::fleet::Usage {
        crate::fleet::Usage { provider: provider.into(), account: account.map(str::to_string),
            windows: used.iter().map(|used| crate::fleet::Window { label: "limit".into(), used: *used, resets: None }).collect() }
    }

    #[test]
    fn remaining_quota_shows_all_subscriptions_and_the_tightest_window() {
        let claude = quota("claude", Some("a"), &[42.0, 18.0]);
        let codex = quota("codex", Some("b"), &[3.0, 11.0]);
        let other = quota("other", Some("c"), &[30.0]);
        let empty = quota("missing", None, &[]);
        let readings = [("local", &other), ("local", &codex), ("local", &empty), ("local", &claude)];
        assert_eq!(super::quota_remaining(readings.into_iter(), "local", str::to_string, false, false), "Claude 58%  Codex 89%  Other 70%");
        assert_eq!(super::quota_remaining(std::iter::empty(), "local", str::to_string, false, false), "");
        // The existing per-window format continues reporting used quota for custom configs.
        assert_eq!(claude.line(), "claude limit 42% limit 18%");
    }

    #[test]
    fn remaining_quota_groups_shared_accounts_but_keeps_distinct_and_unknown_accounts() {
        let local = quota("claude", Some("a"), &[42.0]);
        let shared = quota("claude", Some("a"), &[40.0]);
        let distinct = quota("claude", Some("b"), &[80.0]);
        let unknown = quota("codex", None, &[11.0]);
        let readings = [("studio", &distinct), ("shared", &shared), ("local", &local), ("studio", &unknown), ("local", &unknown)];
        let expected = "Claude 58%  Claude@studio 20%  Codex 89%  Codex@studio 89%";
        assert_eq!(super::quota_remaining(readings.into_iter(), "local", str::to_string, false, false), expected);
        assert_eq!(super::quota_remaining(readings.into_iter().rev(), "local", str::to_string, false, false), expected);
    }

    #[test]
    fn remaining_quota_is_plain_until_low_and_does_not_round_to_exhausted() {
        for (used, number) in [(0.0, "100%"), (79.0, "21%"), (80.0, "20%"), (99.7, "<1%"), (100.0, "0%"), (120.0, "0%")] {
            let u = quota("claude", None, &[used]);
            let plain = format!("Claude {number}");
            assert_eq!(super::quota_remaining(std::iter::once(("local", &u)), "local", str::to_string, false, false), plain);
            let styled = super::quota_remaining(std::iter::once(("local", &u)), "local", str::to_string, true, false);
            if used < 80.0 || crate::theme::no_color() { assert_eq!(styled, plain) }
            else { assert!(styled.starts_with("Claude #[fg=")); assert!(styled.ends_with(&format!("]{number}#[fg=default]"))); }
            assert!(!styled.contains("reverse") && !styled.contains("bg="));
        }
    }

    #[test]
    fn quota_warning_marks_only_high_usage_without_reversing_text() {
        let mut u = crate::fleet::Usage { provider: "claude".into(), account: None,
            windows: vec![crate::fleet::Window { label: "week".into(), used: 79.0, resets: None }] };
        assert_eq!(super::quota_warning(std::iter::once(&u), true), "");
        u.windows[0].used = 80.0;
        let warning = super::quota_warning(std::iter::once(&u), true);
        assert!(warning.starts_with("Claude #[fg="));
        assert!(warning.ends_with("]80%#[fg=default]"));
        assert!(!warning.contains("week") && !warning.contains('●'));
        assert!(!warning.contains("reverse") && !warning.contains("bg="));
        u.windows[0].used = 100.0;
        let full = super::quota_warning(std::iter::once(&u), true);
        let indicator_color = |s: &str| s.split("#[fg=").nth(1).unwrap().split(']').next().unwrap().to_owned();
        assert_ne!(indicator_color(&warning), indicator_color(&full));
        assert!(full.starts_with("Claude #[fg="));
        assert!(full.ends_with("]100%#[fg=default]"));
        assert_eq!(super::quota_warning(std::iter::once(&u), false), "claude week 100%");
    }

    #[test]
    fn format_regex_uses_posix_extended_expressions() {
        assert!(super::posix_match("^(foo|bar)[[:digit:]]+$", "foo12", false));
        assert!(!super::posix_match("^foo$", "FOO", false));
        assert!(super::posix_match("^foo$", "FOO", true));
        assert!(!super::posix_match("(?i)foo", "foo", false));
        assert!(!super::posix_match("[", "foo", false));
        // The platform's regcomp is also tmux's: Darwin does not give \b Perl semantics.
        #[cfg(target_os = "macos")]
        assert!(!super::posix_match(r"\bfoo", "foo", false));
    }

    #[test]
    fn a_short_name_keeps_whole_words() {
        use super::short_name;
        assert_eq!(short_name("Fix flaky login test", 20), "Fix flaky login test");
        assert_eq!(short_name("Refactor billing service", 20), "Refactor billing…");
        assert_eq!(short_name("Train tokenizer on the new corpus", 20), "Train tokenizer on…");
        assert_eq!(short_name("supercalifragilisticexpialidocious", 20), "supercalifragilistic…");
        assert_eq!(short_name("日本語のハーネスの名前です", 20), "日本語のハーネスの名…");
    }
}
