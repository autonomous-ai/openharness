# One list style for the composers: the command panel's — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The shell composer (Ctrl-N / `claude @…`) and the New Harness form show their choices the way the command panel already does — a `›` query line, a muted rule with the count, rows drawn by the panel's own list, a keys line — directly under where you type, in the theme's colours, with a ghost line that says what `@ : % &` choose.

**Architecture:** No new style. The command panel (`settings::draw`, `settings.rs:422-593`) is the reference: `settings::chrome()` (theme-derived `base / muted / accent / selected`, `settings.rs:283-311`) and `settings::list_from` (rows, `settings.rs:596`: the chosen row is the row's text bold on the lifted `selected` band across the whole row, its `›` pointer in that same style; the other rows' detail is muted, the chosen row's detail is the same band without bold). Task 1 lifts the launcher's query line, count rule and keys line (`settings.rs:461-470`, `:486-488`, `:489-498`) into small `pub fn`s the panel itself then calls (no visual change). Tasks 2 and 4 draw the two composers with those functions and `list_from`. Task 3 gives the out-of-process shell picker the TUI's theme (the picker is a separate process and has no theme of its own: `settings::chrome()` there is the dark default until it is told) so `chrome()` there is the same theme.

**Tech Stack:** Rust (ratatui), the shell picker process (`hn --shell-picker`), Python fixtures.

**Spec:** user 2026-10-07: reference screenshot (input line, rule, list below with the chosen row bright and others muted, a footer); "cần có dòng placeholder để instruct @ # : là gì đó để họ gõ"; "cái cách select style của cái new harness nó ko giống trong cái command"; "UI màu đúng… đồng bộ theme"; answers: freeze in the shell composer; the dropdown for **the shell composer and the New Harness form**; "nó nên follow style và đồng bộ theme nhé bạn không custom, nhớ follow rules".

## Controller rulings (2026-10-07, after the plan check) — these OVERRIDE the task text below where they differ

1. **No preview while arrowing over fields:** a chooser drops down only when its field is entered (→, Enter, typing, a click); moving over fields with ↑ ↓ shows nothing extra. Accepted change — the dropdown sits where the old side preview could not.
2. **The user's own list options win:** when `@hn-lists fzf` is set or `FZF_DEFAULT_OPTS` sets `--layout` / `--border` / `--info` / `--color`, the shell composer keeps today's fzf drawing; otherwise (the default) it uses the command panel's pieces. The picker learns which from the TUI's reply (`look.lists`), and from `HN_LOOK` (below) for its first frame.
3. **First frame in the right theme:** the TUI exports `HN_LOOK` (the same JSON as the reply's `look`) into each shell it starts, so the picker's first frame uses it; every reply's `look` then keeps it current.
4. **Welcome page:** the dropdown sits under the chips row (the task box stays visible). Accepted.
5. **Task 4b also fixes → on Browse and Terminal** (today it sets `child_active` with no child — a trap): → there does what Enter does.
6. **Empty ghost:** `Search agents   @ computer   : project   % model   & agent` (the existing words, then the scopes), cut at whole scopes on narrow panes.
7. `Color::Reset` page fills stay: Reset is the terminal's own background, which is theme-following, not a fixed colour.
8. Task 4b's "opened" assertion: verify by running it; if `open_agent` cannot run in the bare test app, assert the same observable state the Enter test at `welcome.rs` asserts, by pressing → and comparing.
9. **Build after plan 004 has merged** (both edit `shell_picker.rs`'s loop and `shell_context.rs` replies).

## Global Constraints

- **No custom style.** Every colour and modifier comes from `settings::chrome()`; every row from `settings::list_from`. No `theme::fzf()` palette, no fixed `Color::*`, no new glyphs (the panel's `›` and `─` only).
- Copy follows `docs/naming-system.md` (Harness, computer, project, model) and the panel's sentence case.
- The shell composer's scopes stay `& agent`, `@ computer`, `: project`, `% model` (`shell_picker.rs:653-658`). `#` cannot be one in a shell: it starts a comment and the word parser refuses it (`shell_composer.rs:59`). The command panel keeps its own `> @ # : * ?`.
- `NO_COLOR` keeps working (`chrome()` already handles it, `settings.rs:284-287`).
- Behaviour unchanged: keys, what is chosen, what is launched. Only where and how the list is drawn.

## Target look (shell composer; the form's dropdown is the same block under its Task field)

```
READY> codex @Office :~/api
 › %gpt▌                                  @ computer   : project   % model   & agent   (ghost when empty)
 2/9 ───────────────────────────────────────────────
 › gpt-6-astra          OpenAI                       ← list_from: chosen row bold on the lifted band (pointer in the same style)
   gpt-6-astra-fast     OpenAI                       ← detail muted
 ↑↓ move · enter choose · esc back                   ← keys line: keys bold, words muted
```

## Facts checked against the code (read before starting)

- `ui::inline_fzf` (`ui.rs:2508`) is the renderer of **every** shell picker process (`shell_picker.rs:290`, one call site): the composer (`source=="compose"`), the `ch` computer chooser, the model chooser, the `choose` picker and the sessions search. It hard-codes `PickerKind::ShellContext`; it has no notion of "composer". Its last parameter `bottom_up` is the **preview text's** anchoring (`preview_bottom` of the reply), not the list direction. So Task 2 needs a flag on the picker: `Picker.shell_panel: bool` (new `pub` field in `picker.rs`, default false; set by `compose_scope`, below). The sessions kind (blank Ctrl-P, with its preview split) and the other pickers keep the fzf frame.
- The shell picker never "opens upward": `Screen::new` reserves `dimensions()` rows by scrolling the terminal (`shell_picker.rs:210-250`). The composer panel is always top-down (query on top), like the panel's non-launcher menus (`settings::top_down`).
- The `part` kind (`shell_picker.rs:595`, `:502`, `:661`; `composition::list` `"part"`) is unreachable today: `composer_kind` (`:653`) only returns `agent|host|folder|model|sessions`. The ghost the user sees when the composer is empty is the placeholder of `sessions` ("Search sessions", blank Ctrl-P) or `agent` ("Search agents", blank Ctrl-N, `:661`). Leave `part` as it is.
- There are no `theme::set_pane_palette` / `theme::set_accent`. The theme the chrome reads is: `term_out::terminal_colours()` (a chosen theme's `THEME_COLOURS`, else the terminal's answer; setter `term_out::set_theme_colours(Option<(bg_hex, fg_hex)>)`, `term_out.rs:335`) and `term_out::accent_override()` (setter `term_out::set_accent_override(Option<String>)`, `:347`), both consulted by `theme::pane_palette()` (`theme.rs:489`) and `theme::accent()` (`theme.rs:403`). These are process-global; tests that set or read them hold `crate::term_out::colours_lock()`. `muted` is derived from the palette by `pane_palette_for` — it is not sent.
- `picker-ready` is the shell's own handshake (`shell_context.rs:457`), answered with empty text and no JSON; the picker process never sends it. The catalogs the picker draws from come back through `reply_data` (`shell_context.rs:375`), from `inline_list` (`:612`) and `composition::data` (`shell_context/composition.rs:47`), as `Items` (`shell_picker.rs:23`, `#[serde(default)]`).

---

### Task 1: The launcher's query line, count rule and keys line as functions

**Files:**
- Modify: `tui/src/settings.rs:461-470` (query), `:486-488` (count), `:489-498` (keys): extract; add `pub fn query_line`, `pub fn count_rule`, `pub fn keys_line`; `settings::draw` calls them
- Test: `tui/src/settings.rs` tests (`mod tests`, `:1019`; helpers there: `app((w,h))`, `text(&buf)`, `open(..)`)

**Interfaces:**
- Produces:
```rust
/// `› query` (or the ghost, muted, when empty) at [x, y], [w] wide. Returns the text cursor and the
/// columns the query or ghost took (the launcher puts its tabs after it). A ghost with `   `-separated
/// parts shows whole parts only (`@ computer   : project`), one without is cut with `…` as the panel's was.
pub fn query_line(buf: &mut Buffer, picker: &Picker, x: u16, y: u16, w: u16, ghost: &str, c: &Chrome) -> (Position, u16)
/// `shown/total ───…` (and ` (marked)` when [marked] is Some, as the launcher's) in muted across [w].
pub fn count_rule(buf: &mut Buffer, shown: usize, total: usize, marked: Option<usize>, x: u16, y: u16, w: u16, c: &Chrome)
/// `key what · key what`, keys bold, words muted; stops at [w]. `&picker.hints[..]` fits ([(&'static str, &'static str)]).
pub fn keys_line(buf: &mut Buffer, keys: &[(&str, &str)], x: u16, y: u16, w: u16, c: &Chrome)
```
(`query_line` also does `picker.prompt_at.set((y, x + 2))` as `:466` does; the `on_tabs` filter on the cursor stays in `draw`. Today's panel draws the count as `{visible}/{rows} ({marked})`, so `count_rule` takes `marked`; the launcher passes `Some(picker.marked.len())`, the composers `None`.)

- [ ] **Step 1: Tests**. (a) A characterisation test that passes on today's code and must pass unchanged after the refactor (note `PickerKind::Commands` is not a launcher: the count and keys rows exist only for `modal::is_launcher` kinds, so use `Open`):
```rust
#[test]
fn the_launcher_draws_keys_count_and_query_in_three_rows() {
    let _l = crate::term_out::colours_lock();
    let app = app((100, 30));
    let body = Rect::new(0, 0, 100, 29);
    let kind = PickerKind::Open { filter: modal::Filter::All, machine: None, project: None };
    let mut p = Picker::new("harnesses", "");
    p.hints = vec![("↑↓", "move"), ("enter", "open")];
    p.set_rows(vec![Row::new("a", "alpha"), Row::new("b", "beta")]);
    let mut buf = Buffer::empty(body);
    let (cursor, _) = draw(&mut buf, &app, body, &kind, &mut p);
    let r = p.screen_area.get();
    let qy = r.bottom() - 2;
    let row = |y: u16| (r.x..r.right()).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>();
    assert!(row(qy).contains('›'), "{}", row(qy));
    assert!(row(qy - 1).trim_start().starts_with("2/2 (0) ─"), "{}", row(qy - 1));
    assert!(row(qy - 2).contains("↑↓ move · enter open"), "{}", row(qy - 2));
    assert_eq!(cursor, Some(Position::new(r.x + 2 + 2, qy)));
}
```
(`Row` is `crate::picker::Row`; add it to the test imports if `use super::*` does not bring it.) (b) The new function, which does not compile yet:
```rust
#[test]
fn the_query_line_is_the_panels() {
    let _l = crate::term_out::colours_lock();
    let c = chrome();
    let mut buf = Buffer::empty(Rect::new(0, 0, 40, 3));
    let mut p = Picker::new("", "");
    p.query = "gpt".into(); p.qcursor = 3;
    let (at, used) = query_line(&mut buf, &p, 0, 0, 40, "@ computer", &c);
    assert_eq!(buf[(0, 0)].symbol(), "›");
    assert_eq!(buf[(0, 0)].fg, c.accent.fg.unwrap());
    assert_eq!((buf[(2, 0)].symbol(), at, used), ("g", Position::new(5, 0), 3));
    p.query.clear(); p.qcursor = 0;
    let mut buf = Buffer::empty(Rect::new(0, 0, 40, 3));
    query_line(&mut buf, &p, 0, 0, 40, "@ computer", &c);
    assert_eq!(buf[(2, 0)].fg, c.muted.fg.unwrap(), "the ghost is muted");
    // whole scopes only, never a scope cut in half
    let mut buf = Buffer::empty(Rect::new(0, 0, 20, 1));
    query_line(&mut buf, &p, 0, 0, 20, "@ computer   : project   % model", &c);
    let line: String = (0..20).map(|x| buf[(x, 0)].symbol().to_string()).collect();
    assert!(line.contains("@ computer") && !line.contains("proj") && !line.contains('…'), "{line}");
}
```
(`c.accent.fg.unwrap()` needs `NO_COLOR` unset, as the other colour tests here.)
- [ ] **Step 2: Run** — `cd tui && cargo test --locked the_launcher_draws_keys` → PASS (today's code); `cargo test --locked the_query_line_is_the_panels` → FAIL (does not compile: `query_line` not found)
- [ ] **Step 3: Implement** — move the code at `settings.rs:461-470` into `query_line` (the launcher passes `&format!("Search {}", …)` or `&picker.placeholder` as the ghost, as `:463` does), `:486-488` into `count_rule`, `:489-498` into `keys_line` (the launcher passes `&tab_keys[..]` or `&picker.hints[..]`); `settings::draw` calls them. Add `pub fn whole_parts(ghost: &str, w: u16) -> String` (the `   `-separated parts that fit whole, joined by `   `; the ghost without separators is returned as is) and use it in `query_line`. No other call-site changes. `tests/workspace-controls.py` / `keybinds.py` must not change.
- [ ] **Step 4: Run** — `cargo test --locked settings` → PASS (including the characterisation test)
- [ ] **Step 5: Commit** — `git commit -am "hn: the command panel's query, count and keys lines as shared pieces"`

### Task 2: The shell composer drawn with the panel's pieces

**Files:**
- Modify: `tui/src/picker.rs` (add `pub shell_panel: bool`, default false, next to `prefixed`/`scope_prefix`, `:129-131`; initialise in `Picker::new`, `:261-290`)
- Modify: `tui/src/shell_picker.rs:659-665` (`compose_scope`): `picker.shell_panel = kind != "sessions"`; the empty-query ghost: `"sessions"` => `Search sessions   @ computer   : project   % model   & agent`, `"agent"` => `Search agents   @ computer   : project   % model   & agent` (the existing text first, then the scopes, `   `-separated so a narrow pane shows whole parts only). `"part"` is left as it is (unreachable).
- Modify: `tui/src/ui.rs:2508` (`inline_fzf`): when `picker.shell_panel`, draw the panel instead of the fzf frame (a new private `fn inline_panel(buf, area, picker, busy) -> Position` called first): fill `area` with `chrome().base`; at `x = area.x + 1`, `w = area.width - 2`: row 0 `query_line(…, &picker.placeholder, &c)`; row 1 `count_rule(buf, picker.visible.len(), picker.total_rows.unwrap_or(rows that are not disabled), None, …)`; rows 2..height-1 `list_from(buf, picker, Rect::new(x, area.y + 2, w, area.height - 3), &c, true, false)` (empty list text: `picker.empty`, set by `Screen::draw` from the status; while `busy`, `picker.busy`'s spinner is the loading mark: put `theme::spinner`-style text from `picker.status` in the rule's place only if `picker.status` is non-empty — no new glyph); last row `keys_line(&[("↑↓","move"),("enter","choose"),("esc","back")], …)`. Too small (`area.height < 4 || area.width < 24`): only `› query` on row 0 (as the existing tiny fallback at `:2511-2519` keeps the query), cursor inside `area`. The panel is always top-down; the fzf `--layout`, `--border`, `--info` options do not apply to it (the user's `--height` still sizes the region through `dimensions()`).
- Modify: `tui/src/ui.rs:1461-1468` (inline ghost, used by the pickers that stay on the fzf frame — `ch`, models, sessions): after a ghost or placeholder is drawn, `shift = typed_w as i32 + 2` (two blanks before the inline count; both branches), fixing "Search agents14/14"
- Test: `tui/src/shell_picker.rs` tests (`mod tests`, near `:811`/`:825`), `tui/tests/shell-first.py` (NOT `composer-machine.py`: that test only talks to the OSC protocol and never reads the screen)

**shell-first.py updates:** `finder_text()` (`:161-164`) finds the box by `╭`…`╰`; `finder_ready()` (`:165`) wants `\d+/\d+` in it; `browsing()` (`:166-170`) looks for `'> '+query`; the closed-picker checks use `'╭' not in …` (`:382-426`, `:586-627`, `:692`), `'> &'` at `:334`. The composer no longer has a box and its prompt is `›`. Change `finder_text()` to return the lines from the first line holding `›` and an `n/m` rule row through the `esc back` keys line when there is no `╭` (the fzf-framed pickers — sessions, `cm` completion, `:664` box-height check — keep `╭`); change `browsing()` to look for `'› '+query` in that text; change the closed checks that follow a composer to `not finder_ready()` (a `'╭' not in` check would now pass while the composer is still open). Add the ghost assertions: with an empty Ctrl-N the screen shows `@ computer`, `: project`, `% model`, `& agent`.

- [ ] **Step 1: Failing test** (in `shell_picker.rs` `mod tests`; builds the picker the way `run` does, with a helper defined here):
```rust
fn composer_picker(labels: &[&str]) -> Picker {
    let mut p = Picker::new("", "");
    p.query = "%gpt".into(); p.qend();
    compose_scope(&mut p, "model");
    p.set_rows(labels.iter().map(|l| Row::new(*l, *l).detail(vec![ratatui::text::Span::raw("OpenAI")])).collect());
    p
}

#[test]
fn the_composer_is_drawn_like_the_command_panel() {
    let _l = crate::term_out::colours_lock();
    let c = crate::settings::chrome();
    let mut picker = composer_picker(&["gpt-6-astra", "gpt-6-astra-fast"]);
    assert!(picker.shell_panel);
    let area = Rect::new(0, 0, 60, 6);
    let mut buf = Buffer::empty(area);
    crate::ui::inline_fzf(&mut buf, area, &mut picker, false, vec![], false);
    let row = |y: u16| (0..60).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>();
    assert!(!row(0).contains('╭') && !row(0).contains('│'), "no border: {}", row(0));
    assert!(row(0).trim_start().starts_with("› %gpt"), "{}", row(0));
    assert!(row(1).starts_with(" 2/2 ─"), "{}", row(1));
    assert!(row(5).contains("↑↓ move") && row(5).contains("esc back"), "{}", row(5));
    let sel = (0..60).find(|x| buf[(*x, 2)].symbol() == "g").unwrap();
    assert_eq!(buf[(sel, 2)].bg, c.selected.bg.unwrap(), "the chosen row on the panel's lifted band");
    assert!(buf[(sel, 2)].modifier.contains(Modifier::BOLD));
    assert_ne!(buf[(sel, 3)].bg, c.selected.bg.unwrap());
}

#[test]
fn the_ghost_shows_whole_scopes_and_the_panel_survives_tiny_areas() {
    let _l = crate::term_out::colours_lock();
    let mut picker = Picker::new("", "");
    compose_scope(&mut picker, "agent");
    picker.set_rows(vec![Row::new("claude", "Claude Code")]);
    for w in [1, 8, 23, 24, 30, 60, 140] { for h in 1..12 {
        let area = Rect::new(0, 0, w, h);
        let mut buf = Buffer::empty(area);
        let at = crate::ui::inline_fzf(&mut buf, area, &mut picker, false, vec![], false);
        assert!(area.contains(at), "{w}x{h}: {at:?}");
        let first: String = (0..w).map(|x| buf[(x, 0)].symbol().to_string()).collect();
        assert!(!first.contains("Search agents1"), "{w}x{h}: {first}");
    } }
}
```
(`Row`, `Rect`, `Buffer`, `Modifier` are in scope in this module through `use super::*` — add `use ratatui::style::Modifier;` if not.) The sessions-kind picker stays on the fzf frame; the existing `inline_renderer_survives_tiny_resizes_and_preserves_its_query` (`configure(&mut picker, true)`, `shell_panel` false) must keep passing.
- [ ] **Step 2: Run** — `cd tui && cargo test --locked the_composer_is_drawn_like` → FAIL (does not compile: `shell_panel`)
- [ ] **Step 3: Implement** as in *Files*. Remove the composer's use of `theme::fzf()` colours (`theme.rs` fzf palette stays for the fzf-framed lists).
- [ ] **Step 4: Run** — `cargo test --locked` + `cd tui && env HN_COMPOSER_TEST_BINARY=target/release/harness-tui python3 -u tests/composer-machine.py` (protocol only; must not change) + the `shell-first.py` journeys → PASS
- [ ] **Step 5: Commit** — `git commit -am "composer: the command panel's list, ghost and keys, no fzf box"`

### Task 3: The shell picker process uses the TUI's theme

**Files:**
- Modify: `tui/src/shell_context.rs:375` (`reply_data`): when `data` is a JSON object, set `data["look"] = {"background": "#rrggbb", "foreground": "#rrggbb", "accent": "<hex or empty>"}` before it is stored and sent — one place for `inline_list`, `composition::data` and the `{"unchanged":true}` replies (an `unchanged` reply must still carry it: a theme change does not change a catalog's revision). Values: background/foreground from `term_out::terminal_colours()` (a chosen theme, else the terminal's answer; omit `look` when it is None: the picker then keeps the same default the TUI uses before the terminal answers); accent from `term_out::accent_override()`, else `term_out::native_accent()` as `#rrggbb`, else `""`.
- Modify: `tui/src/shell_picker.rs:23` (`Items`: `pub look: Option<Look>`; new `#[derive(Clone, Debug, Default, Serialize, Deserialize)] #[serde(default)] pub struct Look { pub background: String, pub foreground: String, pub accent: String }`) and the reply loop (`:512-520`): **before** the `if !value.unchanged` check, `if let Some(look) = &value.look { apply_look(look) }` where `apply_look` calls `term_out::set_theme_colours(Some((background, foreground)))` and `term_out::set_accent_override(Some(accent))` (None when empty) and marks `dirty = true` when either returned a change. `Request::poll` deserialises into `Items`, so `look` arrives with the rows.
- Test: `tui/src/shell_context.rs` tests (next to `inline_list_uses_shared_rows_and_does_not_open_a_modal`, `:1240`; helpers there: `app()`, `prepare`, `bind`, `request`, `output`), `tui/src/shell_picker.rs` tests

- [ ] **Step 1: Failing tests** — (a) in `shell_context.rs`:
```rust
#[tokio::test]
async fn catalog_replies_carry_the_tuis_theme() {
    let _l = crate::term_out::colours_lock();
    crate::term_out::set_theme_colours(Some(("#101010".into(), "#eeeeee".into())));
    crate::term_out::set_accent_override(Some("#ff0000".into()));
    let mut app = app();
    let token = prepare(&mut app, None, false); bind(&mut app, &token, "local", "shell");
    output(&mut app, 1, &request(&token, "list-host", r#"{"query":"","revision":""}"#));
    let data = app.shell_context.replies.back().unwrap().data.as_ref().unwrap();
    assert_eq!(data["look"]["accent"], "#ff0000");
    assert_eq!(data["look"]["background"], "#101010");
    let revision = data["revision"].as_str().unwrap().to_string();
    output(&mut app, 1, &request(&token, "list-host", &json!({"query":"","revision":revision}).to_string()));
    assert_eq!(app.shell_context.replies.back().unwrap().data.as_ref().unwrap()["look"]["accent"], "#ff0000", "an unchanged reply still says the theme");
    crate::term_out::set_theme_colours(None); crate::term_out::set_accent_override(None);
}
```
(b) in `shell_picker.rs`:
```rust
#[test]
fn a_replys_look_changes_the_pickers_chrome() {
    let _l = crate::term_out::colours_lock();
    apply_look(&Look { background: "#ffffff".into(), foreground: "#111111".into(), accent: "#ff0000".into() });
    assert_eq!(theme::accent(), Color::Rgb(255, 0, 0));
    assert_eq!(crate::term_out::terminal_colours(), Some(("#ffffff".into(), "#111111".into())));
    crate::term_out::set_theme_colours(None); crate::term_out::set_accent_override(None);
}
```
(`Color` from `ratatui::style::Color`; import in the test module if absent.)
- [ ] **Step 2: Run** — `cargo test --locked catalog_replies_carry` → FAIL
- [ ] **Step 3: Implement** — colours are `#rrggbb` (the accent override string is already one, or an indexed form `tmuxconf::colour` parses; send it as it is). Known limit: the very first frame, drawn before the first reply, is in the default palette; the next frame (one round trip later) is the theme's.
- [ ] **Step 4: Run** — `cargo test --locked shell` → PASS
- [ ] **Step 5: Commit** — `git commit -am "composer: the shell picker draws in the TUI's theme"`

### Task 4: The New Harness form's choosers drop down under their field, in the panel's style

**Files:**
- Modify: `tui/src/new_harness/view.rs`: remove the side panel (`:82-85` `side_w/side/child_w/child_h`, `:196-197` the side/overlay choice). The form is always drawn; when `form.child_active` and a child exists, `draw_child` is given a dropdown rect: `x = r.x + 1`, `width = form_w - 2`, `y` = the row under the focused field (`fy + height` of the focus row computed in the field loop `:120-190`; for `Field::Task` that is under the task text, `fy + task_h`), height = rows wanted (`4 + visible rows`, at most 12) clamped to `r.bottom() - 1 - y`. If fewer than 4 rows remain, fall back to the existing full-form overlay (`Rect::new(x, y0, form_w, form_h)`, the old `!side` path, form not drawn under it). A chooser that is open but not active (`reveal` on arrowing through fields) is **not drawn**: arrowing down through the fields must not drop a list over the next field (the footer's `form.hint()` already says Enter/→). `draw_child` (`:200-329`) is rewritten with `settings::query_line` + `count_rule` + `list_from(buf, &mut c.picker, Rect::new(x + 1, y + 2, w - 2, h - 3), &chrome, true, false)` + `keys_line(&[("↑↓","move"),("enter","choose"),("esc","back")])`; keep what it sets for the mouse (`form.child_area`, `c.picker.row_at` — `list_from` sets `row_at` and `list_area` itself; keep `page_rows`, the Project separator rows: a `Row` with a `group` gives `list_from`'s heading; `Choice::editing()` kinds — Path/Clone/NewFolder — draw only the query line, as now). Cursor: `query_line`'s position when `child_active`.
- Modify: `view.rs:77` (`Color::Reset` page fill) and `:162` (`theme::fzf().bg_plus` for the active Recent row) and `:189` (`theme::DANGER` errors): the active Recent row uses `chrome.selected` (as `welcome_view.rs:145` already does); the page fill and the error colour stay what they are unless they are fixed colours the constraint forbids — `theme::DANGER`/`theme::WARN` are the palette's semantic colours, not a style of their own: keep `DANGER`. Only `bg_plus` goes.
- Modify: `tui/src/new_harness/welcome_view.rs:186-194` (the chooser: same `draw_child` dropdown, anchored at `y = chips_y + 1` (the row under the settings chips), `x = rect.x`, `w = width.min(60)`, so the task box and the controls stay visible; same four-row fallback to the overlay at `controls_y`); `:136-145` Recent rows already use `chrome.selected`. The welcome page's `settings` chips (`:8-54`) keep their text.
- Modify: `tui/src/new_harness/task/editor.rs:185` (the empty Task's ghost): `What task should this agent work on?` becomes `What should it do?   @ computer   : project   % model`, drawn as whole `   `-separated parts that fit `area.width` (the same rule as `query_line`; the helper `settings::whole_parts(ghost: &str, w: u16) -> String` that Task 1 adds for `query_line`). The old copy is asserted in `welcome.rs:285`, `workspace_controls.rs:534`, `ui.rs:691`, `tests/welcome.py:128`, `tests/welcome-composer.py:93,164`: update them to `What should it do?`.
- Modify: `tui/src/new_harness.rs:1453` (the Task arm `_ if form.blocked(Field::Task).is_none()`): before `task_editor.key`, for `KeyCode::Char('@'|':'|'%')` with no CONTROL/ALT, typed at a word start (the task is empty, or its char before the cursor is whitespace — read it from `form.draft.task` and `form.task_editor` cursor), and the target field exists in `form.fields()` (`%` needs `Field::Model`): `child(app, &mut form, Choice::Machine(None) | Choice::Project | Choice::Model, "")`, `form.child_active = true`, the character is not inserted; `form.focus` stays `Task`, so the dropdown opens under the Task text and Esc (`back()`, `:1366`) closes it with the text unchanged. Elsewhere in a word the character is typed as usual. `@` is the Machine chooser on both surfaces (`Field::Machine` exists only on the page, `fields()` `:162`; `Choice::Machine(None)` works without it), `:` the Project chooser, `%` the Model chooser.
- Modify: `tui/src/new_harness.rs:193-198` (`blocked(Task)`) and `:305-335` (`describe`): the message becomes `Not available for <agent>` (`self.draft.what.label`); `tui/src/new_harness/welcome_view.rs:101-107`: when `form.blocked(Field::Task)` is Some and the task is empty, draw that message (muted) in the task box instead of the editor — today the welcome page shows the editor and drops keys silently, the form page already shows the blocked text.
- Modify: `tui/src/new_harness.rs:439-447` (`open`, the reopen branch): when `!form.starting && form.attempt.is_none()` set `form.focus = Field::Task` (if `task::supported(engine)`, else leave) and `form.child = None; form.child_active = false;` so a reopened form is focused on Task.
- Test: `tui/src/new_harness.rs` tests (`mod tests` at `:1870`; helpers there: `app()`, `open(&mut app, None, Some(cwd))`, `child(..)`, `key(app, Box<Form>, KeyEvent)`, `draw(&mut buf, area, &mut form)`, `set_engine`), `tui/tests/new-harness.py` (it crops the side chooser: `form_bounds` `:54`, `form_screen` `:58`, `settle_ui` `:62`; `shows('Search agents and harnesses')` after only `Down`,`Tab` at `:208-210` expects the inactive preview — change to press `Right` first (`:211`); `:374` `'Search agents' not in screen()` stays)
- **Existing Rust tests that assert the side panel and must be rewritten** (they contradict the new layout): `compact_form_and_side_choosers_stay_anchored_at_every_terminal_size` (`new_harness.rs:2249-2318`: `child_area.y == form.area.y`, `child_area.x == form.area.right() + 2`, `width >= 32`) → `child_area` is inside `form.area` (or equals it in the fallback), never intersects `task_area` when focus is not Task, and `form.hits.len() == form.fields().len()` still holds whenever the dropdown is not the fallback; `the_form_stays_put_when_a_chooser_opens` (`:1915`) keeps passing as is (`form.area` is the same); `terminal_resize_before_its_input_event…` (`:2340`) unchanged.

- [ ] **Step 1: Failing tests** (in `new_harness.rs` `mod tests`; two small helpers defined here):
```rust
fn press(app: &mut App, code: KeyCode) {
    let Some(Modal::NewHarness(form)) = app.modal.take() else { panic!() };
    key(app, form, KeyEvent::new(code, KeyModifiers::NONE));
}
fn form_of(app: &App) -> &Form {
    let Some(Modal::NewHarness(form)) = &app.modal else { panic!() };
    form
}

#[tokio::test]
async fn a_chooser_drops_down_under_its_field_in_the_panels_style() {
    let _l = crate::term_out::colours_lock();
    let mut app = app();
    open(&mut app, None, Some("/home/dev/project".into()));
    let Some(Modal::NewHarness(mut form)) = app.modal.take() else { panic!() };
    form.focus = Field::Project;
    child(&mut app, &mut form, Choice::Project, "");
    form.child_active = true;
    let body = Rect::new(0, 0, 120, 36);
    let mut buf = Buffer::empty(body);
    draw(&mut buf, body, &mut form);
    let at = form.hits.iter().find(|(_, f)| *f == Field::Project).unwrap().0;
    assert_eq!(form.child_area.y, at.y + 1, "right under the Project row");
    assert_eq!(form.child_area.intersection(form.area), form.child_area, "inside the form: no side panel");
    assert!(form.task_area.intersection(form.child_area).is_empty(), "never over the Task line");
    assert_eq!(buf[(form.child_area.x + 1, form.child_area.y)].symbol(), "›", "the query line first");
    let c = crate::settings::chrome();
    let (y, _) = form.child.as_ref().unwrap().picker.row_at[0];
    assert_eq!(buf[(form.child_area.x + 3, y)].bg, c.selected.bg.unwrap(), "the chosen row on the panel's band");
}

#[tokio::test]
async fn at_colon_percent_in_the_task_open_their_choosers() {
    let mut app = app();
    open(&mut app, None, Some("/home/dev/project".into()));
    for ch in "fix the login ".chars() { press(&mut app, KeyCode::Char(ch)); }
    press(&mut app, KeyCode::Char('@'));
    let f = form_of(&app);
    assert_eq!(f.child.as_ref().map(|c| c.kind.clone()), Some(Choice::Machine(None)));
    assert!(f.child_active);
    assert_eq!(f.draft.task, "fix the login ", "the @ is not typed into the task");
    press(&mut app, KeyCode::Esc);
    let f = form_of(&app);
    assert!(f.child.is_none());
    assert_eq!((f.focus, f.draft.task.as_str()), (Field::Task, "fix the login "));
    press(&mut app, KeyCode::Char('%'));
    assert_eq!(form_of(&app).child.as_ref().map(|c| c.kind.clone()), Some(Choice::Model));
    press(&mut app, KeyCode::Esc);
    press(&mut app, KeyCode::Char(':'));
    assert_eq!(form_of(&app).child.as_ref().map(|c| c.kind.clone()), Some(Choice::Project));
    press(&mut app, KeyCode::Esc);
    for ch in "a@b".chars() { press(&mut app, KeyCode::Char(ch)); }
    assert!(form_of(&app).child.is_none());
    assert_eq!(form_of(&app).draft.task, "fix the login a@b", "inside a word it is a letter");
}
```
(The default agent of `app()` is `opencode`, which takes a task; `Choice` derives `Clone, PartialEq, Debug`.)
- [ ] **Step 2: Run** — `cd tui && cargo test --locked a_chooser_drops_down at_colon_percent` → FAIL
- [ ] **Step 3: Implement** as in *Files*.
- [ ] **Step 4: Run** — `cargo test --locked` + `tests/new-harness.py` + `tests/welcome-composer.py` + `tests/welcome.py` → PASS
- [ ] **Step 5: Commit** — `git commit -am "New Harness: choosers drop down under their field in the command panel's style; @ : % in the task"`

### Task 4b: ← → on a Recent row, as in the command panel

**Why:** on the New Harness page's Recent rows (`Field::Recent(i)`), → falls to `KeyCode::Right if form.focus != Field::Create` (`new_harness.rs:1528-1530`) → `activate(app, &mut form)` (`:1092`), whose `_` arm calls `reveal` (nothing for `Recent`) and then sets `form.child_active = true` with no child — the keyboard is stuck in an empty chooser until Esc. ← is only handled for `Worktree` (`:1531-1535`) and does nothing on Recent. Enter/Space open a row through `welcome::activate` (`:1432-1434`). The user chose: **→ opens it (as Enter), ← goes back to the Task field** — the command panel's way (→ into, ← back).

**Files:** Modify `tui/src/new_harness.rs:1432-1434` (the Enter/Space check also takes `KeyCode::Right` when the focus is `Recent(_)`: `matches!(key.code, Enter | Char(' ')) || key.code == KeyCode::Right && matches!(form.focus, Field::Recent(_))`, still before the `form.focus == Field::Task` block), and the else-branch `:1527-1536` (a new arm before the `Worktree` one: `KeyCode::Left if matches!(form.focus, Field::Recent(_) | Field::Browse | Field::Terminal) => { form.focus = Field::Task; reveal(app, &mut form); }`); Test: `tui/src/new_harness/welcome.rs` tests (`mod tests` at `:248`; helpers there: `app()`, `event(&mut app, code, mods)`, `ensure`, `take_active`, `store_form`, `prepare`; agents in the fleet become Recent rows as in the test at `:616`). → on Browse/Terminal (same empty-chooser trap) is left as it is: listed as an open question, not part of this task.

- [ ] **Step 1: Failing test**
```rust
#[tokio::test]
async fn right_opens_a_recent_row_and_left_goes_back_to_the_task() {
    let mut app = app();
    for i in 0..3 {
        let a = crate::fleet::agent_from("local", &json!({"id":format!("{i}"), "name":format!("Work {i}"), "engine":"codex"}), None);
        app.fleet.agents.insert(a.key(), a);
    }
    ensure(&mut app, None, None);
    let tab = app.tab().id.clone();
    let mut form = take_active(&mut app).unwrap();
    prepare(&app, &mut form);
    assert!(form.recent.len() >= 2);
    form.focus = Field::Recent(1);
    store_form(&mut app, form);
    event(&mut app, KeyCode::Left, KeyModifiers::NONE);
    assert_eq!(app.welcome.forms[&tab].focus, Field::Task);
    assert!(app.tab().home, "← opens nothing");
    app.welcome.forms.get_mut(&tab).unwrap().focus = Field::Recent(1);
    event(&mut app, KeyCode::Right, KeyModifiers::NONE);
    assert!(!app.tab().home, "→ opened the harness, as Enter on Recent(1) does");
}
```
(If `open_agent` needs a pane the test app lacks, compare with Enter on a second identical app instead: the effect of Right must equal the effect of `event(.., KeyCode::Enter, ..)`; verify by running both once.)
- [ ] **Step 2: Run** — `cd tui && cargo test --locked right_opens_a_recent_row` → FAIL
- [ ] **Step 3: Implement** as in *Files*. → on the Task field keeps moving the text cursor; → on other fields keeps opening their chooser.
- [ ] **Step 4: Run** — `cargo test --locked` + `tests/welcome.py` → PASS
- [ ] **Step 5: Commit** — `git commit -am "New Harness: → opens a recent harness, ← goes back to the task"`

### Task 5: Gate and look

- [ ] `cd tui && cargo test --locked && cargo build --release --locked && cd .. && python3 scripts/validate-tui-native.py tui/target/release/harness-tui`
- [ ] Isolated hn, dark and light theme, and `NO_COLOR=1`: screenshot the command panel, the shell composer and the New Harness dropdown side by side — same chosen-row band, same muted rule.

## Review Focus

- A light theme and a 256-colour terminal: the chosen row stays readable (`chrome()`'s `lifted` already handles both — verify the composer uses it, not fzf's 236).
- The theme changed while a shell picker is open or between pickers: the next reply carries the new colours (Task 3: every catalog reply says the theme, including `unchanged` ones). The first frame of a picker is in the default palette.
- A shell composer near the bottom of a pane: the region is reserved by scrolling (`Screen::new`), as today; the panel needs at least 4 rows (query, rule, one row, keys) and 24 columns, below that only the query line shows.
- Very narrow panes (< 24 columns): the ghost shows whole scopes only; the count is on its own row in the composer; on the pickers that stay on the fzf frame the count keeps two blanks after the ghost (today "Search agents14/14", `ui.rs:1461-1468`).
- The New Harness form with its dropdown open on a short terminal: the dropdown never covers the Task line being typed (it is drawn under the focused row; with fewer than 4 rows left the old full-form overlay is used, which covers the form while the chooser is active, as the narrow layout does today).

## Plan review (2026-10-07): conflicts between tasks

| Pair / task | File or interface | Verdict |
|---|---|---|
| 1 and 2 | `settings::query_line/count_rule/keys_line`; Task 2's `inline_panel` calls them | Task 1 first; signatures fixed here (`query_line` returns `(Position, u16)`, `count_rule` takes `marked`). |
| 1 and 4 | same functions; Task 4's `draw_child` calls them; `whole_parts` helper is added in Task 4 but `query_line` (Task 1) should use it | Add `whole_parts` in Task 1 (it is `query_line`'s ghost rule); Task 4 only calls it. |
| 2 and 3 | `shell_picker.rs` (`compose_scope`/loop vs `Items`/reply loop), `ui.rs` | Different regions; Task 3's `look` makes Task 2's `chrome()` the TUI's theme. Order 1, 2, 3 or 3 then 2; both before the Task 5 look. |
| 2 and 4 | `ui.rs` / `view.rs` | Disjoint files; both depend on Task 1 only. |
| 4 and 4b | `new_harness.rs` key paths (`:1432`, `:1453`, `:1527`) and `blocked`/`open` | Same function `key`, different arms; do 4 before 4b (4b's `Left` arm calls `reveal`, whose result Task 4 changes to "not drawn until active"). |
| Task 1 tests vs code | characterisation test + new-function test | Match (fixed: `Picker::new(title, placeholder)`, `Commands` is not a launcher). |
| Task 2 tests vs code | `shell_panel` flag, `inline_fzf` signature, count `" 2/2 ─"` | Match after fixes; `shell-first.py` (not `composer-machine.py`) is the screen-reading test. |
| Task 3 tests vs code | `reply_data`, `Items.look`, `term_out` setters | Match after fixes. |
| Task 4 tests vs code | `press`/`form_of` defined; side-panel test rewritten | Match after fixes. |
| Task 4b test vs code | welcome `app()/ensure/take_active/store_form/event` | Match; the "opened" assertion depends on `open_agent` in a bare test app (fallback given). |
| Global Constraints | "no `Color::*`": `view.rs:77` (`Color::Reset` page fill) and `welcome_view.rs` (`bg(Color::Reset)`) already exist | Left as is: they are the page's transparent surface, not a list style; only `theme::fzf().bg_plus` is removed. |
| Global Constraints | "behaviour unchanged" vs dropping the inactive chooser preview while arrowing, ignoring the fzf `--layout/--border/--info` and `@hn-lists fzf` in the composer, the new empty-form copy | Consequences of the requested look; listed for the owner to confirm. |
