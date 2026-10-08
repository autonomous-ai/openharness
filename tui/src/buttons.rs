//! The row of buttons every dialog ends with: `[ Cancel ]  [ Stop ]`, the way out first and the
//! action last, right-aligned, with a muted keys hint at the left. Colours are the command panel's
//! (`settings::chrome()`): the chosen button is its chosen row, the others its panel. It draws as
//! a ratatui widget (`row.view(&chrome)`), its geometry from one `Layout` that clicks share.

use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Flex, Layout, Position, Rect};
use ratatui::text::Line;
use ratatui::widgets::Widget;
use unicode_width::UnicodeWidthStr;

use crate::settings::Chrome;

/// Columns between two buttons, and between the hint and the first button.
const GAP: u16 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Button { pub label: String, pub key: Option<char> }

#[derive(Clone, Debug)]
pub struct Row { pub buttons: Vec<Button>, pub chosen: usize, pub hint: String }

/// The keys hint every question's row shows where it fits — one for all, read as the command
/// panel's keys line: every arrow moves, Enter chooses, Esc cancels. (A button's own letter — `y`,
/// `s` — still answers; the hint does not list them.)
pub const KEYS: &str = "↑↓←→ move   enter choose   esc cancel";

pub enum Answer { Chosen(usize), Cancel, Moved, Ignored }

fn cols(text: &str) -> u16 { text.width().min(u16::MAX as usize) as u16 }

impl Button {
    fn width(&self) -> u16 { cols(&self.label).saturating_add(4) }
}

impl Row {
    /// The buttons alone, with the gaps between them.
    pub fn buttons_width(&self) -> u16 {
        let n = self.buttons.len() as u16;
        let gaps = n.saturating_sub(1) * GAP;
        self.buttons.iter().fold(gaps, |w, b| w.saturating_add(b.width()))
    }

    /// The columns a dialog gives the row: the wider of its two lines — the buttons, and the hint
    /// on the dialog's last line under them.
    pub fn width(&self) -> u16 { self.buttons_width().max(cols(&self.hint)) }

    /// Where each button goes on the one-row [area]: right-aligned, GAP apart. Drawing and clicks
    /// both take them from here. Callers fit the dialog to `buttons_width()` first; a narrower
    /// row shrinks the buttons rather than overlap them. (The hint is not on this row: the
    /// dialog draws it on its last line, [Row::hint_line].)
    pub fn areas(&self, area: Rect) -> Vec<Rect> {
        Layout::horizontal(self.buttons.iter().map(|b| Constraint::Length(b.width())))
            .flex(Flex::End).spacing(GAP).split(area).to_vec()
    }

    /// The hint as the dialog's last line, muted.
    pub fn hint_line<'a>(&'a self, c: &Chrome) -> Line<'a> { Line::styled(self.hint.as_str(), c.muted) }

    /// The row as a ratatui widget in [c]'s colours: `row.view(&c).render(area, buf)`.
    pub fn view<'a>(&'a self, c: &'a Chrome) -> ButtonRow<'a> { ButtonRow { row: self, chrome: c } }

    /// A key: ← → Tab BackTab h l move (wrapping; h / l only when no button owns that letter, and
    /// only without Ctrl/Alt); Enter chooses the chosen button; Esc, Ctrl-C, Ctrl-G cancel;
    /// a button's letter (no Ctrl/Alt) chooses that button. Dialogs that use Tab for something else
    /// (the Open dialog) filter Tab/BackTab/Esc before calling.
    pub fn key(&mut self, code: KeyCode, mods: KeyModifiers) -> Answer {
        let held = mods.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
        let n = self.buttons.len();
        let owned = |ch: char| self.buttons.iter().position(|b| b.key == Some(ch));
        match code {
            KeyCode::Esc => return Answer::Cancel,
            KeyCode::Char('c' | 'g') if mods.contains(KeyModifiers::CONTROL) => return Answer::Cancel,
            _ => {}
        }
        if n == 0 { return Answer::Ignored }
        // (↑ ↓ as ← →: a question's arrows all move between its answers.)
        let step = match code {
            KeyCode::Right | KeyCode::Down | KeyCode::Tab => Some(1),
            KeyCode::Left | KeyCode::Up | KeyCode::BackTab => Some(n - 1),
            KeyCode::Char('l') if !held && owned('l').is_none() => Some(1),
            KeyCode::Char('h') if !held && owned('h').is_none() => Some(n - 1),
            _ => None,
        };
        if let Some(by) = step {
            self.chosen = (self.chosen + by) % n;
            return Answer::Moved;
        }
        match code {
            KeyCode::Enter => Answer::Chosen(self.chosen.min(n - 1)),
            KeyCode::Char(ch) if !held => owned(ch).map_or(Answer::Ignored, Answer::Chosen),
            _ => Answer::Ignored,
        }
    }

    /// The button a click [at] chooses on a row drawn in [area]: none on a gap.
    pub fn click(&self, area: Rect, at: Position) -> Option<usize> {
        self.areas(area).iter().position(|r| r.contains(at))
    }
}

