//! tmux's formats: `#S`, `#{window_name}`, `#{?window_zoomed_flag,Z,}`, `#{=21:pane_title}`,
//! `#[fg=colour136,bold]`, `##`, and strftime's `%H:%M %d-%b-%y` — what `status-left`,
//! `status-right`, `window-status-format` and `display-message` are written in.

use ratatui::style::{Modifier, Style};
use ratatui::text::Span;

use crate::app::App;
use crate::tmuxconf::colour;

thread_local! {
    /// The pane a pane-border-format is being expanded for (else the window's active pane).
    static PANE: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

/// Expand a format for one pane (pane-border-format).
pub fn spans_for_pane(app: &App, fmt: &str, window: usize, pane: u64, base: Style) -> Vec<Span<'static>> {
    PANE.with(|p| p.set(Some(pane)));
    let out = spans(app, fmt, Some(window), base);
    PANE.with(|p| p.set(None));
    out
}

/// A variable's value; `window` is the window a window-status format is for.
fn var(app: &App, name: &str, window: usize) -> String {
    let tab = app.tabs.get(window);
    let focus = PANE.with(|p| p.get()).or_else(|| tab.and_then(|t| t.focus));
    let pane = focus.and_then(|f| app.panes.get(&f));
    let agent = pane.and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id));
    let host = crate::app::hostname();
    match name {
        "session_name" | "S" => app.session_name(),
        "window_index" | "I" => app.win_num(window).to_string(),
        "window_name" | "W" => tab.map(|t| t.name.clone()).unwrap_or_default(),
        "window_flags" | "F" => flags(app, window),
        "window_raw_flags" => flags(app, window),
        "window_active" => (window == app.active).then_some("1").unwrap_or("0").into(),
        "window_last_flag" => (tab.map(|t| app.last_tab.as_ref() == Some(&t.id)).unwrap_or(false)).then_some("1").unwrap_or("0").into(),
        "window_zoomed_flag" => (tab.map(|t| t.zoomed).unwrap_or(false)).then_some("1").unwrap_or("0").into(),
        "window_panes" => tab.map(|t| t.panes().len().to_string()).unwrap_or_default(),
        "window_bell_flag" => flags(app, window).contains('!').then_some("1").unwrap_or("0").into(),
        "pane_active" => (focus == tab.and_then(|t| t.focus)).then_some("1").unwrap_or("0").into(),
        "pane_index" | "P" => focus.and_then(|f| tab.and_then(|t| t.panes().iter().position(|p| *p == f))).map(|i| (i + app.pane_base_index).to_string()).unwrap_or_default(),
        "pane_title" | "T" => agent.map(|a| a.name.clone()).unwrap_or_else(|| host.clone()),
        "pane_id" | "D" => focus.map(|f| format!("%{f}")).unwrap_or_default(),
        "pane_current_path" => pane.and_then(|p| p.cwd.clone()).or_else(|| agent.map(|a| a.cwd.clone())).unwrap_or_default(),
        "pane_current_command" => agent.map(|a| a.engine.clone()).unwrap_or_default(),
        "pane_width" => pane.map(|p| p.cols.to_string()).unwrap_or_default(),
        "pane_height" => pane.map(|p| p.rows.to_string()).unwrap_or_default(),
        "pane_in_mode" => pane.map(|p| p.copy.is_some()).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        "pane_synchronized" => tab.map(|t| t.sync).unwrap_or(false).then_some("1").unwrap_or("0").into(),
        "status" => (app.opts.status != Some(false)).then_some("on").unwrap_or("off").into(),
        "mouse" => app.mouse.then_some("on").unwrap_or("off").into(),
        "client_prefix" => app.prefix.then_some("1").unwrap_or("0").into(),
        "host" | "H" => host,
        "host_short" | "h" => host.split('.').next().unwrap_or("").to_string(),
        // Harness's own: the machine a pane is on, and how many harnesses wait on you.
        "machine" => pane.map(|p| app.fleet.machine_name(&p.machine_id)).unwrap_or_default(),
        "waiting" => app.fleet.waiting().to_string(),
        // tim's face, for a status-right of your own: "#{tim} %H:%M".
        "tim" => crate::tim::face(app).map(|(f, _)| f).unwrap_or_default(),
        _ => String::new(),
    }
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

