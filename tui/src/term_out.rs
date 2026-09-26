//! The terminal hn draws on: ratatui's crossterm backend, with colours written as tmux writes
//! them — the eight colours and their bright forms as SGR 30–37, 90–97 (40–47, 100–107 behind),
//! `colourN` as 38;5;N, RGB as 38;2;R;G;B — where crossterm writes every colour as 38;5;N, which
//! an eight-colour terminal (the Linux console) does not read. Everything else is crossterm's.

use std::io::{self, Write};

use ratatui::backend::{Backend, ClearType, CrosstermBackend, WindowSize};
use ratatui::buffer::Cell;
use ratatui::layout::{Position, Size};
use ratatui::style::{Color, Modifier};

pub struct TmuxBackend<W: Write> { inner: CrosstermBackend<W> }

impl<W: Write> TmuxBackend<W> {
    pub fn new(writer: W) -> Self { Self { inner: CrosstermBackend::new(writer) } }
}

impl<W: Write> Write for TmuxBackend<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> { self.inner.write(buf) }
    fn flush(&mut self) -> io::Result<()> { Write::flush(&mut self.inner) }
}

/// A colour's SGR parameters as tmux's tty_colours_fg / _bg write them ([base] 30, 40 or 58).
fn sgr(c: Color, base: u16) -> String {
    let named = |n: u16| (n + base).to_string();
    let bright = |n: u16| (n + base + 60).to_string();
    match c {
        Color::Reset => (base + 9).to_string(),
        Color::Black => named(0), Color::Red => named(1), Color::Green => named(2), Color::Yellow => named(3),
        Color::Blue => named(4), Color::Magenta => named(5), Color::Cyan => named(6), Color::Gray => named(7),
        Color::DarkGray => bright(0), Color::LightRed => bright(1), Color::LightGreen => bright(2), Color::LightYellow => bright(3),
        Color::LightBlue => bright(4), Color::LightMagenta => bright(5), Color::LightCyan => bright(6), Color::White => bright(7),
        Color::Indexed(n) => format!("{};5;{n}", base + 8),
        Color::Rgb(r, g, b) => format!("{};2;{r};{g};{b}", base + 8),
    }
}

/// The underline colour: 58;5;N or 58;2;R;G;B (a named one as its index), 59 for none.
fn sgr_underline(c: Color) -> String {
    match c {
        Color::Reset => "59".into(),
        Color::Indexed(n) => format!("58;5;{n}"),
        Color::Rgb(r, g, b) => format!("58;2;{r};{g};{b}"),
        named => {
            let order = [Color::Black, Color::Red, Color::Green, Color::Yellow, Color::Blue, Color::Magenta, Color::Cyan, Color::Gray,
                Color::DarkGray, Color::LightRed, Color::LightGreen, Color::LightYellow, Color::LightBlue, Color::LightMagenta, Color::LightCyan, Color::White];
            format!("58;5;{}", order.iter().position(|o| *o == named).unwrap_or(0))
        }
    }
}

const ATTRS: [(Modifier, u8); 9] = [
    (Modifier::BOLD, 1), (Modifier::DIM, 2), (Modifier::ITALIC, 3), (Modifier::UNDERLINED, 4), (Modifier::SLOW_BLINK, 5),
    (Modifier::RAPID_BLINK, 6), (Modifier::REVERSED, 7), (Modifier::HIDDEN, 8), (Modifier::CROSSED_OUT, 9),
];

impl<W: Write> Backend for TmuxBackend<W> {
    type Error = io::Error;

    fn draw<'a, I>(&mut self, content: I) -> io::Result<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        // CrosstermBackend writes through to its writer.
        let w = &mut self.inner;
        let (mut fg, mut bg, mut ul, mut modifier) = (Color::Reset, Color::Reset, Color::Reset, Modifier::empty());
        let mut last: Option<(u16, u16)> = None;
        for (x, y, cell) in content {
            // The cursor moves only where the cells do not follow on.
            if !matches!(last, Some((lx, ly)) if x == lx + 1 && y == ly) { write!(w, "\x1b[{};{}H", y + 1, x + 1)?; }
            last = Some((x, y));
            if cell.modifier != modifier {
                // tmux's tty_attributes: an attribute taken away resets everything, then what is
                // wanted is set again.
                if !(modifier - cell.modifier).is_empty() {
                    w.write_all(b"\x1b[0m")?;
                    (fg, bg, ul, modifier) = (Color::Reset, Color::Reset, Color::Reset, Modifier::empty());
                }
                for (flag, code) in ATTRS { if cell.modifier.contains(flag) && !modifier.contains(flag) { write!(w, "\x1b[{code}m")?; } }
                modifier = cell.modifier;
            }
            if cell.fg != fg { write!(w, "\x1b[{}m", sgr(cell.fg, 30))?; fg = cell.fg; }
            if cell.bg != bg { write!(w, "\x1b[{}m", sgr(cell.bg, 40))?; bg = cell.bg; }
            if cell.underline_color != ul { write!(w, "\x1b[{}m", sgr_underline(cell.underline_color))?; ul = cell.underline_color; }
            w.write_all(cell.symbol().as_bytes())?;
        }
        w.write_all(b"\x1b[39m\x1b[49m\x1b[59m\x1b[0m")
    }

    fn hide_cursor(&mut self) -> io::Result<()> { self.inner.hide_cursor() }
    fn show_cursor(&mut self) -> io::Result<()> { self.inner.show_cursor() }
    fn get_cursor_position(&mut self) -> io::Result<Position> { self.inner.get_cursor_position() }
    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> io::Result<()> { self.inner.set_cursor_position(position) }
    fn clear(&mut self) -> io::Result<()> { self.inner.clear() }
    fn clear_region(&mut self, clear_type: ClearType) -> io::Result<()> { self.inner.clear_region(clear_type) }
    fn append_lines(&mut self, n: u16) -> io::Result<()> { self.inner.append_lines(n) }
    fn size(&self) -> io::Result<Size> { self.inner.size() }
    fn window_size(&mut self) -> io::Result<WindowSize> { self.inner.window_size() }
    fn flush(&mut self) -> io::Result<()> { Backend::flush(&mut self.inner) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_as_tmux_writes_them() {
        assert_eq!(sgr(Color::Red, 30), "31");
        assert_eq!(sgr(Color::Green, 40), "42");
        assert_eq!(sgr(Color::LightBlue, 30), "94");
        assert_eq!(sgr(Color::White, 40), "107");
        assert_eq!(sgr(Color::Reset, 40), "49");
        assert_eq!(sgr(Color::Indexed(1), 30), "38;5;1");
        assert_eq!(sgr(Color::Rgb(1, 2, 3), 40), "48;2;1;2;3");
    }
}
