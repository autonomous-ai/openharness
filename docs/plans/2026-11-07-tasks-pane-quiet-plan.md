# Tasks pane: quiet cards (task #4468)

**Goal:** Redraw the Swarm Tasks pane to anh Dee's quiet rules: a plain header, hairline cards, a grey project
capsule, 18-point faces, and Approve and Reject only while a task waits.

**Architecture:** Two files change. `personal_task_card.dart` draws the card: a hairline at radius 10 with no shadow,
the project tag as a neutral capsule, the status mark top right, the title, then two 18 faces and, while the task
waits, Reject as text and Approve as the theme's blue capsule. `personal_tasks_pane.dart` draws the header: "Tasks"
13 semibold, and the approval choice as plain 12 secondary text on the app's one dropdown (`AppDropdown`), whose
chevron and fill show only on hover or while open. Status marks and faces come from #4461 (PR #3533); main is merged
after it lands, then the Tasks pane joins its gallery and design-doc section.

**Tech Stack:** Flutter (Desktop), flutter_test widget tests, the #4461 gallery goldens.

**Spec:** task #4468 brief (River, from anh Dee's agreed redraw, 11-07 15:35).

Way of working: the project's Engineer flow: plan first, each task's failing test committed before its code, one
pull request, one independent review.

## Global Constraints

- Desktop only; only `desktop/lib/super_tabs/tasks/` plus the doc and gallery entries for what changes.
- Named roles only (`scripts/check-ui-style.py` stays clean): card `AppCard.base`, hairline `DesktopChrome.rim`,
  radius `AppDesktop.rowRadius` (10), tag fill `AppSurface.wellFill`, tag and mode text `DesktopChrome.muted`.
- Sizes: "Tasks" 13 semibold; title 13 medium, up to three lines; details 12; faces 18.
- Grey everywhere; blue only on Approve; colour only on agent faces.
- Light and dark, the pane at 340 inside windows of 880 and wide.

## Review Focus

- The mode choice keeps its width on hover: the chevron's room is held at rest, so the text never jumps.
- A selected card differs from the others by fill alone, without a blue rim or a shadow.
- A long project name ellipsizes inside its capsule and never pushes the status mark off the card.
- A task that stops waiting loses Approve and Reject at once; a disabled pair still shows while a change is sent.
- Keyboard: the mode choice opens with Enter or Space and shows its chevron while focused.

## Task 1: the quiet card

**Files:** `desktop/lib/super_tabs/tasks/personal_task_card.dart`, `personal_tasks_pane.dart` (face size),
`desktop/test/super_tab_personal_tasks_pane_test.dart`.

**Interfaces:** removes `superTabProjectColor`; `SuperTabPersonalTaskCard` becomes stateless, same parameters.

- [ ] Test: the tag is filled `AppSurface.wellFill` with `DesktopChrome.muted` text; the card is a `DesktopChrome.rim`
      hairline at radius 10 with no shadow, selected or not; both faces are 18; a long project name keeps the mark
      inside the card.
- [ ] Watch it fail.
- [ ] Draw the card; drop the project colour and its test.
- [ ] Pass.

## Task 2: the quiet header

**Files:** `desktop/lib/super_tabs/tasks/personal_tasks_pane.dart`, `desktop/test/super_tab_personal_tasks_pane_test.dart`.

**Interfaces:** the trigger keeps key `tasks-approval-mode`; rows are `AppMenuItem`s with the stored one selected.

- [ ] Test: "Tasks" is 13 semibold; the choice shows "Auto approve" in 12 secondary text with its chevron invisible
      at rest and visible on hover and focus, the same width both ways; no `DropdownButton`; picking Review sends
      the command once.
- [ ] Watch it fail.
- [ ] Draw the header.
- [ ] Pass.

## Task 3: gallery and doc (after #4461 merges)

**Files:** `desktop/test/swarm_elements_gallery_test.dart`, its goldens, `desktop/design/desktop-design-system.md`.

- [ ] Merge main; resolve the status mark in the card toward #4461's marks.
- [ ] Gallery: the Tasks header and a waiting, a working and a selected card in light and dark; fails before the
      images are regenerated.
- [ ] Regenerate with `--update-goldens`, inspect, commit.
- [ ] Doc: the Tasks pane card and header lines in the Swarm elements section.
- [ ] Screenshots: the pane in light and dark at 880 and wide.
