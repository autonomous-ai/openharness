//! A tab's panes as a binary split tree — the shape tmux and every tiling window manager use.
//! Splitting replaces a leaf by a split of it and the newcomer; closing one hands its space to its
//! sibling; the named layouts (grid, columns, main + stack…) rebuild the tree from its leaves.

use ratatui::layout::Rect;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    /// Side by side: a | b.
    Horizontal,
    /// Stacked: a over b.
    Vertical,
}

#[derive(Clone, Debug)]
pub enum Node {
    Leaf(u64),
    Split { dir: Dir, ratio: f32, a: Box<Node>, b: Box<Node> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

impl Node {
    pub fn leaves(&self) -> Vec<u64> {
        let mut out = Vec::new();
        self.collect(&mut out);
        out
    }

    fn collect(&self, out: &mut Vec<u64>) {
        match self {
            Node::Leaf(id) => out.push(*id),
            Node::Split { a, b, .. } => { a.collect(out); b.collect(out) }
        }
    }

    /// Each pane's rectangle within [area], leaving one row/column of border between siblings.
    pub fn rects(&self, area: Rect, out: &mut Vec<(u64, Rect)>) {
        match self {
            Node::Leaf(id) => out.push((*id, area)),
            Node::Split { dir, ratio, a, b } => {
                let (ra, rb) = split_rect(area, *dir, *ratio);
                a.rects(ra, out);
                b.rects(rb, out);
            }
        }
    }

    /// tmux's layout string for this tree in `area` (#{window_layout}): `csum,WxH,X,Y{…}`, `{}`
    /// side by side, `[]` stacked, a pane's number after its cell.
    pub fn to_tmux(&self, area: Rect) -> String {
        fn body(n: &Node, r: Rect, out: &mut String) {
            out.push_str(&format!("{}x{},{},{}", r.width, r.height, r.x, r.y));
            match n {
                Node::Leaf(id) => out.push_str(&format!(",{id}")),
                Node::Split { dir, ratio, a, b } => {
                    let (ra, rb) = split_rect(r, *dir, *ratio);
                    out.push(if *dir == Dir::Horizontal { '{' } else { '[' });
                    body(a, ra, out);
                    out.push(',');
                    body(b, rb, out);
                    out.push(if *dir == Dir::Horizontal { '}' } else { ']' });
                }
            }
        }
        let mut b = String::new();
        body(self, area, &mut b);
        format!("{:04x},{b}", checksum(&b))
    }

    /// A tree from a tmux layout string, its cells given to `ids` in order (None when it does not
    /// read, or has more cells than there are panes).
    pub fn from_tmux(text: &str, ids: &[u64]) -> Option<Node> {
        let body = text.split_once(',').map(|(c, rest)| if c.len() == 4 && c.chars().all(|x| x.is_ascii_hexdigit()) { rest } else { text }).unwrap_or(text);
        let mut chars = body.chars().peekable();
        let mut next = 0usize;
        fn num(it: &mut std::iter::Peekable<std::str::Chars>) -> Option<u32> {
            let mut s = String::new();
            while let Some(c) = it.peek() { if c.is_ascii_digit() { s.push(*c); it.next(); } else { break } }
            s.parse().ok()
        }
        fn cell(it: &mut std::iter::Peekable<std::str::Chars>, ids: &[u64], next: &mut usize) -> Option<(Node, u32, u32)> {
            let w = num(it)?; if it.next()? != 'x' { return None }
            let h = num(it)?; if it.next()? != ',' { return None }
            num(it)?; if it.next()? != ',' { return None }
            num(it)?;
            match it.peek().copied() {
                Some('{') | Some('[') => {
                    let open = it.next()?;
                    let (close, dir) = if open == '{' { ('}', Dir::Horizontal) } else { (']', Dir::Vertical) };
                    let mut kids = Vec::new();
                    loop {
                        kids.push(cell(it, ids, next)?);
                        match it.next()? { ',' => continue, c if c == close => break, _ => return None }
                    }
                    // n children as nested pairs, each split at its first child's share.
                    fn fold(mut kids: Vec<(Node, u32, u32)>, dir: Dir) -> Node {
                        if kids.len() == 1 { return kids.remove(0).0 }
                        let size = |k: &(Node, u32, u32)| if dir == Dir::Horizontal { k.1 } else { k.2 } as f32;
                        let total: f32 = kids.iter().map(size).sum::<f32>() + (kids.len() - 1) as f32;
                        let first = kids.remove(0);
                        let ratio = ((size(&first) + 0.5) / total).clamp(0.05, 0.95);
                        Node::Split { dir, ratio, a: Box::new(first.0), b: Box::new(fold(kids, dir)) }
                    }
                    Some((fold(kids, dir), w, h))
                }
                Some(',') => {
                    it.next();
                    num(it)?;
                    let id = *ids.get(*next)?;
                    *next += 1;
                    Some((Node::Leaf(id), w, h))
                }
                _ => { let id = *ids.get(*next)?; *next += 1; Some((Node::Leaf(id), w, h)) }
            }
        }
        cell(&mut chars, ids, &mut next).map(|(n, _, _)| n)
    }

    /// Split the leaf [target] in [dir], the newcomer after it. False when [target] is not here.
    pub fn split(&mut self, target: u64, new_id: u64, dir: Dir) -> bool {
        match self {
            Node::Leaf(id) if *id == target => {
                *self = Node::Split { dir, ratio: 0.5, a: Box::new(Node::Leaf(target)), b: Box::new(Node::Leaf(new_id)) };
                true
            }
            Node::Leaf(_) => false,
            Node::Split { a, b, .. } => a.split(target, new_id, dir) || b.split(target, new_id, dir),
        }
    }

    /// Remove [target]; its sibling takes its place. Returns the new tree (None when it was the last).
    pub fn remove(self, target: u64) -> Option<Node> {
        match self {
            Node::Leaf(id) if id == target => None,
            Node::Leaf(_) => Some(self),
            Node::Split { dir, ratio, a, b } => match (a.remove(target), b.remove(target)) {
                (Some(a), Some(b)) => Some(Node::Split { dir, ratio, a: Box::new(a), b: Box::new(b) }),
                (Some(only), None) | (None, Some(only)) => Some(only),
                (None, None) => None,
            },
        }
    }

    pub fn replace(&mut self, target: u64, with: u64) -> bool {
        match self {
            Node::Leaf(id) if *id == target => { *id = with; true }
            Node::Leaf(_) => false,
            Node::Split { a, b, .. } => a.replace(target, with) || b.replace(target, with),
        }
    }


    pub fn swap(&mut self, x: u64, y: u64) {
        match self {
            Node::Leaf(id) => { if *id == x { *id = y } else if *id == y { *id = x } }
            Node::Split { a, b, .. } => { a.swap(x, y); b.swap(x, y) }
        }
    }

    /// Give every leaf, in order, the id [next] returns.
    pub fn relabel(&mut self, next: &mut dyn FnMut(u64) -> u64) {
        match self {
            Node::Leaf(id) => *id = next(*id),
            Node::Split { a, b, .. } => { a.relabel(next); b.relabel(next) }
        }
    }

    /// Grow [target] toward [toward] by [delta] of its parent split (the nearest split in that axis).
    pub fn resize(&mut self, target: u64, dir: Dir, delta: f32) -> bool {
        match self {
            Node::Leaf(_) => false,
            Node::Split { dir: d, ratio, a, b } => {
                let in_a = a.leaves().contains(&target);
                let in_b = !in_a && b.leaves().contains(&target);
                if !in_a && !in_b { return false }
                let deeper = if in_a { a.resize(target, dir, delta) } else { b.resize(target, dir, delta) };
                if deeper { return true }
                // tmux's resize-pane moves the border: -L (a negative delta) always moves it left,
                // whether the pane is left of it (shrinks) or right of it (grows).
                if *d == dir {
                    *ratio = (*ratio + delta).clamp(0.1, 0.9);
                    return true;
                }
                false
            }
        }
    }

    pub fn equalize(&mut self) {
        if let Node::Split { dir, ratio, a, b } = self {
            a.equalize();
            b.equalize();
            // Weighted by how many panes each side holds along this axis, so three columns come out equal.
            let count = |n: &Node| n.count_along(*dir) as f32;
            *ratio = count(a) / (count(a) + count(b));
        }
    }

    fn count_along(&self, axis: Dir) -> usize {
        match self {
            Node::Leaf(_) => 1,
            Node::Split { dir, a, b, .. } if *dir == axis => a.count_along(axis) + b.count_along(axis),
            Node::Split { a, b, .. } => a.count_along(axis).max(b.count_along(axis)),
        }
    }
}

fn split_rect(area: Rect, dir: Dir, ratio: f32) -> (Rect, Rect) {
    match dir {
        Dir::Horizontal => {
            let usable = area.width.saturating_sub(1);
            let left = ((usable as f32) * ratio).round().clamp(1.0, usable.saturating_sub(1).max(1) as f32) as u16;
            (Rect { width: left, ..area }, Rect { x: area.x + left + 1, width: usable.saturating_sub(left), ..area })
        }
        Dir::Vertical => {
            let usable = area.height;
            let top = ((usable as f32) * ratio).round().clamp(1.0, usable.saturating_sub(1).max(1) as f32) as u16;
            (Rect { height: top, ..area }, Rect { y: area.y + top, height: usable.saturating_sub(top), ..area })
        }
    }
}

/// A balanced tree over [ids] in the shape of [preset].
pub fn build(ids: &[u64], preset: Preset) -> Option<Node> {
    if ids.is_empty() { return None }
    if ids.len() == 1 { return Some(Node::Leaf(ids[0])) }
    let chain = |ids: &[u64], dir: Dir| -> Node {
        let mut node = Node::Leaf(*ids.last().unwrap());
        for (index, id) in ids.iter().rev().skip(1).enumerate() {
            let n = index + 2;
            node = Node::Split { dir, ratio: 1.0 / n as f32, a: Box::new(Node::Leaf(*id)), b: Box::new(node) };
        }
        node
    };
    Some(match preset {
        Preset::Columns => chain(ids, Dir::Horizontal),
        Preset::Rows => chain(ids, Dir::Vertical),
        Preset::MainStack => Node::Split { dir: Dir::Horizontal, ratio: 0.55, a: Box::new(Node::Leaf(ids[0])), b: Box::new(chain(&ids[1..], Dir::Vertical)) },
        Preset::MainRow => Node::Split { dir: Dir::Vertical, ratio: 0.6, a: Box::new(Node::Leaf(ids[0])), b: Box::new(chain(&ids[1..], Dir::Horizontal)) },
        Preset::Grid => {
            let columns = (ids.len() as f32).sqrt().ceil() as usize;
            let rows: Vec<Node> = ids.chunks(columns).map(|row| chain(row, Dir::Horizontal)).collect();
            let mut node = rows.last().unwrap().clone();
            let total = rows.len();
            for (index, row) in rows.iter().rev().skip(1).enumerate() {
                node = Node::Split { dir: Dir::Vertical, ratio: 1.0 / (index + 2) as f32, a: Box::new(row.clone()), b: Box::new(node) };
            }
            let _ = total;
            node
        }
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Toward { Left, Right, Up, Down }

/// The pane next to [from] in direction [toward]: the nearest one whose edge faces it and which
/// overlaps it most along the other axis.
/// tmux's layout checksum.
fn checksum(s: &str) -> u16 {
    let mut c: u16 = 0;
    for b in s.bytes() { c = (c >> 1) | ((c & 1) << 15); c = c.wrapping_add(b as u16) }
    c
}

pub fn neighbour(rects: &[(u64, Rect)], from: u64, toward: Toward) -> Option<u64> {
    let (_, r) = *rects.iter().find(|(id, _)| *id == from)?;
    let overlap = |a0: u16, a1: u16, b0: u16, b1: u16| (a1.min(b1) as i32 - a0.max(b0) as i32).max(0);
    rects.iter()
        .filter(|(id, _)| *id != from)
        .filter_map(|(id, o)| {
            let (gap, shared) = match toward {
                Toward::Left if o.x + o.width <= r.x => (r.x as i32 - (o.x + o.width) as i32, overlap(r.y, r.y + r.height, o.y, o.y + o.height)),
                Toward::Right if o.x >= r.x + r.width => (o.x as i32 - (r.x + r.width) as i32, overlap(r.y, r.y + r.height, o.y, o.y + o.height)),
                Toward::Up if o.y + o.height <= r.y => (r.y as i32 - (o.y + o.height) as i32, overlap(r.x, r.x + r.width, o.x, o.x + o.width)),
                Toward::Down if o.y >= r.y + r.height => (o.y as i32 - (r.y + r.height) as i32, overlap(r.x, r.x + r.width, o.x, o.x + o.width)),
                _ => return None,
            };
            (shared > 0).then_some((*id, gap, shared))
        })
        .min_by(|a, b| a.1.cmp(&b.1).then(b.2.cmp(&a.2)))
        .map(|(id, _, _)| id)
        // Nothing that way: tmux wraps round to the far side.
        .or_else(|| {
            let overlap = |a0: u16, a1: u16, b0: u16, b1: u16| (a1.min(b1) as i32 - a0.max(b0) as i32).max(0);
            rects.iter().filter(|(id, _)| *id != from).filter_map(|(id, o)| {
                let (edge, shared) = match toward {
                    Toward::Left => ((o.x + o.width) as i32, overlap(r.y, r.y + r.height, o.y, o.y + o.height)),
                    Toward::Right => (-(o.x as i32), overlap(r.y, r.y + r.height, o.y, o.y + o.height)),
                    Toward::Up => ((o.y + o.height) as i32, overlap(r.x, r.x + r.width, o.x, o.x + o.width)),
                    Toward::Down => (-(o.y as i32), overlap(r.x, r.x + r.width, o.x, o.x + o.width)),
                };
                (shared > 0).then_some((*id, edge, shared))
            }).max_by(|a, b| a.1.cmp(&b.1).then(a.2.cmp(&b.2))).map(|(id, _, _)| id)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_and_remove() {
        let mut root = Node::Leaf(1);
        assert!(root.split(1, 2, Dir::Horizontal));
        assert!(root.split(2, 3, Dir::Vertical));
        assert_eq!(root.leaves(), vec![1, 2, 3]);
        let root = root.remove(2).unwrap();
        assert_eq!(root.leaves(), vec![1, 3]);
    }

    #[test]
    fn tmux_layout_strings() {
        // Measured from tmux 3.5a: two panes side by side in 81x21.
        assert_eq!(format!("{:04x}", checksum("81x21,0,0{40x21,0,0,0,40x21,41,0,1}")), "cde9");
        let mut root = Node::Leaf(1);
        root.split(1, 2, Dir::Horizontal);
        let text = root.to_tmux(Rect::new(0, 0, 81, 20));
        assert!(text.ends_with(",81x20,0,0{40x20,0,0,1,40x20,41,0,2}"), "{text}");
        let back = Node::from_tmux(&text, &[7, 8]).unwrap();
        assert_eq!(back.leaves(), vec![7, 8]);
        assert!(Node::from_tmux("81x20,0,0[81x10,0,0,1,81x9,0,11{40x9,0,11,2,40x9,41,11,3}]", &[1, 2, 3]).is_some());
    }

    #[test]
    fn rects_cover_area() {
        let mut root = Node::Leaf(1);
        root.split(1, 2, Dir::Horizontal);
        let mut out = Vec::new();
        root.rects(Rect::new(0, 0, 81, 20), &mut out);
        assert_eq!(out[0].1.width + out[1].1.width + 1, 81);
        assert_eq!(neighbour(&out, 1, Toward::Right), Some(2));
        // tmux wraps: left of the leftmost is the rightmost.
        assert_eq!(neighbour(&out, 1, Toward::Left), Some(2));
    }

    #[test]
    fn grid_of_four() {
        let node = build(&[1, 2, 3, 4], Preset::Grid).unwrap();
        let mut out = Vec::new();
        node.rects(Rect::new(0, 0, 101, 40), &mut out);
        assert_eq!(out.len(), 4);
        assert_eq!(out[0].1.height, 20);
    }
}
