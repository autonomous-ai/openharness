//! capture-pane's text, as tmux's cmd_capture_pane_history and grid_string_cells make it from a
//! pane's grid: each line from -S to -E, trailing blanks trimmed (unless -N or -J), wrapped lines
//! joined (-J), attributes and colours as escape sequences (-e, as grid_string_cells_code writes
//! them, carried from line to line), and those escapes and backslashes escaped (-C).
//!
//! alacritty keeps no count of the cells a line has had written (tmux's cellused), so a line ends
//! at its last cell that is not a default blank.

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::vte::ansi::{Color, NamedColor};

use crate::pane::Pane;

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
const ATTRS: [(u16, u32); 12] = [
    (1 << 0, 1),   // BRIGHT
    (1 << 1, 2),   // DIM
    (1 << 2, 3),   // ITALICS
    (1 << 3, 4),   // UNDERSCORE
    (1 << 4, 5),   // BLINK (alacritty keeps none)
    (1 << 5, 7),   // REVERSE
    (1 << 6, 8),   // HIDDEN
    (1 << 7, 9),   // STRIKETHROUGH
    (1 << 8, 42),  // UNDERSCORE_2
    (1 << 9, 43),  // UNDERSCORE_3
    (1 << 10, 44), // UNDERSCORE_4
    (1 << 11, 45), // UNDERSCORE_5
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
    if f.contains(Flags::INVERSE) { attr |= 1 << 5 }
    if f.contains(Flags::HIDDEN) { attr |= 1 << 6 }
    if f.contains(Flags::STRIKEOUT) { attr |= 1 << 7 }
    if f.contains(Flags::DOUBLE_UNDERLINE) { attr |= 1 << 8 }
    if f.contains(Flags::UNDERCURL) { attr |= 1 << 9 }
    if f.contains(Flags::DOTTED_UNDERLINE) { attr |= 1 << 10 }
    if f.contains(Flags::DASHED_UNDERLINE) { attr |= 1 << 11 }
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
pub fn history(pane: &Pane, top: i32, bottom: i32, f: Flags2) -> String {
    let grid = pane.term.grid();
    let cols = grid.columns();
    let mut out = String::new();
    // The lastgc, carried from line to line as tmux's is.
    let mut last = Look::default();
    for line in top..=bottom {
        let row = &grid[Line(line)];
        let used = (0..cols).rposition(|c| !blank(&row[Column(c)])).map(|c| c + 1).unwrap_or(0);
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
        let wrapped = cols > 0 && row[Column(cols - 1)].flags.contains(Flags::WRAPLINE);
        if !f.join || !wrapped { out.push('\n') }
    }
    out
}

/// -S / -E as tmux reads them: `-` the history's first line (or the screen's last), a number
/// counted from the screen's top (negative into the history, held to what there is), anything
/// else the default. [start]: the default is the screen's first line, else its last.
pub fn line_of(pane: &Pane, value: Option<&str>, start: bool) -> i32 {
    let grid = pane.term.grid();
    let (hsize, sy) = (grid.history_size() as i64, grid.screen_lines() as i64);
    let last = sy - 1;
    let n = match value {
        Some("-") => return if start { -(hsize as i32) } else { last as i32 },
        Some(v) => crate::commands::strtonum(v, i32::MIN as i64, i16::MAX as i64).ok(),
        None => None,
    };
    let n = match n { Some(n) => n, None => return if start { 0 } else { last as i32 } };
    // top = hsize + n, held between the history's first line and the screen's last.
    (if n < -hsize { -hsize } else { n }).min(last) as i32
}

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
}
