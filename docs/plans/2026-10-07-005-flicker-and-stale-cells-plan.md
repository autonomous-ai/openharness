# Flicker and stale text in every terminal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hn never shows a blank flash when it repaints the whole screen, and text a terminal kept wrongly is written over shortly after the change that left it, not only after a scroll, focus or resize.

**Architecture:** Two separate causes.
1. **Flicker (hn's bug, confirmed in code).** A full repaint (`app.redraw_all`) calls `term.clear()` at `main.rs:597` *before* the frame is due; `TmuxBackend::clear_region(All)` (`term_out.rs:623-631`) writes `\e[2J` straight to the terminal outside a synchronized update (`?2026h … ?2026l` is only opened by the next frame, `term_out.rs:569`), and the frame may wait up to the frame budget (~6 ms). The terminal shows a blank screen in between. Captured bytes: `…\e[?2026l\e[2J\e[1;1H\e[?2026h…`. Triggers: every focus-in (`input.rs:45`), resize (`input.rs:42`), Ctrl-L in lists (`input.rs:2359`), `close_popup` (`app.rs:2369`), every `set`/`source-file` (`app.rs:2395`), `swap_tabs` (`app.rs:2526`), Settings (`app.rs:5530/5532`), sign-out (`app.rs:5681`), the clock (`input.rs:197`).
   Fix: a full repaint is a **soft** clear (rows erased and rewritten inside the frame's synchronized update, as #601 did for the wheel) unless the size changed; a hard clear, when needed, opens the synchronized update first and happens in the same pass as the draw.
2. **Stale text (Ghostty 1.3.1, the user's version).** hn's bytes are correct: an isolated replay with `HARNESS_TUI_VERIFY` found 0 differing cells and balanced `?2026` pairs (211/211). Ghostty has an open report of exactly this pattern — synchronized output plus small cursor-positioned updates with colour changes progressively corrupting the screen; a full rewrite or resize clears it ([ghostty discussion #12062](https://github.com/ghostty-org/ghostty/discussions/12062)). #592 (lingrd) already rewrites the screen after the wheel rests, on focus and on resize; it does not cover a modal closing or shrinking (command panel, New Harness list, Close Tab), the status/side bar changing, or bursts of pane output.
   Fix: generalise #592's settle repaint: any frame that removed an overlay, or wrote many cells one by one, schedules one soft full repaint ~250 ms after things go quiet.

**Tech Stack:** Rust (`term_out.rs` backend over crossterm/ratatui), `tests/repaint.py`.

**Spec:** user report 2026-10-07: "lâu lâu tôi thấy cái TUI bị chớp, cần bôi đen để clean nó là bình thường, trước đó version cũ tôi nhớ có fix rồi" — the earlier fix is #592/#601 (lingrd), still on main and unchanged.

## Every terminal, not only Ghostty

Every fix here is terminal-neutral: nothing reads the terminal's name, and each one only changes *how* hn writes the same picture.

| Terminal | Synchronized output (?2026) | What these fixes give it |
|---|---|---|
| Ghostty, iTerm2, WezTerm, kitty, foot, Warp, VS Code / Cursor terminal | yes | the clear and the redraw shown together (no blank flash); the settle rewrite clears anything kept wrongly |
| Terminal.app, Alacritty, xterm, an old outer tmux | no (the sequence is ignored) | the soft repaint never erases the whole screen, so no blank flash even without ?2026; the settle rewrite still clears kept cells |
| Over ssh / inside another tmux | as the outer terminal | same as above; bytes per frame do not grow (one rewrite per burst, none while idle) |

Task 4's fixture asserts the byte stream, which is the same for every terminal. Task 5 checks by hand on the terminals installed on the author's Mac (Ghostty, Terminal.app, Warp, Cursor's terminal) and with `HARNESS_TUI_SYNC=off` (a terminal without ?2026).

## Controller rulings (2026-10-07, after the plan check) — these OVERRIDE the task text below where they differ

1. **A list shrinking inside an open panel** must also owe the settle rewrite: `settle_due` compares the **area (Rect) of the overlay drawn in the previous frame with this frame's** (`Option<Rect>`, taken from what the frame drew: `picker.screen_area`, the menu box, the New Harness form/chooser rects), not a bool. Owed when the overlay is gone, or its rect shrank / moved. Test: a picker whose rows drop from 10 to 2 owes one settle rewrite.
2. **One cursor placement per frame (Task 3b) is accepted** even though it raises `plain_echo_keeps_the_printed_cursor_and_needs_few_bytes`' bound (`term_out.rs:730`) from 7 to 13 bytes: correct placement after an input method moved the cursor matters more than 6 bytes per frame.

## Global Constraints

- No terminal-specific branch: no `terminal_name()` / `TERM_PROGRAM` checks in these fixes.

- An idle hn writes nothing (`term_out.rs`: a frame that changes nothing is not written) — the settle repaint runs once per burst, never on a timer while idle.
- `HARNESS_TUI_SYNC=off` keeps working (no synchronized update at all).
- The soft clear must still erase empty rows (`term_out.rs:584-586`: "a row of a soft clear with nothing on it is still erased").
- No change to what is drawn — only how it is written.

## Review Focus

- A real size change must still hard-clear (the terminal reflowed its own cells; a soft rewrite of the old size would leave text outside the new rows).
- Two full repaints requested in one loop pass write one repaint, not two.
- The settle repaint must not fire while the user is dragging a selection in copy mode (it would not break it, but must not reset `copy_top` / selection state — it is a write-only operation; verify).
- Wide characters at the right edge after a soft repaint (the row is erased first with `\e[2K`).
- `HARNESS_TUI_SYNC=off`: the hard clear path writes `\e[2J` without `?2026h`.

---

## Facts the tasks rely on (checked against the code, 2026-10-07, origin/main 91fee170b)

- `ratatui` is 0.30.2 (`ratatui-core` 0.1.2). `Terminal::clear()` on a fullscreen viewport calls `backend.clear_region(ClearType::All)`, never `Backend::clear()`; it also calls `get_cursor_position()` (hn's backend answers `ORIGIN`, `term_out.rs:612`) and then `set_cursor_position(ORIGIN)`, which writes `\e[1;1H` whenever `cursor_at` is `None` (that is the `\e[2J\e[1;1H` in the captured bytes).
- `Terminal::draw` first calls `autoresize()`: if the backend's size differs from the last known area it calls `resize()`, which calls `clear_region(All)` (once, and a second time on a width shrink) and resets the back buffer. That clear happens *inside* `term.draw`, before `TmuxBackend::draw` runs, so it is also outside any `?2026h` today. Task 1's `begin_sync` in `clear_region` covers it. Because of it, a real size change needs no explicit `term.clear()` from `main.rs`.
- `ratatui::Terminal::new(TmuxBackend<Vec<u8>>)` is not usable in unit tests: `Terminal::new` asks the backend for its size, which goes to `crossterm::terminal::size()` (the real `/dev/tty`; it fails without a tty and returns the developer's window size in a terminal). Every existing `term_out.rs` test therefore drives the backend directly: `TmuxBackend::with_sync(&mut written)` (private, `term_out.rs:172`, available to the module's tests), `backend.draw(iter of (x, y, &Cell))`, `Backend::flush(&mut backend)` (the trait call; `flush()` alone is `Write::flush` and does not close `?2026`), `Backend::clear_region(&mut backend, ClearType::All)`, `backend.sync_ok = false`, then `drop(backend)` and read `written`. `Cell::default()` with `set_char`. A pane replay is `crate::pane::Pane::new(1, "m", "a", cols, rows)` + `pane.feed(&written)`. The tests below use only these.
- `main.rs` is a single loop; `need_draw` and `last_draw` are locals declared at `main.rs:503-506`; the draw block is `main.rs:599-628`. `redraw_all` is a field consumed (`mem::take`) in the pass that sees it, *before* the frame-budget check, so today a deferred frame loses its repaint request (it is not lost only because the clear already happened).

---

### Task 1: A hard clear inside the frame's synchronized update, in the same pass

**Files:**
- Modify: `tui/src/term_out.rs:622-632` (`clear`'s sibling `clear_region`, ~`:623-631`), frame writer line `:569`; `tui/src/main.rs:420` (startup clear) and the loop at `:595-599`
- Test: `tui/src/term_out.rs` tests (module `tests`, starts `:645`; next to `:664-691`)

**Interfaces:**
- Produces: `TmuxBackend::begin_sync(&mut self) -> io::Result<()>` (opens `?2026h` once, sets `syncing`) used by `clear_region` (both its hard and its soft branch) and by the frame writer at `:569`.
- Produces in `main.rs`: a local `repaint_due: bool` (declared next to `need_draw`) that carries a repaint request from the pass that sees it to the pass that draws.

- [ ] **Step 1: Failing tests** (in `term_out.rs`'s `mod tests`; no `ratatui::Terminal`, see Facts)

```rust
fn two_cells(backend: &mut TmuxBackend<&mut Vec<u8>>) {
    let (mut a, mut b) = (Cell::default(), Cell::default());
    a.set_char('a'); b.set_char('b');
    backend.draw([(0u16, 0u16, &a), (1, 0, &b)].into_iter()).unwrap();
}

#[test]
fn a_hard_clear_is_inside_the_frames_synchronized_update() {
    let mut written = Vec::new();
    let mut backend = TmuxBackend::with_sync(&mut written);
    two_cells(&mut backend);
    Backend::flush(&mut backend).unwrap();
    // What `Terminal::clear` asks of the backend, then the frame that follows it.
    Backend::clear_region(&mut backend, ClearType::All).unwrap();
    two_cells(&mut backend);
    Backend::flush(&mut backend).unwrap();
    drop(backend);
    let s = String::from_utf8_lossy(&written);
    let clear = s.find("\x1b[2J").expect("a hard clear");
    let open = s[..clear].rfind("\x1b[?2026h").expect("opened before the clear");
    assert!(s[..clear].rfind("\x1b[?2026l").map_or(true, |close| close < open), "no close between open and clear: {s:?}");
    assert!(s[clear..].contains("\x1b[?2026l"), "closed after the redraw: {s:?}");
    assert_eq!(s.matches("\x1b[?2026h").count(), s.matches("\x1b[?2026l").count(), "balanced: {s:?}");
    assert_eq!(s[clear..].matches("\x1b[?2026h").count(), 0, "the frame joins the clear's update, it does not open another: {s:?}");
}

#[test]
fn a_hard_clear_without_synchronized_output_writes_no_2026() {
    let mut written = Vec::new();
    let mut backend = TmuxBackend::with_sync(&mut written);
    backend.sync_ok = false;
    Backend::clear_region(&mut backend, ClearType::All).unwrap();
    two_cells(&mut backend);
    Backend::flush(&mut backend).unwrap();
    drop(backend);
    let s = String::from_utf8_lossy(&written);
    assert!(s.contains("\x1b[2J") && !s.contains("2026"), "{s:?}");
}
```
(Do not run these through `ratatui::Terminal`; its size query needs a real tty. The `main.rs` side, `repaint_due`, has no unit test of its own: Task 4's byte-stream journey covers it.)

- [ ] **Step 2: Run** — `cd tui && cargo test --locked a_hard_clear` → FAIL (`\e[2J` is written with no `?2026h` before it).
- [ ] **Step 3: Implement**

```rust
fn begin_sync(&mut self) -> io::Result<()> {
    if self.sync_ok && !self.syncing { self.inner.write_all(b"\x1b[?2026h")?; self.syncing = true }
    Ok(())
}
```
`clear_region(ClearType::All)` calls `self.begin_sync()?` first, before the soft/hard branch (so the soft path's `\e[1;1H` from `Terminal::clear`'s `set_cursor_position` is inside the update too; the draw that follows always has cells, so the update would have been opened anyway). The frame writer's `:569` line becomes `if cells.len() > 1 || !whole.is_empty() { self.begin_sync()? }`. The update is closed by `Backend::flush`, which `Terminal::draw` always calls, so every `clear_region` must be followed by a draw in the same pass (below). Two callers are not: `main.rs:420` (startup) must end `term.clear()?;` with `ratatui::backend::Backend::flush(term.backend_mut())?;` (full path: with `std::io::Write` in scope, `.flush()` would be `Write::flush`, which does not close `?2026`); the suspend path (`main.rs:582`) builds a fresh `Terminal` and does not clear, so it needs nothing.

In `main.rs`, the repaint request survives until the pass that draws, and the clear moves into the draw pass:

```rust
// beside `let mut need_draw = true;` (main.rs:505)
let mut repaint_due = false;
// ... in the loop, replacing main.rs:595-598:
let settle = app::scroll_settle_in(app.scrolled_at, Instant::now()) == Some(Duration::ZERO);
if settle { app.scrolled_at = None }
// Two requests in one pass (or a request that waited for the frame budget) are one repaint.
if std::mem::take(&mut app.redraw_all) || settle { repaint_due = true; need_draw = true }
if need_draw && last_draw.elapsed() >= frame_budget {
    let repaint = std::mem::take(&mut repaint_due);
    if repaint && !size_changed {            // Task 2: size_changed is computed here
        term.backend_mut().soft_clear_next();
        term.clear()?;
    }
    ... the existing draw ...
}
```
A `redraw_all` that is set while `ui::draw` runs is picked up by the next pass, as today.
- [ ] **Step 4: Run** — `cargo test --locked term_out` → PASS
- [ ] **Step 5: Commit** — `git commit -am "hn: a full repaint's clear is in the same synchronized update as its frame"`

### Task 2: Full repaints are soft unless the size changed

**Files:**
- Modify: `tui/src/main.rs` (`let mut drawn_size = term.size()?;` after the startup `term.clear()` at `:420`; compute `size_changed` in the draw block; update `drawn_size` after `term.draw`), `tui/src/term_out.rs` (the pure decision fn)
- Unchanged: `tui/src/input.rs:42` (Resize keeps setting `redraw_all`)
- Test: `tui/src/term_out.rs` tests

**Decision fn** (`term_out.rs`, `pub fn repaint_is_soft(drawn: Size, now: Size) -> bool { drawn == now }`, `ratatui::layout::Size`).

- [ ] **Step 1: Failing tests**

```rust
#[test]
fn a_repaint_is_soft_unless_the_size_changed() {
    use ratatui::layout::Size;
    assert!(repaint_is_soft(Size::new(80, 24), Size::new(80, 24)));
    assert!(!repaint_is_soft(Size::new(80, 24), Size::new(100, 24)));
    assert!(!repaint_is_soft(Size::new(80, 24), Size::new(80, 20)));
}

#[test]
fn a_soft_clear_erases_each_row_once_inside_one_update_and_never_the_screen() {
    let mut written = Vec::new();
    let mut backend = TmuxBackend::with_sync(&mut written);
    let mut cells = Vec::new();
    for y in 0..3u16 { let mut c = Cell::default(); c.set_char('x'); cells.push((0u16, y, c)) }
    backend.draw(cells.iter().map(|(x, y, c)| (*x, *y, c))).unwrap();
    Backend::flush(&mut backend).unwrap();
    backend.soft_clear_next();
    Backend::clear_region(&mut backend, ClearType::All).unwrap();
    backend.draw(cells.iter().map(|(x, y, c)| (*x, *y, c))).unwrap();
    Backend::flush(&mut backend).unwrap();
    drop(backend);
    let s = String::from_utf8_lossy(&written);
    assert!(!s.contains("\x1b[2J"), "{s:?}");
    // (the size query fails or answers for the developer's own window here, so: at least the three rows drawn)
    assert!(s.matches("\x1b[2K").count() >= 3, "{s:?}");
    assert_eq!(s.matches("\x1b[?2026h").count(), 2, "one update per frame: {s:?}");
    assert_eq!(s.matches("\x1b[?2026l").count(), 2, "{s:?}");
}
```
(The soft clear's existing test `a_soft_clear_writes_every_row_over_the_screen_without_erasing_it`, `:665`, already covers the replay on a stale cell; keep it unchanged. A size change cannot be faked through the backend: it comes from ratatui's `autoresize`, which Task 4's fixture covers by resizing the outer window.)
- [ ] **Step 2: Run** — `cargo test --locked repaint_is_soft` → FAIL (does not compile: no such fn)
- [ ] **Step 3: Implement** — in the draw block: `let size_changed = !term_out::repaint_is_soft(drawn_size, term.size()?);` before the `if repaint && !size_changed` of Task 1; after `term.draw(..)`: `drawn_size = term.size()?;` (ratatui already asks for the size on every draw, so this adds no new cost class). When `size_changed`, `main.rs` does *not* call `term.clear()`: `Terminal::draw`'s own `autoresize` hard-clears and resets the back buffer, and with Task 1's `begin_sync` that clear is inside the frame's update (an explicit second clear would only write a second `\e[2J`). `soft_clear_next()` must not be armed in that case (it would turn the autoresize clear soft and leave text outside the new rows).
- [ ] **Step 4: Run** — `cargo test --locked term_out && cargo check --locked` → PASS (the full `cargo test --locked` is Task 4's gate)
- [ ] **Step 5: Commit** — `git commit -am "hn: a repaint without a size change rewrites rows instead of erasing the screen"`

### Task 3: One settle repaint after any overlay closes or a burst of cell updates

**Files:**
- Modify: `tui/src/app.rs:100-106` (keep `SCROLL_SETTLE` and `scroll_settle_in`; add `SETTLE_CELLS: usize = 400` and `pub fn settle_due(..)` next to them; the field stays `scrolled_at` (`app.rs:497`), its meaning widened in its doc comment: "when the next settle repaint was last owed"), `tui/src/term_out.rs` (field `last_cells: usize`, set in `draw`; `pub fn last_cells(&self) -> usize`; the constructor `:172` gains `last_cells: 0`), `tui/src/main.rs:508-` (loop locals and the post-draw block)
- No rename: the plan's earlier `settle_in` / `settle_at` rename only touches `app.rs:104-105`, `:497`, `:1008`, `input.rs:36`, `main.rs:518,595-596` and the test `:6536-6547` for no behaviour; it is dropped to keep this task's footprint small.
- Test: `tui/src/app.rs` (`mod scroll_settle_tests`, `:6533`; the existing `the_screen_is_written_whole_once_the_wheel_has_rested` at `:6536` stays unchanged), `tui/src/term_out.rs` (`last_cells`)

**Design (fits the real loop):**
- `overlay_now = app.modal.is_some() || app.toast.is_some()` (`app.rs:472-473`) is read right after `term.draw`; `overlay_before` is a loop local holding the last frame's value (`let mut overlay_before = false;` beside `need_draw`).
- `last_cells()` is `cells.len()` of the frame, after the extras merge and before the `cells.is_empty() && !all` early return (`term_out.rs:552`); the early return leaves it 0 (set `self.last_cells = 0` before returning).
- A frame that was itself a repaint writes the whole screen cell by cell, which is over `SETTLE_CELLS`: it must count as 0, or every settle repaint would owe another one and an idle hn would repaint every 250 ms forever. The post-draw code therefore passes `0` for a frame whose `repaint` flag (Task 1) was set.
- A picker list that shrinks while the same modal stays open is *not* an "overlay gone" in this test (`Option<Modal>` is `Some` before and after); it is covered only when that frame wrote more than `SETTLE_CELLS` cells. (If the New Harness list must be covered even for a small shrink, `settle_due` would need the modal's rectangle area instead of a bool; that is a design choice for the owner, not made here.)

- [ ] **Step 1: Failing tests** (in `app.rs` `mod scroll_settle_tests`, which has `use super::*;`)

```rust
#[test]
fn a_closed_overlay_or_a_large_cell_by_cell_frame_owes_one_settle_repaint() {
    let t0 = Instant::now();
    assert_eq!(settle_due(false, true, 10, None, t0), Some(t0), "an overlay closed");
    assert_eq!(settle_due(true, true, 10, None, t0), None, "still open");
    assert_eq!(settle_due(false, false, SETTLE_CELLS + 1, None, t0), Some(t0), "many cells one by one");
    assert_eq!(settle_due(false, false, 3, None, t0), None, "a key echo");
    let earlier = t0 - Duration::from_millis(100);
    assert_eq!(settle_due(false, true, 10, Some(earlier), t0), Some(t0), "a new burst pushes it later");
    assert_eq!(settle_due(false, false, 3, Some(earlier), t0), Some(earlier), "a quiet frame leaves what is owed as it was");
}
```
`pub fn settle_due(overlay_now: bool, overlay_before: bool, cells: usize, owed_since: Option<Instant>, now: Instant) -> Option<Instant>`: `Some(now)` when `(overlay_before && !overlay_now) || cells > SETTLE_CELLS`, else `owed_since`.

`term_out.rs` test for `last_cells` (direct backend, as in Task 1): draw three cells → `backend.last_cells() == 3`; draw an unchanged frame (no cells) → `0`.
- [ ] **Step 2: Run** — `cargo test --locked settle_due` → FAIL (does not compile)
- [ ] **Step 3: Implement** — after `let done = term.draw(..)?;` (`main.rs:~607`) and `drawn_size = ..` (Task 2):

```rust
let overlay_now = app.modal.is_some() || app.toast.is_some();
let cells = if repaint { 0 } else { term.backend().last_cells() };
app.scrolled_at = app::settle_due(overlay_now, overlay_before, cells, app.scrolled_at, Instant::now());
overlay_before = overlay_now;
```
The existing settle branch (`scroll_settle_in(app.scrolled_at, ..) == Some(ZERO)` → `repaint_due`, Task 1) and the `wait.min(d)` at `main.rs:518` are unchanged: an owed settle already shortens the loop's wait, and `scrolled_at = None` is set when it fires, so a settle repaint runs once per burst and an idle hn owes nothing.
- [ ] **Step 4: Run** — `cargo test --locked settle && cargo test --locked term_out` → PASS
- [ ] **Step 5: Commit** — `git commit -am "hn: one quiet rewrite after an overlay closes or a large update, as after a scroll"`

### Task 3b: Never trust where the terminal's cursor was left between frames

**Why:** the writer keeps the cursor position across frames and skips the cursor move when it thinks the cursor is already there (`term_out.rs:575-582` and `set_cursor_position` `:614-621`; comment "an ordinary echoed key needs neither a CUP before it nor one after it"). Anything that moves the terminal's cursor outside hn — an input method composing text (the user types Vietnamese with an IME), a terminal's own overlay, a stray write — makes the next cells land in the wrong place until that area is rewritten, which is exactly what a mouse selection does. Terminal-neutral.

**Files:** Modify `tui/src/term_out.rs` (`Backend::draw`); Test: `tui/src/term_out.rs` tests.

- [ ] **Step 1: Failing test**

```rust
#[test]
fn each_frame_places_the_cursor_itself() {
    let mut written = Vec::new();
    let mut backend = TmuxBackend::with_sync(&mut written);
    let (mut a, mut b, mut c) = (Cell::default(), Cell::default(), Cell::default());
    a.set_char('a'); b.set_char('b'); c.set_char('c');
    backend.draw([(0u16, 0u16, &a), (1, 0, &b)].into_iter()).unwrap();
    Backend::flush(&mut backend).unwrap();
    // The next frame changes only the cell right after the cursor hn left (column 2).
    backend.draw(std::iter::once((2u16, 0u16, &c))).unwrap();
    Backend::flush(&mut backend).unwrap();
    drop(backend);
    let s = String::from_utf8_lossy(&written);
    assert!(s.contains("\x1b[1;3H"), "the second frame moved the cursor first: {s:?}");
}
```
(Today the second frame has no `\e[1;3H`: `cursor_at` is already `(2, 0)`.)
- [ ] **Step 2: Run** — `cargo test --locked each_frame_places` → FAIL
- [ ] **Step 3: Implement** — in `Backend::draw`, immediately *after* the `if cells.is_empty() && !all { return Ok(()) }` early return (`term_out.rs:554`), set `self.cursor_at = None;`. Not at the top of `draw`: an idle frame must stay silent (ratatui calls `draw`, then `set_cursor_position`, every frame; clearing `cursor_at` before the early return would make every idle frame write a CUP — contradicting the Global Constraint "idle writes nothing"). One CUP per frame that writes cells, a few bytes; the skipping of CUPs *within* a frame stays.
- [ ] **Step 4: Run** — `cargo test --locked term_out` → the existing `plain_echo_keeps_the_printed_cursor_and_needs_few_bytes` (`term_out.rs:730`) now fails: it allows 7 bytes for one echoed key, and the echo's frame writes a 6-byte CUP of its own on top of the 6-byte one from `set_cursor_position(2, 1)` in the test. Update that test's expectation, not its intent: change `<= 7` to `<= 13` and its message to "one echoed key wrote {} bytes: its initial cursor, the frame's own CUP and the char" (keep its replay assertions). Search `term_out.rs` tests for other CUP-less assertions (`grep -n "echo" tui/src/term_out.rs`: only this one). Also re-run `cargo test --locked` once at Task 4's gate (the `pane`/`ui` tests replay frames).
- [ ] **Step 5: Commit** — `git commit -am "hn: each frame places the cursor itself, whatever moved it in between"`

### Task 3c: The shell picker's own renderer

**Files:** Modify `tui/src/term_out.rs:44` (`fn risky` becomes `pub(crate) fn risky`), `tui/src/shell_picker.rs:300-309` (`render_diff`); Test: `tui/src/shell_picker.rs` tests (next to `repainting_the_same_frame_does_not_erase_or_retransmit_the_list`, `:826`).

The picker writes through ratatui's plain `CrosstermBackend` (`render_diff`), not `TmuxBackend`, so the writer's risky-row rule does not apply to the inline composer. Rewrite a row whole when it holds a risky symbol, with the same `term_out::risky` rule, so the inline composer gets #592's protection too.

- [ ] **Step 1: Failing test**

```rust
#[test]
fn a_row_with_a_risky_symbol_is_erased_and_written_whole() {
    let area = Rect::new(0, 4, 20, 3);
    let mut first = Buffer::empty(area);
    first.set_string(0, 4, "plain", Style::default());
    first.set_string(0, 5, "go ⚡ now", Style::default());
    let mut next = first.clone();
    next.set_string(8, 5, "x", Style::default()); // a one-cell change on the risky row
    next.set_string(8, 4, "y", Style::default()); // and on a plain row
    let bytes = render_diff(Some(&first), &next, Position::new(0, 4)).unwrap();
    let s = String::from_utf8_lossy(&bytes);
    assert_eq!(s.matches("\x1b[2K").count(), 1, "only the risky row is erased: {s:?}");
    assert!(s.contains("\x1b[6;1H\x1b[2K"), "row 5 (screen row 6) is erased from its first column: {s:?}");
}
```
(`Style`, `Position`, `Buffer`, `Rect` are the imports the neighbouring tests use; add `use ratatui::style::Style;` in the test if the module lacks it. The existing test at `:826` asserts a plain navigation writes no `\e[2K`; it must keep passing: its rows hold no risky symbol.)
- [ ] **Step 2: Run** — `cargo test --locked a_row_with_a_risky_symbol` → FAIL
- [ ] **Step 3: Implement** — in `render_diff`: `let cells = previous.diff(next);` collect `risky_rows: BTreeSet<u16>` = the rows `y` of those cells for which any cell of `previous` or `next` in row `y` (x over `area.x..area.right()`) satisfies `term_out::risky(cell.symbol())`. Draw `cells` whose `y` is not in `risky_rows` as today. Then for each risky row write `\x1b[{y+1};1H\x1b[2K` and draw that row of `Buffer::empty(next.area).diff(next)` (the non-blank cells of the row; the erase already blanked the rest). The picker's rectangle starts at column 0 and spans the terminal width (`Rect::new(0, top, cols, height)`, `shell_picker.rs:264`), so `\e[2K` stays inside it. Everything stays between the `?2026h` and `?2026l` the function already writes.
- [ ] **Step 4: Run** — `cargo test --locked shell_picker` → PASS
- [ ] **Step 5: Commit** — `git commit -am "hn: the inline composer rewrites rows that hold risky symbols whole"`

### Task 4: The byte-stream fixture

**Files:**
- Modify: `tui/tests/repaint.py` (it already starts hn inside an outer tmux session `view` against `mock-daemon.mjs`, with helpers `outer()`, `hn()`, `wait()`, `screen()`; add a journey in the same file)

- [ ] **Step 1: Add the journey** — capture what hn writes with the outer tmux's `pipe-pane`, not `script`: after `started = True`, `outer('pipe-pane', '-t', 'view', f'cat >> {BASE}/raw.bin')` (the program's raw output, `?2026` included), and start hn with `HARNESS_TUI_VERIFY={BASE}/verify.log` added to `ENV`. Drive it with `outer('send-keys', ...)`: focus-in as `send-keys -H 1b 5b 49`, a resize with `outer('resize-window', '-t', 'view', '-x', '100', '-y', '30')` and back, Ctrl-L in a picker, command panel open/close, New Harness open/type/20×Backspace/close. Assert on `raw.bin`: `?2026h`/`?2026l` balanced and never nested; every `\x1b[2J` is between an open and its close; after the command panel closes, within 400 ms, one soft repaint (a `\x1b[2K` for every row) is written; `verify.log` has no line matching `=== .* [1-9][0-9]* cells differ` (a requested dump writes a `=== … 0 cells differ` header, which is fine). `scratchpad/stale.py` is outside the repo (the investigation's setup); the journey does not depend on it.
- [ ] **Step 2: Run** — `cd tui && python3 tests/repaint.py` (needs `cargo build --release --locked` first: it copies `tui/target/release/harness-tui`) → FAIL before Tasks 1-3 (`\x1b[2J` outside), PASS after.
- [ ] **Step 3: Full gate** — `cd tui && cargo test --locked && cargo build --release --locked && cd .. && python3 scripts/validate-tui-native.py tui/target/release/harness-tui`
- [ ] **Step 4: Commit** — `git commit -am "hn: repaint fixture checks synchronized clears and the settle rewrite"`

### Task 5: Check by hand on every terminal at hand

- [ ] With the build in an isolated hn (mock daemon, own sockets), in each of Ghostty, Terminal.app, Warp and Cursor's terminal, and once with `HARNESS_TUI_SYNC=off` in Ghostty: switch away and back (focus), resize, open and close the command panel, type and delete in New Harness, close a tab via Close Tab, scroll a pane. No blank flash; no text left after a panel closes (wait ½ s for the settle rewrite).
- [ ] Then the user's own hn, run for normal work with `HARNESS_TUI_VERIFY=/tmp/hn-verify.log`. If stale text still appears anywhere: a selection starting writes a dump (`main.rs:602-606`, `dump_now("a selection started")`); "0 cells differ" means the terminal drew correct bytes wrongly — shorten the settle delay or widen what triggers it (still terminal-neutral), and report it to that terminal's project with the captured bytes.

## Conflicts between the tasks

| Pair / task | Shared file or interface | Resolution |
|---|---|---|
| 1 and 2 | `main.rs` draw block, `clear_region` | 1 owns `repaint_due` and the soft/clear call; 2 only supplies `size_changed`. Land 1, then 2 (2's `if repaint && !size_changed` is written in 1's snippet). |
| 1 and 3 | `main.rs` settle lines, `scrolled_at` | 3 reads the `repaint` flag that 1 introduces (a repaint frame counts 0 cells); 3 depends on 1. |
| 1 and 3b | `term_out.rs` `draw`, `cursor_at` | independent code, same function: 3b's reset goes after the early return; 1's `begin_sync` is the `:569` line. Order free. |
| 2 and 3 | `main.rs` post-draw block | both add one statement after `term.draw`; 2: `drawn_size`, 3: `settle_due`. Order free. |
| 3b and the echo contract | test `plain_echo_keeps_the_printed_cursor_and_needs_few_bytes` | 3b makes it fail by design; Step 4 raises its byte bound (the extra CUP per cell-writing frame is the plan's stated cost: "one CUP per frame, a few bytes"). |
| 3c and 1-3b | `term_out.rs` | 3c only changes `fn risky` visibility. No conflict. |
| 4 | the whole stream | needs 1-3 built; asserts nothing 3b/3c-specific. |

| Task | Do its tests match its code? |
|---|---|
| 1 | yes: backend-level tests (no `ratatui::Terminal`); main.rs part covered by 4 |
| 2 | yes: pure-fn test plus a three-row soft clear; resize path covered by 4 |
| 3 | yes: `settle_due` and `last_cells` tests; loop wiring covered by 4 |
| 3b | yes after Step 4's change to the one echo test |
| 3c | yes |
| 4 | yes: uses the file's existing outer-tmux harness |

Global Constraints check: nothing reads a terminal's name; idle writes nothing (3b's reset is after the early return, repaint frames count 0 cells in 3, the settle fires once per burst); `HARNESS_TUI_SYNC=off` keeps `begin_sync` a no-op (second test in Task 1); soft clear still erases empty rows (untouched code, `term_out.rs:584-586`).

## Overlaps with other plans of 2026-10-07 (not edited here)

- 003 (confirm dialog): `ui.rs` (`menu`, `:304-350`) and a `mod` line in `main.rs`. This plan touches `main.rs`'s loop and not `ui.rs`; no code overlap.
- 004 (shell composer freeze): `shell_picker.rs` loop `:480-500` and `:612-627`; this plan's Task 3c edits `render_diff` `:300-309` and tests near `:826`. Same file, different regions; the tests region `:819-840` is shared (add, do not reorder).
- 006 (pane drag and drop): `ui.rs:231-232`, a `mod` line in `main.rs`, and it sets `app.redraw_all = true` on release (relies on this plan for stale-cell safety; with Task 1 that is a soft repaint, which is what it needs).
- 007 (composer dropdown): `shell_picker.rs` (`:653-662`) and `ui.rs` `inline_fzf`; `render_diff` draws what `inline_fzf` produces: 3c's risky-row rule applies to the new dropdown rows unchanged.
- 008: no overlap found.
