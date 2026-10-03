//! A window's pane borders as tmux 3.5a draws them (screen-redraw.c): which cells are border,
//! the line-drawing character each takes from its neighbours, whether it is the active pane's
//! border (coloured), the marked pane's (reversed), the arrows of pane-border-indicators, and
//! where each pane's status line (pane-border-status) goes and what it is filled with.

use crate::layout::{Geom, Status};

/// pane-border-lines.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lines { Single, Double, Heavy, Simple, Number }

impl Lines {
    pub fn of(v: &str) -> Lines {
        match v { "double" => Lines::Double, "heavy" => Lines::Heavy, "simple" => Lines::Simple, "number" => Lines::Number, _ => Lines::Single }
    }
}

/// pane-border-indicators.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Indicators { Off, Colour, Arrows, Both }

impl Indicators {
    pub fn of(v: &str) -> Indicators {
        match v { "off" => Indicators::Off, "arrows" => Indicators::Arrows, "both" => Indicators::Both, _ => Indicators::Colour }
    }
}

/// A cell in relation to one pane (enum screen_redraw_border_type).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Side { Outside, Inside, Left, Right, Top, Bottom }

// tmux.h's cell types.
const INSIDE: usize = 0;
const TOPBOTTOM: usize = 1;
const LEFTRIGHT: usize = 2;
const TOPLEFT: usize = 3;
const TOPRIGHT: usize = 4;
const BOTTOMLEFT: usize = 5;
const BOTTOMRIGHT: usize = 6;
const TOPJOIN: usize = 7;
const BOTTOMJOIN: usize = 8;
const LEFTJOIN: usize = 9;
const RIGHTJOIN: usize = 10;
const JOIN: usize = 11;
const OUTSIDE: usize = 12;

/// CELL_BORDERS through tmux's ACS table, and tty-acs.c's double and heavy sets.
const SINGLE: [&str; 13] = [" ", "│", "─", "┌", "┐", "└", "┘", "┬", "┴", "├", "┤", "┼", "·"];
const DOUBLE: [&str; 13] = [" ", "║", "═", "╔", "╗", "╚", "╝", "╦", "╩", "╠", "╣", "╬", "·"];
const HEAVY: [&str; 13] = [" ", "┃", "━", "┏", "┓", "┗", "┛", "┳", "┻", "┣", "┫", "╋", "·"];
const SIMPLE: [&str; 13] = [" ", "|", "-", "+", "+", "+", "+", "+", "+", "+", "+", "+", "."];

/// Whose style a border cell takes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Paint { Active, Normal }

/// One border cell to draw, at (x, y) in the window.
#[derive(Clone, Debug, PartialEq)]
pub struct Cell { pub x: u32, pub y: u32, pub glyph: String, pub paint: Paint, pub marked: bool }

/// A pane's status line: `width` cells from (x, y), filled with `fill` under the format.
#[derive(Clone, Debug, PartialEq)]
pub struct Title { pub pane: u64, pub x: u32, pub y: u32, pub width: u32, pub fill: Vec<String>, pub active: bool }

/// A window as the border code sees it.
pub struct Frame<'a> {
    /// The window's size.
    pub sx: u32,
    pub sy: u32,
    /// Every pane in the window's list order, where the layout has it.
    pub all: &'a [(u64, Geom)],
    /// The panes drawn (all of them, or the zoomed one), in list order.
    pub visible: &'a [(u64, Geom)],
    pub active: Option<u64>,
    pub marked: Option<u64>,
    pub status: Status,
    pub lines: Lines,
    pub indicators: Indicators,
    /// pane-base-index, for pane-border-lines number.
    pub base: usize,
}

