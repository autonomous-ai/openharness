# One button row for every dialog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every hn dialog that asks a question shows its answers as `[ Label ]` buttons on one row, drawn and driven by one shared component: ← → / Tab choose, Enter runs, Esc cancels, the dialog's letter keys still work, a click runs the button under it.

**Architecture:** A new module `tui/src/buttons.rs` owns the row: layout (right-aligned, two columns apart), drawing (theme styles from `settings::chrome()`), keys and clicks. Five dialogs that each draw their own buttons today move onto it. tmux's own `confirm-before` (`kill-pane #P? (y/n)` in the status line) stays as tmux has it — it is tmux behaviour, not an hn dialog.

**Tech Stack:** Rust (ratatui), Python native fixtures.

**Spec:** user 2026-10-07: "I want close tab on one row, pressing left/right" (screenshot of `Close Tab · zsh` with `Cancel (Escape)` / `Stop (s)` on two rows), then: "Some places don't use the same buttons, like Connect machine … can't they be the same as the dialog we'll build, with the `[ ]` style, and usable with the keyboard?"

## Today: five dialogs, four looks

| Dialog | Code | Buttons | ← → | Chosen button |
|---|---|---|---|---|
| Close Tab / Stop Harness | `session_close.rs:154-177` (a vertical `workspace_menu`) | `Cancel (Escape)` / `Stop (s)`, one per row | no | `menu-selected-style` row |
| Machines: Connect / Prevent new links | `devices.rs:1382-1394` (`prompt_actions`), keys `:870-892` (`answer_key`), clicks `:819-835` (`mouse`) | ` Yes ` ` Cancel ` (or ` Continue `/` Next `) + muted `y/n` | no | filled `selected` band |
| Files: Open dialog | `files/dialog.rs:424-431` (`buttons`), keys `:311-318` (`button_key`; Tab/Esc are taken earlier at `:276-281`) | `[ Cancel ] [ Open ]` | yes (Left/Right only) | bold + underline when it has focus; Open bold otherwise |
| Files: Delete confirm | `files.rs:1190-1205` (`confirm_layout`), keys `:810-820` (`confirm_key`), clicks `:853-855` | `[ Delete ] [ Cancel ]`, starts on Delete (Trash) or Cancel (Purge) | yes (also Tab, h, l) | `look.mode` |
| Editor: Save changes? | `files/editor.rs:536-549` (`ask_layout`), keys `:389-399` (`ask_key`) | `[ Save ] [ Don't save ] [ Cancel ]` | yes (Left/Right/Tab/BackTab) | `look.mode` |

## Controller rulings (2026-10-07, after the plan check) — these OVERRIDE the task text below where they differ

