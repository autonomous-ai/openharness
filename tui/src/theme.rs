//! The desktop's dark palette (desktop/lib/shared/theme/app_theme.dart) as terminal colours, and the
//! engine marks the rail draws. The background stays the terminal's own: this is a terminal first.

use ratatui::style::{Color, Modifier, Style};

use crate::fleet::State;

// Hn's own chrome speaks the 16 ANSI colours, as tmux's does: the terminal's theme decides what
// they look like, so it reads on dark, light and Solarized alike. SOFT and MUTED are not colours
// but emphasis (the terminal's dim), `fg` turns them into that.
pub const ACCENT: Color = Color::Blue;
pub const ACCENT_SOFT: Color = Color::Cyan;
pub const ONLINE: Color = Color::Green;
pub const WARN: Color = Color::Yellow;
pub const ATTENTION: Color = Color::Yellow;
pub const DANGER: Color = Color::Red;
pub const TEAL: Color = Color::Cyan;
pub const MUTED: Color = Color::Indexed(8);
pub const SOFT: Color = Color::Indexed(7);
pub const TEXT: Color = Color::Reset;

/// fzf's colours — its dark256 default, or what `--color=light|16|bw` in `$FZF_DEFAULT_OPTS` asks
/// for (and bw under NO_COLOR), so a list here looks like fzf does on this terminal.
pub struct Fzf { pub reverse: bool, pub pointer_char: String, pub marker_char: String, pub prompt_text: String, pub sixteen: bool, pub gutter: Color, pub bg_plus: Color, pub fg_plus: Color, pub hl: Color, pub hl_plus: Color, pub pointer: Color, pub marker: Color, pub info: Color, pub prompt: Color, pub border: Color, pub header: Color, pub bw: bool, pub attrs: FzfAttrs, pub border_dim: bool, pub gutter_dim: bool }

/// The attributes --color gives a slot (`hl+:-1:underline:reverse`, `prompt:bold:red`).
#[derive(Default, Clone, Copy)]
pub struct FzfAttrs { pub hl: Modifier, pub hl_plus: Modifier, pub fg_plus: Modifier, pub prompt: Modifier, pub pointer: Modifier, pub marker: Modifier, pub info: Modifier, pub header: Modifier, pub border: Modifier }

impl Fzf {
    /// The border, separator and scrollbar: the default colour dimmed where the theme has none
    /// (16 and bw), as fzf's.
    pub fn border_style(&self) -> Style { let st = if self.border_dim { Style::default().add_modifier(Modifier::DIM) } else { Style::default().fg(self.border) }; st.add_modifier(self.attrs.border) }
    pub fn prompt_style(&self) -> Style { Style::default().fg(self.prompt).add_modifier(self.attrs.prompt) }
    pub fn info_style(&self) -> Style { Style::default().fg(self.info).add_modifier(self.attrs.info) }
    pub fn header_style(&self) -> Style { Style::default().fg(self.header).add_modifier(self.attrs.header) }
    pub fn gutter_style(&self) -> Style { if self.gutter_dim { Style::default().add_modifier(Modifier::DIM) } else { Style::default().fg(self.gutter) } }
}

/// FZF_DEFAULT_OPTS_FILE's options, then FZF_DEFAULT_OPTS's, as fzf reads them.
pub fn default_opts() -> String {
    let file = std::env::var("FZF_DEFAULT_OPTS_FILE").ok().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    format!("{} {}", file.replace('\n', " "), std::env::var("FZF_DEFAULT_OPTS").unwrap_or_default())
}

/// A --color slot's value: `-1`, 0–255, #rrggbb, a name (bright-* too), and attributes, in any
/// order — the last colour wins, the attributes add up (`regular` clears them).
pub fn fzf_spec(v: &str) -> (Option<Color>, Modifier) {
    let (mut colour, mut attrs) = (None, Modifier::empty());
    for c in v.split(':') {
        match c {
            "regular" => attrs = Modifier::empty(),
            "bold" | "strong" => attrs |= Modifier::BOLD, "dim" => attrs |= Modifier::DIM, "italic" => attrs |= Modifier::ITALIC,
            "underline" => attrs |= Modifier::UNDERLINED, "blink" => attrs |= Modifier::SLOW_BLINK, "reverse" => attrs |= Modifier::REVERSED,
            "strikethrough" => attrs |= Modifier::CROSSED_OUT, "strip" | "" => {}
            other => { if let Some(c) = fzf_colour(other) { colour = Some(c) } }
        }
    }
    (colour, attrs)
}

