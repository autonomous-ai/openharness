# Drag panes with the mouse — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In hn, drag a pane by its title and drop it on another pane (swap it, or put it left / right / above / below that pane) or on a tab in the status bar or side bar (move it into that window).

**Architecture:** A new drag kind `Drag::Pane` in `mouse.rs` starts only from a pane's title (never the pane body, so text selection and programs' own mouse use are untouched). While it moves, a pure function `drop_target` turns the pointer into a `Drop` (swap / side / tab / nothing); the frame draws that drop's zone over the windows. On release the drop runs as the existing tmux commands (`swap-pane`, `join-pane`), so layouts, the desk and every other client follow through the paths they already use.

**Tech Stack:** Rust (ratatui), the tmux-compatible command layer (`commands.rs`), Python native fixtures.

**Spec:** user request 2026-10-07: "tôi muốn kéo thả pane qua lại được trong terminal luôn" (drag panes back and forth in the terminal). Investigation notes: there is no drag-and-drop code today; header hit boxes, `Drag`, `swap_panes`, `join_pane`, `break_pane` and desk publishing exist.

## Controller rulings (2026-10-07, after the plan check) — these OVERRIDE the task text below where they differ

1. **Build after plan 005 has merged**, so the `redraw_all` set on release is 005's soft repaint (no flash).
2. **Side-bar machine headings are not drop targets** in this version (only `Hit::Window` rows and status-bar tabs); a drop there does nothing.
3. **The line look:** dragging the pane's name moves the pane; dragging the rest of the title line resizes, as before. The two existing tests that pressed on the name to resize (`plain_pane_titles_keep_divider_drag_behavior`, `title_drag_journey`) press on the line part instead — that is the agreed change, not a regression.
4. Tests that assume status-bar tab ranges or an accent different from the background: the implementer asserts those preconditions explicitly at the start of the test (fail loudly, never skip).

## Global Constraints

- tmux's mouse bindings keep their meaning: `MouseDrag1Pane` (copy-mode selection / programs' mouse), `MouseDrag1Border resize-pane -M`, `MouseDown1Status select-window`. A user's own binding of `MouseDown1Pane/Border`, a modifier, the prefix, a key table, `tmux_look`, read-only and headless all turn the feature off, as they turn off the header controls today (`workspace_controls.rs:33, 132-148`).
- In the line look the title is the divider: dragging the divider line still resizes (`tests/workspace-controls.py` "plain title divider drags retain tmux resize behavior", `workspace_controls.rs:432`). A pane drag starts only from the title's **text** (the pane name), never from the line.
- A press and release without moving at least 2 cells is a click (selects the pane), as today.
- Every drop goes through `swap-pane` / `join-pane` so `layout_changed` → desk `tab.layout` + `pane.move` publish it (`app.rs:4893, 4914`).
- Colours from the theme (`theme::accent()`, `pane_palette()`), no fixed colours.

## Decisions (defaults; confirm with the user before Task 1)

| Question | Default |
|---|---|
| Where a drag starts | Pane title text (box / surface looks: the whole header row; line look: the name span only) |
| Drop on a pane | Outer 25% band on a side → put it on that side (`join-pane -h/-v [-b]`); the middle → swap (`swap-pane`) |
| Drop on a tab (status bar or side bar) | Move into that window beside its active pane (`join-pane -t :N`) |
| Drop on itself, nothing, or Escape | Nothing happens |
| A window with one pane dragged out | Its window closes, as `join-pane` does in tmux |
| Zoomed window | No drag starts while zoomed |
| Too small to split | The drop is refused with the command's message (`create pane failed: pane too small`), nothing moves |
| Undo | None (the same drag back undoes it); no confirmation |

## Review Focus

- A drag that starts on the header and ends inside the same pane's body must not run anything nor send input to the program.
- A drop while another client changes the layout (desk `pane.move` arriving mid-drag): the source or target may be gone — the drop re-checks both ids at release and does nothing if either is gone.
- Copy-mode drag selection inside a pane still selects text (start inside the body).
- A right-button drag or a drag with a modifier is never a pane drag.
- The overlay must be cleared after the drop (the frame after release has no zone; `redraw_all` once).

---

### Task 1: Drop targets (pure function)

