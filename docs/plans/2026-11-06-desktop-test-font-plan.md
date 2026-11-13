# Desktop tests draw with a real font on Linux CI (task #3511)

> Implemented test first, by superpowers:test-driven-development. No subagent-driven-development and no execution
> handoff.

**Goal:** One-line layout checks run on Linux CI instead of skipping there, because Desktop tests can draw with a real text face on every machine.

**Architecture:** `loadPreviewFonts` (desktop/test/box_render_preview_test.dart), the shared helper tests call for real
faces, finds macOS's system face or the Flutter SDK's cached Roboto. Linux CI has neither, and the app's text on Linux asks
for `Ubuntu Sans` and its fallbacks (lib/shared/theme/app_type.dart), which the helper never registered, so text stays in
the test font, one em per glyph. The helper gains a bundled Roboto (desktop/test/fonts, Apache-2.0 with its licence) as
the last fallback, registered under the Linux families too. A one-line check then drops its skip.

**Tech Stack:** Flutter widget tests (desktop/test).

**Spec:** task #3511's brief (2026-11-06).

## Global Constraints

- Desktop tests only (desktop/test). Nothing in lib/ changes.
- Never run a test that signs the Mac out of the real CLI: these use no sign-in at all.
- What the helper already loads on a Mac stays as it is, so existing screenshots do not move.

## Review Focus

- On a machine with neither the system face nor the SDK's Roboto, the helper still gives the app's text a real face, for
  the families both macOS and Linux ask for.
- The one-line check measures something real: a too-narrow cell wraps, the built width fits.

## Tasks

### Task 1: a real face everywhere

**Files:** `desktop/test/box_render_preview_test.dart` (loadPreviewFonts), `desktop/test/fonts/` (Roboto-Regular.ttf,
LICENSE), `desktop/test/preview_fonts_test.dart` (new).

- [ ] Failing test: with no system face and no SDK cache, after loadPreviewFonts the app's control text and the Linux
  family measure "i" narrower than "W"; "3m06 · 9m59" wraps in a 40 px cell and fits in a 96 px cell.
- [ ] Code: the bundled fallback and the Linux families.