pub fn fzf() -> &'static Fzf {
    static FZF: std::sync::OnceLock<Fzf> = std::sync::OnceLock::new();
    FZF.get_or_init(|| {
        let opts = words(&default_opts());
        // Every --color (either form), in order: a base scheme and slot:colour pairs.
        let mut specs: Vec<String> = Vec::new();
        let (mut reverse, mut pointer, mut marker, mut prompt) = (false, None, None, None);
        let mut i = 0;
        while i < opts.len() {
            let w = &opts[i];
            let (flag, value) = match w.split_once('=') { Some((f, v)) => (f.to_string(), Some(v.to_string())), None => (w.clone(), None) };
            let mut take = || value.clone().or_else(|| { i += 1; opts.get(i).cloned() });
            match flag.as_str() {
                "--color" => { if let Some(v) = take() { specs.push(v) } }
                "--layout" => { if let Some(v) = take() { reverse = v == "reverse" || v == "reverse-list" } }
                "--reverse-list" => reverse = true,
                "--reverse" => reverse = true,
                "--pointer" => pointer = take(),
                "--marker" => marker = take(),
                "--prompt" => prompt = take(),
                _ => {}
            }
            i += 1;
        }
        let base = specs.iter().flat_map(|s| s.split(',')).filter(|p| !p.contains(':')).last().unwrap_or("").to_string();
        let no_color = no_color();
        let i = Color::Indexed;
        // A terminal that only has 16 colours gets fzf's 16-colour scheme, as fzf itself does.
        let base = if base.is_empty() && depth() < 256 { "16".to_string() } else { base };
        let mut z = match base.as_str() {
            _ if no_color || base == "bw" => Fzf { reverse: false, pointer_char: String::new(), marker_char: String::new(), prompt_text: String::new(), sixteen: false, gutter: Color::Reset, bg_plus: Color::Reset, fg_plus: Color::Reset, hl: Color::Reset, hl_plus: Color::Reset, pointer: Color::Reset, marker: Color::Reset, info: Color::Reset, prompt: Color::Reset, border: Color::Reset, header: Color::Reset, bw: true, attrs: FzfAttrs::default(), border_dim: true, gutter_dim: true },
            "light" | "light256" => Fzf { reverse: false, pointer_char: String::new(), marker_char: String::new(), prompt_text: String::new(), sixteen: false, gutter: i(251), bg_plus: i(251), fg_plus: i(237), hl: i(66), hl_plus: i(23), pointer: i(161), marker: i(168), info: i(101), prompt: i(25), border: i(145), header: i(31), bw: false, attrs: FzfAttrs::default(), border_dim: false, gutter_dim: false },
            "16" => Fzf { reverse: false, pointer_char: String::new(), marker_char: String::new(), prompt_text: String::new(), sixteen: true, gutter: Color::DarkGray, bg_plus: Color::DarkGray, fg_plus: Color::White, hl: Color::Green, hl_plus: Color::LightGreen, pointer: Color::Red, marker: Color::Magenta, info: Color::Yellow, prompt: Color::Blue, border: Color::DarkGray, header: Color::Cyan, bw: false, attrs: FzfAttrs::default(), border_dim: true, gutter_dim: false },
            _ => Fzf { reverse: false, pointer_char: String::new(), marker_char: String::new(), prompt_text: String::new(), sixteen: false, gutter: i(236), bg_plus: i(236), fg_plus: i(254), hl: i(108), hl_plus: i(151), pointer: i(161), marker: i(168), info: i(144), prompt: i(110), border: i(59), header: i(109), bw: false, attrs: FzfAttrs::default(), border_dim: false, gutter_dim: false },
        };
        // Slot overrides: --color=hl:204,bg+:236,pointer:#ff0000 …
        if !z.bw {
            let entries = || specs.iter().flat_map(|s| s.split([',', ' ', '\t'])).map(|p| p.trim().to_lowercase()).collect::<Vec<_>>();
            let gutter_given = entries().iter().any(|p| p.starts_with("gutter:"));
            for entry in entries() {
                let Some((slot, spec)) = entry.split_once(':') else { continue };
                let (colour, attrs) = fzf_spec(spec);
                let a = &mut z.attrs;
                match slot {
                    "hl" => a.hl = attrs, "hl+" => a.hl_plus = attrs, "fg+" | "current-fg" => a.fg_plus = attrs, "prompt" => a.prompt = attrs,
                    "pointer" => a.pointer = attrs, "marker" => a.marker = attrs, "info" => a.info = attrs, "header" => a.header = attrs,
                    "border" | "separator" | "scrollbar" | "list-border" => a.border = attrs,
                    _ => {}
                }
                let Some(c) = colour else { continue };
                match slot {
                    // fzf's gutter is bg+ unless it is given.
                    "hl" => z.hl = c, "hl+" => z.hl_plus = c, "fg+" | "current-fg" => z.fg_plus = c, "bg+" | "current-bg" => { z.bg_plus = c; if !gutter_given { z.gutter = c } }
                    "gutter" => { z.gutter = c; z.gutter_dim = false }
                    "pointer" => z.pointer = c, "marker" => z.marker = c, "info" => z.info = c,
                    "prompt" => z.prompt = c, "border" | "separator" | "scrollbar" | "list-border" => { z.border = c; z.border_dim = false }
                    "header" => z.header = c,
                    _ => {}
                }
            }
        }
        z.reverse = reverse;
        z.pointer_char = pointer.unwrap_or_else(|| "▌".into());
        z.marker_char = marker.unwrap_or_else(|| "┃".into());
        z.prompt_text = prompt.unwrap_or_else(|| "> ".into());
        z
    })
}

