//! The row of buttons every dialog ends with: `[ Cancel ]  [ Stop ]`, the way out first and the
//! action last, right-aligned, with a muted keys hint at the left. Colours are the command panel's
//! (`settings::chrome()`): the chosen button is its chosen row, the others its panel.

use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::buffer::Buffer;
use unicode_width::UnicodeWidthStr;

/// Columns between two buttons, and between the hint and the first button.
const GAP: u16 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Button { pub label: String, pub key: Option<char> }

#[derive(Clone, Debug)]
pub struct Row { pub buttons: Vec<Button>, pub chosen: usize, pub hint: String }

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

    /// Total columns the row needs (hint + buttons), for a dialog's width.
    pub fn width(&self) -> u16 {
        if self.hint.is_empty() { return self.buttons_width() }
        self.buttons_width().saturating_add(GAP).saturating_add(cols(&self.hint))
    }

    /// Each button's columns on a row whose right edge is [right]: (index, x, width).
    pub fn cells(&self, right: u16) -> Vec<(usize, u16, u16)> {
        let mut x = right;
        let mut out: Vec<_> = self.buttons.iter().enumerate().rev().map(|(i, b)| {
            let w = b.width();
            x = x.saturating_sub(w);
            let cell = (i, x, w);
            x = x.saturating_sub(GAP);
            cell
        }).collect();
        out.reverse();
        out
    }

    /// Draws the hint at [left] and the buttons right-aligned to [right] on row [y].
    pub fn draw(&self, buf: &mut Buffer, left: u16, right: u16, y: u16, c: &crate::settings::Chrome) {
        let cells = self.cells(right);
        if let Some(&(_, first, _)) = cells.first() {
            let hint = cols(&self.hint);
            if hint > 0 && u32::from(left) + u32::from(hint) + u32::from(GAP) <= u32::from(first) {
                crate::settings::put(buf, left, y, hint, &self.hint, c.muted);
            }
        }
        for (i, x, w) in cells {
            let style = if i == self.chosen { c.selected } else { c.base };
            for dx in 0..w {
                if let Some(cell) = buf.cell_mut((x + dx, y)) { cell.set_style(style); }
            }
            crate::settings::put(buf, x, y, w, &format!("[ {} ]", self.buttons[i].label), style);
        }
    }

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
        let step = match code {
            KeyCode::Right | KeyCode::Tab => Some(1),
            KeyCode::Left | KeyCode::BackTab => Some(n - 1),
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

    /// A click at (x, y) on a row drawn at [y_row] with right edge [right].
    pub fn click(&self, x: u16, y: u16, right: u16, y_row: u16) -> Option<usize> {
        if y != y_row { return None }
        self.cells(right).into_iter().find(|&(_, cx, w)| x >= cx && x - cx < w).map(|(i, ..)| i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{layout::Rect, style::Modifier};

    fn row() -> Row { Row { buttons: vec![Button { label: "Cancel".into(), key: None }, Button { label: "Stop".into(), key: Some('s') }], chosen: 0, hint: "s stop · esc cancel".into() } }

    #[test]
    fn buttons_sit_right_aligned_two_columns_apart() {
        let cells = row().cells(50);
        assert_eq!(cells, vec![(0, 50 - 8 - 2 - 10, 10), (1, 50 - 8, 8)]);   // "[ Cancel ]" 10, "[ Stop ]" 8
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
        let mut buf = Buffer::empty(Rect::new(0, 0, 50, 1));
        let mut r = row(); r.chosen = 1;
        r.draw(&mut buf, 0, 50, 0, &c);
        let (_, x, _) = r.cells(50)[1];
        assert_eq!(buf[(x, 0)].symbol(), "[");
        assert_eq!(buf[(x + 2, 0)].bg, c.selected.bg.unwrap());
        assert!(buf[(x + 2, 0)].modifier.contains(Modifier::BOLD));
        let (_, x0, _) = r.cells(50)[0];
        assert_ne!(buf[(x0 + 2, 0)].bg, c.selected.bg.unwrap());
        assert_eq!(buf[(0, 0)].fg, c.muted.fg.unwrap(), "the hint is muted");
    }

    #[test]
    fn the_hint_goes_first_and_the_buttons_never_overlap() {
        let c = crate::settings::chrome();
        let r = row();
        let right = r.buttons_width();   // no room for the hint
        let mut buf = Buffer::empty(Rect::new(0, 0, right, 1));
        r.draw(&mut buf, 0, right, 0, &c);
        let line: String = (0..right).map(|x| buf[(x, 0)].symbol().to_string()).collect();
        assert_eq!(line, "[ Cancel ]  [ Stop ]");
        assert_eq!(r.width(), r.buttons_width() + 2 + "s stop · esc cancel".chars().count() as u16);
        // narrower than the buttons: saturates, never panics
        assert_eq!(r.cells(5).len(), 2);
        let mut buf = Buffer::empty(Rect::new(0, 0, 5, 1));
        r.draw(&mut buf, 0, 5, 0, &c);
    }

    #[test]
    fn a_click_on_a_button_chooses_it_and_between_them_nothing() {
        let r = row(); let cells = r.cells(50);
        assert_eq!(r.click(cells[1].1 + 1, 3, 50, 3), Some(1));
        assert_eq!(r.click(cells[0].1 + cells[0].2, 3, 50, 3), None, "the gap");
        assert_eq!(r.click(0, 3, 50, 3), None, "the hint");
        assert_eq!(r.click(cells[1].1 + 1, 2, 50, 3), None, "another row");
    }
}