**Files:**
- Create: `tui/src/pane_drag.rs` (module `pane_drag`; add `mod pane_drag;` in `tui/src/main.rs` after `mod pane_frame;` at :58)
- Modify: `tui/src/workspace_controls.rs:307` (`mod tests` → `pub(crate) mod tests`), `:344` (`fn app` → `pub(crate) fn app`), `:371` (`fn render` → `pub(crate) fn render`), so `pane_drag` tests reuse the real fixture instead of inventing one
- Test: `tui/src/pane_drag.rs` tests module

**Real pieces this uses** (all exist): `app.rects: Vec<(u64, Rect)>` (`app.rs:518`, screen coordinates of each pane of the current window); `app.bar.hits: Vec<(Rect, bar::Hit)>` and `bar::hit_at(app, x, y) -> Option<Hit>` (`bar.rs:473`; **side bar only**, it holds `Hit::Window(i)`); `app.status_ranges: Vec<(u16, draw::Range)>` with `RangeKind::Window(number)` for the status-bar tabs (`app.rs:586`; the screen row is `top + row`, `top = if app.status_top { 0 } else { app.size.1 - app.status_lines() }`, as `workspace_controls.rs:166` computes it for a right-click); `app.tab_by_num(n)` / `app.win_num(i)` (`app.rs:3740-3742`); `app.bar_side()`.

**Interfaces:**
- Produces:
```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side { Left, Right, Top, Bottom }
/// A tab is named by its id (`Tab.id`), not its index: a desk update mid-drag can renumber the tabs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Drop { Swap(u64), Beside(u64, Side), Tab(String), Nothing }
/// [x, y] over the screen while pane [src] is dragged: what releasing there does.
pub fn drop_target(app: &App, src: u64, x: u16, y: u16) -> Drop
/// The cells that show [drop]: the zone of the target pane (a side half or the whole pane) or the tab's cells.
pub fn zone(app: &App, drop: &Drop) -> Option<ratatui::layout::Rect>
/// The cells of tab [i] in the side bar, else its status-bar range.
pub fn tab_cell(app: &App, i: usize) -> Option<ratatui::layout::Rect>
```

- [ ] **Step 0: Share the fixture.** In `tui/src/workspace_controls.rs` make `mod tests`, `fn app(width)` and `fn render(app)` `pub(crate)` (three one-word edits; `app(width)` builds two tabs `work-1` / `work-2`, each with one live pane, ids 1 and 2, `mouse = true`, 32 rows; to put both panes in one window, do what `plain_pane_titles_keep_divider_drag_behavior` does: `app.tabs.truncate(1)`, `root.split(1, 2, Dir::…)`, `fit_panes()`, `render`).

- [ ] **Step 1: Write the failing tests** (`tui/src/pane_drag.rs`, bottom of file)

```rust
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

    fn rect(app: &App, id: u64) -> ratatui::layout::Rect { app.rects.iter().find(|(i, _)| *i == id).unwrap().1 }

    #[tokio::test]
    async fn the_middle_swaps_the_outer_quarter_puts_beside_itself_is_nothing() {
        let app = two();
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
        let other = tab_cell(&app, 1).expect("the side bar lists the other tab");
        assert_eq!(drop_target(&app, 1, other.x, other.y), Drop::Tab(app.tabs[1].id.clone()));
    }
}
```
(Use a pane-body rect only after `render`/`fit_panes`; `Rect::right()` / `bottom()` are exclusive edges, hence `- 2` for "one cell inside".)

- [ ] **Step 2: Run to verify they fail**

Run: `cd tui && cargo test --locked pane_drag`
Expected: FAIL (does not compile: `pane_drag` has no items).

- [ ] **Step 3: Implement**

```rust
use ratatui::layout::{Position, Rect};
use crate::{app::App, draw::RangeKind};

pub fn tab_cell(app: &App, i: usize) -> Option<Rect> {
    if app.bar_side().is_some() {
        return app.bar.hits.iter().find(|(_, h)| *h == crate::bar::Hit::Window(i)).map(|(r, _)| *r);
    }
    let number = app.win_num(i) as u64;
    let top = if app.status_top { 0 } else { app.size.1.saturating_sub(app.status_lines()) };
    app.status_ranges.iter().find(|(_, r)| matches!(r.kind, RangeKind::Window(n) if n == number))
        .map(|(row, r)| Rect::new(r.start, top + row, r.end.saturating_sub(r.start), 1))
}

fn tab_at(app: &App, x: u16, y: u16) -> Option<usize> {
    if app.bar_side().is_some() {
        return match crate::bar::hit_at(app, x, y) { Some(crate::bar::Hit::Window(i)) => Some(i), _ => None };
    }
    (0..app.tabs.len()).find(|i| tab_cell(app, *i).is_some_and(|r| r.contains(Position { x, y })))
}

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
```
`zone`: `Beside(id, Left)` the left half of the target's rect in `app.rects` (the half the moved pane will take), `Right` the right half, `Top` / `Bottom` likewise; `Swap(id)` the whole rect; `Tab(tab_id)` → `tab_cell(app, index_of(tab_id))`; `Nothing` / an id no longer present → `None`.

