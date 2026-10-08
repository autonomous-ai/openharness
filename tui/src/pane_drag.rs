//! Where a dragged pane would land: the pointer over the screen -> what releasing there does.
use ratatui::{buffer::Buffer, layout::{Constraint, Layout, Position, Rect}, style::{Color, Modifier, Style}, text::Line, widgets::{Block, Widget}};
use unicode_width::UnicodeWidthStr;
use crate::{app::App, bar::Hit, draw::RangeKind, layout::Dir, theme};

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
    let Some((_, _, side)) = near else { return Drop::Swap(id) };
    // Already there (its neighbour on that side, in the same split): join-pane would only halve [id].
    let (dir, before) = match side { Side::Left => (Dir::Horizontal, true), Side::Right => (Dir::Horizontal, false), Side::Top => (Dir::Vertical, true), Side::Bottom => (Dir::Vertical, false) };
    if app.tab().root.as_ref().and_then(|root| root.neighbour(id, dir, before)) == Some(src) { return Drop::Nothing }
    Drop::Beside(id, side)
}

/// The cells that show [drop]: the zone of the target pane (a side half or the whole pane) or the tab's cells.
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
    let_go_if_gone(app);
    let Some(grab) = &app.controls.grab else { return };
    let (pane, live) = (grab.pane, grab.moved(x, y));
    let drop = if live { drop_target(app, pane, x, y) } else { Drop::Nothing };
    if let Some(grab) = &mut app.controls.grab { grab.live = live; grab.drop = drop; }
}

/// A held pane closed (or its window emptied) mid-drag is let go: its release may never reach
/// the header press (a welcome screen in its place takes it).
pub fn let_go_if_gone(app: &mut App) {
    let Some(pane) = app.controls.grab.as_ref().map(|g| g.pane) else { return };
    if app.panes.contains_key(&pane) && app.tabs.iter().any(|t| t.panes().contains(&pane)) { return }
    cancel(app);
}

/// What the zone says, in a few words.
fn hint(app: &App, drop: &Drop) -> Option<String> {
    let name = |id: &u64| app.panes.get(id).and_then(|p| app.fleet.agent(&p.machine_id, &p.agent_id)).map(|a| a.name.clone());
    match drop {
        Drop::Nothing => None,
        Drop::Swap(id) => Some(format!("swap with {}", name(id)?)),
        Drop::Beside(id, side) => {
            let word = match side { Side::Left => "left of", Side::Right => "right of", Side::Top => "above", Side::Bottom => "below" };
            Some(format!("{word} {}", name(id)?))
        }
        Drop::Tab(tab) => app.tabs.iter().find(|t| t.id == *tab).map(|t| format!("to {}", t.name)),
    }
}

/// The zone a dragged pane will land in: tinted (what is under it stays) with a hint on its middle row.
pub struct DropZone<'a> { hint: Option<&'a str>, tint: Style }

impl<'a> DropZone<'a> {
    /// [reverse] is the cue for NO_COLOR, which paints no colour at all. (Underlined too: NO_COLOR's
    /// status bar is reversed already, so a tab reversed again would show nothing.)
    pub fn new(hint: Option<&'a str>, bg: Color, fg: Color, reverse: bool) -> Self {
        let tint = Style::new().bg(bg).fg(fg);
        DropZone { hint, tint: if reverse { tint.add_modifier(Modifier::REVERSED | Modifier::UNDERLINED) } else { tint } }
    }
}

impl Widget for DropZone<'_> {
    /// The hint is centred and cut to the zone; a zone of one row (a tab) keeps its own label
    /// unless the whole hint fits.
    fn render(self, zone: Rect, buf: &mut Buffer) {
        let zone = zone.intersection(buf.area);
        Block::new().style(self.tint).render(zone, buf);
        let Some(text) = self.hint else { return };
        let width = text.width() as u16;
        if zone.height == 1 && width > zone.width { return }
        let [_, middle, _] = Layout::vertical([Constraint::Length(zone.height / 2), Constraint::Length(1), Constraint::Fill(1)]).areas(zone);
        let [_, hint] = Layout::horizontal([Constraint::Length(zone.width.saturating_sub(width) / 2), Constraint::Fill(1)]).areas(middle);
        Line::raw(text).render(hint, buf);
    }
}

