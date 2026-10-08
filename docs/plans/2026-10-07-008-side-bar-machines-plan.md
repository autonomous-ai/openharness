# Side bar: see and use every machine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the side bar's `machines` list, each machine shows its harnesses (not only the windows open here), a harness opens with a click, and a machine row always does something: open a window, offer a small menu, connect, or say it is offline.

**Architecture:** Only the side bar (`bar.rs`), one small menu (`machine_menu.rs`) and two small public helpers in `devices.rs`. Everything it needs exists: the account's machines and each usable machine's roster are already in `app.fleet` (`merge_roster` in `relist`, `app.rs:1457-1482`); a harness opens as a window with `open-harness -s <machine>:<agent>` (`commands.rs:3650`; `find_harness`, `commands.rs:1330`, takes `machine-id:agent-id` or `machine-name:agent-id`; a harness already open here is gone to, not opened twice, `commands.rs:3679-3682`); a machine's harness list is the Open picker filtered to it (`devices.rs:1026-1034`, the `open` arm of `machine_action`, row "Open its harnesses" at `:1174`); linking is `Machines & devices` → `Connect…` (`devices::connect_to`, `devices.rs:438`, already `pub`: it opens the Connect view with the machine chosen and asks for its remote password; the row is `:1175`); New Harness opens preset to a machine with `new_harness::open(app, Some(machine), None)` (`new_harness.rs:410`; it refuses a machine that is not `usable()`). Menus are `workspace_menu` (the Pane / Tab menus' component; items run a command string through `commands::execute`, so the menu needs one small command, `machine-menu`). No yes/no step is added, so this plan does not depend on plan 003's button row.

**Tech Stack:** Rust (ratatui), Python native fixtures.

**Spec:** user 2026-10-07: "why can't I click to connect to the other machines?" … "I see it's online, but I can't click to control it or see the harnesses on the other machines." Agreed behaviour (item 7 of the 2026-10-07 list).

## Why nothing happens today

- `machine_entries` (`bar.rs:305-331`) lists under a machine only **windows of this hn** that have a pane on it. A machine with no such window has no rows under it, so its harnesses are invisible here.
- Its row's hit is `Hit::Machine(None)`, and a click on that does nothing (`bar.rs:490`: `Hit::Machine(None) | … => {}`). Same for a machine that needs a link or is offline.
- A right press on the bar does nothing for a machine: the bar's own `mouse` (`bar.rs:518`) takes only the left press and the wheel. Right presses reach the bar's code only through `workspace_controls::mouse` (`workspace_controls.rs:132`, called first from `input.rs:~314`), whose right-press branch (`:164-170`) already maps a bar `Hit::Window` to the Tab menu; a machine row is added there.

## Controller rulings (2026-10-07, after the plan check) — these OVERRIDE the task text below where they differ

1. **Other machine states:** `Connecting` → a click says `<name> is connecting…` and opens Machines & devices on it; `Error(msg)` → says `<name>: <msg>` and opens Machines & devices on it; `Unknown` → treated as offline. Right-click always opens the menu.
2. **Machine ids in menu commands are quoted** with the same quoting the command parser reads (`crate::commands` word splitting: wrap in single quotes, escape `'`), so an id or name with spaces works; add a test with an id containing a space.
3. **Tests:** set `app.mouse = true` where a press needs it; the scroll test chooses a bar height that really scrolls (assert the precondition first); if the new `machine-menu` command trips a command-list/help test, register it the way other internal commands are (hidden from the palette) rather than editing those tests' expectations.
4. **Build after plan 003 and plan 006** have merged (they share `workspace_menu.rs` / `workspace_controls.rs`).

## Global Constraints

- **No custom style:** rows use the side bar's existing marks and colours (`mark()` / `theme::state_mark`, `machine_spans`, the window rows' style); menus are `workspace_menu`.
- The current behaviour stays where it works: a machine with a window here still jumps to it on click; window and pane rows are unchanged.
- Read-only clients (`app.read_only()`) and `tmux_look` do not get the menu (the same opt-outs as the header controls, `workspace_controls.rs:33`, `enabled()`); clicks there keep today's behaviour.
- A harness already open in a window here is shown once — as that window's row, not again as a harness row.
- Copy per `docs/naming-system.md`: "harness", "computer"/"machine" as the side bar already says, "New Harness", "New Terminal".

