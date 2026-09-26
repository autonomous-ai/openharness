//! A window's panes as tmux lays them out, ported from tmux 3.5a (layout.c, layout-set.c,
//! layout-custom.c): a tree of cells whose sizes are counted in cells — a pane, or a row (side by
//! side) or column (stacked) of cells with a one-cell border between neighbours. Splitting,
//! closing, resizing, spreading and the named layouts move the same cells tmux's do, so a window
//! reads the same, cell for cell, in both.
//!
//! A pane's status line (pane-border-status top) is the border row above it — the top pane of
//! a column gives up its own first row for it; bottom, the row below, and the bottom pane its
//! last. `rects` hands out each pane's tile that way, status line included.

use ratatui::layout::Rect;

/// tmux's PANE_MINIMUM.
pub const PANE_MINIMUM: u32 = 1;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dir {
    /// Side by side (tmux's LAYOUT_LEFTRIGHT).
    Horizontal,
    /// Stacked (LAYOUT_TOPBOTTOM).
    Vertical,
}

/// pane-border-status: whether each pane has a status line, above it or below it, which the
/// layout's minimums count.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Status { #[default] Off, Top, Bottom }

impl Status {
    pub fn of(v: &str) -> Status { match v { "top" => Status::Top, "bottom" => Status::Bottom, _ => Status::Off } }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Preset {
    Grid,
    Columns,
    Rows,
    MainStack,
    MainRow,
}

impl Preset {
    pub const ALL: [(Preset, &'static str, &'static str); 5] = [
        (Preset::Grid, "Grid", "every pane the same size"),
        (Preset::MainStack, "Main + stack", "one big on the left, the rest stacked"),
        (Preset::MainRow, "Main + row", "one big on top, the rest in a row"),
        (Preset::Columns, "Columns", "side by side"),
        (Preset::Rows, "Rows", "one above the other"),
    ];
}

/// tmux's named layouts, in its order (select-layout, next-layout, M-1 … M-7).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Named { EvenHorizontal, EvenVertical, MainHorizontal, MainHorizontalMirrored, MainVertical, MainVerticalMirrored, Tiled }

impl Named {
    pub const ALL: [Named; 7] = [Named::EvenHorizontal, Named::EvenVertical, Named::MainHorizontal, Named::MainHorizontalMirrored, Named::MainVertical, Named::MainVerticalMirrored, Named::Tiled];
    pub fn name(self) -> &'static str {
        match self {
            Named::EvenHorizontal => "even-horizontal", Named::EvenVertical => "even-vertical", Named::MainHorizontal => "main-horizontal",
            Named::MainHorizontalMirrored => "main-horizontal-mirrored", Named::MainVertical => "main-vertical",
            Named::MainVerticalMirrored => "main-vertical-mirrored", Named::Tiled => "tiled",
        }
    }
    /// tmux's layout_set_lookup: the whole name, else the one name it starts (ambiguous: none).
    pub fn lookup(name: &str) -> Option<Named> {
        if let Some(n) = Named::ALL.iter().find(|n| n.name() == name) { return Some(*n) }
        let hits: Vec<Named> = Named::ALL.iter().copied().filter(|n| !name.is_empty() && n.name().starts_with(name)).collect();
        if hits.len() == 1 { Some(hits[0]) } else { None }
    }
    pub fn of(preset: Preset) -> Named {
        match preset { Preset::Columns => Named::EvenHorizontal, Preset::Rows => Named::EvenVertical, Preset::MainRow => Named::MainHorizontal, Preset::MainStack => Named::MainVertical, Preset::Grid => Named::Tiled }
    }
}

#[derive(Clone, Debug)]
struct Cell { dir: Option<Dir>, pane: u64, sx: u32, sy: u32, xoff: u32, yoff: u32, parent: Option<usize>, cells: Vec<usize> }

/// A window's layout: its cells (an arena), the root, and pane-border-status.
#[derive(Clone, Debug)]
pub struct Node { c: Vec<Cell>, root: usize, pub status: Status }

impl Node {
    /// layout_init: one pane filling a window of sx × sy.
    pub fn new(pane: u64, sx: u16, sy: u16) -> Node {
        Node { c: vec![Cell { dir: None, pane, sx: sx as u32, sy: sy as u32, xoff: 0, yoff: 0, parent: None, cells: Vec::new() }], root: 0, status: Status::Off }
    }

    fn cell(&mut self, parent: Option<usize>) -> usize {
        self.c.push(Cell { dir: None, pane: 0, sx: u32::MAX, sy: u32::MAX, xoff: u32::MAX, yoff: u32::MAX, parent, cells: Vec::new() });
        self.c.len() - 1
    }
    fn is_pane(&self, i: usize) -> bool { self.c[i].dir.is_none() }
    fn size_of(&self, i: usize, dir: Dir) -> u32 { if dir == Dir::Horizontal { self.c[i].sx } else { self.c[i].sy } }
    fn add_size(&mut self, i: usize, dir: Dir, change: i64) { let s = if dir == Dir::Horizontal { &mut self.c[i].sx } else { &mut self.c[i].sy }; *s = (*s as i64 + change).max(0) as u32 }
    fn index_in_parent(&self, i: usize) -> Option<(usize, usize)> { let p = self.c[i].parent?; Some((p, self.c[p].cells.iter().position(|x| *x == i)?)) }
    fn next(&self, i: usize) -> Option<usize> { let (p, at) = self.index_in_parent(i)?; self.c[p].cells.get(at + 1).copied() }
    fn prev(&self, i: usize) -> Option<usize> { let (p, at) = self.index_in_parent(i)?; at.checked_sub(1).map(|a| self.c[p].cells[a]) }
    fn is_last(&self, i: usize) -> bool { self.index_in_parent(i).map(|(p, at)| at + 1 == self.c[p].cells.len()).unwrap_or(true) }
    fn find(&self, pane: u64) -> Option<usize> { self.walk(self.root).into_iter().find(|i| self.c[*i].pane == pane) }
    /// The pane cells under `i`, in order.
    fn walk(&self, i: usize) -> Vec<usize> {
        if self.is_pane(i) { return vec![i] }
        self.c[i].cells.iter().flat_map(|k| self.walk(*k)).collect()
    }