/// While a pane is dragged: the zone it will land in, in the theme's accent, with a hint.
pub fn draw(buf: &mut Buffer, app: &App) {
    let Some(grab) = app.controls.grab.as_ref().filter(|g| g.live) else { return };
    let Some(zone) = zone(app, &grab.drop) else { return };
    // (NO_COLOR paints nothing, so the zone is drawn reversed instead.)
    let (bg, fg) = (theme::paint(theme::accent()), theme::paint(theme::pane_palette().background));
    DropZone::new(hint(app, &grab.drop).as_deref(), bg, fg, theme::no_color()).render(zone, buf);
}

/// What releasing pane [src] over [drop] does: tmux's own swap-pane / join-pane, so the layout
/// reaches the desk and every other client as those commands' does. Another client may have
/// moved or closed either pane while it was dragged: then nothing happens. The held pane keeps
/// the focus wherever it lands (join-pane focuses it; after swap-pane it is selected again).
pub fn release(app: &mut App, src: u64, drop: Drop) {
    let home = |app: &App, id: u64| if app.panes.contains_key(&id) { app.tabs.iter().position(|t| t.panes().contains(&id)) } else { None };
    let Some(from) = home(app, src) else { return };
    let tag = crate::pane::tag;
    let command = match drop {
        Drop::Swap(dst) if dst != src && home(app, dst).is_some() => format!("swap-pane -s {0} -t {1} ; select-pane -t {0}", tag(src), tag(dst)),
        Drop::Beside(dst, side) if dst != src && home(app, dst).is_some() => {
            let flags = match side { Side::Left => "-h -b", Side::Right => "-h", Side::Top => "-v -b", Side::Bottom => "-v" };
            format!("join-pane {flags} -s {} -t {}", tag(src), tag(dst))
        }
        // (`:N` is that window's active pane, as join-pane -t :N is in tmux.)
        Drop::Tab(id) => match app.tabs.iter().position(|t| t.id == id).filter(|i| *i != from) {
            Some(i) => format!("join-pane -s {} -t :{}", tag(src), app.win_num(i)),
            None => return,
        },
        _ => return,
    };
    crate::commands::execute(app, &command);
}

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
        // (1 is already left of 2: see the test below)
        assert_eq!(drop_target(&app, 1, r2.x + 1, r2.y + r2.height / 2), Drop::Nothing);
        assert_eq!(drop_target(&app, 1, r2.right() - 2, r2.y + r2.height / 2), Drop::Beside(2, Side::Right));
        assert_eq!(drop_target(&app, 1, r2.x + r2.width / 2, r2.y + 1), Drop::Beside(2, Side::Top));
        assert_eq!(drop_target(&app, 1, r2.x + r2.width / 2, r2.bottom() - 2), Drop::Beside(2, Side::Bottom));
        let r1 = rect(&app, 1);
        assert_eq!(drop_target(&app, 1, r1.x + 3, r1.y + 3), Drop::Nothing);
    }

    #[tokio::test]
    async fn beside_a_pane_on_the_side_it_already_is_is_nothing() {
        // 1 | 2: 1 is already left of 2, 2 already right of 1 (join-pane would only halve the target)
        let side = two();
        let (r1, r2) = (rect(&side, 1), rect(&side, 2));
        assert_eq!(drop_target(&side, 1, r2.x + 1, r2.y + r2.height / 2), Drop::Nothing);
        assert_eq!(drop_target(&side, 2, r1.right() - 2, r1.y + r1.height / 2), Drop::Nothing);
        assert_eq!(drop_target(&side, 2, r1.x + 1, r1.y + r1.height / 2), Drop::Beside(1, Side::Left), "the far side is a move");
        // 1 over 2
        let mut stack = app(100);
        stack.tabs.truncate(1);
        stack.tabs[0].root.as_mut().unwrap().split(1, 2, Dir::Vertical);
        stack.fit_panes(); render(&mut stack);
        let (r1, r2) = (rect(&stack, 1), rect(&stack, 2));
        assert_eq!(drop_target(&stack, 1, r2.x + r2.width / 2, r2.y + 1), Drop::Nothing);
        assert_eq!(drop_target(&stack, 2, r1.x + r1.width / 2, r1.bottom() - 2), Drop::Nothing);
        assert_eq!(drop_target(&stack, 1, r2.x + r2.width / 2, r2.bottom() - 2), Drop::Beside(2, Side::Bottom), "below 2 is a move");
        // 1 | 2 | 3: left of 3 is a move for 1 (2 is between them), not for 2
        let mut row = three(120);
        render(&mut row);
        let r3 = rect(&row, 3);
        assert_eq!(drop_target(&row, 1, r3.x + 1, r3.y + r3.height / 2), Drop::Beside(3, Side::Left));
        assert_eq!(drop_target(&row, 2, r3.x + 1, r3.y + r3.height / 2), Drop::Nothing);
    }

    #[test]
    fn under_no_color_the_zone_shows_on_an_already_reversed_cell() {
        // NO_COLOR draws the status bar reversed: reversing a tab's cells again would show nothing.
        let mut buf = Buffer::empty(Rect::new(0, 0, 10, 1));
        buf.set_string(0, 0, "1:work", Style::new().add_modifier(Modifier::REVERSED));
        let before = buf.clone();
        DropZone::new(Some("to work"), Color::Reset, Color::Reset, true).render(Rect::new(0, 0, 6, 1), &mut buf);
        for x in 0..6 { assert_ne!(look(&buf, x, 0), look(&before, x, 0), "cell {x} of the tab shows the zone"); }
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
        let (heading, _) = app.bar.hits.iter().find(|(_, h)| matches!(h, crate::bar::Hit::Machine(..)))
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

    /// How a cell looks, apart from its symbol.
    fn look(buf: &Buffer, x: u16, y: u16) -> (Color, Color, Modifier) { let c = &buf[(x, y)]; (c.bg, c.fg, c.modifier) }

    fn row_text(buf: &Buffer, z: Rect, y: u16) -> String { (z.x..z.right()).map(|x| buf[(x, y)].symbol()).collect() }

    #[tokio::test]
    async fn the_zone_is_shaded_with_a_hint_and_cleared_after() {
        let mut app = two();
        let r2 = rect(&app, 2);
        let before = render(&mut app);
        app.controls.grab = Some(crate::workspace_controls::Grab::live_for_test(1, Drop::Beside(2, Side::Left)));
        let buf = render(&mut app);
        let z = zone(&app, &Drop::Beside(2, Side::Left)).unwrap();
        assert!(z.x == r2.x && z.width < r2.width);
        assert_ne!(look(&buf, z.x, z.y + 1), look(&before, z.x, z.y + 1), "the left half is shaded");
        let row = row_text(&buf, z, z.y + z.height / 2);
        assert!(row.contains("left of Task 2"), "{row}");
        assert_eq!(look(&buf, r2.right() - 1, r2.y + 1), look(&before, r2.right() - 1, r2.y + 1), "outside the zone is untouched");
        app.controls.grab = None;
        assert_eq!(render(&mut app), before, "no zone once the drag is over");
    }

    #[tokio::test]
    async fn a_click_not_yet_a_drag_draws_nothing() {
        let mut app = two();
        let before = render(&mut app);
        let mut grab = crate::workspace_controls::Grab::live_for_test(1, Drop::Swap(2));
        grab.live = false;
        app.controls.grab = Some(grab);
        assert_eq!(render(&mut app), before);
    }

    #[tokio::test]
    async fn each_drop_says_what_it_does() {
        let app = two();
        let tab = app.tabs[0].id.clone();
        let name = app.tabs[0].name.clone();
        assert_eq!(hint(&app, &Drop::Swap(2)).as_deref(), Some("swap with Task 2"));
        assert_eq!(hint(&app, &Drop::Beside(2, Side::Left)).as_deref(), Some("left of Task 2"));
        assert_eq!(hint(&app, &Drop::Beside(2, Side::Right)).as_deref(), Some("right of Task 2"));
        assert_eq!(hint(&app, &Drop::Beside(2, Side::Top)).as_deref(), Some("above Task 2"));
        assert_eq!(hint(&app, &Drop::Beside(2, Side::Bottom)).as_deref(), Some("below Task 2"));
        assert_eq!(hint(&app, &Drop::Tab(tab)), Some(format!("to {name}")));
        assert_eq!(hint(&app, &Drop::Nothing), None);
    }

    #[test]
    fn the_shade_takes_the_theme_accent_and_cuts_the_hint_to_the_zone() {
        let (accent, back) = (theme::accent(), theme::pane_palette().background);
        assert_ne!(accent, back, "this test needs an accent that differs from the pane background");
        let mut buf = Buffer::empty(Rect::new(0, 0, 20, 5));
        buf.set_string(0, 0, "x", ratatui::style::Style::default());
        DropZone::new(Some("swap with a long name"), accent, back, false).render(Rect::new(2, 1, 8, 3), &mut buf);
        assert_eq!(buf[(2, 1)].bg, accent);
        assert_eq!(buf[(9, 3)].bg, accent);
        assert_ne!(buf[(10, 2)].bg, accent, "just outside");
        assert_ne!(buf[(1, 2)].bg, accent, "just outside");
        let row: String = (2..10).map(|x| buf[(x, 2)].symbol()).collect();
        assert_eq!(row, "swap wit", "cut at the zone's edge");
        assert_eq!(buf[(10, 2)].symbol(), " ");
        // one row (a tab): its own label stays unless the whole hint fits
        let mut buf = Buffer::empty(Rect::new(0, 0, 20, 2));
        buf.set_string(2, 0, "abcd", ratatui::style::Style::default());
        DropZone::new(Some("to a longer tab"), accent, back, false).render(Rect::new(2, 0, 4, 1), &mut buf);
        assert_eq!((2..6).map(|x| buf[(x, 0)].symbol()).collect::<String>(), "abcd");
        DropZone::new(Some("to b"), accent, back, true).render(Rect::new(2, 0, 6, 1), &mut buf);
        assert_eq!((3..7).map(|x| buf[(x, 0)].symbol()).collect::<String>(), "to b");
        assert!(buf[(2, 0)].modifier.contains(Modifier::REVERSED));
    }

    /// The cell loops the zone was first drawn with, kept to prove the widget draws the same cells
    /// (their NO_COLOR cue since underlined as well, as the widget's is).
    fn oracle_shade(buf: &mut Buffer, zone: Rect, text: Option<&str>, bg: Color, fg: Color, reverse: bool) {
        let zone = zone.intersection(buf.area);
        for pos in zone.positions() {
            let Some(cell) = buf.cell_mut(pos) else { continue };
            cell.set_bg(bg).set_fg(fg);
            if reverse { cell.modifier.insert(Modifier::REVERSED | Modifier::UNDERLINED) }
        }
        let Some(text) = text else { return };
        let width = UnicodeWidthStr::width(text) as u16;
        if zone.height == 1 && width > zone.width { return }
        let (mut x, y) = (zone.x + zone.width.saturating_sub(width) / 2, zone.y + zone.height / 2);
        for ch in text.chars() {
            let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0) as u16;
            if w == 0 { continue }
            if x + w > zone.right() { break }
            if let Some(cell) = buf.cell_mut((x, y)) { cell.set_char(ch); }
            x += w;
        }
    }

    /// A screen of busy cells (symbols, colours and a modifier that differ cell to cell) to shade.
    fn backdrop() -> Buffer {
        let mut buf = Buffer::empty(Rect::new(0, 0, 40, 12));
        for (i, pos) in buf.area.positions().enumerate() {
            let cell = &mut buf[pos];
            cell.set_char((b'a' + (i % 26) as u8) as char).set_fg(Color::Rgb(i as u8, 90, 200)).set_bg(Color::Indexed((i % 200) as u8));
            if i % 7 == 0 { cell.modifier.insert(Modifier::BOLD | Modifier::REVERSED) }
        }
        buf
    }

    #[test]
    fn the_widget_draws_what_the_cell_loops_drew() {
        let dark = theme::pane_palette_of([28, 31, 36], [220, 225, 231]).background;
        let light = theme::pane_palette_of([250, 250, 245], [30, 30, 30]).background;
        let (field, ink) = (Rect::new(0, 0, 40, 12), Rect::new(4, 2, 14, 7));
        let beside = |side| { // the four halves the way `zone` cuts a pane
            let (w, h) = (ink.width / 2, ink.height / 2);
            match side {
                Side::Left => Rect::new(ink.x, ink.y, w, ink.height),
                Side::Right => Rect::new(ink.x + w, ink.y, ink.width - w, ink.height),
                Side::Top => Rect::new(ink.x, ink.y, ink.width, h),
                Side::Bottom => Rect::new(ink.x, ink.y + h, ink.width, ink.height - h),
            }
        };
        let zones = [
            ("swap", ink), ("left", beside(Side::Left)), ("right", beside(Side::Right)), ("top", beside(Side::Top)), ("bottom", beside(Side::Bottom)),
            ("tab", Rect::new(6, 0, 12, 1)), ("narrow tab", Rect::new(6, 0, 3, 1)), ("hanging off the screen", Rect::new(34, 8, 12, 9)),
            ("edge", field), ("empty", Rect::new(3, 3, 0, 0)),
        ];
        let hints = [None, Some("swap with Task 2"), Some("to b"), Some("swap with a much longer agent name than the zone")];
        for (palette, bg) in [("dark", dark), ("light", light)] {
            for fg in [Color::Rgb(230, 120, 30), Color::Reset] {
                for reverse in [false, true] {
                    for (what, z) in zones {
                        for hint in hints {
                            let (mut old, mut new) = (backdrop(), backdrop());
                            oracle_shade(&mut old, z, hint, fg, bg, reverse);
                            DropZone::new(hint, fg, bg, reverse).render(z, &mut new);
                            assert_eq!(new, old, "{palette}, reverse {reverse}, {what} zone {z:?}, hint {hint:?}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_wide_glyph_in_the_hint_takes_two_cells_and_is_cut_whole() {
        // Only the continuation cell differs from the cell loops: they left the old letter
        // there, which a terminal never shows; ratatui blanks it.
        let (bg, fg) = (Color::Rgb(230, 120, 30), Color::Rgb(28, 31, 36));
        for zone in [Rect::new(4, 2, 14, 7), Rect::new(4, 2, 5, 3)] {
            let (mut old, mut new) = (backdrop(), backdrop());
            oracle_shade(&mut old, zone, Some("to 日本語 tab"), bg, fg, false);
            DropZone::new(Some("to 日本語 tab"), bg, fg, false).render(zone, &mut new);
            for pos in new.area.positions() {
                let wide_tail = pos.x > 0 && new[(pos.x - 1, pos.y)].symbol().width() == 2;
                if wide_tail { assert_eq!(new[pos].symbol(), " ", "{pos:?} under a wide glyph"); continue }
                assert_eq!(new[pos], old[pos], "{pos:?}, zone {zone:?}");
            }
        }
    }

    #[test]
    fn an_accent_in_the_hint_stays_with_its_letter() {
        // The cell loops dropped zero-width marks ("ex"); ratatui keeps them with their letter.
        let mut buf = backdrop();
        DropZone::new(Some("e\u{301}x"), Color::Red, Color::Black, false).render(Rect::new(4, 2, 6, 3), &mut buf);
        let row: Vec<&str> = (4..10).map(|x| buf[(x, 3)].symbol()).collect();
        assert!(row.contains(&"e\u{301}") && row.contains(&"x"), "{row:?}");
    }

    /// Panes 1 | 2 | 3 in one window [width] wide, on the desk so that layout changes are queued.
    fn three(width: u16) -> App {
        let mut app = app(width);
        app.tabs.truncate(1);
        let mut pane = crate::pane::Pane::new(3, "local", "a3", width, 30);
        pane.phase = crate::pane::Phase::Live;
        app.panes.insert(3, pane);
        let root = app.tabs[0].root.as_mut().unwrap();
        root.split(1, 2, Dir::Horizontal);
        root.split(2, 3, Dir::Horizontal);
        app.session_desk = true;
        app.tabs[0].on_desk = true;
        app.fit_panes();
        app
    }

    #[tokio::test]
    async fn dropping_runs_swap_and_join_and_publishes_the_layout() {
        let mut app = three(120);
        assert_eq!(app.tabs[0].focus, Some(1));
        release(&mut app, 1, Drop::Swap(3));
        assert_eq!(app.tabs[0].panes(), vec![3, 2, 1]);
        assert_eq!(app.tabs[0].focus, Some(1), "the held pane keeps the focus, not the one it displaced");
        assert!(app.desk_layouts.contains(&app.tabs[0].id), "queued for the desk");
        app.desk_layouts.clear();
        release(&mut app, 3, Drop::Beside(1, Side::Bottom));
        let layout = app.tabs[0].root.as_ref().unwrap().to_tmux();
        assert_eq!(layout.matches('[').count(), 1, "1 and 3 are stacked: {layout}");
        assert_eq!(app.tabs[0].panes(), vec![2, 1, 3]);
        assert_eq!(app.tabs[0].focus, Some(3));
        assert!(app.desk_layouts.contains(&app.tabs[0].id));
        // -b puts it before: on the left of 2
        app.tabs[0].set_active(1);
        release(&mut app, 3, Drop::Beside(2, Side::Left));
        assert_eq!(app.tabs[0].panes(), vec![3, 2, 1]);
        assert_eq!(app.tabs[0].root.as_ref().unwrap().to_tmux().matches('[').count(), 0, "a row again");
        assert_eq!(app.tabs[0].focus, Some(3));
        // a pane that was not the focused one is focused once dropped
        release(&mut app, 2, Drop::Swap(1));
        assert_eq!(app.tabs[0].panes(), vec![3, 1, 2]);
        assert_eq!(app.tabs[0].focus, Some(2));
    }

    #[tokio::test]
    async fn dropping_on_a_tab_moves_the_pane_into_that_window() {
        let mut app = app(100);                          // window 1: pane 1; window 2: pane 2
        let other = app.tabs[1].id.clone();
        release(&mut app, 1, Drop::Tab(other.clone()));
        let tab = app.tabs.iter().find(|t| t.id == other).unwrap();
        assert!(tab.panes().contains(&1) && tab.panes().contains(&2));
        assert_eq!(app.tabs.len(), 1, "a window left with no pane closes, as join-pane does");
        assert_eq!((app.tab().id.clone(), app.tab().focus), (other, Some(1)), "the view follows the held pane");
    }

    #[tokio::test]
    async fn a_tab_drop_publishes_both_windows_and_follows_the_pane() {
        // window 1: panes 1 | 3; window 2: pane 2; both on the desk
        let mut app = app(100);
        let mut pane = crate::pane::Pane::new(3, "local", "a3", 100, 30);
        pane.phase = crate::pane::Phase::Live;
        app.panes.insert(3, pane);
        app.tabs[0].root.as_mut().unwrap().split(1, 3, Dir::Horizontal);
        app.session_desk = true;
        for tab in &mut app.tabs { tab.on_desk = true }
        app.fit_panes();
        let (left, other) = (app.tabs[0].id.clone(), app.tabs[1].id.clone());
        assert_eq!((app.active, app.tab().focus), (0, Some(1)));
        release(&mut app, 3, Drop::Tab(other.clone()));
        assert_eq!(app.tabs[0].panes(), vec![1]);
        assert_eq!(app.tabs[1].panes(), vec![2, 3]);
        assert!(app.desk_layouts.contains(&left) && app.desk_layouts.contains(&other), "{:?}", app.desk_layouts);
        assert_eq!((app.active, app.tab().focus), (1, Some(3)), "the view follows the held pane into its window");
    }

    #[tokio::test]
    async fn a_gone_source_or_target_does_nothing() {
        let mut app = three(120);
        let before = app.tabs[0].panes();
        let own = app.tabs[0].id.clone();
        release(&mut app, 99, Drop::Swap(2));
        release(&mut app, 1, Drop::Swap(99));
        release(&mut app, 1, Drop::Beside(99, Side::Left));
        release(&mut app, 1, Drop::Tab("no-such-window".into()));
        release(&mut app, 1, Drop::Tab(own));
        release(&mut app, 1, Drop::Swap(1));
        release(&mut app, 1, Drop::Nothing);
        assert_eq!(app.tabs[0].panes(), before);
        assert!(app.desk_layouts.is_empty());
        assert_eq!(app.errors, 0, "nothing ran, so nothing failed");
    }

    #[tokio::test]
    async fn a_pane_too_small_to_split_refuses_the_drop_and_nothing_moves() {
        let mut app = three(8);
        let (before, layout) = (app.tabs[0].panes(), app.tabs[0].root.as_ref().unwrap().to_tmux());
        release(&mut app, 1, Drop::Beside(3, Side::Left));
        assert_eq!(app.tabs[0].panes(), before);
        assert_eq!(app.tabs[0].root.as_ref().unwrap().to_tmux(), layout);
        let toast = app.toast.as_ref().map(|(t, ..)| t.clone()).unwrap_or_default();
        assert!(toast.contains("pane too small"), "the command's own message: {toast:?}");
        assert!(app.desk_layouts.is_empty());
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