1. **Close Tab box colours:** a workspace menu that has a button row is filled with `chrome().base` (its border in `chrome().muted`), so the box and its buttons match; tmux `display-menu` and the vertical Pane/Tab/Harness menus keep `menu-style`.
2. **Narrow Machines panel (24 columns, `devices.rs:1808` test):** the keys hint is dropped first when it does not fit; the buttons must still fit. If `[ Cancel ]  [ Yes ]` cannot fit at 24 columns, raise that test's minimum width by 2 and say so in the commit — never overlap or clip a button.
3. **Keys:** each dialog keeps Tab where it already means something else (the Open dialog's regions; Entry prompts keep letters for typing). ← → always move between buttons when the buttons have the keys.
4. **Delete defaults to Cancel** (risky action): accepted behaviour change; rewrite the old `files.rs` tests that pressed Enter on Delete to press Right (or `d`/the action key) first.

## Global Constraints

- **One look, no custom style:** `[ Label ]`; the chosen button in `chrome().selected` (bold on the lifted band — the command panel's chosen row); the others in `chrome().base`; a muted keys hint at the row's left (`s stop · esc cancel`). No fixed colours. `NO_COLOR`: the chosen button reversed (`chrome()` already does this).
- **One order:** the way out (Cancel / Don't save) first, the action last, right-aligned — `[ Cancel ]  [ Stop ]`, `[ Don't save ]  [ Cancel ]  [ Save ]`, `[ Cancel ]  [ Delete ]`, `[ Cancel ]  [ Yes ]`.
- **One default:** a destructive action (Stop, Delete, Delete Permanently, Prevent new links) starts on Cancel; a safe one (Open, Save, Continue, Connect) starts on the action. The Close Tab tests require Cancel by default (`session_close.rs:417-429, 514`).
- **Same keys everywhere:** ← → Tab Shift-Tab (and h / l) move, wrapping; Enter runs the chosen; Esc, C-c, C-g cancel; each dialog keeps its letters (`s` stop, `y`/`n`, the files' `q`/`n`).
- Copy unchanged except `Cancel (Escape)` → `[ Cancel ]` and the order above. Follow `docs/naming-system.md`.
- tmux `display-menu`, `confirm-before` and the vertical Harness / Pane / Tab menus do not change.

## Target look

```
┌Close Tab · zsh──────────────────────────────────┐
  The terminal and its running commands will end.
  Stop? Saved history will remain.

  s stop · esc cancel        [ Cancel ]  [ Stop ]
└─────────────────────────────────────────────────┘
```

## Review Focus

- A dialog narrower than its buttons: the hint goes first, then the row is refused with the existing "Make the terminal larger" message (workspace menus) or clipped the way that dialog clips today — never overlapping buttons.
- A click between two buttons, or on the hint, runs nothing.
- Resize while a dialog is open keeps the chosen button.
- A failed stop shows only `[ Back ]`: one button, chosen, Enter runs it.
- The Machines dialog's password prompt (paste-protected, `tui/tests/workspace-controls.py:226-248`) keeps its input focus: while the input has the keys, typing, Backspace, Enter (continue) and Esc work as today and ← → move the caret in the input; Tab moves the keys to the buttons, then ← → move between the buttons and Enter runs one; Tab again, or typing a printable key, returns to the input. A pasted `y`/`n` is never a button letter (paste is never a yes).
- Enter on a chosen `[ Cancel ]` in an Entry prompt cancels (it does not submit the typed value).

---

### Task 1: The shared component `buttons.rs`

**Files:**
- Create: `tui/src/buttons.rs` (add `mod buttons;` to `tui/src/main.rs` beside `mod workspace_menu;` at `:44`)
- Test: `tui/src/buttons.rs` tests

The dialogs hand it keys of two types: devices/menus have a crossterm `KeyEvent`, the files UI has its own `crate::keys::Chord { code, mods }` (`config.rs:46`). So `Row::key` takes `(KeyCode, KeyModifiers)`; callers pass `k.code, k.mods` (a `KeyEvent` has `.code`/`.modifiers`, a `Chord` has `.code`/`.mods`).

**Interfaces:**
- Produces:
```rust
use crossterm::event::{KeyCode, KeyModifiers};
use ratatui::buffer::Buffer;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Button { pub label: String, pub key: Option<char> }   // key: the dialog's letter (s, y, d…)
#[derive(Clone, Debug)]
pub struct Row { pub buttons: Vec<Button>, pub chosen: usize, pub hint: String }
pub enum Answer { Chosen(usize), Cancel, Moved, Ignored }
impl Row {
    /// Total columns the row needs (hint + buttons), for a dialog's width.
    pub fn width(&self) -> u16;
    /// Each button's columns on a row whose right edge is [right]: (index, x, width).
    pub fn cells(&self, right: u16) -> Vec<(usize, u16, u16)>;
    /// Draws the hint at [left] and the buttons right-aligned to [right] on row [y].
    pub fn draw(&self, buf: &mut Buffer, left: u16, right: u16, y: u16, c: &crate::settings::Chrome);
    /// A key: ← → Tab BackTab h l move (wrapping; h / l only when no button owns that letter, and
    /// only without Ctrl/Alt); Enter → Chosen(chosen); Esc, Ctrl-C, Ctrl-G → Cancel;
    /// a button's letter (no Ctrl/Alt) → Chosen(that). Dialogs that use Tab for something else
    /// (the Open dialog) filter Tab/BackTab/Esc before calling.
    pub fn key(&mut self, code: KeyCode, mods: KeyModifiers) -> Answer;
    /// A click at (x, y) on a row drawn at [y_row] with right edge [right].
    pub fn click(&self, x: u16, y: u16, right: u16, y_row: u16) -> Option<usize>;
}
```

- [ ] **Step 1: Failing tests**

```rust
use super::*;
use ratatui::{layout::Rect, style::Modifier};

fn row() -> Row { Row { buttons: vec![Button { label: "Cancel".into(), key: None }, Button { label: "Stop".into(), key: Some('s') }], chosen: 0, hint: "s stop · esc cancel".into() } }

#[test]
fn buttons_sit_right_aligned_two_columns_apart() {
    let cells = row().cells(50);
    assert_eq!(cells, vec![(0, 50 - 8 - 2 - 10, 10), (1, 50 - 8, 8)]);   // "[ Cancel ]" 10, "[ Stop ]" 8
}

#[test]
fn keys_move_wrap_choose_and_cancel() {
    let mut r = row();
    let k = |r: &mut Row, c| r.key(c, KeyModifiers::NONE);
    assert!(matches!(k(&mut r, KeyCode::Right), Answer::Moved)); assert_eq!(r.chosen, 1);
    assert!(matches!(k(&mut r, KeyCode::Right), Answer::Moved)); assert_eq!(r.chosen, 0, "wraps");
    assert!(matches!(k(&mut r, KeyCode::BackTab), Answer::Moved)); assert_eq!(r.chosen, 1);
    assert!(matches!(k(&mut r, KeyCode::Enter), Answer::Chosen(1)));
    assert!(matches!(k(&mut r, KeyCode::Char('s')), Answer::Chosen(1)));
    assert!(matches!(k(&mut r, KeyCode::Esc), Answer::Cancel));
    assert!(matches!(r.key(KeyCode::Char('c'), KeyModifiers::CONTROL), Answer::Cancel));
    assert!(matches!(k(&mut r, KeyCode::Char('x')), Answer::Ignored));
}

#[test]
fn the_chosen_button_is_the_panels_chosen_row() {
    if crate::theme::no_color() { return }   // NO_COLOR: `selected` is REVERSED, with no bg to compare
    let c = crate::settings::chrome();
    let mut buf = Buffer::empty(Rect::new(0, 0, 50, 1));
    let mut r = row(); r.chosen = 1;
    r.draw(&mut buf, 0, 50, 0, &c);
    let (_, x, _) = r.cells(50)[1];
    assert_eq!(buf[(x, 0)].symbol(), "[");
    assert_eq!(buf[(x + 2, 0)].bg, c.selected.bg.unwrap());
    assert!(buf[(x + 2, 0)].modifier.contains(Modifier::BOLD));
    let (_, x0, _) = r.cells(50)[0];
    assert_ne!(buf[(x0 + 2, 0)].bg, c.selected.bg.unwrap());
    assert_eq!(buf[(0, 0)].fg, c.muted.fg.unwrap(), "the hint is muted");
}

#[test]
fn a_click_on_a_button_chooses_it_and_between_them_nothing() {
    let r = row(); let cells = r.cells(50);
    assert_eq!(r.click(cells[1].1 + 1, 3, 50, 3), Some(1));
    assert_eq!(r.click(cells[0].1 + cells[0].2, 3, 50, 3), None, "the gap");
    assert_eq!(r.click(cells[1].1 + 1, 2, 50, 3), None, "another row");
}
```
- [ ] **Step 2: Run** — `cd tui && cargo test --locked buttons::` → FAIL (module missing)
- [ ] **Step 3: Implement** — straightforward from the interface; `draw` fills each button's cells with its style (chosen: `c.selected`, others `c.base`, hint `c.muted`; paint via `buf.cell_mut((x, y))` as `settings::put` does), then writes `[ {label} ]`; the hint is drawn only when it fits left of the first button with 2 columns to spare. `cells(right)` saturates at 0 so a too-narrow `right` never underflows. An empty `hint` draws nothing (the Open dialog keeps its own text).
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** — `git add tui/src/buttons.rs tui/src/main.rs && git commit -m "hn: one button row for dialogs"`

### Task 2: Close Tab / Stop Harness on the button row

**Files:**
- Modify: `tui/src/modal.rs:134-153` (`Menu` gains `pub buttons: Option<crate::workspace_menu::Buttons>`). `Layout` (`workspace_menu.rs:10`) has private fields and `ui.rs` / `input.rs` only see `Menu`, so the row lives on `Menu`; `Layout` keeps its own copy for re-fitting. The only two `Menu { .. }` literals are `workspace_menu.rs:27` (`open`) and `input.rs:1976` (`prompt_menu`): add `buttons: None` to both.
- Modify: `tui/src/workspace_menu.rs`: `#[derive(Clone, Debug)] pub struct Buttons { pub row: crate::buttons::Row, pub actions: Vec<String> }` (`actions[i]` is the command button i runs; button 0 is the way out, so `actions[0]` is also what Esc runs). `Layout` gains `buttons: Option<Buttons>`. New `pub fn open_buttons(app, title, notes: Vec<MenuItem>, row: Row, actions: Vec<String>) -> bool` (like `open`, `choice: None`, items = notes only). `fit`: width also `max(row.width())` (before the `min(size.0 - 4)` clamp), height = wrapped notes + (1 blank + 1 row when buttons) + 2, the `size.1 < actions + 2` guard counts those two rows; when the row does not fit (`row.width() > width`) drop the hint first (`row.hint.clear()` on the copy in `Menu`), and if the buttons alone still do not fit return false (the existing "Make the terminal larger" path). `fit` copies `menu.buttons.row.chosen` back into the layout's row first so a resize keeps the chosen button.
- Modify: `tui/src/ui.rs:304-350` (`menu`): `h = m.items.len() as u16 + 2 + if m.buttons.is_some() { 2 } else { 0 }`; after the item loop draw the row with `Row::draw(buf, x0 + 2, x0 + 2 + m.width, y0 + 1 + items + 1, &crate::settings::chrome())` (`items = m.items.len()`; the blank row is already painted by the background fill).
- Modify: `tui/src/input.rs:1632` (`Modal::Menu(mut menu)` arm): before the existing `menu.items ... it.key == name` lookup, `if let Some(b) = menu.buttons.as_mut()`: `match b.row.key(key.code, key.modifiers)` — `Chosen(i)` runs `b.actions[i]` with `commands::execute_in(app, &cmd, menu.mouse.clone())` (as `menu_chosen` `:3533` ends), `Cancel` runs `b.actions[0]` (this replaces today's bare `return`, which left the close operation pending; `session_close::cancel` keeps a Stop in progress), `Moved` puts the menu back (`app.modal = Some(Modal::Menu(menu))`), `Ignored` falls through (so `q` and the vertical-menu keys stay harmless; notes are disabled items so nothing else is selectable).
- Modify: `tui/src/input.rs:3549-3574` (`menu_mouse`): the bounds test `m.y > py + count` must count the button rows (`count = items + 2` when `menu.buttons.is_some()`), else a click on the row closes the menu; when `m.y == py + 1 + items.len() + 1` use `Row::click(m.x, m.y, px + 2 + width, m.y)` — `Some(i)` (on a press / release as `chosen` is computed) runs `actions[i]`, `None` keeps the menu open; a click on a note row runs nothing.
- Modify: `tui/src/session_close.rs:150-152` (`showing`: `m.buttons.as_ref().is_some_and(|b| b.actions.iter().any(|a| *a == format!("close-harness -x {id}")))` — the cancel command is no longer a menu item, so the old test would never find the modal) and `:154-177` (`show`: keep the note building, drop the two `menu::item` lines and the `cancel` index; `menu::open_buttons(app, &title, items, Row { buttons: [Cancel|Back (None), Stop (Some('s')) when confirm], chosen: 0, hint: "s stop · esc cancel" when confirm else "" }, actions: [format!("close-harness -x {id}"), format!("close-harness -y {id}")])`; the hint is empty for `Back`).
- Test: `tui/src/session_close.rs` tests `:417-561` keep passing unchanged (Enter on default Cancel closes; `s` stops; Esc dismisses; `:560` `menu.items.iter().any(|i| i.label.contains("1 stopped"))` still holds because notes stay items). `tui/src/workspace_menu.rs` tests at `:99-130` use `open` and `wrap_notes` and are unchanged. New tests below.
- Fixtures: `tui/tests/workspace-controls.py:362` and `:607` `click_text('(s)')` → `click_text('[ Stop ]')`; `tui/tests/fresh-user.py:184,187` `'(s)' in self.screen()` → `'[ Stop ]' in self.screen()`. `shown('Cancel')` (`:599`) and `'Cancel' not in screen()` (`:603`) keep working: the hint reads `esc cancel` (lower case) so it never matches `Cancel`. `shell-first.py:553` only waits for the question text: unchanged.

- [ ] **Step 1: Failing tests**
  - In `session_close.rs` tests (helpers `app()`, `pane()`, `answer()`, `key()`, `modes()` already there): 
```rust
#[tokio::test]
async fn right_then_enter_stops_and_the_buttons_are_one_row_model() {
    let mut app = app();
    pane(&mut app, 1);
    answer(&mut app, "inspect", json!({"activity":"working"}));
    let Some(Modal::Menu(m)) = &app.modal else { panic!("no confirmation") };
    let b = m.buttons.as_ref().expect("a button row");
    assert_eq!(b.row.buttons.iter().map(|x| x.label.as_str()).collect::<Vec<_>>(), ["Cancel", "Stop"]);
    assert_eq!(b.row.chosen, 0, "a destructive action starts on Cancel");
    key(&mut app, KeyCode::Right);
    key(&mut app, KeyCode::Enter);
    assert_eq!(modes(&app), ["inspect", "now"]);
}
```
  - In `ui.rs` `theme_render_tests` (`:2982`; its `app()` is 150x42 and `screen(&mut app)` returns the painted text): `crate::workspace_menu::open_buttons(&mut app, "Close Tab · zsh", vec![crate::workspace_menu::note("Stop? Saved history will remain.")], row, vec!["close-harness -x x".into(), "close-harness -y x".into()])` (row = Cancel, Stop); `let s = screen(&mut app)`; the line holding `[ Cancel ]` also holds `[ Stop ]`, with Cancel to its left; `crate::input::modal_key` Right then Enter closes the modal (the commands are ignored by `session_close` as no operation `x` exists).
  - In the `input.rs` tests module (`:3577`): open the same menu, call `menu_mouse` with a left press over `[ Stop ]` (x, y from `Row::cells` and the menu's `x`/`y`) → modal closed; a press in the 2-column gap between the buttons → modal still open and nothing run.
- [ ] **Step 2: Run** → FAIL (no `buttons` field)
- [ ] **Step 3: Implement** as in *Files*.
- [ ] **Step 4: Run** — `cd tui && cargo test --locked session_close:: workspace_menu:: buttons:: theme_render_tests` (then the full suite once at Task 5) → PASS
- [ ] **Step 5: Commit** — `git commit -am "hn: Close Tab and Stop Harness ask with [ Cancel ] [ Stop ] on one row"`

### Task 3: Machines prompts on the button row

**Files:**
- Modify: `tui/src/devices.rs:1382-1394` (`prompt_actions`): build a `Row` from `app.devices.ask`: `[ Cancel ]  [ Yes ]` for `Ask::Confirm`, `[ Cancel ]  [ Continue ]` / `[ Next ]` (`w < 19`) for `Ask::Entry`; hint `y yes · n no` for a confirm only (an Entry has no letters: typing goes to the input). Keep the existing `PromptActions { size, accept, cancel }` (`:149`) and fill `cancel` / `accept` from `Row::cells(x + w)` (button 0 / button 1), so `mouse` `:819-835` and the test helper `click_prompt` (`devices.rs:1747-1752`) keep working with their rects; the clicks only need `Row::click` if you drop the rects. The chosen button is state, not drawing: add `prompt_row: Cell<usize>` (chosen index) and `prompt_focus: Cell<bool>` (keys on the buttons) to `Devices` (`:151`, constructed at `:173`), reset by the two functions that set `app.devices.ask` (`entry` `:797`, `confirm` `:802`). Defaults: a confirm for `Act::ClearPassword | Unlink | Remove | Unpair` starts on Cancel (0), for `Act::Link | SetPassword | Rename | ArmPhone` on Yes (1); an Entry starts with `prompt_focus` false and chosen = the action. Keep the "needs room" guard (`w < needed` returns) with `needed = row.width()`.
- Modify: `tui/src/devices.rs:870-892` (`answer_key`): for `Ask::Confirm`, first `Row::key(key.code, key.modifiers)` on the row (letters `y` → Yes, `n` → Cancel; keep the existing `Y` / `N` arms and the "any other key keeps the prompt" arm): `Chosen(1)` → `run_act`, `Chosen(0)` / `Cancel` → `note(app, "Nothing changed")`, `Moved` → store the chosen index and keep the ask, `Ignored` → keep the ask. For `Ask::Entry`: Tab / BackTab toggle `prompt_focus`; while it is true, ← → Enter go through `Row::key` (`Chosen(1)` = `submit` as Enter does today, `Chosen(0)` / `Cancel` = `note(app, "Nothing changed")`); while false everything is as today (typing, Backspace, Ctrl-U, Enter submits, Esc cancels), and no letter is ever a button letter. Note `answer_key` takes the ask out (`.take()`) and puts it back at the end of each arm: put it back on the new paths too.
- Test: `tui/src/devices.rs` tests: `device_confirmation_buttons_survive_resize_and_hidden_targets_do_not_run` (`:1808`) asserts `visible.contains(" Yes ") && visible.contains(" Cancel ")` → `"[ Yes ]"` and `"[ Cancel ]"`; the smallest size in its loop `(24, 10)` must still show the row — `[ Cancel ]  [ Yes ]` is 19 wide plus the panel's inset; if `w < 19` there, either raise the smallest size or assert the refusal (no row, `prompt_actions` is none) for that size only; do not weaken the other sizes. `mouse_link_requires_continue_then_explicit_yes_and_cancel_writes_nothing` (`:1773`) and `pasted_passwords_stay_masked...` (`:1788`) keep passing.
- Fixtures: `tui/tests/workspace-controls.py:248` `click_text(' Yes ')` → `click_text('[ Yes ]')`; `:257-258` `shown(' Cancel ')` / `shown(' Yes ')` → `shown('[ Cancel ]')` / `shown('[ Yes ]')`; `click_text('Continue')` (`:232, 235, 245, 247`) and `click_text('Cancel')` (`:239, 260`) still match inside the new labels.

- [ ] **Step 1: Failing test** — a Prevent-new-links prompt (`go_to(&mut app, "pw:clear"); press(&mut app, KeyCode::Enter)` as `:1821-1822`, helpers `press`, `screen`, `fake`, `has`, `clis` exist in the module): the row starts on Cancel; Left/Right move between the two buttons; Enter on Cancel closes without the request (`!has(&log, &clear)`); Right, Enter sends it (`clis(&log, "remote-password")` contains `clear` once); the drawn chosen button's cells have `chrome().selected`'s bg (read the buffer from the same `screen` helper's draw; skip the bg assert when `theme::no_color()`). A second test: in the password Entry prompt, Right does nothing to the typed value, Tab then Right/Enter on `[ Cancel ]` cancels without a request.
- [ ] **Step 2: Run** → FAIL (no ← →)
- [ ] **Step 3: Implement** as in *Files*.
- [ ] **Step 4: Run** — `cd tui && cargo test --locked devices::` and `python3 tests/workspace-controls.py` (from `tui/`, with the fixture's usual environment) → PASS
- [ ] **Step 5: Commit** — `git commit -am "hn: machines prompts use the dialog button row"`

### Task 4: Files and the editor on the button row

Buttons are always indexed in display order from now on (Cancel first, the action last). The three dialogs index their buttons by number today, so every `0` / `1` / `2` below changes with the order.

**Files:**
- Modify: `tui/src/files/dialog.rs`: `buttons()` (`:424-431`, returns `[(x, end, label); 2]`) is rebuilt on `Row::cells(self.size.0 - 2)` (Row `[Cancel, Open]`, `chosen: self.button`) and keeps its signature, so `click` and the test at `:797` (`let (ox, ..) = e.buttons()[1]`) work as they do. `button_key` (`:311-318`) becomes: build the row from `self.button`, `Row::key(k.code, k.mods)`, store `row.chosen` back to `self.button`; `Chosen(1)` → `self.open(self.target())`, `Chosen(0)` / `Cancel` → `DOut::Cancel`. Tab, BackTab, Esc, `/` and Ctrl-F are already consumed at `:276-281` before `button_key` is reached (Tab there moves focus between sidebar / columns / buttons), so they never reach `Row::key`. Drawing `:556-562`: the chosen button (`self.button`) is drawn with `chrome().selected` whether or not `focus == Focus::Buttons` (Open is the default action and is emphasised today even unfocused); the others `chrome().base`; `Row.hint` stays empty — the bottom row keeps its own `Enter open · Esc cancel · …` text drawn left of the first button at `:556-558`.
- Modify: `tui/src/files.rs`: `Confirm.focus` (`:181`, comment `:179`) now means 0 Cancel, 1 Delete / Delete Permanently. `confirm_layout` (`:1193-1209`) labels `["[ Cancel ]", "[ {yes} ]"]` (laid out left to right as today); draw `:1181-1187` `unwrap_or(0)` and uses `Row::draw`-equivalent cells; `confirm_key` (`:810-820`): the Left/Right/Tab/BackTab/h/l arm is replaced by `Row::key`, Enter → `if c.focus == 1 { self.confirmed() } else { self.confirm = None }`, and the extra cancel letters `q` and `n` (`:815`) stay as they are. `click_at` (`:853-855`): `if b == 1 { self.confirmed() } else { self.confirm = None }`. Defaults: `Act::Delete` (`:582`) `focus: 0` (Cancel — a change from today, where Trash starts on Delete), Purge (`:828`) `focus: 0` (was 1).
- Modify: `tui/src/files/editor.rs`: new order `[Don't save, Cancel, Save]`; `asking: Option<usize>` (`:87`) now holds 0 Don't save, 1 Cancel, 2 Save; the request at `:385` is `asking = Some(2)`; `ask_layout` (`:536-549`) `LABELS = ["[ Don't save ]", "[ Cancel ]", "[ Save ]"]`; `ask_key` (`:389-399`): `Row::key` (Left/BackTab/Right/Tab move as today, wrapping over 3); `Chosen(i)` → `self.answer(i)`; `Cancel` (Esc) → `asking = None`; `answer` (`:401-408`): `0 => EdOut::Close`, `1 => EdOut::None`, `2 =>` the save arm (`save()`: `Ok` → `Close`, `Err` → message). Click `:442-444` already calls `answer(b)` with the displayed index.
- Test: `files/dialog.rs` tests `:726-794` keep their text asserts (the Open dialog's order did not change); `files.rs` tests: `:2126-2134` — a Trash confirm now starts on Cancel, so the old `Delete, Right, Enter` (cancelled) becomes `Delete, Enter`, and the old `Delete, Enter` (deleted) becomes `Delete, Right, Enter`; `:2159-2170` (`what_cannot_go_to_the_trash_is_deleted_only_after_a_second_yes`): the first `Delete, Enter` becomes `Delete, Right, Enter`, `:2161` `Some((Doom::Purge(..), 1))` becomes `0`, `:2165-2168` `Delete, Enter, Left, Enter` becomes `Delete, Right, Enter, Right, Enter`; `editor.rs` `closing_with_changes_asks_first` (`:685-700`): `assert_eq!(e.asking, Some(0))` becomes `Some(2)`, the `Right, Right, Enter` = Cancel path still holds (2 -> 0 -> 1).

- [ ] **Step 1: Failing tests** — (a) Delete confirm: after `Delete`, `f.confirm` has `focus == 0` (Cancel), Right makes it 1, Enter deletes; (b) Editor: `closing_with_changes_asks_first` with the new `Some(2)` and Left (2 -> 1) = Cancel; (c) each dialog's chosen button has `chrome().selected`'s bg: draw into a `Buffer` (Editor: `e.draw(&mut buf, area, &Look::default())` as `editor.rs:716`; Open dialog: the `text(&mut d, 130, 34)` helper path; Delete confirm: the `files.rs` draw test helper) and read the cell at the chosen button's `[ x + 2 ]` from `ask_layout()` / `buttons()` / `confirm_layout(g)` (offset by the draw origin the dialog uses); skip the bg assert when `theme::no_color()`.
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** — the files' `Look` is not used for buttons any more; `settings::chrome()` is. It reads `theme::pane_palette()` (the terminal's own colours, else the default palette), so it also works when Files runs in its own process (`files::standalone`, `files.rs:1517`) — there it follows the terminal's colours, not hn's chosen theme.
- [ ] **Step 4: Run** — `cd tui && cargo test --locked files::` → PASS
- [ ] **Step 5: Commit** — `git commit -am "hn: files and editor dialogs use the dialog button row"`

### Task 5: Gate and look

- [ ] `cd tui && cargo test --locked && cargo build --release --locked && cd .. && python3 scripts/validate-tui-native.py tui/target/release/harness-tui` (composer-machine on macOS bash 3.2: known, separate).
- [ ] Isolated hn, dark and light theme and `NO_COLOR=1`: capture Close Tab, a Machines prompt, the Open dialog, Delete and Save changes? — the five button rows look the same. Check in particular the Close Tab row: its non-chosen button uses `chrome().base` over a tmux `menu-style` box, so look for a visible band mismatch on the box background.
