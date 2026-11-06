# Desktop Machines screen follows the design standard — plan (task #3801)

**Goal:** The Desktop Machines screen (Swarm sidebar and Manage ▸ Machines) meets the Machines design standard Scholes
asked for: status-first grouping with the reader's own machines pinned; collapsed crew counts; one fixed row anatomy;
four type sizes; token-only colour, light and dark; real loading, empty and error states; keyboard and VoiceOver.
No reference doc is coming (Scholes, 11-06): the brief is the spec.

**Architecture:** `SuperTabMachines` (`desktop/lib/super_tabs/machines.dart`) already draws one row per machine with a
fixed anatomy (`_MachineLine`), a spoken label per row, the context menu on the keyboard (Menu, Shift+F10), the crew
collapsed to one count line (`superTabMachineCrewLine`, "3 crew · 1 asleep"), the four `DesktopChrome` text roles and
`grid` colour tokens. What it lacks: the rows are one list sorted by status, not grouped; nothing is pinned; while the
Swarm is first read the screen says "Add a machine…" as if it had none; and a Swarm that can't be read shows the same
empty note under its pill. This change groups the sorted rows under headings (Yours, Online, Status unknown, Offline,
each with its count; Yours first and only when the reader owns a machine there), and gives the screen a loading state
(skeleton rows) and an error state (what failed, with Retry). Data, filters, row actions and menus are unchanged.

**Tech Stack:** Flutter 3.47 (Desktop), `flutter_test` with `ConversationServer` (memory store, fake sign-in).

**Spec:** River's brief on task #3801 (Scholes, 11-06), and River's note that no reference doc is coming.

This plan is written and carried out by its Engineer, test first; there is no execution handoff.

## Design

N/A beyond the screen: no stored data, no server read or command, no migration. The groups come from the statuses and
owners the screen already reads.

## Global Constraints

- Same rows, actions, menus and filters; only their grouping and the screen's states change.
- Harness design language (`scripts/check-ui-style.py`), light and dark; the four `DesktopChrome` text roles only.
- Desktop tests use a memory store and a fake sign-in. No process starts (Windows: no window flash).

## Review Focus

- Every machine is in exactly one group; the reader's own are in Yours whatever their status.
- Loading is never shown as empty, and an unreadable Swarm is never shown as having no machines.
- Headings are announced as headings; each row keeps its spoken label and keyboard menu.

## Tasks

### 1. Status groups, the reader's machines pinned (`machines.dart`)

- [ ] Failing test: machines of the reader and of others, live, unknown and offline, sit under Yours, Online, Status
      unknown and Offline in that order, each heading with its count and announced as a heading; no empty group shows.
- [ ] Code.

### 2. Loading and error states (`machines.dart`)

- [ ] Failing test: before the Swarm is read the screen shows its loading rows, not "Add a machine"; a Swarm that can't
      be read and holds no machine says so with Retry, which reads it again; a read Swarm with none shows the empty note.
- [ ] Code. Light and dark screenshots of the grouped list.