/// A [Row]'s buttons drawn: each a `Line` over its area — the chosen one in the panel's chosen
/// row (`selected`), the others in its surface (`base`).
pub struct ButtonRow<'a> { row: &'a Row, chrome: &'a Chrome }

impl Widget for ButtonRow<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let buttons = self.row.areas(area);
        for (i, (b, at)) in self.row.buttons.iter().zip(buttons).enumerate() {
            let style = if i == self.row.chosen { self.chrome.selected } else { self.chrome.base };
            Line::styled(format!("[ {} ]", b.label), style).render(at, buf);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Modifier;

    fn row() -> Row { Row { buttons: vec![Button { label: "Cancel".into(), key: None }, Button { label: "Stop".into(), key: Some('s') }], chosen: 0, hint: "s stop · esc cancel".into() } }

    /// The row as drawn now, at [area] (one row).
    fn drawn(r: &Row, buf: &mut Buffer, area: Rect, c: &Chrome) { r.view(c).render(area, buf) }

    /// Which button a click on each column of [area]'s row would choose, now.
    fn clicks(r: &Row, area: Rect, width: u16) -> Vec<Option<usize>> { (0..width).map(|x| r.click(area, Position::new(x, area.y))).collect() }

    /// The buttons' areas on a row ending at column 50.
    fn at50(r: &Row) -> Vec<Rect> { r.areas(Rect::new(0, 3, 50, 1)) }

    /// The row draws and answers clicks exactly as before it was a ratatui widget: every cell's
    /// symbol, colours and modifiers, for one, two and three buttons (and wide labels), each
    /// chosen (and none, as the Machines panel's unfocused row), from the narrowest row that fits
    /// the buttons to 120 columns, in a dark and a light theme and NO_COLOR. (Its hint is the
    /// dialog's last line now, never on the row: the old row is drawn with none.)
    #[test]
    fn the_widget_draws_and_clicks_as_the_old_row() {
        let b = |label: &str, key| Button { label: label.into(), key };
        let rows = [
            row(),
            Row { buttons: vec![b("Don't save", None), b("Cancel", None), b("Save", None)], chosen: 2, hint: String::new() },
            Row { buttons: vec![b("Cancel", Some('n')), b("Continue", Some('y'))], chosen: 1, hint: "tab buttons".into() },
            Row { buttons: vec![b("Back", None)], chosen: 0, hint: String::new() },
            Row { buttons: vec![b("取消", None), b("保存", None)], chosen: 0, hint: "回车 保存".into() },   // wide characters
        ];
        for c in oracle::chromes() {
            for mut r in rows.clone() {
                for chosen in (0..r.buttons.len()).chain([usize::MAX]) {
                    r.chosen = chosen;
                    for w in r.buttons_width()..=120 {
                        let area = Rect::new(3, 1, w, 1);
                        let screen = Rect::new(0, 0, w + 6, 3);
                        let (mut old, mut new) = (oracle::canvas(screen), oracle::canvas(screen));
                        oracle::draw(&Row { hint: String::new(), ..r.clone() }, &mut old, area.x, area.right(), area.y, &c);
                        drawn(&r, &mut new, area, &c);
                        assert_eq!(new, old, "{:?} chosen {chosen} at {w} columns", r.buttons);
                        let before: Vec<_> = (0..screen.width).map(|x| oracle::click(&r, x, area.right())).collect();
                        assert_eq!(clicks(&r, area, screen.width), before, "{:?} at {w} columns", r.buttons);
                    }
                }
            }
        }
    }

    #[test]
    fn buttons_sit_right_aligned_two_columns_apart() {
        let cells = at50(&row());
        assert_eq!(cells, vec![Rect::new(50 - 8 - 2 - 10, 3, 10, 1), Rect::new(50 - 8, 3, 8, 1)]);   // "[ Cancel ]" 10, "[ Stop ]" 8
    }

    #[test]
    fn up_and_down_move_between_the_answers_too() {
        let mut r = row();
        assert!(matches!(r.key(KeyCode::Down, KeyModifiers::NONE), Answer::Moved)); assert_eq!(r.chosen, 1);
        assert!(matches!(r.key(KeyCode::Down, KeyModifiers::NONE), Answer::Moved)); assert_eq!(r.chosen, 0, "wraps");
        assert!(matches!(r.key(KeyCode::Up, KeyModifiers::NONE), Answer::Moved)); assert_eq!(r.chosen, 1);
    }

    #[test]
    fn keys_move_wrap_choose_and_cancel() {
        let mut r = row();
        let k = |r: &mut Row, c| r.key(c, KeyModifiers::NONE);
        assert!(matches!(k(&mut r, KeyCode::Right), Answer::Moved)); assert_eq!(r.chosen, 1);
        assert!(matches!(k(&mut r, KeyCode::Right), Answer::Moved)); assert_eq!(r.chosen, 0, "wraps");
        assert!(matches!(k(&mut r, KeyCode::BackTab), Answer::Moved)); assert_eq!(r.chosen, 1);
        assert!(matches!(k(&mut r, KeyCode::Enter), Answer::Chosen(1)));
        assert!(matches!(k(&mut r, KeyCode::Char('s')), Answer::Chosen(1)));
        assert!(matches!(k(&mut r, KeyCode::Esc), Answer::Cancel));
        assert!(matches!(r.key(KeyCode::Char('c'), KeyModifiers::CONTROL), Answer::Cancel));
        assert!(matches!(r.key(KeyCode::Char('g'), KeyModifiers::CONTROL), Answer::Cancel));
        assert!(matches!(k(&mut r, KeyCode::Char('x')), Answer::Ignored));
    }

    #[test]
    fn h_and_l_move_unless_a_button_owns_them() {
        let mut r = row();
        assert!(matches!(r.key(KeyCode::Char('l'), KeyModifiers::NONE), Answer::Moved)); assert_eq!(r.chosen, 1);
        assert!(matches!(r.key(KeyCode::Char('h'), KeyModifiers::NONE), Answer::Moved)); assert_eq!(r.chosen, 0);
        assert!(matches!(r.key(KeyCode::Char('l'), KeyModifiers::CONTROL), Answer::Ignored));
        assert!(matches!(r.key(KeyCode::Char('s'), KeyModifiers::ALT), Answer::Ignored));
        r.buttons[0].key = Some('h');
        assert!(matches!(r.key(KeyCode::Char('h'), KeyModifiers::NONE), Answer::Chosen(0)));
        assert_eq!(r.chosen, 0);
    }

    #[test]
    fn the_chosen_button_is_the_panels_chosen_row() {
        if crate::theme::no_color() { return }   // NO_COLOR: `selected` is REVERSED, with no bg to compare
        let c = crate::settings::chrome();
        let mut buf = Buffer::empty(Rect::new(0, 3, 50, 1));
        let mut r = row(); r.chosen = 1;
        r.view(&c).render(buf.area, &mut buf);
        let x = at50(&r)[1].x;
        assert_eq!(buf[(x, 3)].symbol(), "[");
        assert_eq!(buf[(x + 2, 3)].bg, c.selected.bg.unwrap());
        assert!(buf[(x + 2, 3)].modifier.contains(Modifier::BOLD));
        let x0 = at50(&r)[0].x;
        assert_ne!(buf[(x0 + 2, 3)].bg, c.selected.bg.unwrap());
        assert_eq!(buf[(0, 3)].symbol(), " ", "no hint on the buttons' row: it is the dialog's last line");
        assert_eq!(r.hint_line(&c).style, c.muted, "the hint is muted");
    }

    #[test]
    fn the_buttons_never_overlap_and_the_hint_is_not_on_their_row() {
        let c = crate::settings::chrome();
        let r = row();
        let right = r.buttons_width();
        let mut buf = Buffer::empty(Rect::new(0, 0, right, 1));
        r.view(&c).render(buf.area, &mut buf);
        let line: String = (0..right).map(|x| buf[(x, 0)].symbol().to_string()).collect();
        assert_eq!(line, "[ Cancel ]  [ Stop ]");
        assert_eq!(r.width(), r.buttons_width().max("s stop · esc cancel".chars().count() as u16), "the wider of the row and the hint's line");
        // narrower than the buttons: they shrink side by side, never overlap, never panic
        let cells = r.areas(Rect::new(0, 0, 5, 1));
        assert_eq!(cells.len(), 2);
        assert!(cells[0].right() <= cells[1].x);
        let mut buf = Buffer::empty(Rect::new(0, 0, 5, 1));
        r.view(&c).render(buf.area, &mut buf);
    }

    #[test]
    fn a_click_on_a_button_chooses_it_and_between_them_nothing() {
        let (r, area) = (row(), Rect::new(0, 3, 50, 1));
        let cells = at50(&r);
        assert_eq!(r.click(area, Position::new(cells[1].x + 1, 3)), Some(1));
        assert_eq!(r.click(area, Position::new(cells[0].right(), 3)), None, "the gap");
        assert_eq!(r.click(area, Position::new(0, 3)), None, "the hint");
        assert_eq!(r.click(area, Position::new(cells[1].x + 1, 2)), None, "another row");
    }
}

