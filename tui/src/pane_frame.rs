//! Presentation insets live outside the tmux layout tree. Its splits and named layouts
//! remain unchanged; the terminal, cursor, copy mode and mouse share this content rectangle.

use ratatui::layout::Rect;
use crate::layout::Status;

#[derive(Clone, Copy, Debug)]
pub struct Frame { pub surface: Rect, pub content: Rect, pub title: Option<Rect> }

/// A pane as a blurred surface: the surface filled, its edge cell padding, the title in its top
/// (or bottom) row. A pane takes the cell tmux keeps between panes as its edge — a box draws its
/// line there, a blurred surface lets that edge cell be the gap — so two panes sit flush and
/// never leave a blank column (or, with a title, a blank row) of space between them.
pub fn frame(tile: Rect, canvas: Rect, inner: Rect, status: Status) -> Frame { cells(tile, canvas, inner, status, false) }

// ── box panes ──

/// A pane as a box (`@hn-border box`): its own single-line frame on the pane's outer cells
/// (`surface`), the program inside it. Boxes side by side, or stacked, touch — `││`, never a
/// blank between — each with a frame of its own (never two panes on one line): a box takes the
/// cell tmux keeps after it (its divider) for its right or bottom line, and a lower pane's title
/// row is its frame's top line. The title goes into the frame's top (or bottom) line (`title`).
/// The layout's cells stay tmux's, so splits, resizes and layouts are unchanged.
#[cfg(test)]
pub fn boxed(tile: Rect, canvas: Rect, status: Status) -> Frame { boxed_in(tile, canvas, canvas, status) }

/// [boxed], every frame kept inside [inner] (`App::box_inner`: the window).
pub fn boxed_in(tile: Rect, canvas: Rect, inner: Rect, status: Status) -> Frame { cells(tile, canvas, inner, status, true) }