/// The rest of FZF_DEFAULT_OPTS that shapes a list: --cycle, --exact, -i/+i, --no-separator,
/// --ellipsis, fg:/bg: colours, and --bind key:action pairs.
pub struct FzfOpts { pub info_mode: String, pub prompt_top: bool, pub header_first: bool, pub border: Option<String>, pub no_sort: bool, pub tac: bool, pub tiebreak: Vec<crate::fzf::Tiebreak>, pub selected_bg: Option<Color>, pub info_hidden: bool, pub info_right: bool, pub separator_char: String, pub scrollbar: Option<String>, pub info_inline: bool, pub cycle: bool, pub exact: bool, pub case: Option<bool>, pub separator: bool, pub ellipsis: String, pub fg: Option<Color>, pub bg: Option<Color>, pub list_bg: Option<Color>, pub binds: Vec<(String, String)>, pub hscroll: bool, pub hscroll_off: usize, pub highlight_line: bool, pub scroll_off: usize }

pub fn fzf_opts() -> &'static FzfOpts {
    static OPTS: std::sync::OnceLock<FzfOpts> = std::sync::OnceLock::new();
    OPTS.get_or_init(|| {
        let opts = words(&default_opts());
        let mut o = FzfOpts { info_mode: "default".into(), prompt_top: false, header_first: false, border: None, no_sort: false, tac: false, tiebreak: vec![crate::fzf::Tiebreak::Length], selected_bg: None, info_hidden: false, info_right: false, separator_char: "─".into(), scrollbar: Some("│".into()), info_inline: false, cycle: false, exact: false, case: None, separator: true, ellipsis: "··".into(), fg: None, bg: None, list_bg: None, binds: Vec::new(), hscroll: true, hscroll_off: 10, highlight_line: false, scroll_off: 3 };
        let mut i = 0;
        while i < opts.len() {
            let w = &opts[i];
            let (flag, value) = match w.split_once('=') { Some((f, v)) => (f.to_string(), Some(v.to_string())), None => (w.clone(), None) };
            let mut take = || value.clone().or_else(|| { i += 1; opts.get(i).cloned() });
            match flag.as_str() {
                "--cycle" => o.cycle = true, "--no-cycle" => o.cycle = false,
                "--hscroll" => o.hscroll = true, "--no-hscroll" => o.hscroll = false,
                "--hscroll-off" => { if let Some(v) = take() { o.hscroll_off = v.parse().unwrap_or(10) } }
                "--highlight-line" => o.highlight_line = true, "--no-highlight-line" => o.highlight_line = false,
                "--scroll-off" => { if let Some(v) = take() { o.scroll_off = v.parse().unwrap_or(3) } }
                "--inline-info" => o.info_inline = true,
                "--no-info" => { o.info_hidden = true; o.info_mode = "hidden".into() }
                "--info" => { if let Some(v) = take() { let v = v.split(':').next().unwrap_or("").to_string(); o.info_inline = v.starts_with("inline"); o.info_right = v == "inline-right"; o.info_hidden = v == "hidden"; o.info_mode = v } }
                "--layout" => { if let Some(v) = take() { o.prompt_top = v == "reverse" } }
                "--reverse" => o.prompt_top = true,
                "--header-first" => o.header_first = true,
                "--border" => o.border = Some(value.clone().unwrap_or_else(|| "rounded".into())),
                "--no-border" => o.border = None,
                "--no-sort" | "+s" => o.no_sort = true,
                "--tac" => o.tac = true,
                // --tiebreak=length,begin,…: after the score, in that order (index: the input's).
                "--tiebreak" => {
                    if let Some(v) = take() {
                        use crate::fzf::Tiebreak::*;
                        o.tiebreak = v.split(',').filter_map(|c| match c.trim().to_lowercase().as_str() { "length" => Some(Length), "chunk" => Some(Chunk), "pathname" => Some(Pathname), "begin" => Some(Begin), "end" => Some(End), _ => None }).collect();
                    }
                }
                "--separator" => { if let Some(v) = take() { o.separator_char = v; o.separator = !o.separator_char.is_empty() } }
                "--scrollbar" => { if let Some(v) = take() { o.scrollbar = v.chars().next().map(|c| c.to_string()) } }
                "--no-scrollbar" => o.scrollbar = None,
                "-e" | "--exact" => o.exact = true, "--no-exact" => o.exact = false,
                "-i" | "--ignore-case" => o.case = Some(false), "+i" | "--no-ignore-case" => o.case = Some(true), "--smart-case" => o.case = None,
                "--no-separator" => o.separator = false,
                "--ellipsis" => { if let Some(v) = take() { o.ellipsis = v } }
                "--color" => {
                    if let Some(v) = take() {
                        for (slot, c) in v.split(',').filter_map(|p| p.split_once(':')) {
                            match slot { "fg" | "list-fg" => o.fg = fzf_spec(c).0, "bg" => o.bg = fzf_spec(c).0, "list-bg" => o.list_bg = fzf_spec(c).0, "selected-bg" => o.selected_bg = fzf_spec(c).0, _ => {} }
                        }
                    }
                }
                "--bind" => {
                    if let Some(v) = take() {
                        // Commas inside an action's (…) belong to it.
                        let (mut depth, mut start) = (0, 0);
                        let mut parts = Vec::new();
                        for (i, c) in v.char_indices() { match c { '(' | '[' | '{' => depth += 1, ')' | ']' | '}' => depth -= 1, ',' if depth == 0 => { parts.push(&v[start..i]); start = i + 1 } _ => {} } }
                        parts.push(&v[start..]);
                        for pair in parts { if let Some((k, a)) = pair.split_once(':') { o.binds.push((k.replace("return", "enter"), a.to_string())) } }
                    }
                }
                _ => {}
            }
            i += 1;
        }
        if no_color() { o.fg = None; o.bg = None }
        o
    })
}