/// The row as it was drawn by hand, cell by cell, before it was a ratatui widget: what the
/// widget must still look like, cell for cell.
#[cfg(test)]
pub(crate) mod oracle {
    use super::{Row, GAP, cols};
    use crate::settings::Chrome;
    use ratatui::{buffer::Buffer, layout::Rect, style::{Color, Modifier, Style}};

    /// A dark theme, a light one and NO_COLOR.
    pub(crate) fn chromes() -> [Chrome; 3] {
        let of = |bg, fg| crate::settings::chrome_for(crate::theme::pane_palette_of(bg, fg));
        [of([28, 31, 36], [220, 225, 231]), of([250, 250, 250], [40, 40, 40]), crate::settings::chrome_with(true)]
    }

    /// A screen with something on it already, so a cell left alone or painted over shows.
    pub(crate) fn canvas(area: Rect) -> Buffer {
        let mut buf = Buffer::empty(area);
        let st = Style::default().fg(Color::Red).bg(Color::Blue).add_modifier(Modifier::ITALIC);
        for (i, cell) in buf.content.iter_mut().enumerate() { cell.set_symbol(if i % 2 == 0 { "." } else { "x" }).set_style(st); }
        buf
    }

    pub(crate) fn cells(r: &Row, right: u16) -> Vec<(usize, u16, u16)> {
        let mut x = right;
        let mut out: Vec<_> = r.buttons.iter().enumerate().rev().map(|(i, b)| {
            let w = b.width();
            x = x.saturating_sub(w);
            let cell = (i, x, w);
            x = x.saturating_sub(GAP);
            cell
        }).collect();
        out.reverse();
        out
    }

    pub(crate) fn draw(r: &Row, buf: &mut Buffer, left: u16, right: u16, y: u16, c: &Chrome) {
        let cells = cells(r, right);
        if let Some(&(_, first, _)) = cells.first() {
            let hint = cols(&r.hint);
            if hint > 0 && u32::from(left) + u32::from(hint) + u32::from(GAP) <= u32::from(first) {
                crate::settings::put(buf, left, y, hint, &r.hint, c.muted);
            }
        }
        for (i, x, w) in cells {
            let style = if i == r.chosen { c.selected } else { c.base };
            for dx in 0..w {
                if let Some(cell) = buf.cell_mut((x + dx, y)) { cell.set_style(style); }
            }
            crate::settings::put(buf, x, y, w, &format!("[ {} ]", r.buttons[i].label), style);
        }
    }

    /// The button at column [x] of a row whose right edge is [right].
    pub(crate) fn click(r: &Row, x: u16, right: u16) -> Option<usize> {
        cells(r, right).into_iter().find(|&(_, cx, w)| x >= cx && x - cx < w).map(|(i, ..)| i)
    }
}