## Target look (side bar, `machines` section)

Marks are the bar's own: a harness row's mark is `bar::mark(Some(state))` (spinner working, `?` needs you, `✓` done, `✗` failed; idle/paused/offline harnesses have no mark and the name sits close, as on the window rows); a machine's mark is `theme::machine_mark` (`✓` connected, `?` needs a link, `·` offline).

```
 machines
 ✓ Mac Auto
   ├─ 1:Harness TUI LMStudio    2          ← a window here (as today)
   └─ 3:pi:c
 ✓ grid-dev
   ├─ ? Run Ollama model on Mac            ← its harnesses not open here: mark (if any) + name
   ├─ Start grid chat model
   ├─ Review the daemon logs
   └─ + 4 more                             ← opens "Open its harnesses" (the Open picker on grid-dev)
 ? linux-box                               ← needs a link: a click opens Connect…
 · MacBook-Air.local         offline       ← offline: a click says so
```

## Review Focus

- A machine with 40 harnesses must not push the other machines off the list: at most 3 harness rows per machine, then `+ N more`.
- A roster that arrives while the bar is scrolled: the scroll position stays on the same entry. `scroll_list` (`bar.rs:435`) keeps only an entry **index** (`app.bar.scroll`), and `follow` only moves it to the focused row, so Task 1 Step 3 adds the identity keeping.
- Clicking a harness that is already opening (a slow remote attach) twice opens one window, not two: verified, `open-harness -s` on a harness with a pane here selects that window (`commands.rs:3679-3682`), and once the first click has made the pane the row is drawn as a window row (`Hit::Window`) anyway. Task 1's test runs the command twice.
- A stopped harness (`status == "stopped"`) is not listed; `agent_rows` in the Open picker decides whether its list shows stopped ones.
- `This computer` and the local machine id show the same rows (no duplicate machine): the local-shells machine (`hn-local-shells`, `local::MACHINE`) holds only terminals, which are never listed, so no harness row can repeat.

---

### Task 1: Each machine's harnesses in the side bar