/// Take a `{…}` body starting after the `{`, balanced; returns it and the rest.
fn braced(s: &str) -> (&str, &str) {
    let mut depth = 1;
    for (i, c) in s.char_indices() {
        match c { '{' => depth += 1, '}' => { depth -= 1; if depth == 0 { return (&s[..i], &s[i + 1..]) } } _ => {} }
    }
    (s, "")
}

/// Split `a,b,c` at top-level commas (not inside `#{…}`).
fn commas(s: &str) -> Vec<&str> {
    let (mut out, mut depth, mut start) = (Vec::new(), 0, 0);
    let bytes = s.as_bytes();
    for (i, c) in s.char_indices() {
        match c {
            '{' if i > 0 && bytes[i - 1] == b'#' => depth += 1,
            '}' if depth > 0 => depth -= 1,
            ',' if depth == 0 => { out.push(&s[start..i]); start = i + 1 }
            _ => {}
        }
    }
    out.push(&s[start..]);
    out
}

fn truthy(v: &str) -> bool { !v.is_empty() && v != "0" }

/// One `#{…}` body: a variable, `?cond,a,b`, `=N:var`, `==:a,b` and friends.
fn braces(app: &App, body: &str, window: usize) -> String {
    if let Some(rest) = body.strip_prefix('?') {
        let parts = commas(rest);
        let cond = parts.first().copied().unwrap_or("");
        let value = if cond.contains("#{") || cond.contains('#') { text(app, cond, Some(window)) } else { var(app, cond, window) };
        let pick = if truthy(&value) { parts.get(1) } else { parts.get(2) };
        return pick.map(|p| text(app, p, Some(window))).unwrap_or_default();
    }
    if let Some(rest) = body.strip_prefix("==:").or_else(|| body.strip_prefix("!=:")) {
        let parts = commas(rest);
        let same = parts.len() == 2 && text(app, parts[0], Some(window)) == text(app, parts[1], Some(window));
        return if same == body.starts_with("==") { "1".into() } else { "0".into() };
    }
    if let Some(rest) = body.strip_prefix('=') {
        // #{=21:pane_title} (from the left), #{=-21:…} (from the right).
        if let Some((n, name)) = rest.split_once(':') {
            let n: i64 = n.parse().unwrap_or(0);
            let v = braces(app, name, window);
            let chars: Vec<char> = v.chars().collect();
            let k = n.unsigned_abs() as usize;
            return if chars.len() <= k { v } else if n >= 0 { chars[..k].iter().collect() } else { chars[chars.len() - k..].iter().collect() };
        }
    }
    if let Some((_, name)) = body.split_once(':').filter(|(m, _)| matches!(*m, "t" | "b" | "d" | "l" | "q")) {
        if body.starts_with("l:") { return name.to_string() }
        return var(app, name, window);
    }
    var(app, body, window)
}

/// strftime, the parts tmux status lines use.
fn strftime(app: &App, c: char) -> Option<String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) + app.utc_offset_secs;
    let (days, secs) = (now.div_euclid(86_400), now.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    let (h, mi, s) = (secs / 3600, (secs / 60) % 60, secs % 60);
    Some(match c {
        'H' => format!("{h:02}"), 'M' => format!("{mi:02}"), 'S' => format!("{s:02}"),
        'I' => format!("{:02}", if h % 12 == 0 { 12 } else { h % 12 }), 'p' => (if h < 12 { "AM" } else { "PM" }).into(),
        'd' => format!("{d:02}"), 'e' => format!("{d:2}"), 'm' => format!("{m:02}"), 'b' | 'h' => MONTHS[(m - 1) as usize].into(),
        'y' => format!("{:02}", y % 100), 'Y' => y.to_string(), 'a' => DAYS[days.rem_euclid(7) as usize].into(),
        'R' => format!("{h:02}:{mi:02}"), 'T' => format!("{h:02}:{mi:02}:{s:02}"), 'F' => format!("{y}-{m:02}-{d:02}"), '%' => "%".into(),
        _ => return None,
    })
}