/// A pane's surface, content and title: [touch] for boxes (the divider after a pane is its
/// line), else a blurred surface — the cell after the pane is its edge, so the two touch.
fn cells(tile: Rect, canvas: Rect, inner: Rect, status: Status, touch: bool) -> Frame {
    let mut outer = tile;
    // A pane takes the divider column after it — a box draws its line there, a blurred surface
    // lets its edge cell be the gap — so two side by side sit flush, never a blank column of
    // space between them (the same reason a stacked pane's title fills the row above it).
    if tile.right() < canvas.right() { outer.width += 1 }
    if touch {
        // A box takes the divider after it (its right or bottom line) and the one before it too
        // — an empty divider column when side by side, and, titles off, an empty divider row —
        // so adjacent boxes share the single divider cell and their contents are a cell apart,
        // never two. (With a title the lower pane's title row is itself the boundary, so it needs
        // no row claimed above it.)
        if tile.bottom() < canvas.bottom() { outer.height += 1 }
        if tile.x > canvas.x { outer.x -= 1; outer.width += 1 }
        if status == Status::Off && tile.y > canvas.y { outer.y -= 1; outer.height += 1 }
    } else {
        // The pane-border-status row is already part of the tile handed in (the layout reserves
        // it for a non-top pane), so a surface keeps every row: a stacked pane sits flush
        // against the one above, its title filling the gap — never a blank row between surfaces.
    }
    outer = outer.intersection(inner);
    // Too small for a frame with something in it: the program has every cell.
    if outer.width < 3 || outer.height < 3 || tile.width < 3 || tile.height < 3 { let cells = if outer.height == 0 { tile } else { outer.intersection(tile) }; return Frame { surface: cells, content: cells, title: None } }
    let content = Rect::new(outer.x + 1, outer.y + 1, outer.width - 2, outer.height - 2);
    let title = (status != Status::Off).then(|| Rect::new(outer.x + 1, if status == Status::Bottom { outer.bottom() - 1 } else { outer.y }, outer.width - 2, 1));
    Frame { surface: outer, content, title }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blurred_surfaces_touch_and_the_gap_is_each_edge_cell() {
        let canvas = Rect::new(0, 0, 120, 40);
        for status in [Status::Off, Status::Top, Status::Bottom] {
            let (left, right) = (frame(Rect::new(0, 0, 59, 40), canvas, canvas, status), frame(Rect::new(60, 0, 60, 40), canvas, canvas, status));
            assert_eq!(right.surface.x, left.surface.right(), "{status:?}: the surfaces touch, no blank column between");
            // Each surface's edge cell is the gap (= box panes' `border`), so the contents are two
            // cells apart, never three.
            assert_eq!(right.content.x - left.content.right(), 2, "{status:?}: each surface's edge cell is the gap");
        }
    }

    // ── box panes ──

    #[test]
    fn boxes_touch_each_with_its_own_frame_and_the_title_in_it() {
        use crate::layout::{Dir, Node};
        let canvas = Rect::new(26, 1, 100, 40);
        for status in [Status::Off, Status::Top, Status::Bottom] {
            // Three panes: a left one, and a right column of two (tmux's cells, titles included).
            let mut n = Node::new(1, canvas.width, canvas.height);
            n.status = status;
            n.split(1, 2, Dir::Horizontal);
            n.split(2, 3, Dir::Vertical);
            let mut tiles = Vec::new();
            n.rects(canvas, &mut tiles);
            let boxes: Vec<Frame> = tiles.iter().map(|(_, t)| boxed(*t, canvas, status)).collect();
            for b in boxes.iter() {
                assert_eq!(b.surface.intersection(canvas), b.surface, "{status:?}: inside the window");
                assert_eq!(b.content, Rect::new(b.surface.x + 1, b.surface.y + 1, b.surface.width - 2, b.surface.height - 2));
                match status { Status::Off => assert!(b.title.is_none()), Status::Top => assert_eq!(b.title.unwrap().y, b.surface.y), Status::Bottom => assert_eq!(b.title.unwrap().y, b.surface.bottom() - 1) }
            }
            // Two boxes side by side, or stacked, share the divider — the contents are a cell
            // apart, never two, and each frame takes the shared boundary for its own line.
            assert_eq!(boxes[1].content.x - boxes[0].content.right(), 1, "{status:?}: side-by-side contents a cell apart");
            assert_eq!(boxes[2].content.y - boxes[1].content.bottom(), 1, "{status:?}: stacked contents a cell apart");
            assert_eq!(boxes[1].surface.x, boxes[0].surface.right() - 1, "{status:?}: share the divider column");
            assert_eq!(boxes[2].surface.y, boxes[1].surface.bottom() - 1, "{status:?}: share the divider row");
            // The window's edges are the outer frames' edges.
            assert_eq!((boxes[0].surface.x, boxes[0].surface.y, boxes[0].surface.bottom()), (canvas.x, canvas.y, canvas.bottom()));
            assert_eq!((boxes[1].surface.right(), boxes[2].surface.bottom()), (canvas.right(), canvas.bottom()));
        }
        // A pane too small for a frame keeps every cell for its program.
        let tiny = boxed(Rect::new(30, 5, 2, 5), canvas, Status::Off);
        assert_eq!(tiny.content, Rect::new(30, 5, 2, 5));
    }

    #[test]
    fn side_by_side_surfaces_touch_and_the_gap_is_two_edge_cells() {
        use crate::layout::{Dir, Node};
        let canvas = Rect::new(0, 0, 120, 40);
        for status in [Status::Off, Status::Top, Status::Bottom] {
            let mut n = Node::new(1, canvas.width, canvas.height);
            n.status = status;
            n.split(1, 2, Dir::Horizontal);
            let mut tiles = Vec::new();
            n.rects(canvas, &mut tiles);
            let f: Vec<Frame> = tiles.iter().map(|(_, t)| frame(*t, canvas, canvas, status)).collect();
            assert_eq!(f[1].surface.x, f[0].surface.right(), "{status:?}: side-by-side surfaces touch");
            // Each surface's edge cell is the gap (as a box's border is), so their contents are
            // two cells apart — the same as two stacked panes with a title.
            assert_eq!(f[1].content.x - f[0].content.right(), 2, "{status:?}: contents two cells apart");
        }
    }

    #[test]
    fn stacked_surfaces_have_no_blank_row_between_them() {
        use crate::layout::{Dir, Node};
        let canvas = Rect::new(0, 0, 100, 40);
        for status in [Status::Off, Status::Top, Status::Bottom] {
            let mut n = Node::new(1, canvas.width, canvas.height);
            n.status = status;
            n.split(1, 2, Dir::Vertical);
            let mut tiles = Vec::new();
            n.rects(canvas, &mut tiles);
            let fs: Vec<Frame> = tiles.iter().map(|(_, t)| frame(*t, canvas, canvas, status)).collect();
            // A stacked pane is flush against the one above; with titles off a single cell
            // (the divider) separates them, with a title it is the lower pane's title row —
            // never two blank rows as the reported split-vertical gap.
            let gap = fs[1].surface.y - fs[0].surface.bottom();
            assert!(gap <= 1, "{status:?}: stacked surfaces gap {gap} rows");
            if status == Status::Top { assert_eq!(fs[1].title.unwrap().y, fs[1].surface.y, "{status:?}: lower title on the boundary") }
            if status == Status::Bottom { assert_eq!(fs[1].title.unwrap().y, fs[1].surface.bottom() - 1, "{status:?}: lower title on the boundary") }
        }
    }
}
