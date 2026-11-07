# Swarm elements: agent face, Lead ring, task status marks, design system and gallery (task #4461)

**Goal:** Build anh Dee's three picks (an agent face, a gold ring for Leads, clear task status marks) and write them
into the design system with a gallery test against checked-in images, so every future Swarm element follows it.

**Architecture:** The face replaces the pixel pattern inside `SuperTabAvatarFace` (`avatar_art.dart`), so every
place that already draws an agent without a picture (rows, cards, chat, profile) gets it with no call-site change
beyond the renamed flag. The Lead ring replaces the crown inside `SuperTabAvatar`, painted outside the avatar's box.
The status marks change in `SuperTabTaskStatusMark` and, for Failed, in the shared `ActivityMark`. Colours live as
named roles in a theme file so `check-ui-style.py` stays clean.

**Tech Stack:** Flutter (Desktop), flutter_test goldens with a small pixel tolerance so macOS and Linux agree.

**Spec:** task #4461 brief (anh Dee, 11-07 15:25): exact numbers below.

Way of working: the project's Engineer flow: plan first, each task's failing test committed before its code, one
pull request, one independent review.

## Global Constraints

- Desktop and docs only. Keep every row's size and layout: the ring is drawn outside the avatar's box.
- People keep their photo or initial; an agent's chosen picture still wins over the face.
- Light and dark draw the same face art.
- Terminal text (the CLI, native tab marks) keeps `✗`; no Flutter status draws an X.
- The leaderboard's #1 crown stays.
- Out of scope: the left pane layout, the top bar.

## Review Focus

- The face numbers: palette by `hash % 8`, eyes, mouth, shift `[-3,0,3][(hash>>9)%3]`, tilt
  `[-9,-4,0,5,10][(hash>>5)%5]`, ink `#221F29`.
- The ring: hsl(42 92% 58%), stroke 5% of the diameter, gap 7%, outside the box; the Lead label is spoken.
- The gallery is deterministic on macOS and Linux (test font for text, tolerance for anti-aliasing).

## Task 1: the agent face

**Files:** `desktop/lib/super_tabs/avatar_art.dart`, `desktop/lib/shared/theme/swarm_palette.dart` (new),
`desktop/test/super_tab_avatar_test.dart`, call sites passing `pattern: true`.

**Interfaces:** `superTabAgentFace(String name) → ({Color top, Color bottom, double shift, double tilt})`;
`SuperTabAvatarFace.face` (was `pattern`), key `super-agent-face`.

- [ ] Test: the face of a name has the palette entry, shift and tilt its hash picks, is stable, ignores case and
      outer spaces; an agent without a picture draws the face, not an initial.
- [ ] Watch it fail.
- [ ] Replace `superTabAgentPattern` and `_PatternPainter` with the face and its painter; remove the pattern and
      its CLI-parity vector test (the dial port in `cli/` is untouched; see the PR).
- [ ] Pass.

## Task 2: the Lead ring

**Files:** `desktop/lib/super_tabs/identity.dart`, `buddy_rows.dart`, `project_sidebar.dart`,
`desktop/test/super_tab_v3_left_test.dart`.

**Interfaces:** `SuperTabAvatar.agent(lead: true)` (was `crown`), key `super-lead-ring`.

- [ ] Test: a PM's row avatar wears the ring (no crown icon), the avatar keeps its size, the ring's rect is the
      face's diameter + 2 × (7% + 5%), its label says Lead; a Regular agent has none.
- [ ] Watch it fail.
- [ ] Paint the ring; drop the crown badge.
- [ ] Pass.

## Task 3: task status marks

**Files:** `desktop/lib/super_tabs/tasks/personal_task_card.dart`, `desktop/lib/widgets/harness_activity_mark.dart`,
`desktop/lib/shared/theme/app_icons.dart`, tests beside them.

- [ ] Test: Proposal draws `lightbulb`, Rejected `thumbsDown`, Stuck/Failed `triangleAlert` in the error ink;
      `ActivityMark` for failed draws `triangleAlert`, never the `✗` text.
- [ ] Watch it fail.
- [ ] Add `lightbulb` and `thumbsDown` to the catalogue; change the marks.
- [ ] Pass.

## Task 4: design system and gallery

**Files:** `desktop/design/desktop-design-system.md`, `desktop/design/icon-design-system.md`,
`desktop/test/swarm_elements_gallery_test.dart` (new), `desktop/test/goldens/swarm-elements-{light,dark}.png`.

- [ ] Gallery test drawing every Swarm element (agent faces of all eight colours, Lead ring, person avatar with
      photo-less initial, every status mark, a task card, a row) in light and dark, compared to the checked-in
      images; fails before the images exist.
- [ ] Generate the images with `--update-goldens`, inspect them, commit.
- [ ] Doc: a Swarm elements section with these rules; icon doc's activity line and status marks; UI checklist line
      "a new or changed element updates the doc and gallery in the same pull request, or it doesn't merge".