/// Expand a format to plain text (styles dropped).
pub fn text(app: &App, fmt: &str, window: Option<usize>) -> String {
    spans(app, fmt, window, Style::default()).into_iter().map(|s| s.content.into_owned()).collect()
}

/// Expand a format to styled spans, `#[…]` applied over `base`.
pub fn spans(app: &App, fmt: &str, window: Option<usize>, base: Style) -> Vec<Span<'static>> {
    let window = window.unwrap_or(app.active);
    let mut out = Vec::new();
    let mut style = base;
    render(app, fmt, window, base, &mut style, &mut out, 0);
    out
}

/// The branch a `#{?cond,a,b}` takes, unexpanded (so its `#[…]` styles survive).
fn branch<'a>(app: &App, body: &'a str, window: usize) -> &'a str {
    let rest = &body[1..];
    let parts = commas(rest);
    let cond = parts.first().copied().unwrap_or("");
    let value = if cond.contains('#') { text(app, cond, Some(window)) } else { var(app, cond, window) };
    if truthy(&value) { parts.get(1).copied().unwrap_or("") } else { parts.get(2).copied().unwrap_or("") }
}

fn render(app: &App, fmt: &str, window: usize, base: Style, style: &mut Style, out: &mut Vec<Span<'static>>, depth: u8) {
    let mut run = String::new();
    let mut rest = fmt;
    macro_rules! flush { () => { if !run.is_empty() { out.push(Span::styled(std::mem::take(&mut run), *style)) } } }
    while let Some(c) = rest.chars().next() {
        rest = &rest[c.len_utf8()..];
        match c {
            '#' => {
                let Some(n) = rest.chars().next() else { run.push('#'); break };
                rest = &rest[n.len_utf8()..];
                match n {
                    '#' => run.push('#'),
                    ',' => run.push(','),
                    '}' => run.push('}'),
                    '{' => {
                        let (body, after) = braced(rest);
                        rest = after;
                        if body.starts_with('?') && depth < 8 {
                            flush!();
                            render(app, branch(app, body, window), window, base, style, out, depth + 1);
                        } else { run.push_str(&braces(app, body, window)) }
                    }
                    '[' => {
                        let end = rest.find(']').unwrap_or(rest.len());
                        let spec = &rest[..end];
                        rest = rest.get(end + 1..).unwrap_or("");
                        flush!();
                        *style = restyle(*style, base, spec);
                    }
                    c if c.is_ascii_alphabetic() => run.push_str(&var(app, &c.to_string(), window)),
                    other => { run.push('#'); run.push(other) }
                }
            }
            '%' => {
                let Some(n) = rest.chars().next() else { run.push('%'); break };
                match strftime(app, n) { Some(v) => { rest = &rest[n.len_utf8()..]; run.push_str(&v) } None => run.push('%') }
            }
            c => run.push(c),
        }
    }
    flush!();
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
            p => {
                if let Some(c) = p.strip_prefix("fg=") { style = match c { "default" => style.fg(base.fg.unwrap_or(ratatui::style::Color::Reset)), c => colour(c).map(|c| style.fg(c)).unwrap_or(style) } }
                if let Some(c) = p.strip_prefix("bg=") { style = match c { "default" => style.bg(base.bg.unwrap_or(ratatui::style::Color::Reset)), c => colour(c).map(|c| style.bg(c)).unwrap_or(style) } }
            }
        }
    }
    style
}