/// fzf's colour values: 0-255, #rrggbb, a name, -1 (the default).
fn fzf_colour(v: &str) -> Option<Color> {
    let v = v.split(':').next().unwrap_or(v);
    if v == "-1" { return Some(Color::Reset) }
    let named = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
    if let Some(n) = named.iter().position(|c| *c == v) { return Some(Color::Indexed(n as u8)) }
    if let Some(n) = v.strip_prefix("bright-").and_then(|b| named.iter().position(|c| *c == b)) { return Some(Color::Indexed(n as u8 + 8)) }
    if v == "gray" || v == "grey" { return Some(Color::Indexed(8)) }
    if let Ok(n) = v.parse::<u8>() { return Some(Color::Indexed(n)) }
    if let Some(hex) = v.strip_prefix('#') { let n = u32::from_str_radix(hex, 16).ok()?; return Some(Color::Rgb((n >> 16) as u8, (n >> 8) as u8, n as u8)) }
    crate::tmuxconf::colour(v)
}

/// Split options the way a shell would (quotes, backslashes).
fn words(s: &str) -> Vec<String> {
    let (mut out, mut w, mut q, mut any) = (Vec::new(), String::new(), None::<char>, false);
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match (q, c) {
            (Some(x), c) if c == x => q = None,
            (Some(_), c) => w.push(c),
            (None, '"' | '\'') => { q = Some(c); any = true }
            (None, '\\') => { if let Some(n) = chars.next() { w.push(n); any = true } }
            (None, c) if c.is_whitespace() => { if any || !w.is_empty() { out.push(std::mem::take(&mut w)); any = false } }
            (None, c) => { w.push(c); any = true }
        }
    }
    if any || !w.is_empty() { out.push(w) }
    out
}

