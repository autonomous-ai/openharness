# #4717: one Swarm gallery image per element — Plan

> Written by the Engineer and implemented by it, task by task, test first. No Execution Handoff.

**Goal:** Every Desktop PR changed the same two gallery images (`swarm-elements-{light,dark}.png`), so each merge made the
next PRs conflict, re-push and lose their reviews. Each element section gets its own image per brightness, so two PRs that
change different elements never touch the same file.

**Architecture:** `test/swarm_elements_gallery_test.dart` draws the same page, with each section in its own `RepaintBoundary`
and its own image, `test/goldens/swarm-elements/<section>-<light|dark>.png`. Each section's regions and words are checked in
its own coordinates. A test holds the doc's Swarm elements, `_Gallery.sections` and the image files to one set.

**Tech Stack:** Flutter widget tests, golden files.

**Spec:** Task #4717.

## Global Constraints
- Desktop tests, goldens and the design doc only; nothing the app draws changes.
- The per-element tolerances stay; the 38-pixel budget outside words applies per section.

## Review Focus
- Each section image shows what the old image showed there; no element falls outside every section.

## Tasks

### 1. A section per image
Files: `desktop/test/swarm_elements_gallery_test.dart`, `desktop/test/goldens/swarm-elements/`, `desktop/design/desktop-design-system.md`
- [ ] Failing test: every section matches its own image in light and dark; a changed face fails its section; the doc's elements, the sections and the images are one set.
- [ ] Code: the images, the old two removed, the doc's gallery paragraph and its Adding line.
