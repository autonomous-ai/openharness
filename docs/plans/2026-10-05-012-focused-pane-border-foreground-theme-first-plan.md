# Focused Pane Border Foreground + Theme-First Appearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the focused pane's box border use the theme **foreground** (so a single-pane box border matches the white statusbar text, not the yellow accent) and move the **Theme** section to the top of the Appearance panel.

**Architecture:** Three small, independent edits in `tui/` (Rust/ratatui). `modal.rs` reorders the Appearance section list; `ui.rs::box_style` recolors the focused box frame; `settings.rs::preview` recolors the Appearance preview's focused box so the panel matches the real look. Tests that assert the old color or the old section order are updated alongside each change.

**Tech Stack:** Rust, ratatui, cargo. Tests are Rust unit tests in the crate's `src/*.rs` `#[cfg(test)]` modules.

**Spec:** Design agreed in conversation. No separate spec file — this is a bounded change to existing code. Global conventions below are the only constraints.

## Global Constraints

- Bash line-drawing: keep the focused box border distinct from the quiet `pane_palette().border` (foreground is brighter; under NO_COLOR the existing `BOLD` modifier still distinguishes focus).
- Do not change the *waiting/attention* pane color, the classic-line `pane-border-indicators` coloring, or the global `theme::accent()` used by the shortcut box, selection rows, and the status window name.
- Keep the published behavior of the Appearance picker: opening the panel still lands the cursor on the first section row; Enter still opens that section (`theme_in` set).
- Tests: run `cargo test` in `tui/` before and after; 366 tests currently pass, 0 fail.

## Review Focus

- **Section order is also the default cursor.** Reordering is not just display: the picker selects row 0, so the default cursor and "Enter opens first section" move from Pane titles to Theme. Every test that assumes the first section was `section:status` must be updated together with the reorder, or it silently breaks (they live in `input.rs` and `ui.rs`, not `modal.rs`).
- **Focused frame color is asserted in two render tests** (`bar.rs`, `settings.rs`), not just the implementation. A color-only implementation change without the test updates fails the suite.
- **Preview vs. real draw color source differ.** The real draw applies `theme::paint(...)`, but the preview writes `pal.foreground` directly (unpainted). The test must compare against the same source each path uses or the equality fails.
- **The deviating-from-convention tradeoff is intentional** (tmux/clawtool use a distinct accent). It is documented in the code comment so a future reader knows the focused box is the theme foreground by choice.

---

### Task 1: Move the Theme section to the top of the Appearance panel

**Files:**
- Modify: `tui/src/modal.rs` (function `theme_sections`, ~lines 676-689)
- Test: `tui/src/modal.rs` (test `theme_sections_list_the_look_sections`, ~lines 823-837)
- Test: `tui/src/input.rs` (tests `theme_opens_the_sections_and_theme_lists_every_theme` ~line 3452, `theme_enter_opens_the_section` ~lines 3481-3488)
- Test: `tui/src/ui.rs` (test `theme_draws_the_settings_panel_and_a_refresh_keeps_its_section`, ~lines 2911-2922)

**Interfaces:**
- Consumes: existing `Row` API and `theme_sections(app) -> Vec<Row>`.
- Produces: `theme_sections` returns the sections in the order **Theme, Pane titles, Focus, Status bar, Borders**; the first row id is `section:theme`; Enter on it opens `theme_in == "theme"`.

- [ ] **Step 1: Update `theme_sections_list_the_look_sections` expected order (failing test)**

In `tui/src/modal.rs` change the expected ids to:

```rust
assert_eq!(ids, vec!["section:theme", "section:status", "section:focus",
    "section:bar", "section:boxes"]);
```

- [ ] **Step 2: Run the failing test**

Run: `cargo test theme_sections_list_the_look_sections -- --nocapture` (in `tui/`).
Expected: FAIL — actual order is `section:status, section:focus, section:theme, ...`.

- [ ] **Step 3: Reorder the `vec!` in `theme_sections`**

Move the `sec("section:theme", ...)` row to the top of the vector, before `sec("section:status", ...)`. Keep each row's existing arguments unchanged (do not alter labels, details, or `.right` values). Order becomes: theme, status, focus, bar, boxes.

- [ ] **Step 4: Update the dependent section-order tests in `input.rs`**

- `theme_opens_the_sections_and_theme_lists_every_theme`: change
  `Some("section:status")` → `Some("section:theme")`.
- `theme_enter_opens_the_section`:
  - `picker.current_id().as_deref()` expectation → `Some("section:theme")`.
  - After Enter, `picker.theme_in.as_deref()` expectation → `Some("theme")`.
  - The rows assertion `r.id.starts_with("border_status:")` → `r.id.starts_with("theme:")`.
  - The "current option is marked" assertion still holds (the native `theme:` row is marked when no theme chosen).

- [ ] **Step 5: Update `theme_draws_the_settings_panel_and_a_refresh_keeps_its_section` in `ui.rs`**

- The loop over `["off", "top", "bottom"]` asserts left over from the old first section (those were the `status` options). Now Enter opens the theme section, so replace that loop with a check on the picker rows: `assert!(picker.rows.iter().all(|r| r.id.starts_with("theme:")), "shows the theme options after a refresh")`.
- `picker.theme_in.as_deref()` expectation → `Some("theme")`.

- [ ] **Step 6: Run the crate tests**

