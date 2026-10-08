//! Where a dragged pane would land: the pointer over the screen -> what releasing there does.
use ratatui::layout::{Position, Rect};
use crate::{app::App, bar::Hit, draw::RangeKind};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side { Left, Right, Top, Bottom }

/// A tab is named by its id (`Tab.id`), not its index: a desk update mid-drag can renumber the tabs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Drop { Swap(u64), Beside(u64, Side), Tab(String), Nothing }

/// The cells of tab [i] in the side bar, else its status-bar range.
pub fn tab_cell(app: &App, i: usize) -> Option<Rect> {
    if app.bar_side().is_some() {
        return app.bar.hits.iter().find(|(_, h)| *h == Hit::Window(i)).map(|(r, _)| *r);
    }
    let number = app.win_num(i) as u64;
    let top = if app.status_top { 0 } else { app.size.1.saturating_sub(app.status_lines()) };
    app.status_ranges.iter().find(|(_, r)| matches!(r.kind, RangeKind::Window(n) if n == number))
        .map(|(row, r)| Rect::new(r.start, top + row, r.end.saturating_sub(r.start), 1))
}

/// The tab under (x, y). A machine heading in the side bar is not one.
fn tab_at(app: &App, x: u16, y: u16) -> Option<usize> {
    if app.bar_side().is_some() {
        return match crate::bar::hit_at(app, x, y) { Some(Hit::Window(i)) => Some(i), _ => None };
    }
    (0..app.tabs.len()).find(|i| tab_cell(app, *i).is_some_and(|r| r.contains(Position { x, y })))
}

/// [x, y] over the screen while pane [src] is dragged: what releasing there does.
pub fn drop_target(app: &App, src: u64, x: u16, y: u16) -> Drop {
    if let Some(i) = tab_at(app, x, y) {
        return if i == app.active { Drop::Nothing } else { Drop::Tab(app.tabs[i].id.clone()) };
    }
    let Some((id, r)) = app.rects.iter().find(|(_, r)| r.contains(Position { x, y })).copied() else { return Drop::Nothing };
    if id == src { return Drop::Nothing }
    let (bx, by) = ((r.width / 4).max(1), (r.height / 4).max(1));
    let (dl, dr, dt, db) = (x - r.x, r.right() - 1 - x, y - r.y, r.bottom() - 1 - y);
    // the nearest edge band wins (distance as a share of the band); outside every band, the middle swaps
    let near = [(dl, bx, Side::Left), (dr, bx, Side::Right), (dt, by, Side::Top), (db, by, Side::Bottom)]
        .into_iter().filter(|(d, b, _)| d < b).min_by_key(|(d, b, _)| *d as u32 * 1000 / *b as u32);
    match near { Some((_, _, side)) => Drop::Beside(id, side), None => Drop::Swap(id) }
}

/// The cells that show [drop]: the zone of the target pane (a side half or the whole pane) or the tab's cells.
// (Until the frame draws the zone.)
#[cfg_attr(not(test), allow(dead_code))]
pub fn zone(app: &App, drop: &Drop) -> Option<Rect> {
    let pane = |id: &u64| app.rects.iter().find(|(i, _)| i == id).map(|(_, r)| *r);
    match drop {
        Drop::Nothing => None,
        Drop::Swap(id) => pane(id),
        Drop::Beside(id, side) => pane(id).map(|r| {
            let (w, h) = (r.width / 2, r.height / 2);
            match side {
                Side::Left => Rect::new(r.x, r.y, w, r.height),
                Side::Right => Rect::new(r.x + w, r.y, r.width - w, r.height),
                Side::Top => Rect::new(r.x, r.y, r.width, h),
                Side::Bottom => Rect::new(r.x, r.y + h, r.width, r.height - h),
            }
        }),
        Drop::Tab(tab) => app.tabs.iter().position(|t| t.id == *tab).and_then(|i| tab_cell(app, i)),
    }
}

/// The held pane follows the pointer: a drag once it moved 2 cells from the press, a click until then.
pub fn follow(app: &mut App, x: u16, y: u16) {
    let Some(grab) = &app.controls.grab else { return };
    let (pane, (fx, fy)) = (grab.pane, grab.from);
    let live = grab.live || x.abs_diff(fx) + y.abs_diff(fy) >= 2;
    let drop = if live { drop_target(app, pane, x, y) } else { Drop::Nothing };
    if let Some(grab) = &mut app.controls.grab { grab.live = live; grab.drop = drop; }
}

/// What releasing pane [src] over [drop] does.
pub fn release(_app: &mut App, _src: u64, _drop: Drop) {}