impl Frame<'_> {
    /// screen_redraw_two_panes: two panes, split that way (0 side by side, 1 stacked).
    fn two_panes(&self, direction: u8) -> bool {
        if self.all.len() != 2 { return false }
        let second = self.all[1].1;
        !((direction == 0 && second.x == 0) || (direction == 1 && second.y == 0))
    }

    /// screen_redraw_pane_border: the cell in relation to a pane.
    fn side(&self, g: &Geom, px: u32, py: u32) -> Side {
        let (ex, ey) = (g.x + g.w, g.y + g.h);
        if px >= g.x && px < ex && py >= g.y && py < ey { return Side::Inside }
        let split = matches!(self.indicators, Indicators::Colour | Indicators::Both);
        // Left and right: with two panes and no status lines, each pane has half the border.
        if self.status == Status::Off && self.two_panes(0) && split {
            if g.x == 0 && px == g.w && py <= g.h / 2 { return Side::Right }
            if g.x != 0 && px == g.x - 1 && py > g.h / 2 { return Side::Left }
        } else if (g.y == 0 || py >= g.y - 1) && py <= ey {
            if g.x != 0 && px == g.x - 1 { return Side::Left }
            if px == ex { return Side::Right }
        }
        // Top and bottom.
        let across = (g.x == 0 || px >= g.x - 1) && px <= ex;
        match self.status {
            Status::Off if self.two_panes(1) && split => {
                if g.y == 0 && py == g.h && px <= g.w / 2 { return Side::Bottom }
                if g.y != 0 && py == g.y - 1 && px > g.w / 2 { return Side::Top }
            }
            Status::Off => if across {
                if g.y != 0 && py == g.y - 1 { return Side::Top }
                if py == ey { return Side::Bottom }
            },
            Status::Top => if across && g.y != 0 && py == g.y - 1 { return Side::Top },
            Status::Bottom => if across && py == ey { return Side::Bottom },
        }
        Side::Outside
    }

    /// screen_redraw_cell_border: whether a cell is a border (the window's edge counts).
    fn is_border(&self, px: u32, py: u32) -> bool {
        if px > self.sx || py > self.sy { return false }
        if px == self.sx || py == self.sy { return true }
        for (_, g) in self.visible {
            match self.side(g, px, py) { Side::Inside => return false, Side::Outside => {}, _ => return true }
        }
        false
    }

    /// screen_redraw_type_of_cell: the line-drawing character, from which neighbours are border.
    fn cell_type(&self, px: u32, py: u32) -> usize {
        if px > self.sx || py > self.sy { return OUTSIDE }
        let mut b = 0;
        if px == 0 || self.is_border(px - 1, py) { b |= 8 }
        if px <= self.sx && self.is_border(px + 1, py) { b |= 4 }
        match self.status {
            Status::Top => {
                if py != 0 && self.is_border(px, py - 1) { b |= 2 }
                if self.is_border(px, py + 1) { b |= 1 }
            }
            Status::Bottom => {
                if py == 0 || self.is_border(px, py - 1) { b |= 2 }
                if py + 1 != self.sy && self.is_border(px, py + 1) { b |= 1 }
            }
            Status::Off => {
                if py == 0 || self.is_border(px, py - 1) { b |= 2 }
                if self.is_border(px, py + 1) { b |= 1 }
            }
        }
        match b {
            15 => JOIN, 14 => BOTTOMJOIN, 13 => TOPJOIN, 12 => LEFTRIGHT, 11 => RIGHTJOIN, 10 => BOTTOMRIGHT,
            9 => TOPRIGHT, 7 => LEFTJOIN, 6 => BOTTOMLEFT, 5 => TOPLEFT, 3 => TOPBOTTOM, _ => OUTSIDE,
        }
    }

    /// The visible panes from the active one round (tmux walks them that way).
    fn from_active(&self) -> Vec<usize> {
        let n = self.visible.len();
        let start = self.active.and_then(|a| self.visible.iter().position(|(id, _)| *id == a)).unwrap_or(0);
        (0..n).map(|i| (start + i) % n).collect()
    }

    /// Where a pane's status line is: its row, and the columns its format has.
    fn status_line(&self, g: &Geom) -> Option<(u32, u32, u32)> {
        let y = match self.status { Status::Top => g.y.checked_sub(1)?, Status::Bottom => g.y + g.h, Status::Off => return None };
        let width = if g.w < 4 { 0 } else { g.w - 4 };
        Some((g.x + 2, y, width))
    }

    /// screen_redraw_check_cell: the cell's type and the pane whose border it is.
    fn check(&self, px: u32, py: u32) -> (usize, Option<usize>) {
        if px > self.sx || py > self.sy { return (OUTSIDE, None) }
        if px == self.sx || py == self.sy { return (self.cell_type(px, py), None) }
        let order = self.from_active();
        if self.status != Status::Off {
            for &i in &order {
                if let Some((x, y, width)) = self.status_line(&self.visible[i].1) {
                    if py == y && px >= x && px + 1 <= x + width { return (INSIDE, None) }
                }
            }
        }
        let mut last = None;
        for &i in &order {
            last = Some(i);
            match self.side(&self.visible[i].1, px, py) {
                Side::Inside => return (INSIDE, Some(i)),
                Side::Outside => continue,
                _ => return (self.cell_type(px, py), Some(i)),
            }
        }
        (OUTSIDE, last)
    }

    /// screen_redraw_check_is: whether a cell is on a pane's border.
    fn is_on(&self, px: u32, py: u32, pane: Option<u64>) -> bool {
        let Some(g) = pane.and_then(|p| self.visible.iter().find(|(id, _)| *id == p)).map(|(_, g)| *g) else { return false };
        !matches!(self.side(&g, px, py), Side::Inside | Side::Outside)
    }

    /// screen_redraw_border_set: the character for a cell type.
    fn glyph(&self, cell_type: usize, pane: Option<usize>) -> String {
        match self.lines {
            Lines::Number if cell_type == OUTSIDE => SINGLE[OUTSIDE].to_string(),
            Lines::Number => match pane.and_then(|i| self.all.iter().position(|(id, _)| *id == self.visible[i].0)) {
                Some(index) => char::from(b'0' + ((index + self.base) % 10) as u8).to_string(),
                None => "*".into(),
            },
            Lines::Double => DOUBLE[cell_type].into(),
            Lines::Heavy => HEAVY[cell_type].into(),
            Lines::Simple => SIMPLE[cell_type].into(),
            Lines::Single => SINGLE[cell_type].into(),
        }
    }

    /// Every border cell of the window (screen_redraw_draw_borders).
    pub fn cells(&self) -> Vec<Cell> {
        let mut out = Vec::new();
        let arrows = matches!(self.indicators, Indicators::Arrows | Indicators::Both);
        let active_geom = self.active.and_then(|a| self.visible.iter().find(|(id, _)| *id == a)).map(|(_, g)| *g);
        for y in 0..self.sy {
            for x in 0..self.sx {
                let (cell_type, pane) = self.check(x, y);
                if cell_type == INSIDE { continue }
                let paint = if pane.is_some() && self.is_on(x, y, self.active) { Paint::Active } else { Paint::Normal };
                let marked = pane.is_some() && self.marked.is_some() && self.is_on(x, y, self.marked);
                let mut glyph = self.glyph(cell_type, pane);
                if let (true, Some(i), Some(ag)) = (arrows, pane, active_geom) {
                    // An arrow one cell in along the active pane's border, pointing at it.
                    let border = self.side(&ag, x, y);
                    let wg = self.visible[i].1;
                    let along = (x == wg.x + 1 && (cell_type == LEFTRIGHT || (cell_type == TOPJOIN && border == Side::Bottom) || (cell_type == BOTTOMJOIN && border == Side::Top)))
                        || (y == wg.y + 1 && (cell_type == TOPBOTTOM || (cell_type == LEFTJOIN && border == Side::Right) || (cell_type == RIGHTJOIN && border == Side::Left)));
                    if along && self.is_on(x, y, self.active) {
                        glyph = match border { Side::Left => "→", Side::Right => "←", Side::Top => "↓", Side::Bottom => "↑", _ => " " }.into();
                    }
                }
                out.push(Cell { x, y, glyph, paint, marked });
            }
        }
        out
    }

    /// Each visible pane's status line (screen_redraw_make_pane_status): where, and the border
    /// characters under its format.
    pub fn titles(&self) -> Vec<Title> {
        let mut out = Vec::new();
        for (i, (id, g)) in self.visible.iter().enumerate() {
            let Some((x, y, width)) = self.status_line(g) else { continue };
            if y >= self.sy { continue }
            let fill = (0..width).map(|k| self.glyph(self.cell_type(x + k, y), Some(i))).collect();
            out.push(Title { pane: *id, x, y, width, fill, active: Some(*id) == self.active });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(x: u32, y: u32, w: u32, h: u32) -> Geom { Geom { x, y, w, h } }

    /// The window as text: border glyphs where tmux puts them, `.` inside panes, `=` status lines.
    fn picture(f: &Frame) -> Vec<String> {
        let mut rows = vec![vec![".".to_string(); f.sx as usize]; f.sy as usize];
        for c in f.cells() { rows[c.y as usize][c.x as usize] = c.glyph }
        for t in f.titles() { for k in 0..t.width { rows[t.y as usize][(t.x + k) as usize] = "=".into() } }
        rows.into_iter().map(|r| r.concat()).collect()
    }

    #[test]
    fn stacked_and_side_by_side_as_tmux_draws_them() {
        // tmux 3.5a, 20x7, pane-border-status off: 0 | (1 over 2).
        let panes = [(0, g(0, 0, 10, 7)), (1, g(11, 0, 9, 3)), (2, g(11, 4, 9, 3))];
        let f = Frame { sx: 20, sy: 7, all: &panes, visible: &panes, active: Some(2), marked: None, status: Status::Off, lines: Lines::Single, indicators: Indicators::Colour, base: 0 };
        assert_eq!(picture(&f), vec![
            "..........│.........",
            "..........│.........",
            "..........│.........",
            "..........├─────────",
            "..........│.........",
            "..........│.........",
            "..........│.........",
        ]);
        // The active pane's border is its own: the seam beside it and the line above it.
        let active: Vec<(u32, u32)> = f.cells().into_iter().filter(|c| c.paint == Paint::Active).map(|c| (c.x, c.y)).collect();
        assert!(active.contains(&(10, 5)) && active.contains(&(15, 3)) && !active.contains(&(10, 1)));
    }

    #[test]
    fn two_panes_share_the_border_by_halves() {
        // Two side by side, no status lines: the left pane owns the top half of the seam.
        let panes = [(0, g(0, 0, 10, 6)), (1, g(11, 0, 9, 6))];
        let left = Frame { sx: 20, sy: 6, all: &panes, visible: &panes, active: Some(0), marked: None, status: Status::Off, lines: Lines::Single, indicators: Indicators::Colour, base: 0 };
        let lit: Vec<u32> = left.cells().into_iter().filter(|c| c.paint == Paint::Active).map(|c| c.y).collect();
        assert_eq!(lit, vec![0, 1, 2, 3]);
        let right = Frame { active: Some(1), ..left };
        let lit: Vec<u32> = right.cells().into_iter().filter(|c| c.paint == Paint::Active).map(|c| c.y).collect();
        assert_eq!(lit, vec![4, 5]);
    }

    #[test]
    fn status_lines_start_two_cells_in() {
        // pane-border-status top, 20x8: 0 over 1, each with its title row.
        let panes = [(0, g(0, 1, 20, 3)), (1, g(0, 5, 20, 3))];
        let f = Frame { sx: 20, sy: 8, all: &panes, visible: &panes, active: Some(0), marked: None, status: Status::Top, lines: Lines::Single, indicators: Indicators::Colour, base: 0 };
        assert_eq!(picture(&f), vec![
            "──================──",
            "....................",
            "....................",
            "....................",
            "──================──",
            "....................",
            "....................",
            "....................",
        ]);
        assert_eq!(f.titles()[0].fill.concat(), "─".repeat(16));
    }
}