    pub fn leaves(&self) -> Vec<u64> { self.walk(self.root).into_iter().map(|i| self.c[i].pane).collect() }

    /// The window's size in cells.
    pub fn size(&self) -> (u16, u16) { (self.c[self.root].sx as u16, self.c[self.root].sy as u16) }

    /// A pane's cell size.

    fn fix_offsets(&mut self) {
        let r = self.root;
        self.c[r].xoff = 0;
        self.c[r].yoff = 0;
        self.fix_offsets1(r);
    }

    fn fix_offsets1(&mut self, i: usize) {
        let (dir, x, y) = (self.c[i].dir, self.c[i].xoff, self.c[i].yoff);
        let kids = self.c[i].cells.clone();
        let (mut xoff, mut yoff) = (x, y);
        for k in kids {
            if dir == Some(Dir::Horizontal) { self.c[k].xoff = xoff; self.c[k].yoff = y } else { self.c[k].xoff = x; self.c[k].yoff = yoff }
            if !self.is_pane(k) { self.fix_offsets1(k) }
            if dir == Some(Dir::Horizontal) { xoff += self.c[k].sx + 1 } else { yoff += self.c[k].sy + 1 }
        }
    }

    fn cell_is_top(&self, mut i: usize) -> bool {
        while let Some(p) = self.c[i].parent {
            if self.c[p].dir == Some(Dir::Vertical) && self.c[p].cells.first() != Some(&i) { return false }
            i = p;
        }
        true
    }

    /// layout_cell_is_bottom: no cell below it in any column it is in.
    fn cell_is_bottom(&self, mut i: usize) -> bool {
        while let Some(p) = self.c[i].parent {
            if self.c[p].dir == Some(Dir::Vertical) && self.c[p].cells.last() != Some(&i) { return false }
            i = p;
        }
        true
    }

    /// layout_add_horizontal_border: whether this cell gives a row to its pane's status line.
    fn add_border(&self, i: usize) -> bool {
        match self.status { Status::Top => self.cell_is_top(i), Status::Bottom => self.cell_is_bottom(i), Status::Off => false }
    }

    /// layout_resize_check: how much a cell can give up in a direction.
    fn resize_check(&self, i: usize, dir: Dir) -> u32 {
        if self.is_pane(i) {
            let (available, minimum) = if dir == Dir::Horizontal { (self.c[i].sx, PANE_MINIMUM) } else { (self.c[i].sy, if self.add_border(i) { PANE_MINIMUM + 1 } else { PANE_MINIMUM }) };
            return available.saturating_sub(minimum);
        }
        if self.c[i].dir == Some(dir) {
            self.c[i].cells.iter().map(|k| self.resize_check(*k, dir)).sum()
        } else {
            self.c[i].cells.iter().map(|k| self.resize_check(*k, dir)).min().unwrap_or(0)
        }
    }

    /// layout_resize_adjust: grow or shrink a cell, its children evenly.
    fn resize_adjust(&mut self, i: usize, dir: Dir, mut change: i64) {
        self.add_size(i, dir, change);
        if self.is_pane(i) { return }
        let kids = self.c[i].cells.clone();
        if self.c[i].dir != Some(dir) {
            for k in kids { self.resize_adjust(k, dir, change) }
            return;
        }
        while change != 0 {
            let before = change;
            for &k in &kids {
                if change == 0 { break }
                if change > 0 { self.resize_adjust(k, dir, 1); change -= 1; continue }
                if self.resize_check(k, dir) > 0 { self.resize_adjust(k, dir, -1); change += 1 }
            }
            // (tmux loops until done; a change none of them can take would loop for ever.)
            if change == before { break }
        }
    }

    /// layout_resize: the window's size changed.
    pub fn resize(&mut self, sx: u16, sy: u16) {
        let r = self.root;
        for (dir, want) in [(Dir::Horizontal, sx as i64), (Dir::Vertical, sy as i64)] {
            let now = self.size_of(r, dir) as i64;
            let mut change = want - now;
            let limit = self.resize_check(r, dir) as i64;
            if change < 0 && change < -limit { change = -limit }
            if limit == 0 { change = if want <= now { 0 } else { want - now } }
            if change != 0 { self.resize_adjust(r, dir, change) }
        }
        self.fix_offsets();
    }

