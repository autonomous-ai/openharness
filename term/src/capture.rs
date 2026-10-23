//! capture-pane's text, as tmux's cmd_capture_pane_history and grid_string_cells make it from a
//! pane's grid: each line from -S to -E, trailing blanks trimmed (unless -N or -J), wrapped lines
//! joined (-J), attributes and colours as escape sequences (-e, as grid_string_cells_code writes
//! them, carried from line to line), and those escapes and backslashes escaped (-C).
//!
//! alacritty keeps no count of the cells a line has had written (tmux's cellused), so a line ends
//! at its last cell that is not a default blank — unless it wrapped, when every cell was written
//! and it runs to the pane's width (a space in its last column is kept).

use alacritty_terminal::grid::{Dimensions, Grid};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::vte::ansi::{Color, NamedColor};


/// grid_string_cells' flags, as capture-pane sets them.
#[derive(Clone, Copy, Default, Debug)]
pub struct Flags2 {
    /// -J: wrapped lines joined, and no trimming.
    pub join: bool,
    /// -e: attributes and colours as escape sequences.
    pub sequences: bool,
    /// -C: those escape sequences (and backslashes) escaped, `\033`.
    pub escape: bool,
    /// Not -T (and not -J): a line runs to the pane's width, empty cells included.
    pub empty_cells: bool,
    /// Not -N (and not -J): trailing spaces trimmed.
    pub trim: bool,
}

/// A cell as tmux's grid keeps what grid_string_cells_code compares: its colours (8 the
/// default, 0–7 and 90–97 plain, COLOUR_FLAG_256 or COLOUR_FLAG_RGB set) and attributes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Look { fg: u32, bg: u32, us: u32, attr: u16 }

const FLAG_256: u32 = 0x0100_0000;
const FLAG_RGB: u32 = 0x0200_0000;

impl Default for Look {
    fn default() -> Look { Look { fg: 8, bg: 8, us: 8, attr: 0 } }
}

// GRID_ATTR_* in the order grid_string_cells_code writes them, and their codes.
const ATTRS: [(u16, u32); 13] = [
    (1 << 0, 1),   // BRIGHT
    (1 << 1, 2),   // DIM
    (1 << 2, 3),   // ITALICS
    (1 << 3, 4),   // UNDERSCORE
    (1 << 4, 5),   // BLINK
    (1 << 5, 7),   // REVERSE
    (1 << 6, 8),   // HIDDEN
    (1 << 7, 9),   // STRIKETHROUGH
    (1 << 8, 42),  // UNDERSCORE_2
    (1 << 9, 43),  // UNDERSCORE_3
    (1 << 10, 44), // UNDERSCORE_4
    (1 << 11, 45), // UNDERSCORE_5
    (1 << 12, 53), // OVERLINE (tmux capture-pane spells this 5:3)
];

fn colour(c: Color, default: u32) -> u32 {
    match c {
        Color::Named(n) => match n {
            NamedColor::Black => 0, NamedColor::Red => 1, NamedColor::Green => 2, NamedColor::Yellow => 3,
            NamedColor::Blue => 4, NamedColor::Magenta => 5, NamedColor::Cyan => 6, NamedColor::White => 7,
            NamedColor::BrightBlack => 90, NamedColor::BrightRed => 91, NamedColor::BrightGreen => 92, NamedColor::BrightYellow => 93,
            NamedColor::BrightBlue => 94, NamedColor::BrightMagenta => 95, NamedColor::BrightCyan => 96, NamedColor::BrightWhite => 97,
            NamedColor::DimBlack => 0, NamedColor::DimRed => 1, NamedColor::DimGreen => 2, NamedColor::DimYellow => 3,
            NamedColor::DimBlue => 4, NamedColor::DimMagenta => 5, NamedColor::DimCyan => 6, NamedColor::DimWhite => 7,
            _ => default,
        },
        Color::Indexed(i) => FLAG_256 | i as u32,
        Color::Spec(rgb) => FLAG_RGB | (rgb.r as u32) << 16 | (rgb.g as u32) << 8 | rgb.b as u32,
    }
}

fn look(cell: &Cell) -> Look {
    let f = cell.flags;
    let mut attr = 0u16;
    if f.contains(Flags::BOLD) { attr |= 1 << 0 }
    if f.contains(Flags::DIM) { attr |= 1 << 1 }
    if f.contains(Flags::ITALIC) { attr |= 1 << 2 }
    if f.contains(Flags::UNDERLINE) { attr |= 1 << 3 }
    if f.contains(Flags::BLINK) { attr |= 1 << 4 }
    if f.contains(Flags::INVERSE) { attr |= 1 << 5 }
    if f.contains(Flags::HIDDEN) { attr |= 1 << 6 }
    if f.contains(Flags::STRIKEOUT) { attr |= 1 << 7 }
    if f.contains(Flags::DOUBLE_UNDERLINE) { attr |= 1 << 8 }
    if f.contains(Flags::UNDERCURL) { attr |= 1 << 9 }
    if f.contains(Flags::DOTTED_UNDERLINE) { attr |= 1 << 10 }
    if f.contains(Flags::DASHED_UNDERLINE) { attr |= 1 << 11 }
    if f.contains(Flags::OVERLINE) { attr |= 1 << 12 }
    Look { fg: colour(cell.fg, 8), bg: colour(cell.bg, 8), us: cell.underline_color().map(|c| colour(c, 8)).unwrap_or(8), attr }
}

