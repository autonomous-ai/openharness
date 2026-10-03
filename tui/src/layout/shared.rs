//! The desk describes pane slots as fractions of one canvas, independently of pixels/cells.
//! Borders occupy the last cell before a cut: f maps to f * (extent + 1), as desktop's gap does.
use super::{Cell, Dir, Node, Status};

const EPS: f64 = 0.000001;
type Tile = [f64; 4];

enum Split {
    Pane(usize),
    Cut(Dir, f64, Box<Split>, Box<Split>),
}

fn partition(tiles: &[Tile], indices: &[usize], bounds: Tile) -> Option<Split> {
    if indices.len() == 1 {
        return tiles[indices[0]].iter().zip(bounds).all(|(a, b)| (a - b).abs() < EPS)
            .then_some(Split::Pane(indices[0]));
    }
    // A complete cut is required; this rejects holes, overlaps and malformed remote layouts.
    for (dir, axis) in [(Dir::Vertical, 1), (Dir::Horizontal, 0)] {
        for &i in indices {
            let at = tiles[i][axis + 2];
            if at <= bounds[axis] + EPS || at >= bounds[axis + 2] - EPS { continue }
            let mut before = Vec::new();
            let mut after = Vec::new();
            for &j in indices {
                if tiles[j][axis + 2] <= at + EPS { before.push(j) }
                else if tiles[j][axis] >= at - EPS { after.push(j) }
            }
            if before.is_empty() || after.is_empty() || before.len() + after.len() != indices.len() { continue }
            let mut left = bounds;
            let mut right = bounds;
            left[axis + 2] = at;
            right[axis] = at;
            let a = partition(tiles, &before, left)?;
            let b = partition(tiles, &after, right)?;
            return Some(Split::Cut(dir, (at - bounds[axis]) / (bounds[axis + 2] - bounds[axis]), Box::new(a), Box::new(b)));
        }
    }
    None
}

impl Split {
    fn minimum(&self, tiles: &[Tile], status: Status) -> (u32, u32) {
        match self {
            Split::Pane(i) => (1, 1 + u32::from(match status {
                Status::Top => tiles[*i][1] < EPS,
                Status::Bottom => tiles[*i][3] > 1.0 - EPS,
                Status::Off => false,
            })),
            Split::Cut(dir, _, a, b) => {
                let (aw, ah) = a.minimum(tiles, status);
                let (bw, bh) = b.minimum(tiles, status);
                if *dir == Dir::Horizontal { (aw + bw + 1, ah.max(bh)) }
                else { (aw.max(bw), ah + bh + 1) }
            }
        }
    }

    fn build(&self, tiles: &[Tile], ids: &[u64], status: Status, size: (u32, u32), parent: Option<usize>, cells: &mut Vec<Cell>) -> usize {
        let index = cells.len();
        let dir = match self { Split::Cut(dir, ..) => Some(*dir), _ => None };
        let pane = match self { Split::Pane(i) => ids[*i], _ => 0 };
        cells.push(Cell { dir, pane, sx: size.0, sy: size.1, xoff: 0, yoff: 0, parent, cells: Vec::new() });
        if let Split::Cut(dir, ratio, a, b) = self {
            let horizontal = *dir == Dir::Horizontal;
            let extent = if horizontal { size.0 } else { size.1 };
            let amin = a.minimum(tiles, status);
            let bmin = b.minimum(tiles, status);
            let low = if horizontal { amin.0 } else { amin.1 };
            let high = extent - 1 - if horizontal { bmin.0 } else { bmin.1 };
            let first = (((extent + 1) as f64 * ratio).round() as u32).saturating_sub(1).clamp(low, high);
            let second = extent - first - 1;
            let a_size = if horizontal { (first, size.1) } else { (size.0, first) };
            let b_size = if horizontal { (second, size.1) } else { (size.0, second) };
            let left = a.build(tiles, ids, status, a_size, Some(index), cells);
            let right = b.build(tiles, ids, status, b_size, Some(index), cells);
            cells[index].cells = vec![left, right];
        }
        index
    }
}

impl Node {
    /// Adjacent cuts on one axis are one tmux group. Keeping arbitrary binary
    /// parsing groups would make equalize/resize treat three columns as 1 + 2.
    fn flatten_shared(&mut self, i: usize) {
        let mut children = Vec::new();
        for k in self.c[i].cells.clone() {
            self.flatten_shared(k);
            if self.c[k].dir.is_some() && self.c[k].dir == self.c[i].dir {
                children.extend(self.c[k].cells.iter().copied());
            } else { children.push(k); }
        }
        for &k in &children { self.c[k].parent = Some(i); }
        self.c[i].cells = children;
    }