// tmux's default colours.
pub const TMUX_STATUS_BG: Color = Color::Green;
pub const TMUX_STATUS_FG: Color = Color::Black;
pub const TMUX_MESSAGE_BG: Color = Color::Yellow;
pub const TMUX_MESSAGE_FG: Color = Color::Black;
pub const TMUX_ACTIVE_BORDER: Color = Color::Green;
pub const TMUX_DISPLAY_PANES: Color = Color::Blue;
pub const TMUX_DISPLAY_PANES_ACTIVE: Color = Color::Red;

pub fn fg(color: Color) -> Style {
    match color {
        MUTED | SOFT => Style::default().add_modifier(Modifier::DIM),
        _ if no_color() => Style::default(),
        c => Style::default().fg(depth_fit(c)),
    }
}

/// NO_COLOR (no-color.org): hn's own chrome keeps its bold and dim, drops its colours. (The panes
/// are other programs' screens and keep theirs.)
pub fn no_color() -> bool { std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty()) }

/// How many colours the terminal has: 16777216 with COLORTERM=truecolor|24bit, 256 with a
/// *256color TERM, else 16.
pub fn depth() -> u32 {
    static DEPTH: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *DEPTH.get_or_init(|| {
        let ct = std::env::var("COLORTERM").unwrap_or_default();
        let term = std::env::var("TERM").unwrap_or_default();
        if ct == "truecolor" || ct == "24bit" { 1 << 24 } else if term.contains("256") || term.contains("kitty") || term.contains("ghostty") || term.contains("wezterm") || term.contains("alacritty") || term.contains("tmux") { 256 } else if term.is_empty() { 256 } else { 16 }
    })
}

/// Any colour as one of the 16.
pub fn to16(c: Color) -> Color {
    match c {
        Color::Rgb(r, g, b) => nearest16(r, g, b),
        Color::Indexed(n) if n >= 16 => {
            let (r, g, b) = if n >= 232 { let v = (8 + 10 * (n - 232) as u16) as u8; (v, v, v) } else { let n = n - 16; let f = |x: u8| if x == 0 { 0 } else { 55 + 40 * x }; (f(n / 36), f((n / 6) % 6), f(n % 6)) };
            nearest16(r, g, b)
        }
        c => c,
    }
}

fn nearest16(r: u8, g: u8, b: u8) -> Color {
    let bit = |v: u8| v > 110;
    match (bit(r), bit(g), bit(b)) {
        (false, false, false) => Color::DarkGray, (true, false, false) => Color::Red, (false, true, false) => Color::Green, (true, true, false) => Color::Yellow,
        (false, false, true) => Color::Blue, (true, false, true) => Color::Magenta, (false, true, true) => Color::Cyan, (true, true, true) => Color::Reset,
    }
}