    /// layout_destroy_cell: a pane goes, its space to the cell before it (or after, for the first).
    pub fn remove(mut self, pane: u64) -> Option<Node> {
        let i = self.find(pane)?;
        let Some(p) = self.c[i].parent else { return None };
        let at = self.c[p].cells.iter().position(|x| *x == i)?;
        let other = if at == 0 { self.c[p].cells.get(1).copied() } else { Some(self.c[p].cells[at - 1]) };
        if let Some(o) = other {
            let dir = self.c[p].dir.unwrap_or(Dir::Horizontal);
            let give = self.size_of(i, dir) as i64 + 1;
            self.resize_adjust(o, dir, give);
        }
        self.c[p].cells.remove(at);
        if self.c[p].cells.len() == 1 {
            let only = self.c[p].cells[0];
            let grand = self.c[p].parent;
            self.c[only].parent = grand;
            match grand {
                None => { self.root = only; self.c[only].xoff = 0; self.c[only].yoff = 0 }
                Some(g) => { if let Some(slot) = self.c[g].cells.iter_mut().find(|x| **x == p) { *slot = only } }
            }
        }
        self.fix_offsets();
        Some(self.compact())
    }

    /// The live cells only (a tree that lost some keeps its arena small).
    fn compact(self) -> Node {
        fn copy(src: &Node, i: usize, parent: Option<usize>, out: &mut Vec<Cell>) -> usize {
            let at = out.len();
            let mut cell = src.c[i].clone();
            cell.parent = parent;
            cell.cells = Vec::new();
            out.push(cell);
            let kids: Vec<usize> = src.c[i].cells.iter().map(|k| copy(src, *k, Some(at), out)).collect();
            out[at].cells = kids;
            at
        }
        let mut c = Vec::new();
        copy(&self, self.root, None, &mut c);
        Node { c, root: 0, status: self.status }
    }

    pub fn replace(&mut self, target: u64, with: u64) -> bool {
        match self.find(target) { Some(i) => { self.c[i].pane = with; true } None => false }
    }

    pub fn swap(&mut self, x: u64, y: u64) {
        let (a, b) = (self.find(x), self.find(y));
        if let (Some(a), Some(b)) = (a, b) { self.c[a].pane = y; self.c[b].pane = x }
    }

    /// The panes renamed in order (rotate-window).
    pub fn relabel(&mut self, next: &mut dyn FnMut(u64) -> u64) {
        for i in self.walk(self.root) { self.c[i].pane = next(self.c[i].pane) }
    }

    /// Each pane's tile within [area] — the cells of a window of the area's size — its title row
    /// included (on the border above it, but for the top pane of a column).
    pub fn rects(&self, area: Rect, out: &mut Vec<(u64, Rect)>) {
        let fitted;
        let me = if self.size() != (area.width, area.height) { let mut n = self.clone(); n.resize(area.width, area.height); fitted = n; &fitted } else { self };
        for i in me.walk(me.root) {
            let c = &me.c[i];
            let (x, y, w, h) = (c.xoff, c.yoff, c.sx, c.sy);
            let (y, h) = match me.status {
                Status::Top if !me.cell_is_top(i) => (y.saturating_sub(1), h + 1),
                Status::Bottom if !me.cell_is_bottom(i) => (y, h + 1),
                _ => (y, h),
            };
            let r = Rect::new(area.x + x.min(u16::MAX as u32) as u16, area.y + y.min(u16::MAX as u32) as u16, w.min(u16::MAX as u32) as u16, h.min(u16::MAX as u32) as u16);
            out.push((c.pane, r.intersection(area)));
        }
    }

    /// layout_split_pane + layout_assign_pane: [new] beside [target] (or, [full], across the whole
    /// window), taking [size] cells (None: half), [before] it: left of or above. False when there
    /// is no room (tmux's "no space for new pane").
    pub fn split_with(&mut self, target: Option<u64>, new: u64, dir: Dir, size: Option<u32>, before: bool, full: bool) -> bool {
        let lc = if full { self.root } else { match target.and_then(|t| self.find(t)) { Some(i) => i, None => return false } };
        let (sx, sy, xoff, yoff) = (self.c[lc].sx, self.c[lc].sy, self.c[lc].xoff, self.c[lc].yoff);
        match dir {
            Dir::Horizontal => { if sx < PANE_MINIMUM * 2 + 1 { return false } }
            Dir::Vertical => { let minimum = if self.add_border(lc) { PANE_MINIMUM * 2 + 2 } else { PANE_MINIMUM * 2 + 1 }; if sy < minimum { return false } }
        }
        let saved = if dir == Dir::Horizontal { sx } else { sy };
        let mut size2 = match size { None => (saved + 1) / 2 - 1, Some(s) if before => saved.saturating_sub(s + 1), Some(s) => s };
        if size2 < PANE_MINIMUM { size2 = PANE_MINIMUM } else if size2 > saved - 2 { size2 = saved - 2 }
        let size1 = saved - 1 - size2;
        let new_size = if before { size2 } else { size1 };
        if full && !self.set_size_check(lc, dir, new_size as i64) { return false }
        let mut resize_first = false;
        let lcnew;
        let parent = self.c[lc].parent;
        if parent.map(|p| self.c[p].dir == Some(dir)).unwrap_or(false) {
            let p = parent.unwrap();
            lcnew = self.cell(Some(p));
            let at = self.c[p].cells.iter().position(|x| *x == lc).unwrap_or(0);
            self.c[p].cells.insert(if before { at } else { at + 1 }, lcnew);
        } else if full && parent.is_none() && self.c[lc].dir == Some(dir) {
            // The new full-size pane runs the root's way: it goes under the root, which shrinks first.
            if dir == Dir::Horizontal { self.c[lc].sx = new_size } else { self.c[lc].sy = new_size }
            self.resize_child_cells(lc);
            if dir == Dir::Horizontal { self.c[lc].sx = saved } else { self.c[lc].sy = saved }
            resize_first = true;
            lcnew = self.cell(Some(lc));
            let sz = saved - 1 - new_size;
            if dir == Dir::Horizontal { self.set_size(lcnew, sz, sy, 0, 0) } else { self.set_size(lcnew, sx, sz, 0, 0) }
            if before { self.c[lc].cells.insert(0, lcnew) } else { self.c[lc].cells.push(lcnew) }
        } else {
            // A new parent in the cell's place, the cell and the newcomer under it.
            let np = self.cell(parent);
            self.c[np].dir = Some(dir);
            self.set_size(np, sx, sy, xoff, yoff);
            match parent { None => self.root = np, Some(p) => { if let Some(slot) = self.c[p].cells.iter_mut().find(|x| **x == lc) { *slot = np } } }
            self.c[lc].parent = Some(np);
            self.c[np].cells.push(lc);
            lcnew = self.cell(Some(np));
            if before { self.c[np].cells.insert(0, lcnew) } else { self.c[np].cells.push(lcnew) }
        }
        let (lc1, lc2) = if before { (lcnew, lc) } else { (lc, lcnew) };
        if !resize_first {
            if dir == Dir::Horizontal {
                self.set_size(lc1, size1, sy, xoff, yoff);
                let x2 = xoff + self.c[lc1].sx + 1;
                self.set_size(lc2, size2, sy, x2, yoff);
            } else {
                self.set_size(lc1, sx, size1, xoff, yoff);
                let y2 = yoff + self.c[lc1].sy + 1;
                self.set_size(lc2, sx, size2, xoff, y2);
            }
        }
        if full {
            if !resize_first { self.resize_child_cells(lc) }
        }
        self.c[lcnew].dir = None;
        self.c[lcnew].pane = new;
        self.fix_offsets();
        true
    }