Run: `cargo test` (in `tui/`).
Expected: 366 passed, 0 failed.

- [ ] **Step 7: Commit**

```bash
git add tui/src/modal.rs tui/src/input.rs tui/src/ui.rs
git commit -m "feat(tui): put the Theme section first in Appearance"
```

---

### Task 2: Focused box border uses the theme foreground

**Files:**
- Modify: `tui/src/ui.rs` (function `box_style`, ~line 576; comments above `boxes` ~528-532 and `box_style` ~569-571)
- Test: `tui/src/bar.rs` (test `each_pane_is_its_own_box_in_the_focus_and_attention_colours`, ~lines 826-853)

**Interfaces:**
- Consumes: `theme::pane_palette()` and `theme::paint()` (existing), `app.pane_state`, `app.focused`.
- Produces: a focused box frame whose `fg` is `theme::paint(theme::pane_palette().foreground)`, still with the existing `BOLD` modifier under `no_color`.

- [ ] **Step 1: Update `each_pane_is_its_own_box_in_the_focus_and_attention_colours` (failing test)**

In `tui/src/bar.rs`, replace the color bindings and the focused-frame assertion:

```rust
let (foreground, attention) = (theme::paint(theme::pane_palette().foreground), theme::paint(theme::ATTENTION));
assert_eq!(buf[(left.right() - 1, mid)].fg, foreground, "the focused pane's frame");
assert_eq!(buf[(top_right.x, top_right.y + 1)].fg, attention, "the waiting pane's frame");
assert_ne!(buf[(below.x, below.y + 1)].fg, foreground, "a quiet frame");
assert_ne!(buf[(below.x, below.y + 1)].fg, attention, "a quiet frame");
```

Also update the test's doc comment: "the focused one's in the accent" → "the focused one's in the theme foreground".

- [ ] **Step 2: Run the failing test**

Run: `cargo test each_pane_is_its_own_box_in_the_focus_and_attention_colours -- --nocapture` (in `tui/`).
Expected: FAIL — focused frame is the accent, not the foreground.

- [ ] **Step 3: Change `box_style`'s active branch**

In `tui/src/ui.rs`, change the focused branch:

```rust
else if active { Style::default().fg(theme::paint(theme::pane_palette().foreground)).add_modifier(if theme::no_color() { Modifier::BOLD } else { Modifier::empty() }) }
```

Leave the `own`/`border_style`, the waiting/attention branch, and the quiet border branch unchanged. Update the `boxes` and `box_style` doc comments to say the focused box is the theme's *foreground* (readable text colour), not the accent.

- [ ] **Step 4: Run the crate tests**

Run: `cargo test` (in `tui/`).
Expected: 366 passed, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add tui/src/ui.rs tui/src/bar.rs
git commit -m "feat(tui): focused box border uses the theme foreground"
```

---

### Task 3: Appearance preview focused box uses the theme foreground

**Files:**
- Modify: `tui/src/settings.rs` (function `preview`, ~line 899; comment ~896-897)
- Test: `tui/src/settings.rs` (test `the_preview_draws_the_status_bar_where_it_goes_and_the_boxes_in_their_colours`, ~lines 1210-1216)

**Interfaces:**
- Consumes: `pal.foreground` (bound as `fg` at line 835), `theme::native_pane_palette()` (the source `preview` uses when no theme is shown).
- Produces: the Appearance preview's focused box frame is drawn with the theme foreground, not the accent.

- [ ] **Step 1: Update the preview test (failing test)**

In `tui/src/settings.rs`, change the focused-frame assertions:

```rust
let foreground = theme::native_pane_palette().foreground;
assert_eq!(bottom[(panes[0].x, panes[0].y)].fg, foreground);
assert_ne!(foreground, bottom[(panes[1].x, panes[1].y)].fg);
assert_eq!(bottom[(panes[1].x, panes[1].y)].fg, theme::paint(theme::ATTENTION));
```

(Keep the `bottom[(panes[0].x, panes[0].y)].symbol() == "┌"` and `panes[1]` symbol assertions unchanged.) Update the doc comment at ~line 1182 and the inline comment "the focused one's frame in the accent" → "in the theme foreground".

- [ ] **Step 2: Run the failing test**

Run: `cargo test the_preview_draws_the_status_bar_where_it_goes_and_the_boxes_in_their_colours -- --nocapture` (in `tui/`).
Expected: FAIL — focused preview frame is the accent.

- [ ] **Step 3: Change the preview box frame**

In `tui/src/settings.rs` `preview`, the boxed frame line:

```rust
let frame = Style::default().fg(if here { fg } else if i == 1 { theme::paint(theme::ATTENTION) } else { pal.border }).bg(pbg);
```

Only the `if here { accent }` term changes to `if here { fg }`. Leave arrows, indicators, content lead text, and the status window name on `accent`.

- [ ] **Step 4: Run the crate tests**

Run: `cargo test` (in `tui/`).
Expected: 366 passed, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add tui/src/settings.rs
git commit -m "feat(tui): Appearance preview focused box uses the theme foreground"
```

---

## Verification (full)

Run: `cargo test` in `tui/`.
Expected: all 366 tests pass, 0 fail.

Manual spot-check (optional, if a terminal is available): open `hn`, run `theme`, confirm the Appearance panel lists **Theme** first and the focused single-pane box border renders in the theme foreground.