/// A brand colour (the engine marks) brought down to what the terminal has.
pub fn depth_fit(c: Color) -> Color {
    match c {
        Color::Rgb(r, g, b) if depth() < (1 << 24) => {
            if depth() >= 256 {
                let q = |v: u8| ((v as u16 * 5 + 127) / 255) as u8;
                Color::Indexed(16 + 36 * q(r) + 6 * q(g) + q(b))
            } else {
                // The nearest of the 8 base colours.
                let bit = |v: u8| v > 110;
                match (bit(r), bit(g), bit(b)) {
                    (false, false, false) => Color::DarkGray, (true, false, false) => Color::Red, (false, true, false) => Color::Green, (true, true, false) => Color::Yellow,
                    (false, false, true) => Color::Blue, (true, false, true) => Color::Magenta, (false, true, true) => Color::Cyan, (true, true, true) => Color::Reset,
                }
            }
        }
        Color::Indexed(n) if n > 15 && depth() < 256 => Color::Reset,
        c => c,
    }
}
pub fn bold(color: Color) -> Style { fg(color).add_modifier(Modifier::BOLD) }

pub fn engine_mark(engine: &str) -> (&'static str, Color) {
    let (mark, color) = engine_mark_raw(engine);
    (mark, paint(color))
}

/// A colour as this terminal can show it: none under NO_COLOR, the nearest it has otherwise.
pub fn paint(c: Color) -> Color { if no_color() { Color::Reset } else { depth_fit(c) } }

fn engine_mark_raw(engine: &str) -> (&'static str, Color) {
    match engine {
        "claude" => ("✳", Color::Rgb(0xD9, 0x77, 0x57)),
        "codex" => ("◎", Color::Rgb(0x10, 0xA3, 0x7F)),
        "cursor" => ("▲", TEXT),
        "opencode" => ("▣", Color::Rgb(0xF5, 0xA7, 0x42)),
        "pi" => ("π", ACCENT_SOFT),
        "hermes" => ("☿", Color::Rgb(0xC7, 0x92, 0xEA)),
        "amp" => ("ϟ", DANGER),
        "kilo" => ("K", Color::Rgb(0xF7, 0xDF, 0x1E)),
        "grok" => ("X", TEXT),
        "devin" => ("◆", TEAL),
        "copilot" => ("◉", Color::Rgb(0x8B, 0x94, 0x9E)),
        "commandcode" => ("⌘", ACCENT),
        "muse" => ("♪", ATTENTION),
        "agy" => ("◈", Color::Rgb(0x42, 0x85, 0xF4)),
        "terminal" => ("❯", SOFT),
        _ => ("●", SOFT),
    }
}

pub fn engine_label(engine: &str) -> &str {
    match engine {
        "claude" => "Claude Code", "codex" => "Codex", "cursor" => "Cursor", "opencode" => "OpenCode", "pi" => "Pi",
        "hermes" => "Hermes", "amp" => "Amp", "kilo" => "Kilo", "grok" => "Grok", "devin" => "Devin", "copilot" => "Copilot",
        "commandcode" => "Command Code", "muse" => "Muse", "agy" => "Antigravity", "terminal" => "Terminal",
        other => other,
    }
}

/// The state dot and word the desktop's tiles and rows use.
pub fn state_mark(state: State) -> (&'static str, &'static str, Color) {
    let (dot, word, color) = state_mark_raw(state);
    (dot, word, if color == MUTED { color } else { paint(color) })
}

fn state_mark_raw(state: State) -> (&'static str, &'static str, Color) {
    match state {
        State::NeedsInput => ("◆", "needs input", ATTENTION),
        State::Working => ("●", "working", ACCENT_SOFT),
        State::Done => ("●", "done", ONLINE),
        State::Ready => ("○", "ready", ONLINE),
        State::Starting => ("◌", "starting", WARN),
        State::Failed => ("✕", "failed", DANGER),
        State::Paused => ("‖", "paused", MUTED),
        State::Offline => ("·", "offline", MUTED),
    }
}

/// A spinner frame for things in motion (working dots, connecting cards).
pub fn spinner(tick: u64) -> &'static str {
    const FRAMES: [&str; 8] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
    FRAMES[(tick as usize) % FRAMES.len()]
}
