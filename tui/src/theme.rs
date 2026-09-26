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
pub struct Fzf { pub gutter: Color, pub bg_plus: Color, pub fg_plus: Color, pub hl: Color, pub hl_plus: Color, pub pointer: Color, pub marker: Color, pub info: Color, pub prompt: Color, pub border: Color, pub header: Color, pub bw: bool }

pub fn fzf() -> &'static Fzf {
    static FZF: std::sync::OnceLock<Fzf> = std::sync::OnceLock::new();
    FZF.get_or_init(|| {
        let opts = std::env::var("FZF_DEFAULT_OPTS").unwrap_or_default();
        let base = opts.split_whitespace().rev().find_map(|w| w.strip_prefix("--color=").or_else(|| w.strip_prefix("--color "))).map(|c| c.split(',').next().unwrap_or("").to_string()).unwrap_or_default();
        let no_color = no_color();
        let i = Color::Indexed;
        // A terminal that only has 16 colours gets fzf's 16-colour scheme, as fzf itself does.
        let base = if base.is_empty() && depth() < 256 { "16".to_string() } else { base };
        match base.as_str() {
            _ if no_color || base == "bw" => Fzf { gutter: Color::Reset, bg_plus: Color::Reset, fg_plus: Color::Reset, hl: Color::Reset, hl_plus: Color::Reset, pointer: Color::Reset, marker: Color::Reset, info: Color::Reset, prompt: Color::Reset, border: Color::Reset, header: Color::Reset, bw: true },
            "light" | "light256" => Fzf { gutter: i(251), bg_plus: i(251), fg_plus: i(237), hl: i(66), hl_plus: i(23), pointer: i(161), marker: i(168), info: i(101), prompt: i(25), border: i(145), header: i(31), bw: false },
            "16" => Fzf { gutter: Color::DarkGray, bg_plus: Color::DarkGray, fg_plus: Color::White, hl: Color::Green, hl_plus: Color::LightGreen, pointer: Color::Red, marker: Color::Magenta, info: Color::Yellow, prompt: Color::Blue, border: Color::DarkGray, header: Color::Cyan, bw: false },
            _ => Fzf { gutter: i(236), bg_plus: i(236), fg_plus: i(254), hl: i(108), hl_plus: i(151), pointer: i(161), marker: i(168), info: i(144), prompt: i(110), border: i(59), header: i(109), bw: false },
        }
    })
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