    /// split-window's default: half of [target], after it.
    pub fn split(&mut self, target: u64, new: u64, dir: Dir) -> bool { self.split_with(Some(target), new, dir, None, false, false) }

    fn set_size(&mut self, i: usize, sx: u32, sy: u32, xoff: u32, yoff: u32) { let c = &mut self.c[i]; c.sx = sx; c.sy = sy; c.xoff = xoff; c.yoff = yoff }

    /// layout_new_pane_size.
    fn new_pane_size(&self, previous: u32, i: usize, dir: Dir, size: u32, count_left: u32, size_left: u32) -> u32 {
        if count_left == 1 { return size_left }
        let available = self.resize_check(i, dir);
        let mut min = (PANE_MINIMUM + 1) * (count_left - 1);
        let cur = self.size_of(i, dir);
        if cur.saturating_sub(available) > min { min = cur - available }
        let mut new_size = if previous == 0 { 0 } else { (cur as u64 * size as u64 / previous as u64) as u32 };
        let max = size_left.saturating_sub(min);
        if new_size > max { new_size = max }
        if new_size < PANE_MINIMUM { new_size = PANE_MINIMUM }
        new_size
    }

    /// layout_set_size_check: can this cell take that size?
    fn set_size_check(&self, i: usize, dir: Dir, size: i64) -> bool {
        if self.is_pane(i) { return size >= PANE_MINIMUM as i64 }
        let mut available = size;
        let count = self.c[i].cells.len() as i64;
        if self.c[i].dir == Some(dir) {
            if available < count * 2 - 1 { return false }
            let previous = self.size_of(i, dir);
            for (idx, &k) in self.c[i].cells.iter().enumerate() {
                let new_size = self.new_pane_size(previous, k, dir, size.max(0) as u32, (count - idx as i64) as u32, available.max(0) as u32) as i64;
                if idx as i64 == count - 1 { if new_size > available { return false } available -= new_size }
                else { if new_size + 1 > available { return false } available -= new_size + 1 }
                if !self.set_size_check(k, dir, new_size) { return false }
            }
        } else {
            for &k in &self.c[i].cells { if !self.is_pane(k) && !self.set_size_check(k, dir, size) { return false } }
        }
        true
    }

    /// layout_resize_child_cells: a cell's children fitted into its size.
    fn resize_child_cells(&mut self, i: usize) {
        if self.is_pane(i) { return }
        let dir = self.c[i].dir.unwrap_or(Dir::Horizontal);
        let kids = self.c[i].cells.clone();
        let count = kids.len() as u32;
        let mut previous: u32 = kids.iter().map(|k| self.size_of(*k, dir)).sum();
        previous += count.saturating_sub(1);
        let mut available = self.size_of(i, dir);
        for (idx, &k) in kids.iter().enumerate() {
            if dir == Dir::Vertical {
                self.c[k].sx = self.c[i].sx;
                self.c[k].xoff = self.c[i].xoff;
            } else {
                let s = self.new_pane_size(previous, k, dir, self.c[i].sx, count - idx as u32, available);
                self.c[k].sx = s;
                available = available.saturating_sub(s + 1);
            }
            if dir == Dir::Horizontal {
                self.c[k].sy = self.c[i].sy;
            } else {
                let s = self.new_pane_size(previous, k, dir, self.c[i].sy, count - idx as u32, available);
                self.c[k].sy = s;
                available = available.saturating_sub(s + 1);
            }
            self.resize_child_cells(k);
        }
    }

    /// layout_resize_pane: [pane] grows (or shrinks) by `change` cells in a direction, by the
    /// border after it — before it for the last in a row; [opposite]: take from the other side too.
    pub fn resize_pane(&mut self, pane: u64, dir: Dir, change: i32, opposite: bool) {
        let Some(mut lc) = self.find(pane) else { return };
        let mut parent = self.c[lc].parent;
        while let Some(p) = parent { if self.c[p].dir == Some(dir) { break } lc = p; parent = self.c[p].parent }
        if parent.is_none() { return }
        if self.is_last(lc) { if let Some(p) = self.prev(lc) { lc = p } }
        self.resize_layout(lc, dir, change, opposite);
    }