/// grid_string_cells_fg / _bg / _us: a colour's SGR parameters.
fn params(c: u32, base: u32) -> Vec<u32> {
    if c & FLAG_256 != 0 { return vec![base + 8, 5, c & 0xff] }
    if c & FLAG_RGB != 0 { return vec![base + 8, 2, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff] }
    match (base, c) {
        // The underline colour has no plain form.
        (50, _) => vec![],
        (_, 0..=7) => vec![base + c],
        (_, 8) => vec![base + 9],
        (30, 90..=97) => vec![c],
        (40, 90..=97) => vec![c + 10],
        _ => vec![],
    }
}

/// grid_string_cells_code: the escape sequences that take the terminal from [last] to [now].
fn code(last: &Look, now: &Look, escape: bool) -> String {
    let esc = if escape { "\\033[" } else { "\x1b[" };
    let mut s: Vec<u32> = Vec::new();
    let mut last_attr = last.attr;
    // Any attribute removed (or the underline colour gone back to default): begin with 0.
    if ATTRS.iter().any(|(m, _)| now.attr & m == 0 && last_attr & m != 0) || (last.us != 8 && now.us == 8) {
        s.push(0);
        last_attr = 0;
    }
    for (m, code) in ATTRS { if now.attr & m != 0 && last_attr & m == 0 { s.push(code) } }
    let mut out = String::new();
    if !s.is_empty() {
        out.push_str(esc);
        let parts: Vec<String> = s.iter().map(|c| if *c < 10 { c.to_string() } else { format!("{}:{}", c / 10, c % 10) }).collect();
        out.push_str(&parts.join(";"));
        out.push('m');
    }
    let reset = s.first() == Some(&0);
    for (new, old) in [(params(now.fg, 30), params(last.fg, 30)), (params(now.bg, 40), params(last.bg, 40)), (params(now.us, 50), params(last.us, 50))] {
        // grid_string_cells_add_code.
        if new.is_empty() { continue }
        if !reset && new == old { continue }
        if reset && (new[0] == 49 || new[0] == 39) { continue }
        out.push_str(esc);
        out.push_str(&new.iter().map(u32::to_string).collect::<Vec<_>>().join(";"));
        out.push('m');
    }
    out
}

/// Blank as a never-written cell is: a space (or nothing) with no colour or attribute.
fn blank(cell: &Cell) -> bool {
    (cell.c == ' ' || cell.c == '\0') && look(cell) == Look::default() && cell.zerowidth().is_none()
}

/// cmd_capture_pane_history: lines [top] to [bottom] (alacritty's numbering: 0 the screen's first
/// line, the history above it negative), each followed by a newline — a wrapped one not, with -J.
pub fn history(grid: &Grid<Cell>, top: i32, bottom: i32, f: Flags2) -> String {
    let cols = grid.columns();
    let mut out = String::new();
    // The lastgc, carried from line to line as tmux's is.
    let mut last = Look::default();
    for line in top..=bottom {
        let row = &grid[Line(line)];
        let wrapped = cols > 0 && row[Column(cols - 1)].flags.contains(Flags::WRAPLINE);
        // tmux's cellused: every cell of a row that wrapped was written, blank or not.
        let used = if wrapped { cols } else {
            (0..cols).rposition(|c| !blank(&row[Column(c)])).map(|c| c + 1).unwrap_or(0)
        };
        let end = if f.empty_cells { cols } else { used };
        let mut s = String::new();
        for c in 0..end {
            let cell = &row[Column(c)];
            if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) { continue }
            if f.sequences {
                let now = look(cell);
                s.push_str(&code(&last, &now, f.escape));
                last = now;
            }
            let ch = if cell.c == '\0' { ' ' } else { cell.c };
            if f.escape && ch == '\\' { s.push_str("\\\\") } else { s.push(ch) }
            if let Some(z) = cell.zerowidth() { s.extend(z.iter()) }
        }
        if f.trim { while s.ends_with(' ') { s.pop(); } }
        out.push_str(&s);
        if !f.join || !wrapped { out.push('\n') }
    }
    out
}

/// -S / -E as tmux reads them: `-` the history's first line (or the screen's last), a number
/// counted from the screen's top (negative into the history, held to what there is), anything
/// else the default. [start]: the default is the screen's first line, else its last.
pub fn line_bounds(grid: &Grid<Cell>, value: Option<&str>, start: bool, parse: impl Fn(&str) -> Option<i64>) -> i32 {
    let (hsize, sy) = (grid.history_size() as i64, grid.screen_lines() as i64);
    let last = sy - 1;
    let n = match value {
        Some("-") => return if start { -(hsize as i32) } else { last as i32 },
        Some(v) => parse(v),
        None => None,
    };
    let n = match n { Some(n) => n, None => return if start { 0 } else { last as i32 } };
    // top = hsize + n, held between the history's first line and the screen's last.
    (if n < -hsize { -hsize } else { n }).min(last) as i32
}

