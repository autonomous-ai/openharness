//! Presentation insets live outside the tmux layout tree. Its splits and named layouts
//! remain unchanged; the terminal, cursor, copy mode and mouse share this content rectangle.

use ratatui::layout::Rect;
use crate::layout::Status;

#[derive(Clone, Copy, Debug)]
pub struct Frame { pub surface: Rect, pub content: Rect, pub title: Option<Rect> }

/// A pane as a blurred surface: the surface filled, its edge cell padding, the title in its top
/// (or bottom) row. The cell tmux keeps between panes — its divider, or a lower pane's title row
/// — is left empty, so two surfaces of one colour never run together: one cell between them, never
/// each pane's own padding added to its neighbour's.
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
/// line), else a surface a cell apart from the next.
fn cells(tile: Rect, canvas: Rect, inner: Rect, status: Status, touch: bool) -> Frame {
    let mut outer = tile;
    if touch {
        // The divider column after a pane, and (titles off) the divider row below it.
        if tile.right() < canvas.right() { outer.width += 1 }
        if status == Status::Off && tile.bottom() < canvas.bottom() { outer.height += 1 }
    } else {
        match status {
            Status::Top if tile.y != canvas.y => { outer.y += 1; outer.height = outer.height.saturating_sub(1) }
            Status::Bottom if tile.bottom() != canvas.bottom() => outer.height = outer.height.saturating_sub(1),
            _ => {}
        }
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
    fn blurred_surfaces_are_a_cell_apart() {
        let canvas = Rect::new(0, 0, 120, 40);
        for status in [Status::Off, Status::Top, Status::Bottom] {
            let (left, right) = (frame(Rect::new(0, 0, 59, 40), canvas, canvas, status), frame(Rect::new(60, 0, 60, 40), canvas, canvas, status));
            assert_eq!(right.surface.x - left.surface.right(), 1, "{status:?}: one cell between two surfaces");
            assert_eq!(right.content.x - left.content.right(), 3, "{status:?}: each surface's edge cell, then the gap");
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
            for (i, b) in boxes.iter().enumerate() {
                assert_eq!(b.surface.intersection(canvas), b.surface, "{status:?}: inside the window");
                assert_eq!(b.content, Rect::new(b.surface.x + 1, b.surface.y + 1, b.surface.width - 2, b.surface.height - 2));
                match status { Status::Off => assert!(b.title.is_none()), Status::Top => assert_eq!(b.title.unwrap().y, b.surface.y), Status::Bottom => assert_eq!(b.title.unwrap().y, b.surface.bottom() - 1) }
                for other in &boxes[i + 1..] { assert_eq!(b.surface.intersection(other.surface).area(), 0, "{status:?}: frames never share a cell") }
            }
            // Side by side and stacked, the frames touch; the window's edges are the outer
            // frames' edges.
            assert_eq!(boxes[1].surface.x, boxes[0].surface.right(), "{status:?}");
            assert_eq!(boxes[2].surface.y, boxes[1].surface.bottom(), "{status:?}");
            assert_eq!((boxes[0].surface.x, boxes[0].surface.y, boxes[0].surface.bottom()), (canvas.x, canvas.y, canvas.bottom()));
            assert_eq!((boxes[1].surface.right(), boxes[2].surface.bottom()), (canvas.right(), canvas.bottom()));
        }
        // A pane too small for a frame keeps every cell for its program.
        let tiny = boxed(Rect::new(30, 5, 2, 5), canvas, Status::Off);
        assert_eq!(tiny.content, Rect::new(30, 5, 2, 5));
    }
}