**Files:**
- Modify: `tui/src/bar.rs:40-56` (`Hit`: add `Harness(String, String)` — machine, agent; `More(String)` — machine), `:305-331` (`machine_entries`), `:435-442` (`scroll_list`), `:495-508` (`wheel`: add arms), `:480-492` (`click`: `Harness` → `crate::commands::execute(app, &format!("open-harness -s {m}:{a}"))`; `More(m)` → `crate::devices::open_machine_list(app, &m)`), `State` (`:60`: `top: [Option<Hit>; 2]`)
- Modify: `tui/src/devices.rs:1026-1034` (move the `open` arm's picker building into `pub(crate) fn open_machine_list(app: &mut App, machine: &str)`; the arm keeps `app.devices.sub = None;` and calls it)
- Test: `tui/src/bar.rs` tests (next to `the_bar_draws_the_machine_its_windows_with_their_panes_then_the_machines`, `:639`)

**Interfaces:**
- Produces: `Hit::Harness(String, String)`, `Hit::More(String)`; `pub(crate) fn devices::open_machine_list(app: &mut App, machine: &str)`.
- `Hit` stays `Clone` (it is not `Copy`); the new variants only add arms: `wheel` takes `Hit::Machines | Hit::Machine(..) | Hit::Harness(..) | Hit::More(_) | Hit::Fold => 1`, `click` takes the two new arms. Nothing outside `bar.rs` matches `Hit` exhaustively (`workspace_controls.rs:165` matches `Hit::Window(i)` with `_`).

- [ ] **Step 1: Failing tests** — the bar tests' real helper is `app(size, side)` (`bar.rs:560`: machines `local` "studio" Ready and `lab` Offline, four panes in two windows), with `screen(&mut app) -> (String, Buffer)`, `ev(kind, column, row)` and `mouse(app, &ev)`. Add these helpers to the `tests` module and the tests after them:

```rust
/// The bar app of `app((120, 50), "left")` plus the machine `grid` (named `grid-dev`, Ready) with
/// [n] harnesses that are open in no window here.
fn with_grid(n: usize) -> App {
    let mut app = app((120, 50), "left");
    app.fleet.machines.push(crate::fleet::Machine { shared: false, id: "grid".into(), name: "grid-dev".into(), local: false, status: "online".into(), reach: crate::fleet::Reach::Ready });
    let rows: Vec<_> = (0..n).map(|i| json!({"id": format!("g{i}"), "name": format!("Grid task {i}"), "engine": "codex"})).collect();
    app.fleet.merge_roster("grid", &rows);
    app
}

/// Draw, then the first bar rect whose hit [want] accepts.
fn rect_of(app: &mut App, want: impl Fn(&Hit) -> bool) -> Rect {
    let _ = screen(app);
    app.bar.hits.iter().find(|(_, h)| want(h)).map(|(r, _)| *r).expect("that entry is drawn")
}

/// A left press on that entry (three columns in, on its first row).
fn click_on(app: &mut App, want: impl Fn(&Hit) -> bool) {
    let r = rect_of(app, want);
    assert!(mouse(app, &ev(MouseEventKind::Down(MouseButton::Left), r.x + 3, r.y)));
}

fn harness(m: &str, a: &str) -> Hit { Hit::Harness(m.into(), a.into()) }

#[test]
fn a_machine_lists_its_harnesses_not_open_here_three_then_more() {
    let mut app = with_grid(5);
    let (s, _) = screen(&mut app);
    assert!(s.contains("grid-dev"), "{s}");
    // (Equal recency: the name decides, so the first three are 0, 1, 2.)
    assert!(s.contains("Grid task 0") && s.contains("Grid task 2"), "{s}");
    assert!(!s.contains("Grid task 3"), "three rows at most: {s}");
    assert!(s.contains("+ 2 more"), "{s}");
    assert!(app.bar.hits.iter().any(|(_, h)| *h == Hit::More("grid".into())));
    // Not for a machine that is not Ready (`lab`: offline, a roster of two): none.
    assert!(!app.bar.hits.iter().any(|(_, h)| matches!(h, Hit::Harness(m, _) if m == "lab")));
}

#[test]
fn a_harness_open_in_a_window_here_is_shown_once() {
    let mut app = with_grid(5);
    let mut tab = Tab::new("Grid task 0");
    tab.root = Some(Node::new(5, 40, 20));
    tab.focus = Some(5);
    let mut pane = Pane::new(5, "grid", "g0", 40, 20);
    pane.phase = Phase::Live;
    app.panes.insert(5, pane);
    app.tabs.push(tab);
    app.fit_panes();
    let _ = screen(&mut app);
    // (Its window's row is in both lists; as a harness row it is not drawn.)
    assert!(!app.bar.hits.iter().any(|(_, h)| *h == harness("grid", "g0")));
    assert!(app.bar.hits.iter().any(|(_, h)| *h == harness("grid", "g1")));
}

#[tokio::test]
async fn clicking_a_harness_row_opens_it_and_more_opens_the_machines_list() {
    let mut app = with_grid(5);
    click_on(&mut app, |h| *h == harness("grid", "g1"));
    assert!(app.find_pane("grid", "g1").is_some(), "open-harness ran");
    // Again (a slow attach): the same window, not a second one.
    let windows = app.tabs.len();
    crate::commands::execute(&mut app, "open-harness -s grid:g1");
    assert_eq!(app.tabs.len(), windows);
    click_on(&mut app, |h| *h == Hit::More("grid".into()));
    assert!(matches!(&app.modal, Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Open { machine: Some(m), .. }, .. }) if m == "grid"));
}

#[test]
fn a_roster_arriving_keeps_the_scroll_on_the_same_entry() {
    let mut app = with_grid(0);
    app.size.1 = 20; // few rows: the machines list scrolls
    let _ = screen(&mut app);
    assert!(app.bar.max_scroll[1] > 0, "lower the height until the machines list scrolls");
    wheel(&mut app, Hit::Machines, false);
    let top = |app: &mut App| { let _ = screen(app); app.bar.top[1].clone() };
    let before = top(&mut app);
    let rows: Vec<_> = (0..5).map(|i| json!({"id": format!("g{i}"), "name": format!("Grid task {i}"), "engine": "codex"})).collect();
    app.fleet.merge_roster("grid", &rows);
    assert_eq!(top(&mut app), before, "the first entry shown is the same one");
}
```
(`Tab`, `Node`, `Pane`, `Phase`, `json` are already imported by the tests module.)

- [ ] **Step 2: Run** — `cd tui && cargo test --locked bar::` → FAIL (does not compile: `Hit::Harness`, `Hit::More`, `bar.top`).
- [ ] **Step 3: Implement**
  - **Rows.** In `machine_entries`, the children of a machine are, in order: its window rows (as today), then its harness rows, then `+ N more`; the tree prefix is chosen over **all** of them (`├─ ` for each but the last child, `└─ ` for the last), so `window_entry(.., Some(prefix))` is called with the prefix of its position among all children, not only among windows (today the last window gets `└─ `). Harness rows only for `m.usable()` machines (the others have no roster): agents of `app.fleet.agents` with `a.machine_id == id`, `a.status != "stopped"`, `a.engine != "terminal"`, `app.find_pane(&id, &a.id).is_none()` (not open in a window of this session), sorted by `(Reverse(a.recency()), &a.name)`; the first 3 become `Entry { rows: vec![(1, [prefix, mark, name])], right: None, hit: Hit::Harness(id, a.id), current: false }` where mark is `mark(Some(app.fleet.state_of(a)), c, app.tick)` as `window_entry` builds it (no mark when it is a blank), then, when more remain, `Entry { rows: vec![(1, [prefix, "+ N more"])], hit: Hit::More(id), current: false }`.
  - **Offline label.** A machine that is not `online()` gets `right: Some(("offline", muted))` on its heading (`Entry.right` is drawn by `list`); `machine_spans` is given `width - 8` for it so the name is cut before the label.
  - **Scroll identity** (Review Focus). `State` gets `top: [Option<Hit>; 2]` (`State` derives `Default`, which covers it). In `scroll_list`, before clamping: if `!follow` and `app.bar.top[which]` is `Some(h)` and the entry at index `s` is not `h`, move `s` to the entry whose `hit == h` nearest to `s` (`min_by_key(|i| i.abs_diff(s))`; window rows repeat under several machines, so "nearest"), then clamp as today; after: `app.bar.top[which] = entries.get(s).map(|e| e.hit.clone())`. `wheel` still changes the index, and the next draw records the new top.
  - **Click/wheel.** As in **Files**. `devices::open_machine_list` is the `open` arm's body from `let kind = PickerKind::Open { … machine: Some(machine) … }` to `app.modal = Some(Modal::Picker { kind, picker: next })`, with `machine` a `&str` made `String`.
- [ ] **Step 4: Run** → PASS (and the existing bar tests: `the_bar_draws_…` is unchanged because `studio`'s harnesses are open in windows and `lab` is offline, so it gets no harness rows, only the `offline` label after ` · lab`, which `starts_with(" · lab")` still accepts)
- [ ] **Step 5: Commit** — `git commit -am "side bar: each machine's harnesses, opened with a click"`

### Task 2: A machine row always does something

**Files:**
- Modify: `tui/src/bar.rs:46` (`Hit::Machine(String, Option<usize>)` — the machine id too), `:323` (build it with the id), `:480-492` (`click` → `click_at(app, hit, at)`, `click(app, hit)` stays as `click_at(app, hit, None)` so `click(&mut app, Hit::Fold)` in the existing tests keeps compiling), `:535-536` (`mouse` passes `Some((ev.column, ev.row + 1))`), `:502` (`wheel`: `Hit::Machine(..)`), tests `:731-732` (see Interfaces)
- Modify: `tui/src/workspace_controls.rs:33` (`enabled` becomes `pub(crate)`), `:164-170` (the right-press branch: before the `let tab = …` lookup, `if let Some(crate::bar::Hit::Machine(m, _)) = crate::bar::hit_at(app, mouse.column, mouse.row) { begin_press(app, MouseButton::Right); crate::machine_menu::open(app, &m, at); return true; }`)
- Modify: `tui/src/devices.rs` (add `pub(crate) fn open_machine(app: &mut App, machine: &str)`: `open(app, View::Machines); sub(app, format!("m:{machine}"))` — Machines & devices on that machine's own actions; `sub` is private to `devices.rs`)
- Modify: `tui/src/commands.rs:90-97` (table: `("machine-menu", "machine-menu", "Actions for a machine: machine-menu <new-harness|new-terminal|open|connect|machine> <machine>")`), `:3537` (dispatch: `"machine-menu" => crate::machine_menu::command(app, &words[1..])`), `tui/src/main.rs:44` (`mod machine_menu;`)
- Create: `tui/src/machine_menu.rs` — `pub fn open(app: &mut App, machine: &str, at: Option<(u16, u16)>)` building a `workspace_menu` (items are `menu::item(label, key, format!("machine-menu {verb} {machine}"))`) and `pub fn command(app: &mut App, args: &[String])` running the verb
- Test: `tui/src/bar.rs` tests, `tui/src/machine_menu.rs` tests

**Interfaces:**
- Consumes: `devices::open_machine_list` (Task 1), `new_harness::open(app, Some(machine), None)`, `devices::connect_to(app, machine)` (`devices.rs:438`, `pub`), `devices::open_machine` (new), `crate::input::new_shell_from(app, Some((machine, String::new())), Placement::Auto(None), None, None)` (what the `terminal` key runs, `input.rs:1053`; `shell_machine` takes the machine from the first tuple field, `input.rs:1359`).
- Produces: `machine_menu::open`, `machine_menu::command`, `devices::open_machine`.
- `Hit::Machine` changing shape breaks, and Step 3 fixes: the construction `bar.rs:323`; the `click` arms `:488` (`Hit::Window(i) | Hit::Machine(Some(i))`) and `:490` (`Hit::Machine(None) | …`); the `wheel` arm `:502` (`Hit::Machine(_)` → `Hit::Machine(..)`); the test `a_click_on_the_bar_does_what_its_entry_says` `:731-732` (`Hit::Machine(Some(0))` → find `Hit::Machine(m, Some(0)) if m == "lab"`, and `hit_at` equals `Hit::Machine("lab".into(), Some(0))`). Task 1 must land first (same enum, same `click` match).
- Not for a read-only client or `tmux_look` (`workspace_controls::enabled`): a machine heading there keeps today's click (its window, else nothing) and gets no menu and no Connect/offline action.

| Machine | Left click | Right click |
|---|---|---|
| Has a window here | Its first window (today) | Menu |
| Ready, no window here | Menu | Menu |
| Online, needs a link (`reach == NeedsLink && online()`, mark `?`) | `devices::connect_to` (Connect view, password asked) | Menu (Connect… first) |
| Anything else — offline (and, not specified by the agreed behaviour, Connecting / Error / Unknown, treated as offline) | Status message `<name> is offline — start Harness on it` (`app.say(.., theme::WARN)`), then `devices::open_machine` | Menu (only Machines & devices…) |

Menu items (title = the machine's name; shown per the table): `New Harness on <name>…` (n, `new-harness`: `new_harness::open(app, Some(id), None)`), `New Terminal on <name>` (t, `new-terminal`: `new_shell_from` as above), `Open its harnesses` (o, `open`: `devices::open_machine_list`) — these three only when `usable()`; `Connect…` (c, `connect`: `devices::connect_to`, only when it needs a link and is online), `Machines & devices…` (m, `machine`: `devices::open_machine`).

- [ ] **Step 1: Failing tests** — in `bar.rs` tests (helpers `with_grid`, `rect_of`, `click_on`, `harness` from Task 1; `Machine` has no `Default`, so each machine is a full literal):

```rust
fn machine(id: &str, name: &str, status: &str, reach: crate::fleet::Reach) -> crate::fleet::Machine {
    crate::fleet::Machine { shared: false, id: id.into(), name: name.into(), local: false, status: status.into(), reach }
}

#[tokio::test]
async fn a_ready_machine_without_a_window_opens_its_menu() {
    let mut app = with_grid(2);
    click_on(&mut app, |h| *h == Hit::Machine("grid".into(), None));
    let Some(crate::modal::Modal::Menu(m)) = &app.modal else { panic!("a menu") };
    assert_eq!(m.title, "grid-dev");
    let labels: Vec<_> = m.items.iter().map(|i| i.label.as_str()).collect();
    assert!(labels.contains(&"New Harness on grid-dev…") && labels.contains(&"Open its harnesses"), "{labels:?}");
    assert!(!labels.contains(&"Connect…"));
}

#[tokio::test]
async fn a_machine_that_needs_a_link_opens_connect_and_an_offline_one_says_so() {
    let mut app = app((120, 50), "left");
    app.fleet.machines.push(machine("lb", "linux-box", "online", crate::fleet::Reach::NeedsLink));
    click_on(&mut app, |h| *h == Hit::Machine("lb".into(), None));
    assert!(matches!(app.modal, Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Devices(crate::devices::View::Connect), .. })));
    app.modal = None;
    app.fleet.machines.push(machine("air", "MacBook-Air.local", "offline", crate::fleet::Reach::Offline));
    click_on(&mut app, |h| *h == Hit::Machine("air".into(), None));
    assert!(app.toast.as_ref().is_some_and(|t| t.0.contains("MacBook-Air.local is offline")), "{:?}", app.toast);
    assert!(matches!(app.modal, Some(crate::modal::Modal::Picker { kind: crate::modal::PickerKind::Devices(crate::devices::View::Machines), .. })));
}

#[tokio::test]
async fn a_machine_with_a_window_here_still_jumps_to_it_and_a_right_press_opens_its_menu() {
    let mut app = app((120, 50), "left");
    app.select_tab(1);
    click_on(&mut app, |h| matches!(h, Hit::Machine(m, Some(0)) if m == "lab"));
    assert_eq!(app.active, 0);
    // Right press: through the same path the real input takes (workspace_controls first).
    let r = rect_of(&mut app, |h| matches!(h, Hit::Machine(m, _) if m == "local"));
    let press = ev(MouseEventKind::Down(MouseButton::Right), r.x + 3, r.y);
    assert!(crate::workspace_controls::mouse(&mut app, &press));
    assert!(matches!(&app.modal, Some(crate::modal::Modal::Menu(m)) if m.title == "studio"));
}
```
(The third test needs `app.mouse` true; if the bar tests' `app()` leaves it false, set `app.mouse = true` first. A read-only client — `app.client_flags.push("read-only".into())` — gets no menu: assert `app.modal.is_none()` after the same right press and that the left click on `grid` does nothing.)

and in `tui/src/machine_menu.rs` tests (explicit app, as `workspace_menu.rs`'s tests build theirs):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::modal::Modal;

    fn grid() -> App {
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let mut app = App::new(19798, tx, (160, 40));
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: "grid".into(), name: "grid-dev".into(), local: false, status: "online".into(), reach: crate::fleet::Reach::Ready });
        app
    }

    /// Run the menu item with this label the way a chosen item runs: its command.
    fn choose(app: &mut App, label: &str) {
        let Some(Modal::Menu(m)) = &app.modal else { panic!("a menu") };
        let command = m.items.iter().find(|i| i.label == label).unwrap_or_else(|| panic!("no item {label}")).command.clone();
        app.modal = None;
        crate::commands::execute(app, &command);
    }

    #[tokio::test]
    async fn new_harness_on_a_machine_opens_the_form_on_it() {
        let mut app = grid();
        open(&mut app, "grid", None);
        choose(&mut app, "New Harness on grid-dev…");
        let Some(Modal::NewHarness(form)) = &app.modal else { panic!("the form") };
        assert_eq!(form.draft.machine, "grid");
    }

    #[tokio::test]
    async fn the_menu_lists_only_what_the_machine_can_do() {
        let mut app = grid();
        app.fleet.machines.push(crate::fleet::Machine { shared: false, id: "air".into(), name: "air".into(), local: false, status: "offline".into(), reach: crate::fleet::Reach::Offline });
        open(&mut app, "air", None);
        let Some(Modal::Menu(m)) = &app.modal else { panic!("a menu") };
        assert_eq!(m.items.iter().map(|i| i.label.as_str()).collect::<Vec<_>>(), ["Machines & devices…"]);
    }
}
```
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** as in the table, **Files** and **Interfaces** above. `bar::click_at` guards the menu / Connect / offline paths with `crate::workspace_controls::enabled(app)`; when it is false the old arms apply (`Some(i)` → the window, `None` → nothing).
- [ ] **Step 4: Run** → PASS (`cd tui && cargo test --locked bar:: machine_menu::` and the commands-table tests, since `machine-menu` is a new table entry)
- [ ] **Step 5: Commit** — `git commit -am "side bar: a machine row opens its window, its menu, Connect…, or says it is offline"`

### Task 3: Fixture and gate

**Files:** Modify `tui/tests/workspace-controls.py` (the fixture already has a `Remote` computer, `api({'action': 'machines', 'remote': True})`; helpers `click_text(text, occurrence, button, row, before)`, `click(x, y, button)` — button `2` is the right button — `shown`, `wait`, `hn`, `screen`)

- [ ] **Step 1: Journey** — set the bar on the left (`hn('set', '-g', '@hn-status-bar', 'left')`); the remote machine's harnesses appear under it in the `machines` section; `click_text` one → a new window shows its terminal (`shown('Gamma remote task terminal')`); right-click the machine (`click_text('Remote', button=2)`) → the menu lists `New Harness on …`; Esc closes it; remove the remote (`api({'action': 'machines', 'remote': False})`) → its rows go. (If the fixture's remote roster has only harnesses already open in windows, add one the journey does not open, so a harness row exists to click.)
- [ ] **Step 2: Gate** — `cd tui && cargo test --locked && cargo build --release --locked && cd .. && python3 scripts/validate-tui-native.py tui/target/release/harness-tui`
- [ ] **Step 3: Commit** — `git commit -am "side bar machines: fixture journey"`

## Conflicts

Task pairs touching the same file or interface:

| Pair | Shared | Resolution |
|---|---|---|
| Task 1 – Task 2 | `bar.rs` `Hit` enum, `click` match, `wheel` match, `machine_entries`; `devices.rs` `machine_action` | Task 1 adds variants and `open_machine_list`; Task 2 reshapes `Hit::Machine` afterwards. Task 2 builds the machine heading entry (`:323`) that Task 1 left as is. Order: 1 then 2. |
| Task 2 – Task 3 | right-click menu, bar rows | The fixture only drives behaviour Tasks 1 and 2 provide; run after both. |
| Task 1 – Task 3 | harness rows | Same: the fixture needs the rows. |

Per task, do its tests match its code: Task 1 yes (real helpers, `Hit::More`/`Harness` exist after Step 3; the scroll test needs `State::top`, added in Step 3). Task 2 yes (the existing `bar.rs` test at `:731` is updated in the same task; `machine_menu` tests build their own app). Task 3 yes (real fixture helpers). Nothing contradicts the Global Constraints: the read-only / `tmux_look` opt-out is `workspace_controls::enabled`; window and pane rows are untouched; a harness open here is not drawn twice (`find_pane`).

Cross-plan overlaps (other plans are not changed):

| Plan | File | Overlap |
|---|---|---|
| 003 (button row) | `workspace_menu.rs` (`Layout.buttons`, `fit`) | Task 2 uses `workspace_menu::open` with plain items; 003's `actions are no longer items.last()` change only affects button menus. No code conflict; 008 does not use `buttons::Row`. |
| 003 | `devices.rs` (`prompt_actions` `:1382-1394`, clicks `:819-835`, `answer_key` `:870-880`) | 008 adds `open_machine_list` / `open_machine` and edits the `open` arm (`:1026-1034`), away from those lines; the Connect password prompt that `connect_to` shows gets 003's buttons. |
| 003 | `input.rs` menu keys `:1632-1681`, `menu_mouse` `:3549-3574` | 008 does not edit `input.rs`; its menu rides those handlers unchanged. |
| 006 (pane drag) | `workspace_controls.rs` `mouse` / `finish_press` (`:118-148`) and the right-press branch | 008 adds one arm in the right-press branch (`:164-170`) and makes `enabled` (`:33`) `pub(crate)`; 006 edits `finish_press` and the header press in the same function: merge by hand. 006 reads `bar::hit_at` only for `Hit::Window`. |
| 005 (flicker) | `input.rs` | 008 does not touch `input.rs`; no overlap. |
| 004, 007 | none of `bar.rs`, `devices.rs`, `workspace_menu.rs`, `input.rs` | none |