- [ ] **Step 4: Run to verify they pass** — `cd tui && cargo test --locked pane_drag` → PASS
- [ ] **Step 5: Commit** — `git add tui/src/pane_drag.rs tui/src/main.rs tui/src/workspace_controls.rs && git commit -m "hn: where a dragged pane would land"`

### Task 2: Starting, following and ending a pane drag

The pane drag lives in `workspace_controls`, not in `mouse.rs`'s `Drag` enum. Reason: a header press is already owned by `workspace_controls` (`begin_press` sets `controls.pressed`), and `input.rs:290` calls `finish_press` before anything else, which swallows every drag and release of that button. `mouse::drag_update` / `drag_release` (`mouse.rs:410, 418`) only run for tmux's own drags (`drag_flag`), so a `Drag::Pane` variant would never see an event; setting `mouse_state.drag` would also switch off `workspace_controls::mouse` (`:134`) and `bar::mouse` (`bar.rs:531`). `mouse.rs` is therefore not modified.

**Files:**
- Modify: `tui/src/workspace_controls.rs`: `State` (`:14-22`) gets `grips: RefCell<Vec<(Rect, u64)>>` (the cells a pane drag may start from) and `grab: Option<Grab>`; `begin_frame` (`:31`) also clears `grips`; `title` (`:47`) registers the remaining title rect as the pane's grip; new `pub fn name_span(app, pane, width)`; `finish_press` (`:122-130`); `mouse` Header press (`:151-158`)
- Modify: `tui/src/ui.rs:567` (`title_line`, line look): after the title is drawn, `workspace_controls::name_span(app, id, <number of leading drawn cells>)` narrows the grip to the name; `boxes` (`:585`, `:611`) keeps the whole title rect
- Modify: `tui/src/input.rs:21-31` (`handle`, the `CEvent::Key` arm): Escape cancels a live grab before `on_key`
- Modify: `tui/src/pane_drag.rs`: `follow` and a `release` stub
- Test: `tui/src/workspace_controls.rs` tests (next to `plain_pane_titles_keep_divider_drag_behavior` :432); the existing test is changed (below)

**Interfaces:**
- Consumes: `pane_drag::{drop_target, Drop}`.
- Produces:
```rust
// workspace_controls.rs
pub struct Grab { pub pane: u64, from: (u16, u16), /// true once the pointer moved 2 cells: a drag, no longer a click
    pub live: bool, pub drop: crate::pane_drag::Drop }
// State: pub grips: RefCell<Vec<(Rect, u64)>>, pub grab: Option<Grab>
// pane_drag.rs
pub fn follow(app: &mut App, x: u16, y: u16)               // sets grab.live after 2 cells, then grab.drop = drop_target(..)
pub fn release(app: &mut App, src: u64, drop: Drop)        // Task 4; here `{}`
pub fn cancel(app: &mut App)                               // grab = None, redraw
```
The frame draws `app.controls.grab` while `live`; there is no `app.pane_drag` field and `app.rs` is not modified.