    /// layout_resize_pane_to: [pane] made `size` cells in a direction.
    pub fn resize_pane_to(&mut self, pane: u64, dir: Dir, size: u32) {
        let Some(mut lc) = self.find(pane) else { return };
        let mut parent = self.c[lc].parent;
        while let Some(p) = parent { if self.c[p].dir == Some(dir) { break } lc = p; parent = self.c[p].parent }
        if parent.is_none() { return }
        let now = self.size_of(lc, dir) as i64;
        let change = if self.is_last(lc) { now - size as i64 } else { size as i64 - now };
        self.resize_pane(pane, dir, change as i32, true);
    }

    fn resize_layout(&mut self, lc: usize, dir: Dir, change: i32, opposite: bool) {
        let mut needed = change as i64;
        while needed != 0 {
            let size = if change > 0 { let s = self.grow(lc, dir, needed, opposite); needed -= s; s } else { let s = self.shrink(lc, dir, needed); needed += s; s };
            if size == 0 { break }
        }
        self.fix_offsets();
    }

    fn grow(&mut self, lc: usize, dir: Dir, needed: i64, opposite: bool) -> i64 {
        let mut size = 0u32;
        let mut remove = self.next(lc);
        while let Some(r) = remove { size = self.resize_check(r, dir); if size > 0 { break } remove = self.next(r) }
        if opposite && remove.is_none() {
            remove = self.prev(lc);
            while let Some(r) = remove { size = self.resize_check(r, dir); if size > 0 { break } remove = self.prev(r) }
        }
        let Some(r) = remove else { return 0 };
        let size = (size as i64).min(needed);
        self.resize_adjust(lc, dir, size);
        self.resize_adjust(r, dir, -size);
        size
    }

    fn shrink(&mut self, lc: usize, dir: Dir, needed: i64) -> i64 {
        let mut remove = Some(lc);
        let mut size = 0u32;
        while let Some(r) = remove { size = self.resize_check(r, dir); if size != 0 { break } remove = self.prev(r) }
        let Some(r) = remove else { return 0 };
        let Some(add) = self.next(lc) else { return 0 };
        let size = (size as i64).min(-needed);
        self.resize_adjust(add, dir, size);
        self.resize_adjust(r, dir, -size);
        size
    }

    /// layout_spread_cell: a row's or column's cells made the same size.
    fn spread_cell(&mut self, parent: usize) -> bool {
        let number = self.c[parent].cells.len() as u32;
        if number <= 1 { return false }
        let Some(dir) = self.c[parent].dir else { return false };
        let size = if dir == Dir::Horizontal { self.c[parent].sx } else if self.add_border(parent) { self.c[parent].sy.saturating_sub(1) } else { self.c[parent].sy };
        if size < number - 1 { return false }
        let mut each = (size - (number - 1)) / number;
        if each == 0 { return false }
        let mut changed = false;
        let kids = self.c[parent].cells.clone();
        for (n, &k) in kids.iter().enumerate() {
            if n + 1 == kids.len() { each = size - (each + 1) * (number - 1) }
            let change = if dir == Dir::Horizontal {
                let c = each as i64 - self.c[k].sx as i64;
                self.resize_adjust(k, Dir::Horizontal, c);
                c
            } else {
                let this = if self.add_border(k) { each + 1 } else { each };
                let c = this as i64 - self.c[k].sy as i64;
                self.resize_adjust(k, Dir::Vertical, c);
                c
            };
            if change != 0 { changed = true }
        }
        changed
    }

    /// layout_spread_out (select-layout -E): the pane's row or column evened out, else the next
    /// one up that changes.
    pub fn spread_out(&mut self, pane: u64) {
        let Some(i) = self.find(pane) else { return };
        let mut parent = self.c[i].parent;
        while let Some(p) = parent {
            if self.spread_cell(p) { self.fix_offsets(); return }
            parent = self.c[p].parent;
        }
    }

    /// tmux's layout string (layout_dump): `csum,WxH,X,Y{…}`, a pane's id after its cell.
    pub fn to_tmux(&self) -> String {
        fn body(n: &Node, i: usize, out: &mut String) {
            let c = &n.c[i];
            out.push_str(&format!("{}x{},{},{}", c.sx, c.sy, c.xoff, c.yoff));
            match c.dir {
                None => out.push_str(&format!(",{}", c.pane)),
                Some(dir) => {
                    out.push(if dir == Dir::Horizontal { '{' } else { '[' });
                    for (k, kid) in c.cells.iter().enumerate() { if k > 0 { out.push(',') } body(n, *kid, out) }
                    out.push(if dir == Dir::Horizontal { '}' } else { ']' });
                }
            }
        }
        let mut b = String::new();
        body(self, self.root, &mut b);
        format!("{:04x},{b}", checksum(&b))
    }