    /// Restore ordered, normalized slots without importing another client's numeric pane IDs.
    pub fn from_tiles(tiles: &[Tile], ids: &[u64], width: u16, height: u16, status: Status) -> Option<Self> {
        if tiles.len() != ids.len() || tiles.is_empty() || tiles.len() > 64 { return None }
        if tiles.iter().any(|t| t.iter().any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
            || t[2] - t[0] < EPS || t[3] - t[1] < EPS) { return None }
        let tree = partition(tiles, &(0..tiles.len()).collect::<Vec<_>>(), [0.0, 0.0, 1.0, 1.0])?;
        let minimum = tree.minimum(tiles, status);
        let mut cells = Vec::new();
        let root = tree.build(tiles, ids, status, ((width as u32).max(minimum.0), (height as u32).max(minimum.1)), None, &mut cells);
        let mut node = Node { c: cells, root, status };
        node.flatten_shared(root);
        node.fix_offsets();
        Some(node.compact())
    }

    /// Full tile bounds, before title rows/chrome are removed, in desktop's reading order.
    pub fn normalized_tiles(&self) -> Vec<(u64, Tile)> {
        let (w, h) = self.size();
        let mut cells: Vec<_> = self.walk(self.root).into_iter().map(|i| &self.c[i]).collect();
        cells.sort_by_key(|c| (c.yoff, c.xoff));
        cells.into_iter().map(|c| (c.pane, [
            c.xoff as f64 / (w as f64 + 1.0),
            c.yoff as f64 / (h as f64 + 1.0),
            (c.xoff + c.sx + 1) as f64 / (w as f64 + 1.0),
            (c.yoff + c.sy + 1) as f64 / (h as f64 + 1.0),
        ])).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_slots_preserve_right_main_identity_and_proportions_at_every_size() {
        let tiles = [[0.0, 0.0, 0.3, 0.6], [0.3, 0.0, 1.0, 1.0], [0.0, 0.6, 0.3, 1.0]];
        for (w, h) in [(80, 24), (200, 60), (400, 100), (1, 1)] {
            let root = Node::from_tiles(&tiles, &[71, 4, 29], w, h, Status::Top).unwrap();
            let actual = root.normalized_tiles();
            assert_eq!(actual.iter().map(|t| t.0).collect::<Vec<_>>(), [71, 4, 29]);
            if w > 1 {
                for ((_, got), want) in actual.iter().zip(tiles) {
                    for axis in 0..4 { assert!((got[axis] - want[axis]).abs() <= 1.0 / if axis % 2 == 0 { w as f64 } else { h as f64 }); }
                }
            }
        }
    }

    #[test]
    fn every_tmux_shape_can_be_exchanged_as_normalized_slots() {
        for count in 2..=9 {
            let ids: Vec<_> = (1..=count).collect();
            for shape in crate::layout::Named::ALL {
                let original = crate::layout::arrange(shape, &ids, 160, 60, Status::Top, ("80", "24"), ("0", "0")).unwrap();
                let shared = original.normalized_tiles();
                let order: Vec<_> = shared.iter().map(|r| r.0).collect();
                let tiles: Vec<_> = shared.iter().map(|r| r.1).collect();
                let restored = Node::from_tiles(&tiles, &order, 160, 60, Status::Top).unwrap();
                assert_eq!(restored.normalized_tiles(), shared, "{shape:?} / {count}");
            }
        }
    }

    #[test]
    fn malformed_geometry_is_rejected_without_losing_panes() {
        for tiles in [
            vec![[0.0, 0.0, 0.4, 1.0], [0.5, 0.0, 1.0, 1.0]],
            vec![[0.0, 0.0, 0.6, 1.0], [0.5, 0.0, 1.0, 1.0]],
            vec![[0.0, 0.0, f64::NAN, 1.0], [0.5, 0.0, 1.0, 1.0]],
            vec![[0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 1.0, 1.0]],
        ] { assert!(Node::from_tiles(&tiles, &[1, 2], 80, 24, Status::Top).is_none()); }
    }

    #[test]
    fn imported_columns_keep_tmux_equalize_grouping() {
        let mut root = Node::from_tiles(&[[0.0,0.0,0.2,1.0], [0.2,0.0,0.75,1.0], [0.75,0.0,1.0,1.0]], &[1,2,3], 122, 40, Status::Top).unwrap();
        root.spread_out(1);
        let widths: Vec<_> = root.normalized_tiles().iter().map(|(_, t)| t[2] - t[0]).collect();
        assert!(widths.iter().all(|w| (w - 1.0 / 3.0).abs() < 0.01), "{widths:?}");
    }
}