/// What `tmux capture-pane -p [-e] -J [-S -<n>]` prints (cli/src/lib/tmuxCapture.ts): joined, untrimmed,
/// from `n` lines into the history (bounded 20..=300 like the daemon) or the visible screen alone.
pub fn capture_pane(grid: &Grid<Cell>, history_lines: Option<u32>, ansi: bool) -> String {
    let screen = grid.screen_lines() as i32;
    let top = match history_lines {
        Some(n) => -(n.clamp(20, 300) as i32).min(grid.history_size() as i32),
        None => 0,
    };
    let flags = Flags2 { join: true, sequences: ansi, escape: false, empty_cells: false, trim: false };
    history(grid, top, screen - 1, flags)
}

/// Attribute encoding shared with the persistent local terminal's reconnect keyframe.
pub fn cell_style(cell: &Cell) -> String { code(&Look::default(), &look(cell), false) }
pub fn cell_style_change(last: &Cell, cell: &Cell) -> String { code(&look(last), &look(cell), false) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_as_grid_string_cells_code_writes_them() {
        let plain = Look::default();
        let red_bold = Look { fg: 1, attr: 1, ..plain };
        assert_eq!(code(&plain, &red_bold, false), "\x1b[1m\x1b[31m");
        // An attribute gone: 0 first, then only colours that are not the default.
        assert_eq!(code(&red_bold, &Look { fg: 1, ..plain }, false), "\x1b[0m\x1b[31m");
        assert_eq!(code(&red_bold, &plain, false), "\x1b[0m");
        assert_eq!(code(&plain, &Look { fg: FLAG_256 | 208, bg: 94, ..plain }, true), "\\033[38;5;208m\\033[104m");
        assert_eq!(code(&plain, &Look { attr: 1 << 9, ..plain }, false), "\x1b[4:3m");
        assert_eq!(code(&plain, &Look { fg: FLAG_RGB | 0x10_20_30, ..plain }, false), "\x1b[38;2;16;32;48m");
    }

    #[test]
    fn capture_pane_joins_wrapped_lines() {
        use alacritty_terminal::term::{Config, Term, test::TermSize};
        use alacritty_terminal::vte::ansi::Processor;
        let mut term = Term::new(Config::default(), &TermSize::new(10, 5), alacritty_terminal::event::VoidListener);
        let mut parser: Processor = Processor::new();
        parser.advance(&mut term, b"0123456789abc\r\nnext");
        let out = capture_pane(term.grid(), None, false);
        assert!(out.starts_with("0123456789abc\nnext\n"), "{out:?}");
    }

    #[test]
    fn capture_pane_holds_history_start_to_what_exists() {
        use alacritty_terminal::term::{Config, Term, test::TermSize};
        use alacritty_terminal::vte::ansi::Processor;
        let mut term = Term::new(Config::default(), &TermSize::new(10, 3), alacritty_terminal::event::VoidListener);
        let mut parser: Processor = Processor::new();
        parser.advance(&mut term, b"a\r\nb\r\nc\r\nd\r\ne");
        // Two lines scrolled off; -S -20 reaches only as far back as they.
        assert_eq!(capture_pane(term.grid(), Some(20), false), "a\nb\nc\nd\ne\n");
        assert_eq!(capture_pane(term.grid(), None, false), "c\nd\ne\n");
        // No history at all must not index above the grid.
        let fresh = Term::new(Config::default(), &TermSize::new(10, 3), alacritty_terminal::event::VoidListener);
        assert_eq!(capture_pane(fresh.grid(), Some(20), false), "\n\n\n");
    }

    /// tmux 3.8 on a 10×6 pane, for `abcdefghi world\r\n\e[31mredredred\e[0m next\r\nend`: a
    /// row that wrapped keeps the space in its last column (`capture-pane -p -J`, `-p -e -J`,
    /// `-p -e -N -T`).
    #[test]
    fn a_wrapped_row_runs_to_the_width() {
        use alacritty_terminal::term::{Config, Term, test::TermSize};
        use alacritty_terminal::vte::ansi::Processor;
        let mut term = Term::new(Config::default(), &TermSize::new(10, 6), alacritty_terminal::event::VoidListener);
        let mut parser: Processor = Processor::new();
        parser.advance(&mut term, b"abcdefghi world\r\n\x1b[31mredredred\x1b[0m next\r\nend");
        let flags = |join, sequences| Flags2 { join, sequences, ..Flags2::default() };
        assert_eq!(history(term.grid(), 0, 5, flags(true, false)), "abcdefghi world\nredredred next\nend\n\n");
        assert_eq!(history(term.grid(), 0, 5, flags(true, true)), "abcdefghi world\n\x1b[31mredredred\x1b[39m next\nend\n\n");
        assert_eq!(
            history(term.grid(), 0, 5, flags(false, true)),
            "abcdefghi \nworld\n\x1b[31mredredred\x1b[39m \nnext\nend\n\n"
        );
    }
}
