//! The box every question is asked in — Close Tab, Stop Harness, the Machines prompts, Files'
//! Delete and names, the editor's Save changes, hn's own Rename / Send / Broadcast / Answer /
//! Message: a bordered box in the command panel's colours with its
//! title in the top rule, the question, an optional one-line input (its label above it, a password
//! as dots), a line for what went wrong, and the button row (`buttons::Row`) at the bottom. It is
//! a ratatui widget; [areas] is the one place its parts are laid out, for drawing and clicks alike.

use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Margin, Position, Rect};
use ratatui::style::Style;
use ratatui::symbols::border;
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Clear, Paragraph, Widget};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::buttons::Row;
use crate::settings::Chrome;

/// The input box's rows: its border above and below the text.
const INPUT_ROWS: u16 = 3;

/// The columns a typed line's input box wants.
pub const INPUT_W: u16 = 48;

/// A one-line input: [label] above a bordered box with [value] in it — dots when [secret] — and
/// the caret [caret] characters in. [focused]: the input has the keys (not the buttons). [width]:
/// the columns it wants, so the box does not grow as it is typed into. [select]: the characters
/// `(from, to)` that typing replaces, drawn in the chosen style.
pub struct Input<'a> { pub label: &'a str, pub value: &'a str, pub caret: usize, pub select: Option<(usize, usize)>, pub secret: bool, pub focused: bool, pub width: u16 }

pub struct Dialog<'a> {
    pub title: Line<'a>,
    pub body: Vec<Line<'a>>,
    pub input: Option<Input<'a>>,
    /// What went wrong (or what to do), under the input: wrapped lines, which fitting drops last first.
    pub message: Vec<Line<'a>>,
    pub row: &'a Row,
    pub border: border::Set<'a>,
    pub chrome: &'a Chrome,
    /// The row's keys hint on the last line, under the buttons (the row has one, and there is
    /// room: fitting drops it first).
    pub hint: bool,
}

/// Which optional parts a dialog has (and how many lines its message is): its geometry depends on
/// nothing else.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Parts { pub label: bool, pub input: bool, pub message: u16, pub hint: bool }

/// Where each part of a dialog goes inside its box.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Areas { pub body: Rect, pub label: Option<Rect>, pub input: Option<Rect>, pub field: Option<Rect>, pub message: Option<Rect>, pub row: Rect, pub hint: Option<Rect> }

/// The parts of a dialog drawn in [area] (its box), two columns in from each side: the body,
/// then the label, the input box, the message, a blank row, the buttons' row and — a blank row
/// above it, always the last line — the keys hint.
pub fn areas(area: Rect, parts: Parts) -> Areas {
    let optional = [(parts.label, 1), (parts.input, INPUT_ROWS), (parts.message > 0, parts.message)];
    let constraints = std::iter::once(Constraint::Fill(1))
        .chain(optional.iter().filter(|(on, _)| *on).map(|&(_, rows)| Constraint::Length(rows)))
        .chain([Constraint::Length(1), Constraint::Length(1)])   // a blank row, the buttons
        .chain(parts.hint.then_some([Constraint::Length(1), Constraint::Length(1)]).into_iter().flatten());   // a blank row, the hint
    let rects = Layout::vertical(constraints).split(area.inner(Margin::new(2, 1)));
    let mut next = rects.iter().copied();
    let body = next.next().unwrap_or_default();
    let mut take = |on: bool| if on { next.next() } else { None };
    let (label, input, message) = (take(parts.label), take(parts.input), take(parts.message > 0));
    let (_blank, row) = (take(true), take(true).unwrap_or_default());
    let (_blank, hint) = (take(parts.hint), take(parts.hint));
    Areas { body, label, input, field: input.map(|r| r.inner(Margin::new(1, 1))), message, row, hint }
}

/// [text] as lines of at most [width] columns, broken between words, in [style].
pub fn wrap(text: &str, width: u16, style: Style) -> Vec<Line<'static>> {
    if text.is_empty() { return Vec::new() }
    crate::workspace_menu::wrap(text, width as usize).into_iter().map(|l| Line::styled(l, style)).collect()
}

/// [text] cut to [width] columns, ending in … where it was cut.
fn cut(text: &str, width: u16) -> String {
    if text.width() <= width as usize { return text.to_string() }
    let mut used = 1;   // the …
    let kept: String = text.chars().take_while(|ch| { used += ch.width().unwrap_or(0); used <= width as usize }).collect();
    kept + "…"
}

