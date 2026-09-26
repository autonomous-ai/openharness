//! The desktop's dark palette (desktop/lib/shared/theme/app_theme.dart) as terminal colours, and the
//! engine marks the rail draws. The background stays the terminal's own: this is a terminal first.

use ratatui::style::{Color, Modifier, Style};

use crate::fleet::State;

pub const ACCENT: Color = Color::Rgb(0x41, 0x66, 0xF2);
pub const ACCENT_SOFT: Color = Color::Rgb(0x8F, 0xA3, 0xF8);
pub const ONLINE: Color = Color::Rgb(0x3F, 0xB9, 0x50);
pub const WARN: Color = Color::Rgb(0xFF, 0xB0, 0x20);
pub const ATTENTION: Color = Color::Rgb(0xE0, 0xA9, 0x3B);
pub const DANGER: Color = Color::Rgb(0xF2, 0x54, 0x4B);
pub const TEAL: Color = Color::Rgb(0x2D, 0xD4, 0xBF);
pub const MUTED: Color = Color::Rgb(0x6E, 0x6E, 0x6E);
pub const SOFT: Color = Color::Rgb(0xA8, 0xA8, 0xA2);
pub const TEXT: Color = Color::Rgb(0xF5, 0xF5, 0xF5);
pub const LINE: Color = Color::Rgb(0x3A, 0x3A, 0x3A);
pub const SELECT: Color = Color::Rgb(0x26, 0x32, 0x4F);
pub const SELECT_TEXT: Color = Color::Rgb(0x2F, 0x4A, 0x9E);
pub const PANEL: Color = Color::Rgb(0x16, 0x17, 0x1A);

// fzf's default dark256 colours (fzf 0.67, measured from its output).
pub const FZF_GUTTER: Color = Color::Indexed(236);
pub const FZF_BG_PLUS: Color = Color::Indexed(236);
pub const FZF_FG_PLUS: Color = Color::Indexed(254);
pub const FZF_HL: Color = Color::Indexed(108);
pub const FZF_HL_PLUS: Color = Color::Indexed(151);
pub const FZF_POINTER: Color = Color::Indexed(161);
pub const FZF_MARKER: Color = Color::Indexed(168);
pub const FZF_INFO: Color = Color::Indexed(144);
pub const FZF_PROMPT: Color = Color::Indexed(110);
pub const FZF_BORDER: Color = Color::Indexed(59);
pub const FZF_HEADER: Color = Color::Indexed(109);

// tmux's default colours.
pub const TMUX_STATUS_BG: Color = Color::Green;
pub const TMUX_STATUS_FG: Color = Color::Black;
pub const TMUX_MESSAGE_BG: Color = Color::Yellow;
pub const TMUX_MESSAGE_FG: Color = Color::Black;
pub const TMUX_ACTIVE_BORDER: Color = Color::Green;
pub const TMUX_DISPLAY_PANES: Color = Color::Blue;
pub const TMUX_DISPLAY_PANES_ACTIVE: Color = Color::Red;

pub fn fg(color: Color) -> Style { Style::default().fg(color) }
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