**How a press becomes a grab.** `title()` already registers `Action::Header(pane)` over the whole title rect (kept: it still selects the pane and opens the menu on right-click). It also registers a grip over `rect` minus the 6 reserved control cells. In the boxed and surface looks that is the whole header row. In the line look `title_line` narrows it to the name: the leading run of cells `format_draw_over` drew (the same `cells.iter().position(|c| c.is_none())` that `boxes` uses at `ui.rs:615`), so the divider line to its right is not a grip. In `mouse()`, on `Down(Left)` over `Action::Header(pane)`: `over_resize_border` (`mouse.rs:141`) only wins when the press is **not** on a grip (today that branch calls `select_pane` and returns `false`, so tmux's `MouseDown1Border` / resize runs; keep that for the divider cells). On a grip (and not zoomed: `!app.tab().zoomed`) the press goes the normal header way (`begin_press`, `activate` selects the pane, `return true`) and also sets `app.controls.grab = Some(Grab { pane, from: (col, row), live: false, drop: Drop::Nothing })`.

- [ ] **Step 1: Failing tests** (in `workspace_controls.rs` `mod tests`; `app`, `render`, `hit` exist there; add these two small helpers)

```rust
    fn send(app: &mut App, kind: MouseEventKind, x: u16, y: u16) {
        crate::input::handle(app, Event::Mouse(MouseEvent { kind, column: x, row: y, modifiers: KeyModifiers::NONE }));
    }
    fn grip(app: &App, pane: u64) -> Rect {
        app.controls.grips.borrow().iter().find(|(_, p)| *p == pane).unwrap_or_else(|| panic!("no grip for {pane}")).0
    }
    fn live(app: &App) -> bool { app.controls.grab.as_ref().is_some_and(|g| g.live) }

    #[tokio::test]
    async fn a_header_drag_of_two_cells_becomes_a_pane_drag_and_a_short_one_stays_a_click() {
        let mut app = app(120);
        app.tabs.truncate(1);
        app.tabs[0].root.as_mut().unwrap().split(1, 2, crate::layout::Dir::Horizontal);
        app.fit_panes(); render(&mut app);
        let g = grip(&app, 1);
        send(&mut app, MouseEventKind::Down(MouseButton::Left), g.x + 1, g.y);
        send(&mut app, MouseEventKind::Drag(MouseButton::Left), g.x + 2, g.y);       // 1 cell: still a click
        assert!(!live(&app));
        send(&mut app, MouseEventKind::Drag(MouseButton::Left), g.x + 4, g.y + 3);   // 2 or more cells
        assert!(live(&app));
        let r2 = app.rects.iter().find(|(id, _)| *id == 2).unwrap().1;
        let (cx, cy) = (r2.x + r2.width / 2, r2.y + r2.height / 2);
        send(&mut app, MouseEventKind::Drag(MouseButton::Left), cx, cy);
        assert_eq!(app.controls.grab.as_ref().unwrap().drop, crate::pane_drag::Drop::Swap(2));
        send(&mut app, MouseEventKind::Up(MouseButton::Left), cx, cy);
        assert!(app.controls.grab.is_none() && app.controls.pressed.is_none());
        // a press and release that never moved 2 cells runs nothing
        let order = app.tabs[0].panes();
        let g = grip(&app, 1);
        send(&mut app, MouseEventKind::Down(MouseButton::Left), g.x + 1, g.y);
        send(&mut app, MouseEventKind::Up(MouseButton::Left), g.x + 1, g.y);
        assert_eq!(app.tabs[0].panes(), order);
    }

    #[tokio::test]
    async fn the_line_looks_divider_still_resizes_and_only_the_name_drags_the_pane() {
        for name_drag in [false, true] {
            let mut app = app(100);
            app.tabs.truncate(1);
            app.tabs[0].root.as_mut().unwrap().split(1, 2, crate::layout::Dir::Vertical);
            app.options.set("@hn-border", Some("line"), &crate::options::SetFlags { global: true, ..Default::default() }, "", 0).unwrap();
            app.fit_panes(); render(&mut app);
            let title = hit(&app, Action::Header(2));
            let name = grip(&app, 2);
            assert!(name.width > 0 && name.right() < title.right() - 6, "the grip is the name, not the whole line");
            let before = app.tab().root.as_ref().unwrap().to_tmux();
            let x = if name_drag { name.x + 1 } else { name.right() + 1 };
            send(&mut app, MouseEventKind::Down(MouseButton::Left), x, title.y);
            send(&mut app, MouseEventKind::Drag(MouseButton::Left), x, title.y + 3);
            assert_eq!(live(&app), name_drag, "name_drag={name_drag}");
            send(&mut app, MouseEventKind::Up(MouseButton::Left), x, title.y + 3);
            let after = app.tab().root.as_ref().unwrap().to_tmux();
            // the divider part resizes as before; the name part never resizes
            assert_eq!(after != before, !name_drag, "name_drag={name_drag}");
        }
    }

    #[tokio::test]
    async fn escape_during_a_pane_drag_cancels_it_and_the_release_runs_nothing() {
        let mut app = app(120);
        app.tabs.truncate(1);
        app.tabs[0].root.as_mut().unwrap().split(1, 2, crate::layout::Dir::Horizontal);
        app.fit_panes(); render(&mut app);
        let order = app.tabs[0].panes();
        let g = grip(&app, 1);
        let r2 = app.rects.iter().find(|(id, _)| *id == 2).unwrap().1;
        send(&mut app, MouseEventKind::Down(MouseButton::Left), g.x + 1, g.y);
        send(&mut app, MouseEventKind::Drag(MouseButton::Left), g.x + 1, g.y + 3);
        assert!(live(&app));
        crate::input::handle(&mut app, Event::Key(crossterm::event::KeyEvent::new(crossterm::event::KeyCode::Esc, KeyModifiers::NONE)));
        assert!(app.controls.grab.is_none());
        send(&mut app, MouseEventKind::Up(MouseButton::Left), r2.x + 5, r2.y + 5);
        assert_eq!(app.tabs[0].panes(), order);
    }
```
Also change the existing `plain_pane_titles_keep_divider_drag_behavior` (`workspace_controls.rs:432`) and `title_drag_journey` (`tui/tests/workspace-controls.py:392`): they press at `title.x + 3` / `x + 5`, which is on the name and would now start a pane drag. Press on the divider line instead: in the Rust test `let col = grip(&app, 2).right() + 1;` (before `if !controls { … }` the grips exist; clearing only `hits` for `controls=false` is unchanged) and use `col` in place of `title.x + 3`; in the Python journey pick the first `─` on the title row right of the name: `col = next(c for c in range(x + width('Beta task') + 2, x + int(value('#{pane_width}', beta)) - 7) if screen().splitlines()[top - 1][c] == '─')` and send `col + 1` in place of `x + 5` (the existing assertions are unchanged: the divider still resizes).

- [ ] **Step 2: Run** — `cd tui && cargo test --locked workspace_controls` → FAIL (`grips`, `grab` do not exist)
- [ ] **Step 3: Implement**
  - `State`: add `pub grips: RefCell<Vec<(Rect, u64)>>` and `pub grab: Option<Grab>`; `begin_frame` clears `grips` too.
  - `title()` (after `register(app, rect, Action::Header(pane))`): `app.controls.grips.borrow_mut().push((Rect::new(rect.x, rect.y, rect.width - reserve, 1), pane));`
  - `pub fn name_span(app: &App, pane: u64, width: u16)`: find the grip of `pane` and set its width to `width.min(old)`; remove it when `width == 0`. `ui.rs::title_line` calls it after building `cells` with `cells.iter().position(|c| c.is_none()).unwrap_or(cells.len())`.
  - `mouse()` Header press: `let on_grip = app.controls.grips.borrow().iter().any(|(r, p)| *p == pane && inside(r));` the `over_resize_border` early return becomes `if !on_grip && over_resize_border(..)`; after `begin_press`, `if on_grip && !app.tab().zoomed { app.controls.grab = Some(Grab { pane, from: (mouse.column, mouse.row), live: false, drop: Drop::Nothing }) }`.
  - `finish_press`:
```rust
        MouseEventKind::Up(up) if up == button => {
            app.controls.pressed = None;
            if let Some(g) = app.controls.grab.take() { if g.live { crate::pane_drag::release(app, g.pane, g.drop) } }
            true
        }
        MouseEventKind::Drag(drag) if drag == button => { crate::pane_drag::follow(app, mouse.column, mouse.row); true }
        MouseEventKind::Down(_) => { app.controls.pressed = None; app.controls.grab = None; false }
```
  - `pane_drag::follow`: read `grab` (`pane`, `from`, `live`); `live ||= |dx| + |dy| >= 2` from `from`; when live, `grab.drop = drop_target(app, pane, x, y)`. `cancel`: `app.controls.grab = None`.
  - `input.rs` `handle`, first line of the `CEvent::Key(key) if key.kind != KeyEventKind::Release` arm: `if key.code == KeyCode::Esc && app.controls.grab.is_some() { crate::pane_drag::cancel(app); return }` (the release that follows is still swallowed by `finish_press` because `controls.pressed` stays set).
- [ ] **Step 4: Run** — `cd tui && cargo test --locked` → PASS (including the edited `plain_pane_titles_keep_divider_drag_behavior`, `header_controls_preserve_custom_pane_mouse_bindings` :458, `right_click_opens_the_panes_menu_…` :586)
- [ ] **Step 5: Commit** — `git commit -am "hn: drag a pane by its title"`

### Task 3: Drawing the drop zone

**Files:**
- Modify: `tui/src/ui.rs:232` (right after the `DisplayPanes` overlay line, still before the modals: `crate::pane_drag::draw(buf, app);`)
- Modify: `tui/src/pane_drag.rs` (`pub fn draw(buf: &mut Buffer, app: &App)`)
- Test: `tui/src/pane_drag.rs` tests (buffer assertions through `render`)

- [ ] **Step 1: Failing test** (in `pane_drag.rs` `mod tests`, uses `two()`, `rect()`, `render` from Task 1)

```rust
    #[tokio::test]
    async fn the_zone_is_shaded_in_the_accent_with_a_hint_and_cleared_after() {
        let mut app = two();
        let r2 = rect(&app, 2);
        let tint = crate::theme::paint(crate::theme::accent());
        app.controls.grab = Some(crate::workspace_controls::Grab::live_for_test(1, Drop::Beside(2, Side::Left)));
        let buf = render(&mut app);
        let z = zone(&app, &Drop::Beside(2, Side::Left)).unwrap();
        assert_eq!(z.x, r2.x);
        assert!(z.width < r2.width && buf[(z.x, z.y + 1)].bg == tint, "the left half takes the accent");
        let row: String = (z.x..z.right()).map(|x| buf[(x, z.y + z.height / 2)].symbol()).collect();
        assert!(row.contains("left of Task 2"), "{row}");
        assert!(buf[(r2.right() - 1, r2.y + 1)].bg != tint, "outside the zone keeps its colour");
        app.controls.grab = None;
        let buf = render(&mut app);
        assert!(buf.content().iter().all(|c| c.bg != tint), "no zone once the drag is over");
    }
```
(`Grab::live_for_test(pane, drop)` is a `#[cfg(test)]` constructor next to `Grab` that fills the private `from`; the roster names panes `Task 1` / `Task 2` in `app()`. Hint texts: `left of <name>` / `right of` / `above` / `below`, `swap with <name>`, `to <tab name>` (`app.tabs[i].name`); a pane's name is `app.fleet.agent(&p.machine_id, &p.agent_id).map(|a| a.name.clone())`. If the theme's accent is not distinct from the pane background in the fixture, compare against a render without the grab instead.)
- [ ] **Step 2: Run** — `cargo test --locked pane_drag` → FAIL
- [ ] **Step 3: Implement** — `pub fn draw(buf, app)`: return unless `app.controls.grab` is `live`; take `zone(app, &grab.drop)`; for each cell of the zone `cell.set_bg(theme::paint(theme::accent())).set_fg(theme::paint(theme::pane_palette().background))` (symbols stay); write the hint centred on the zone's middle row, clipped to the zone width (`unicode_width` as `workspace_controls.rs` does). On release `pane_drag::release` sets `app.redraw_all = true` once (see Review Focus; plan 005 changes what `redraw_all` costs, so if 005 lands first a plain redraw request is enough, because the zone is part of the frame buffer and the diff removes it).
- [ ] **Step 4: Run** — `cargo test --locked pane_drag` → PASS
- [ ] **Step 5: Commit** — `git commit -am "hn: show where a dragged pane will land"`

### Task 4: The drop runs as tmux commands

**Files:**
- Modify: `tui/src/pane_drag.rs` (`release`)
- Test: `tui/src/pane_drag.rs` tests; `tui/tests/workspace-controls.py` (new `pane_drag_journey`). `tui/tests/layout-sync.py` is **not** extended: it has no mouse input path, and its existing `swap-pane` step (:287-291, `hn('swap-pane', '-s', source, '-t', target, '-d')` then `wait(... names() == desk_names() ...)`) already proves a swap publishes the pane order; the Rust test below proves the drop issues that same command and queues the layout.

How the commands target things (all exist): a pane is `crate::pane::tag(id)` (`%{id-1}`, `pane.rs:45`); a window is `:{number}` with `number = app.win_num(index)` (the form `bar.rs:481` uses for `select-window -t :{n}`; as a `join-pane -t` it resolves to that window's active pane through `commands::pane_target`, `commands.rs:279`). `swap-pane` takes `-s -t` (cmd.rs:115, `swap_panes` publishes via `layout_changed`, `app.rs:5333`); `join-pane` takes `-b -h -v -s -t` (cmd.rs:54; `App::join_pane` `app.rs:4455` refuses with `create pane failed: pane too small` before moving anything, and calls `layout_changed` for the window it left and the one it joined, `app.rs:4487-4488`). `layout_changed` (`app.rs:4893`) queues the tab's id in `app.desk_layouts` (a `HashSet<String>`, drained by `send_desk_layouts`, `app.rs:4914`) only when `app.session_desk` and `tab.on_desk` are set; the existing tests assert exactly that with `app.desk_layouts.contains("layout-test")` (`app.rs:7219`).

- [ ] **Step 1: Failing tests** (in `pane_drag.rs` `mod tests`)

```rust
    /// Panes 1 | 2 | 3 in one window, on the desk so that layout changes are queued.
    fn three() -> App {
        let mut app = app(120);
        app.tabs.truncate(1);
        let mut pane = crate::pane::Pane::new(3, "local", "a3", 120, 30);
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
        let mut app = three();
        release(&mut app, 1, Drop::Swap(3));
        assert_eq!(app.tabs[0].panes(), vec![3, 2, 1]);
        assert!(app.desk_layouts.contains(&app.tabs[0].id), "queued for the desk");
        app.desk_layouts.clear();
        release(&mut app, 3, Drop::Beside(1, Side::Bottom));
        assert_eq!(app.tabs[0].root.as_ref().unwrap().to_tmux().matches('[').count(), 1, "1 and 3 are stacked");
        assert!(app.desk_layouts.contains(&app.tabs[0].id));
    }

    #[tokio::test]
    async fn dropping_on_a_tab_moves_the_pane_into_that_window() {
        let mut app = app(100);                          // window 1: pane 1; window 2: pane 2
        let other = app.tabs[1].id.clone();
        release(&mut app, 1, Drop::Tab(other.clone()));
        let tab = app.tabs.iter().find(|t| t.id == other).unwrap();
        assert!(tab.panes().contains(&1) && tab.panes().contains(&2));
        assert_eq!(app.tabs.len(), 1, "a window left with no pane closes, as join-pane does");
    }

    #[tokio::test]
    async fn a_gone_source_or_target_does_nothing() {
        let mut app = three();
        let before = app.tabs[0].panes();
        release(&mut app, 99, Drop::Swap(2));
        release(&mut app, 1, Drop::Swap(99));
        release(&mut app, 1, Drop::Beside(99, Side::Left));
        release(&mut app, 1, Drop::Tab("no-such-window".into()));
        release(&mut app, 1, Drop::Swap(1));
        release(&mut app, 1, Drop::Nothing);
        assert_eq!(app.tabs[0].panes(), before);
        assert!(app.desk_layouts.is_empty());
    }
```
- [ ] **Step 2: Run** — `cargo test --locked pane_drag` → FAIL (the Task 2 stub does nothing)
- [ ] **Step 3: Implement**

```rust
pub fn release(app: &mut App, src: u64, drop: Drop) {
    let alive = |app: &App, id: u64| app.panes.contains_key(&id) && app.tabs.iter().any(|t| t.panes().contains(&id));
    if !alive(app, src) { return }
    let tag = crate::pane::tag;
    let command = match drop {
        Drop::Swap(dst) if dst != src && alive(app, dst) => format!("swap-pane -s {} -t {}", tag(src), tag(dst)),
        Drop::Beside(dst, side) if dst != src && alive(app, dst) => {
            let flags = match side { Side::Left => "-h -b", Side::Right => "-h", Side::Top => "-v -b", Side::Bottom => "-v" };
            format!("join-pane {flags} -s {} -t {}", tag(src), tag(dst))
        }
        Drop::Tab(id) => match app.tabs.iter().position(|t| t.id == id).filter(|i| *i != app.active) {
            Some(i) => format!("join-pane -s {} -t :{}", tag(src), app.win_num(i)),
            None => return,
        },
        _ => return,
    };
    crate::commands::execute(app, &command);
    app.redraw_all = true;
}
```
A refused drop (`create pane failed: pane too small`) is reported by the command itself (`app.error`); nothing moves.

Native journey (`tui/tests/workspace-controls.py`): add `pane_drag_journey(alpha, beta)` next to `title_drag_journey` (:392), called after it at :619 and under a new `--pane-drag` argument beside `--title-drag` (:459-462; `api({'action': 'terminal-mouse'})` first, as there). It sends raw SGR mouse bytes with the same `tmux('send-keys','-H', ...)` loop as `title_drag_journey` (a press `\x1b[<0;X;YM`, motion `\x1b[<32;X;YM`, release `\x1b[<0;X;Ym`; the existing `click()` at :142 shows the 1-based coordinates). Steps: `@hn-border box`; press on Alpha's title name (row `#{pane_top}` − 1 plus the box frame; read it from `screen()` as `painted_workspace` does), drag to the middle of Beta, release, then `wait` until `hn('list-panes', '-F', '#{pane_id}').splitlines()` is `[beta, alpha]`; `assert len(api()['inputs']) == before` (no program input); drag Alpha to Beta's bottom quarter and `wait` for `#{pane_top}` of the two panes to differ with equal `#{pane_left}`; drag a pane onto the other tab's name in the status bar (`click_text` shows how a tab's cell is located on screen) and check it is listed with `list-panes -t :N`. The Rust `workspace_controls.rs` / `pane_drag.rs` tests above are the primary evidence; this journey is the real-terminal check. Restore the layout at the end as `title_drag_journey` does.

- [ ] **Step 4: Run** — `cd tui && cargo test --locked && cargo build --release --locked && cd .. && python3 scripts/validate-tui-native.py tui/target/release/harness-tui` → all pass (the native runner starts `workspace-controls` once; `--pane-drag` runs only on demand: `cd tui && env HN_WORKSPACE_BINARY=<binary> HN_WORKSPACE_PORT=19930 python3 -u tests/workspace-controls.py --pane-drag`). Composer-machine: macOS bash 3.2, known.
- [ ] **Step 5: Commit** — `git commit -am "hn: dropping a pane swaps it, puts it beside another, or moves it to a tab"`

---

## Plan check (2026-10-07, against origin/main)

Conflicts between tasks, and whether each task's tests match its code:

| Pair / task | Shared file or interface | Status |
|---|---|---|
| Task 1 and Task 2 | `workspace_controls.rs`: Task 1 makes `tests`, `app`, `render` `pub(crate)`; Task 2 adds helpers and tests to the same module | No conflict (Task 1 first, one-word edits) |
| Task 1 and Task 4 | `Drop::Tab(String)`: Task 1 produces it, Task 4 resolves it by id | Same type in both; tests use ids |
| Task 2 and Task 3 | `Grab` (Task 2) is read by `pane_drag::draw` (Task 3); `Grab::live_for_test` is added in Task 2's struct | Task 3 depends on Task 2 |
| Task 2 and Task 4 | `pane_drag::release` is a stub in Task 2 and filled in Task 4; `finish_press` calls it on release | Order 2 then 4; tests of Task 2 assert the order only after Task 4 for the swap (the first test asserts `grab` cleared, not the swap) |
| Task 2 and Task 3 | both edit `ui.rs`: `title_line` (:567) and :232 | Different lines |
| Task 2 test and existing test | `plain_pane_titles_keep_divider_drag_behavior` and `title_drag_journey` pressed on the name | Both changed in Task 2 to press on the divider |
| Task 1 test | needs the status bar visible (`status_lines() > 0`, no side bar) | Asserted at the start of the test |
| Task 2 code and Global Constraints | line-look divider resizes; drag from the name only; Esc; 2-cell click rule | Match |
| Task 3 code and Global Constraints | theme colours only (`theme::accent()`, `pane_palette()`) | Match |
| Task 4 code and Global Constraints | every drop through `swap-pane` / `join-pane` | Match |

Cross-plan overlaps (not edited here): plan 005 changes the cost and meaning of `app.redraw_all` and edits `input.rs:36, 42` (this plan edits `input.rs:21-31` and sets `redraw_all` on release); plan 003 edits `ui.rs:304-350` and `input.rs:1632-1681, 3549-3574` (no shared lines); plan 007 edits `ui.rs:1460-1467, 2508-…` (no shared lines); plan 008 changes `bar::Hit` (`Hit::Machine(String, Option<usize>)`, new `Harness`/`More`) and `bar.rs:470-492`; this plan only uses `Hit::Window(i)` and `app.bar.hits`, which 008 keeps. Plan 004 touches none of these files.