    /// A layout from tmux's string, its cells given to `ids` in order, fitted to sx × sy (None
    /// when it does not read, or its cells do not match the panes).
    pub fn from_tmux(text: &str, ids: &[u64], sx: u16, sy: u16) -> Option<Node> {
        let body = match text.split_once(',') { Some((c, rest)) if c.len() == 4 && c.chars().all(|x| x.is_ascii_hexdigit()) => rest, _ => text };
        let b: Vec<char> = body.chars().collect();
        let mut n = Node { c: Vec::new(), root: 0, status: Status::Off };
        let mut at = 0usize;
        let mut next = 0usize;
        fn num(b: &[char], at: &mut usize) -> Option<u32> {
            let start = *at;
            while *at < b.len() && b[*at].is_ascii_digit() { *at += 1 }
            b[start..*at].iter().collect::<String>().parse().ok()
        }
        fn parse(n: &mut Node, b: &[char], at: &mut usize, parent: Option<usize>, ids: &[u64], next: &mut usize) -> Option<usize> {
            let i = n.cell(parent);
            let sx = num(b, at)?; if b.get(*at) != Some(&'x') { return None } *at += 1;
            let sy = num(b, at)?; if b.get(*at) != Some(&',') { return None } *at += 1;
            let xoff = num(b, at)?; if b.get(*at) != Some(&',') { return None } *at += 1;
            let yoff = num(b, at)?;
            n.set_size(i, sx, sy, xoff, yoff);
            match b.get(*at) {
                Some('{') | Some('[') => {
                    let (close, dir) = if b[*at] == '{' { ('}', Dir::Horizontal) } else { (']', Dir::Vertical) };
                    *at += 1;
                    n.c[i].dir = Some(dir);
                    loop {
                        let k = parse(n, b, at, Some(i), ids, next)?;
                        n.c[i].cells.push(k);
                        match b.get(*at) { Some(',') => { *at += 1; continue } Some(c) if *c == close => { *at += 1; break } _ => return None }
                    }
                }
                Some(',') if b.get(*at + 1).map(|c| c.is_ascii_digit()).unwrap_or(false) => { *at += 1; num(b, at)?; n.c[i].pane = *ids.get(*next)?; *next += 1 }
                _ => { n.c[i].pane = *ids.get(*next)?; *next += 1 }
            }
            Some(i)
        }
        n.root = parse(&mut n, &b, &mut at, None, ids, &mut next)?;
        if at != b.len() || next != ids.len() { return None }
        n.resize(sx, sy);
        Some(n)
    }
}

