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
        let no_color = std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty());
        let i = Color::Indexed;
        match base.as_str() {
            _ if no_color || base == "bw" => Fzf { gutter: Color::Reset, bg_plus: Color::Reset, fg_plus: Color::Reset, hl: Color::Reset, hl_plus: Color::Reset, pointer: Color::Reset, marker: Color::Reset, info: Color::Reset, prompt: Color::Reset, border: Color::Reset, header: Color::Reset, bw: true },
            "light" | "light256" => Fzf { gutter: i(251), bg_plus: i(251), fg_plus: Color::Reset, hl: i(25), hl_plus: i(25), pointer: i(161), marker: i(168), info: i(101), prompt: i(25), border: i(145), header: i(31), bw: false },
            "16" => Fzf { gutter: Color::Black, bg_plus: Color::Black, fg_plus: Color::Reset, hl: Color::Green, hl_plus: Color::Green, pointer: Color::Red, marker: Color::Magenta, info: Color::Gray, prompt: Color::Blue, border: Color::Black, header: Color::Cyan, bw: false },
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
        c => Style::default().fg(c),
    }
}
pub fn bold(color: Color) -> Style { Style::default().fg(color).add_modifier(Modifier::BOLD) }

pub fn engine_mark(engine: &str) -> (&'static str, Color) {
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