impl Input<'_> {
    /// What the box shows: the value, or a dot for each of its characters.
    fn shown(&self) -> String {
        if self.secret { "•".repeat(self.value.chars().count()) } else { self.value.to_string() }
    }

    /// [shown] as a `Line`, the selection in [selected]'s style.
    fn line(&self, selected: Style) -> Line<'static> {
        let shown = self.shown();
        let Some((from, to)) = self.select.filter(|(a, b)| a < b) else { return Line::raw(shown) };
        let part = |skip: usize, take: usize| shown.chars().skip(skip).take(take).collect::<String>();
        Line::from(vec![Span::raw(part(0, from)), Span::styled(part(from, to - from), selected), Span::raw(part(to, usize::MAX))])
    }

    /// The caret's column in what is shown, and how far that is scrolled so the caret stays in a
    /// field [room] columns wide.
    fn caret(&self, room: u16) -> (u16, u16) {
        let before: String = self.shown().chars().take(self.caret).collect();
        let col = before.width().min(u16::MAX as usize) as u16;
        (col, col.saturating_sub(room.saturating_sub(1)))
    }
}

impl<'a> Dialog<'a> {
    /// A dialog titled [title] in [c]'s muted colour, with the default single-line border.
    pub fn new(title: &str, body: Vec<Line<'a>>, row: &'a Row, c: &'a Chrome) -> Dialog<'a> {
        Dialog { title: Line::from(Span::styled(title.to_string(), c.muted)), body, input: None, message: Vec::new(), row, border: border::PLAIN, chrome: c, hint: true }
    }

    pub fn parts(&self) -> Parts {
        let input = self.input.as_ref();
        Parts { label: input.is_some_and(|i| !i.label.is_empty()), input: input.is_some(), message: self.message.len().min(u16::MAX as usize / 2) as u16,
            hint: self.hint && !self.row.hint.is_empty() }
    }

    pub fn areas(&self, area: Rect) -> Areas { areas(area, self.parts()) }

    /// The columns the box wants: its widest part, and two columns each side for the border and margin.
    pub fn width(&self) -> u16 {
        let label = self.input.as_ref().map_or(0, |i| i.label.width().max(i.width as usize));
        let message = self.message.iter().map(Line::width).max().unwrap_or(0);
        let widest = self.body.iter().map(Line::width).chain([self.title.width(), label, message, self.row.width() as usize]).max().unwrap_or(0);
        widest.min(u16::MAX as usize - 4) as u16 + 4
    }

    /// The rows the box needs.
    pub fn height(&self) -> u16 {
        let p = self.parts();
        // (The hint: a blank row and its line.)
        let optional = u16::from(p.label) + if p.input { INPUT_ROWS } else { 0 } + p.message + 2 * u16::from(p.hint);
        (self.body.len().min(u16::MAX as usize / 2) as u16).saturating_add(optional + 2 + 2)
    }

    /// Fitted into [rows]: the keys hint goes first, then the body's last lines (the last one
    /// kept ends in …), then the message, then the label — and with an input, which is the
    /// question then, the body. False when even the rest does not fit.
    pub fn fit(&mut self, rows: u16) -> bool {
        if self.height() > rows { self.hint = false }
        let others = self.height() as usize - self.body.len();
        let room = (rows as usize).saturating_sub(others).max(1);
        if self.body.len() > room {
            let widest = self.body.iter().map(Line::width).max().unwrap_or(0);
            self.body.truncate(room);
            if let Some(last) = self.body.last_mut() {
                let style = last.spans.first().map_or(last.style, |s| last.style.patch(s.style));
                let mut used = 1;   // the …
                let cut: String = last.to_string().chars().take_while(|ch| { used += ch.width().unwrap_or(0); used <= widest }).collect();
                *last = Line::styled(cut + "…", style);
            }
        }
        while self.height() > rows && self.message.pop().is_some() {}
        if self.height() > rows && let Some(input) = &mut self.input { input.label = "" }
        if self.height() > rows && self.input.is_some() { self.body.clear() }
        self.height() <= rows
    }

    /// Where the box goes: centred over [over], no bigger than it.
    pub fn place(&self, over: Rect) -> Rect {
        over.centered(Constraint::Length(self.width().min(over.width)), Constraint::Length(self.height().min(over.height)))
    }

    /// Where the terminal cursor goes for a box drawn at [area]: at the input's caret, while it
    /// has the keys.
    pub fn cursor(&self, area: Rect) -> Option<Position> {
        let input = self.input.as_ref().filter(|i| i.focused)?;
        let field = self.areas(area).field.filter(|f| f.width > 0)?;
        let (col, offset) = input.caret(field.width);
        Some(Position::new(field.x + col - offset, field.y))
    }

    /// The box at [area] as an overlay on [over]: what it is over dimmed first, with the command
    /// panel's backdrop, so the question stands apart and is not read as text drawn over text.
    pub fn render_over(&self, over: Rect, area: Rect, buf: &mut Buffer) {
        crate::settings::backdrop(buf, over, self.chrome.backdrop);
        Widget::render(self, area, buf);
    }
}

/// `Clear`, then a `Block` in the command panel's surface with its border in the muted colour
/// and the title over the top rule; the body a `Paragraph`; the input a bordered `Block` (in the
/// accent while it has the keys) round a `Paragraph` scrolled to its caret; the message a `Line`;
/// the buttons the row widget.
impl Widget for &Dialog<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let c = self.chrome;
        let mut block = Block::bordered().border_set(self.border).border_style(c.muted).style(c.base);
        if self.title.width() > 0 {
            // A Block's title starts next to the corner, tmux's a column later: one more of the rule first.
            let rule = Span::styled(self.border.horizontal_top, c.muted);
            block = block.title(Line::from_iter(std::iter::once(rule).chain(self.title.spans.iter().cloned())).style(self.title.style));
        }
        crate::term_out::clear_extras(area);
        Clear.render(area, buf);
        block.render(area, buf);
        let a = self.areas(area);
        Paragraph::new(Text::from(self.body.clone())).render(a.body, buf);
        if let (Some(input), Some(r), Some(field)) = (&self.input, a.input, a.field) {
            if let Some(label) = a.label { Line::styled(cut(input.label, label.width), c.base).render(label, buf) }
            Block::bordered().border_set(self.border).border_style(if input.focused { c.accent } else { c.muted }).render(r, buf);
            let (_, offset) = input.caret(field.width);
            Paragraph::new(input.line(c.selected)).style(c.base).scroll((0, offset)).render(field, buf);
        }
        if let Some(r) = a.message { Paragraph::new(Text::from(self.message.clone())).render(r, buf) }
        self.row.view(c).render(a.row, buf);
        if let Some(r) = a.hint { self.row.hint_line(c).render(r, buf) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buttons::{oracle, Button};
    use ratatui::style::Modifier;

    fn connect() -> Row {
        let b = |label: &str| Button { label: label.into(), key: None };
        Row { buttons: vec![b("Cancel"), b("Connect")], chosen: 1, hint: String::new() }
    }

    fn text(buf: &Buffer) -> Vec<String> {
        let a = buf.area;
        (a.top()..a.bottom()).map(|y| (a.left()..a.right()).map(|x| buf[(x, y)].symbol()).collect()).collect()
    }

    fn password<'a>(row: &'a Row, c: &'a Chrome, value: &'a str, focused: bool) -> Dialog<'a> {
        let mut d = Dialog::new("Connect · linux-box", vec![Line::styled("Enter the password.", c.base)], row, c);
        d.input = Some(Input { label: "Remote password", value, caret: value.chars().count(), select: None, secret: true, focused, width: 0 });
        d.message = vec![Line::styled("Wrong password", c.danger)];
        d
    }

    #[test]
    fn it_draws_the_title_body_masked_input_message_and_buttons() {
        for c in oracle::chromes() {
            let mut row = connect();
            row.chosen = usize::MAX;   // the input has the keys
            let d = password(&row, &c, "pass", true);
            assert_eq!((d.width(), d.height()), (27, 10));
            let area = Rect::new(2, 1, d.width() + 4, d.height());
            let mut buf = oracle::canvas(Rect::new(0, 0, 40, 12));
            (&d).render(area, &mut buf);
            // 31 columns: 27 inside the margins.
            let shown: Vec<String> = text(&buf)[1..11].iter().map(|l| l.chars().skip(2).take(31).collect()).collect();
            let (rule, gap) = (|n: usize| "─".repeat(n), |n: usize| " ".repeat(n));
            assert_eq!(shown, [
                format!("┌─Connect · linux-box{}┐", rule(9)),
                format!("│ Enter the password.{} │", gap(8)),
                format!("│ Remote password{} │", gap(12)),
                format!("│ ┌{}┐ │", rule(25)),
                format!("│ │••••{}│ │", gap(21)),
                format!("│ └{}┘ │", rule(25)),
                format!("│ Wrong password{} │", gap(13)),
                format!("│{}│", gap(29)),
                format!("│ {}[ Cancel ]  [ Connect ] │", gap(4)),
                format!("└{}┘", rule(29)),
            ], "{:?}", text(&buf));
            assert!(!text(&buf)[5].contains("pass"), "masked");
            let cell = &buf[(4, 7)];
            let reset = ratatui::style::Color::Reset;
            assert_eq!((cell.fg, cell.bg), (c.danger.fg.unwrap_or(reset), c.danger.bg.unwrap_or(reset)), "the message in the danger style");
            assert!(cell.modifier.contains(c.danger.add_modifier));
            assert_eq!(d.cursor(area), Some(Position::new(5 + 4, 5)), "after the fourth dot");
            assert!(buf[(4, 4)].modifier.contains(Modifier::BOLD), "the input with the keys is bordered in the accent");
            assert_eq!(buf[(1, 1)].symbol(), "x", "nothing drawn outside the box");
        }
    }

    #[test]
    fn under_no_color_the_chosen_button_is_reversed_and_the_message_bold() {
        let c = crate::settings::chrome_with(true);
        let row = connect();
        let d = password(&row, &c, "pw", false);
        let area = Rect::new(0, 0, d.width(), d.height());
        let mut buf = Buffer::empty(area);
        (&d).render(area, &mut buf);
        let a = d.areas(area);
        let connect = row.areas(a.row)[1];
        assert!(buf[(connect.x, connect.y)].modifier.contains(Modifier::REVERSED));
        assert!(buf[(a.message.unwrap().x, a.message.unwrap().y)].modifier.contains(Modifier::BOLD));
        assert_eq!(buf[(a.input.unwrap().x, a.input.unwrap().y)].modifier, Modifier::DIM, "the input without the keys is muted");
        assert_eq!(d.cursor(area), None, "no caret while the buttons have the keys");
        assert_eq!(buf[(a.input.unwrap().x, a.input.unwrap().y)].fg, ratatui::style::Color::Reset, "no colour at all");
    }

    #[test]
    fn drawing_and_clicks_share_one_geometry() {
        let c = crate::settings::chrome_with(false);
        let row = connect();
        let d = password(&row, &c, "", true);
        let area = Rect::new(10, 5, 40, 12);
        let a = d.areas(area);
        assert_eq!(a.body, Rect::new(12, 6, 36, 3), "the body takes what is left");
        assert_eq!((a.label, a.input, a.field), (Some(Rect::new(12, 9, 36, 1)), Some(Rect::new(12, 10, 36, 3)), Some(Rect::new(13, 11, 34, 1))));
        assert_eq!(a.message, Some(Rect::new(12, 13, 36, 1)));
        assert_eq!(a.row, Rect::new(12, 15, 36, 1), "a blank row above the buttons");
        let connect = row.areas(a.row)[1];
        assert_eq!(row.click(a.row, Position::new(connect.x, connect.y)), Some(1));
        // A question with no input is notes, a blank row and the buttons — the Close Tab box.
        let plain = areas(area, Parts::default());
        assert_eq!((plain.body, plain.row, plain.input), (Rect::new(12, 6, 36, 8), Rect::new(12, 15, 36, 1), None));
    }

    #[test]
    fn a_long_value_scrolls_to_keep_the_caret_in_view() {
        let c = crate::settings::chrome_with(false);
        let row = connect();
        let value = "abcdefghijklmnopqrstuvwxyz";
        let mut d = Dialog::new("Rename Machine", vec![], &row, &c);
        d.input = Some(Input { label: "", value, caret: 26, select: None, secret: false, focused: true, width: 30 });
        assert_eq!(d.width(), 34, "the box as wide as the input wants, not as its value");
        let area = Rect::new(0, 0, 18, d.height());
        let field = d.areas(area).field.unwrap();
        assert_eq!(field.width, 12);
        let mut buf = Buffer::empty(area);
        (&d).render(area, &mut buf);
        let line = |buf: &Buffer| (field.x..field.right()).map(|x| buf[(x, field.y)].symbol()).collect::<String>();
        assert_eq!(line(&buf), "pqrstuvwxyz ", "the end, and room for the caret");
        assert_eq!(d.cursor(area), Some(Position::new(field.right() - 1, field.y)));
        d.input.as_mut().unwrap().caret = 0;
        let mut buf = Buffer::empty(area);
        (&d).render(area, &mut buf);
        assert_eq!(line(&buf), "abcdefghijkl");
        assert_eq!(d.cursor(area), Some(Position::new(field.x, field.y)));
    }

    #[test]
    fn fitting_cuts_the_body_then_drops_the_message_then_the_label() {
        let c = crate::settings::chrome_with(false);
        let row = connect();
        let mut d = Dialog::new("Remote Password", wrap("Prevent new links using this password? Existing links and sessions stay connected.", 20, c.base), &row, &c);
        assert_eq!(d.body.len(), 5);
        assert!(d.body.iter().all(|l| l.width() <= 20));
        assert_eq!(d.height(), 2 + 5 + 2);
        assert!(d.fit(7));
        assert_eq!(d.body.len(), 3);
        assert!(d.body[2].to_string().ends_with('…'), "{:?}", d.body[2]);
        assert!(!d.fit(4), "no room for one line of the question and the buttons");
        let mut d = password(&row, &c, "", true);
        assert!(d.fit(9) && d.message.is_empty() && d.input.as_ref().unwrap().label == "Remote password" && d.body.len() == 1);
        // (With an input, the input is the question: the body may go too.)
        assert!(d.fit(7) && d.input.as_ref().unwrap().label.is_empty() && d.body.is_empty());
        assert_eq!(d.height(), 7);
        assert!(!d.fit(6));
    }

    #[test]
    fn a_long_message_wraps_and_fitting_drops_its_last_lines_first() {
        let c = crate::settings::chrome_with(false);
        let row = connect();
        let mut d = password(&row, &c, "", true);
        d.message = wrap("Passwords do not match, so nothing was changed.", 20, c.danger);
        assert_eq!(d.message.iter().map(|l| l.to_string()).collect::<Vec<_>>(), ["Passwords do not", "match, so nothing", "was changed."]);
        assert_eq!(d.parts(), Parts { label: true, input: true, message: 3, hint: false });
        assert_eq!(d.areas(Rect::new(0, 0, 30, 20)).message.map(|r| r.height), Some(3));
        assert_eq!(d.height(), 1 + 1 + 3 + 3 + 4, "the body, the label, the input box, three message lines, two rules and two rows");
        assert!(d.fit(d.height() - 1));
        assert_eq!(d.message.iter().map(|l| l.to_string()).collect::<Vec<_>>(), ["Passwords do not", "match, so nothing"], "the last line went first");
        assert!(d.fit(9) && d.message.is_empty(), "then the rest of the message, before the label");
        assert!(d.input.as_ref().unwrap().label == "Remote password");
    }

    #[test]
    fn a_label_cut_to_the_box_ends_in_an_ellipsis() {
        let c = crate::settings::chrome_with(false);
        let row = connect();
        let mut d = password(&row, &c, "", true);
        d.input.as_mut().unwrap().label = "Remote password set on this computer";
        let area = Rect::new(0, 0, 24, d.height());
        let mut buf = Buffer::empty(area);
        (&d).render(area, &mut buf);
        let label = d.areas(area).label.unwrap();
        let shown: String = (label.x..label.right()).map(|x| buf[(x, label.y)].symbol()).collect();
        assert_eq!(shown, "Remote password set…");
    }

    #[test]
    fn a_selection_in_the_input_is_drawn_in_the_chosen_style() {
        let c = crate::settings::chrome_with(false);
        let row = connect();
        let mut d = Dialog::new("Rename · notes.txt", vec![], &row, &c);
        d.input = Some(Input { label: "", value: "notes.txt", caret: 5, select: Some((0, 5)), secret: false, focused: true, width: 20 });
        let area = Rect::new(0, 0, 30, d.height());
        let mut buf = Buffer::empty(area);
        (&d).render(area, &mut buf);
        let field = d.areas(area).field.unwrap();
        let bg = |i: u16| buf[(field.x + i, field.y)].bg;
        assert_eq!((bg(0), bg(4)), (c.selected.bg.unwrap(), c.selected.bg.unwrap()), "notes");
        assert_ne!(bg(5), c.selected.bg.unwrap(), ".txt is not");
        assert_eq!(d.cursor(area), Some(Position::new(field.x + 5, field.y)));
    }

    #[test]
    fn it_is_placed_in_the_middle_of_what_it_is_over() {
        let c = crate::settings::chrome_with(false);
        let row = connect();
        let d = Dialog::new("Hi", vec![Line::raw("Stop?")], &row, &c);
        let r = d.place(Rect::new(10, 4, 60, 20));
        assert_eq!((r.width, r.height), (d.width(), 5));
        assert!((r.x - 10).abs_diff(60 - r.right() + 10) <= 1 && (r.y - 4).abs_diff(24 - r.bottom()) <= 1, "{r:?}");
        assert_eq!(d.place(Rect::new(0, 0, 20, 3)), Rect::new(0, 0, 20, 3), "no bigger than it");
    }
}