/// tmux's named layouts (layout-set.c) over `ids` in a window of sx × sy. main-pane-width/height
/// and other-pane-width/height are tmux's strings (cells, or n%).
pub fn arrange(named: Named, ids: &[u64], sx: u16, sy: u16, status: Status, main: (&str, &str), other: (&str, &str)) -> Option<Node> {
    if ids.is_empty() { return None }
    let (wsx, wsy) = (sx as u32, sy as u32);
    let mut n = Node::new(ids[0], sx, sy);
    n.status = status;
    if ids.len() == 1 { return Some(n) }
    n.c.clear();
    let pct = |s: &str, total: u32| -> Option<u32> { match s.strip_suffix('%') { Some(p) => p.parse::<u32>().ok().map(|p| total * p / 100), None => s.parse().ok() } };
    match named {
        Named::EvenHorizontal | Named::EvenVertical => {
            let dir = if named == Named::EvenHorizontal { Dir::Horizontal } else { Dir::Vertical };
            let count = ids.len() as u32;
            let need = count * (PANE_MINIMUM + 1) - 1;
            let (sx, sy) = if dir == Dir::Horizontal { (need.max(wsx), wsy) } else { (wsx, need.max(wsy)) };
            let root = n.cell(None);
            n.root = root;
            n.set_size(root, sx, sy, 0, 0);
            n.c[root].dir = Some(dir);
            for id in ids { let k = n.cell(Some(root)); n.c[k].pane = *id; n.set_size(k, wsx, wsy, 0, 0); n.c[root].cells.push(k) }
            n.spread_cell(root);
        }
        Named::MainHorizontal | Named::MainHorizontalMirrored | Named::MainVertical | Named::MainVerticalMirrored => {
            let horizontal = matches!(named, Named::MainHorizontal | Named::MainHorizontalMirrored);
            let mirrored = matches!(named, Named::MainHorizontalMirrored | Named::MainVerticalMirrored);
            let others = ids.len() as u32 - 1;
            // The room across the split, one taken for the border.
            let span = if horizontal { wsy.saturating_sub(1) } else { wsx.saturating_sub(1) };
            let (main_s, other_s) = if horizontal { (main.1, other.1) } else { (main.0, other.0) };
            let mut mainz = pct(main_s, span).unwrap_or(if horizontal { 24 } else { 80 });
            let otherz;
            if mainz + PANE_MINIMUM >= span {
                mainz = if span <= PANE_MINIMUM + PANE_MINIMUM { PANE_MINIMUM } else { span - PANE_MINIMUM };
                otherz = PANE_MINIMUM;
            } else {
                let o = pct(other_s, span).unwrap_or(0);
                if o == 0 { otherz = span - mainz }
                else if o > span || span - o < mainz { otherz = span - mainz }
                else { otherz = o; mainz = span - o }
            }
            // Room along it for the others.
            let along = (others * (PANE_MINIMUM + 1) - 1).max(if horizontal { wsx } else { wsy });
            let root = n.cell(None);
            n.root = root;
            if horizontal { n.set_size(root, along, mainz + otherz + 1, 0, 0) } else { n.set_size(root, mainz + otherz + 1, along, 0, 0) }
            n.c[root].dir = Some(if horizontal { Dir::Vertical } else { Dir::Horizontal });
            let add_main = |n: &mut Node| { let m = n.cell(Some(root)); n.c[m].pane = ids[0]; if horizontal { n.set_size(m, along, mainz, 0, 0) } else { n.set_size(m, mainz, along, 0, 0) } n.c[root].cells.push(m) };
            if !mirrored { add_main(&mut n) }
            let o = n.cell(Some(root));
            if horizontal { n.set_size(o, along, otherz, 0, 0) } else { n.set_size(o, otherz, along, 0, 0) }
            n.c[root].cells.push(o);
            if others == 1 { n.c[o].pane = ids[1] } else {
                n.c[o].dir = Some(if horizontal { Dir::Horizontal } else { Dir::Vertical });
                for id in &ids[1..] {
                    let k = n.cell(Some(o));
                    n.c[k].pane = *id;
                    if horizontal { n.set_size(k, PANE_MINIMUM, otherz, 0, 0) } else { n.set_size(k, otherz, PANE_MINIMUM, 0, 0) }
                    n.c[o].cells.push(k);
                }
                n.spread_cell(o);
            }
            if mirrored { add_main(&mut n) }
        }
        Named::Tiled => {
            let count = ids.len() as u32;
            let (mut rows, mut columns) = (1u32, 1u32);
            while rows * columns < count { rows += 1; if rows * columns < count { columns += 1 } }
            let width = ((wsx.saturating_sub(columns - 1)) / columns).max(PANE_MINIMUM);
            let height = ((wsy.saturating_sub(rows - 1)) / rows).max(PANE_MINIMUM);
            let root = n.cell(None);
            n.root = root;
            n.set_size(root, ((width + 1) * columns - 1).max(wsx), ((height + 1) * rows - 1).max(wsy), 0, 0);
            n.c[root].dir = Some(Dir::Vertical);
            let mut next = 0usize;
            for j in 0..rows {
                if next >= ids.len() { break }
                let row = n.cell(Some(root));
                n.set_size(row, wsx, height, 0, 0);
                n.c[root].cells.push(row);
                if count - j * columns == 1 || columns == 1 { n.c[row].pane = ids[next]; next += 1; continue }
                n.c[row].dir = Some(Dir::Horizontal);
                let mut i = 0u32;
                while i < columns {
                    let k = n.cell(Some(row));
                    n.set_size(k, width, height, 0, 0);
                    n.c[k].pane = ids[next];
                    n.c[row].cells.push(k);
                    next += 1;
                    if next >= ids.len() { break }
                    i += 1;
                }
                if i == columns { i -= 1 }
                let used = (i + 1) * (width + 1) - 1;
                if wsx > used { let last = *n.c[row].cells.last().unwrap(); n.resize_adjust(last, Dir::Horizontal, (wsx - used) as i64) }
            }
            let used = rows * height + rows - 1;
            if wsy > used { let last = *n.c[root].cells.last().unwrap(); n.resize_adjust(last, Dir::Vertical, (wsy - used) as i64) }
        }
    }
    n.fix_offsets();
    // tmux's window_resize to the layout's size, then the client's: back to the window.
    n.resize(sx, sy);
    Some(n.compact())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Toward { Left, Right, Up, Down }

/// tmux's layout checksum.
fn checksum(s: &str) -> u16 {
    let mut c: u16 = 0;
    for b in s.bytes() { c = (c >> 1) | ((c & 1) << 15); c = c.wrapping_add(b as u16) }
    c
}

/// The pane next to [from] in direction [toward]: the nearest one whose edge faces it and which
/// overlaps it most along the other axis.
/// A pane where tmux keeps it: its cells (xoff, yoff, sx, sy) in the window, title rows apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Geom { pub x: u32, pub y: u32, pub w: u32, pub h: u32 }

/// tmux's window_pane_find_up/down/left/right (window.c): the panes whose far edge meets this
/// one's on that side (round to the other side of the window at its edge) and that overlap it
/// along that edge; of those, the most recently active (`point`), the first in the list on a tie.
/// `panes` in the window's list order; `size` the window's; `status` its pane-border-status.
pub fn find_toward(panes: &[(u64, Geom)], from: u64, toward: Toward, size: (u32, u32), status: Status, point: &dyn Fn(u64) -> u64) -> Option<u64> {
    let (_, g) = *panes.iter().find(|(id, _)| *id == from)?;
    let (wsx, wsy) = size;
    let edge = match (toward, status) {
        (Toward::Up, Status::Top) => if g.y == 1 { wsy + 1 } else { g.y },
        (Toward::Up, Status::Bottom) => if g.y == 0 { wsy } else { g.y },
        (Toward::Up, Status::Off) => if g.y == 0 { wsy + 1 } else { g.y },
        (Toward::Down, Status::Top) => { let e = g.y + g.h + 1; if e >= wsy { 1 } else { e } }
        (Toward::Down, Status::Bottom) => { let e = g.y + g.h + 1; if e + 1 >= wsy { 0 } else { e } }
        (Toward::Down, Status::Off) => { let e = g.y + g.h + 1; if e >= wsy { 0 } else { e } }
        (Toward::Left, _) => if g.x == 0 { wsx + 1 } else { g.x },
        (Toward::Right, _) => { let e = g.x + g.w + 1; if e >= wsx { 0 } else { e } }
    };
    // Along the edge: from..to of this pane, and whether the other's span meets it (tmux's test,
    // which counts a pane that starts just past this one's end).
    let meets = |start: u32, len: u32, lo: u32, hi: u32| {
        let end = (start + len).saturating_sub(1);
        (start < lo && end > hi) || (start >= lo && start <= hi) || (end >= lo && end <= hi)
    };
    let mut best: Option<(u64, u64)> = None;
    for (id, n) in panes {
        if *id == from { continue }
        let (touches, along) = match toward {
            Toward::Up => (n.y + n.h + 1 == edge, meets(n.x, n.w, g.x, g.x + g.w)),
            Toward::Down => (n.y == edge, meets(n.x, n.w, g.x, g.x + g.w)),
            Toward::Left => (n.x + n.w + 1 == edge, meets(n.y, n.h, g.y, g.y + g.h)),
            Toward::Right => (n.x == edge, meets(n.y, n.h, g.y, g.y + g.h)),
        };
        if !touches || !along { continue }
        let p = point(*id);
        if best.map(|(_, bp)| p > bp).unwrap_or(true) { best = Some((*id, p)) }
    }
    best.map(|(id, _)| id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rects(n: &Node) -> Vec<(u64, Rect)> { let (w, h) = n.size(); let mut out = Vec::new(); n.rects(Rect::new(0, 0, w, h), &mut out); out }

    #[test]
    fn splits_as_tmux_does() {
        // tmux 3.5a, a 120×31 window: split-window -h gives 60 | 59.
        let mut n = Node::new(0, 120, 31);
        assert!(n.split(0, 1, Dir::Horizontal));
        let r = rects(&n);
        assert_eq!((r[0].1.width, r[1].1.width, r[1].1.x), (60, 59, 61));
        // -l 10 below pane 0, then the layout string reads back.
        assert!(n.split_with(Some(0), 2, Dir::Vertical, Some(10), false, false));
        assert_eq!(n.leaves(), vec![0, 2, 1]);
        let text = n.to_tmux();
        let back = Node::from_tmux(&text, &[0, 2, 1], 120, 31).unwrap();
        assert_eq!(back.to_tmux(), text);
    }

    #[test]
    fn remove_gives_the_space_back() {
        let mut n = Node::new(1, 81, 20);
        n.split(1, 2, Dir::Horizontal);
        n.split(2, 3, Dir::Vertical);
        let n = n.remove(2).unwrap();
        assert_eq!(n.leaves(), vec![1, 3]);
        let r = rects(&n);
        assert_eq!(r[0].1.width + r[1].1.width + 1, 81);
        let n = n.remove(3).unwrap();
        assert_eq!(rects(&n)[0].1.width, 81);
    }

    #[test]
    fn named_layouts() {
        // tiled with two panes stacks them (tmux: rows before columns).
        let n = arrange(Named::Tiled, &[1, 2], 100, 30, Status::Off, ("80", "24"), ("0", "0")).unwrap();
        let r = rects(&n);
        assert_eq!(r[0].1.width, 100);
        assert_eq!(r[1].1.y, r[0].1.height + 1);
        let n = arrange(Named::EvenHorizontal, &[1, 2, 3], 122, 30, Status::Off, ("80", "24"), ("0", "0")).unwrap();
        assert!(rects(&n).iter().all(|(_, r)| r.width == 40));
        let n = arrange(Named::MainVertical, &[1, 2, 3], 200, 40, Status::Off, ("80", "24"), ("0", "0")).unwrap();
        assert_eq!(rects(&n)[0].1.width, 80);
        let n = arrange(Named::MainVerticalMirrored, &[1, 2, 3], 200, 40, Status::Off, ("80", "24"), ("0", "0")).unwrap();
        let r = rects(&n);
        // The main pane (the first) on the right.
        assert_eq!(r.iter().find(|(id, _)| *id == 1).unwrap().1.x, 200 - 80);
        assert_eq!(Named::lookup("tiled"), Some(Named::Tiled));
        assert_eq!(Named::lookup("main-v"), None);
        assert_eq!(Named::lookup("even-v"), Some(Named::EvenVertical));
    }

    #[test]
    fn resize_moves_the_border() {
        let mut n = Node::new(1, 81, 20);
        n.split(1, 2, Dir::Horizontal);
        n.resize_pane_to(1, Dir::Horizontal, 30);
        assert_eq!(rects(&n)[0].1.width, 30);
        n.resize_pane(1, Dir::Horizontal, 5, true);
        assert_eq!(rects(&n)[0].1.width, 35);
        n.resize(61, 20);
        let r = rects(&n);
        assert_eq!(r[0].1.width + r[1].1.width + 1, 61);
    }

    #[test]
    fn neighbours_wrap() {
        // tmux 3.5a, 120x31 with title rows: 0 on the left, 1 over 2 on the right (2 made last).
        let g = |x, y, w, h| Geom { x, y, w, h };
        let panes = [(0, g(0, 1, 60, 30)), (1, g(61, 1, 59, 14)), (2, g(61, 16, 59, 15))];
        let point = |p: u64| [5, 1, 9][p as usize];
        let find = |from, toward| find_toward(&panes, from, toward, (120, 31), Status::Top, &point);
        assert_eq!(find(0, Toward::Right), Some(2), "the more recently active of the two");
        assert_eq!(find(0, Toward::Left), Some(2), "round the far side");
        assert_eq!(find(1, Toward::Down), Some(2));
        assert_eq!(find(2, Toward::Down), Some(1), "round to the top");
        assert_eq!(find(1, Toward::Up), Some(2));
        assert_eq!(find(1, Toward::Left), Some(0));
        assert_eq!(find(0, Toward::Up), None);
        // Measured from tmux 3.5a: two panes side by side in 81x21.
        assert_eq!(format!("{:04x}", checksum("81x21,0,0{40x21,0,0,0,40x21,41,0,1}")), "cde9");
    }
}