/// Escape: the pane is let go where it was.
pub fn cancel(app: &mut App) {
    if app.controls.grab.take().is_some_and(|g| g.live) { app.redraw_all = true; }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::Dir;
    use crate::workspace_controls::tests::{app, render};

    /// Panes 1 | 2 side by side in one window (pane 2's own window is gone).
    fn two() -> App {
        let mut app = app(100);
        app.tabs.truncate(1);
        app.tabs[0].root.as_mut().unwrap().split(1, 2, Dir::Horizontal);
        app.fit_panes();
        render(&mut app);
        app
    }

    fn rect(app: &App, id: u64) -> Rect { app.rects.iter().find(|(i, _)| *i == id).unwrap().1 }

    #[tokio::test]
    async fn the_middle_swaps_the_outer_quarter_puts_beside_itself_is_nothing() {
        let app = two();
        assert_eq!(app.rects.len(), 2, "this test needs both panes laid out");
        let r2 = rect(&app, 2);
        assert_eq!(drop_target(&app, 1, r2.x + r2.width / 2, r2.y + r2.height / 2), Drop::Swap(2));
        assert_eq!(drop_target(&app, 1, r2.x + 1, r2.y + r2.height / 2), Drop::Beside(2, Side::Left));
        assert_eq!(drop_target(&app, 1, r2.right() - 2, r2.y + r2.height / 2), Drop::Beside(2, Side::Right));
        assert_eq!(drop_target(&app, 1, r2.x + r2.width / 2, r2.y + 1), Drop::Beside(2, Side::Top));
        assert_eq!(drop_target(&app, 1, r2.x + r2.width / 2, r2.bottom() - 2), Drop::Beside(2, Side::Bottom));
        let r1 = rect(&app, 1);
        assert_eq!(drop_target(&app, 1, r1.x + 3, r1.y + 3), Drop::Nothing);
    }

    #[tokio::test]
    async fn outside_every_pane_is_nothing() {
        let app = two();
        assert_eq!(drop_target(&app, 1, 500, 500), Drop::Nothing);
    }

    #[tokio::test]
    async fn a_tab_in_the_status_bar_is_a_target_and_the_current_tab_is_not() {
        let mut app = app(100);                       // window 1 holds pane 1, window 2 pane 2
        render(&mut app);                             // fills app.status_ranges
        assert!(app.status_lines() > 0 && app.bar_side().is_none(), "this test needs the status bar");
        let other = tab_cell(&app, 1).expect("the other tab has a range");
        assert_eq!(drop_target(&app, 1, other.x, other.y), Drop::Tab(app.tabs[1].id.clone()));
        let here = tab_cell(&app, 0).expect("this tab has a range");
        assert_eq!(drop_target(&app, 1, here.x, here.y), Drop::Nothing);
        assert_eq!(zone(&app, &Drop::Tab(app.tabs[1].id.clone())), Some(other));
    }

    #[tokio::test]
    async fn a_tab_in_the_side_bar_is_a_target() {
        let mut app = app(100);
        app.options.set("@hn-status-bar", Some("left"), &crate::options::SetFlags { global: true, ..Default::default() }, "", 0).unwrap();
        app.fit_panes();
        render(&mut app);
        assert!(app.bar_side().is_some(), "this test needs the side bar");
        let other = tab_cell(&app, 1).expect("the side bar lists the other tab");
        assert_eq!(drop_target(&app, 1, other.x, other.y), Drop::Tab(app.tabs[1].id.clone()));
        assert_eq!(zone(&app, &Drop::Tab(app.tabs[1].id.clone())), Some(other));
    }

    #[tokio::test]
    async fn a_machine_heading_in_the_side_bar_is_not_a_target() {
        let mut app = app(100);
        app.options.set("@hn-status-bar", Some("left"), &crate::options::SetFlags { global: true, ..Default::default() }, "", 0).unwrap();
        app.fit_panes();
        render(&mut app);
        let (heading, _) = app.bar.hits.iter().find(|(_, h)| matches!(h, crate::bar::Hit::Machine(_)))
            .expect("this test needs a machine heading in the side bar").clone();
        assert_eq!(drop_target(&app, 1, heading.x, heading.y), Drop::Nothing);
    }

    #[tokio::test]
    async fn the_zone_is_the_half_the_moved_pane_will_take() {
        let app = two();
        let r2 = rect(&app, 2);
        assert_eq!(zone(&app, &Drop::Swap(2)), Some(r2));
        let left = zone(&app, &Drop::Beside(2, Side::Left)).unwrap();
        let right = zone(&app, &Drop::Beside(2, Side::Right)).unwrap();
        assert_eq!((left.x, left.y, left.height), (r2.x, r2.y, r2.height));
        assert_eq!(left.width + right.width, r2.width);
        assert_eq!(right.right(), r2.right());
        assert_eq!(left.right(), right.x);
        let top = zone(&app, &Drop::Beside(2, Side::Top)).unwrap();
        let bottom = zone(&app, &Drop::Beside(2, Side::Bottom)).unwrap();
        assert_eq!((top.x, top.y, top.width), (r2.x, r2.y, r2.width));
        assert_eq!(top.height + bottom.height, r2.height);
        assert_eq!(bottom.bottom(), r2.bottom());
        assert_eq!(top.bottom(), bottom.y);
    }

    #[tokio::test]
    async fn a_pane_or_tab_that_is_gone_has_no_zone() {
        let app = two();
        assert_eq!(zone(&app, &Drop::Nothing), None);
        assert_eq!(zone(&app, &Drop::Swap(99)), None);
        assert_eq!(zone(&app, &Drop::Beside(99, Side::Left)), None);
        assert_eq!(zone(&app, &Drop::Tab("no-such-tab".into())), None);
    }
}
