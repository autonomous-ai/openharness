# Role Tools Sheets Implementation Plan

> Implement task by task, test first, following the project's Engineer workflow (project instructions, Engineer).

**Goal:** Every agent reads the Swarm tools it uses, not the whole 24 KB manual. The PM gets a sheet of at most 3 KB, the Engineer, Reviewer, Tester and Guide at most 6 KB each. The full manual stays one command away.

**Architecture:** `cli/src/lib/swarmToolSheets.ts` reads the unchanged full manual (`SWARM_TOOLS_SKILL`, still the single source of the rules) as blocks (a bullet with its sub-bullets, or a paragraph). A table gives each block exactly one owner (`core` or one role), the roles whose sheets carry it as a one-liner, and that one-liner. A sheet is built from the table, so a new rule in the manual with no owner fails a test. `launch` and the host's refresh write the sheet for the session's role; `harness super-tab help tools` prints the full manual.

**Tech Stack:** CLI TypeScript (Vitest specs).

**Spec:** Swarm task #3448 brief (Dee's Swarm redesign, 2026-11-05) and River's answer: one source, one-line forms for the PM sheet, full manual through `help tools`, every section owned once, role sheet swapped on the host refresh; rules the server already enforces may be one-liners even in engineer sheets.

## Global Constraints

- The full manual's text does not change: the tests and records that hold its version stay valid. Only sheets are new.
- A sheet leaves rules out, never changes one: each one-liner restates its rule in fewer words, and the full text is in `help tools`.
- Role of a session: the coordinator gets the PM sheet at launch and on refresh. An agent gets the Engineer sheet at launch (the launch knows only "agent"), and the host refresh swaps in the Reviewer, Tester or Guide sheet by the project role's name (anything else keeps the Engineer sheet). A Reviewer started as the fallback role gets the Reviewer sheet.
- Swarm code stays out of cli/src/core. Desktop tests use a memory store and a fake sign-in. Specs run with a scratchpad TMPDIR.

## Design

- growth: N/A because it stores nothing new; sheets are files in the session's skill folder, replaced on a text change as the manual is.
- concurrency: N/A because it is pure text built at launch and on the host's refresh, which already serializes by session.
- read cost: the point of the task: PM 24 KB to at most 3 KB, other roles at most 6 KB.
- scale: N/A because it is constant text.
- compatibility: the manual (`SWARM_TOOLS_SKILL`) is unchanged; a session launched before this release keeps its manual until the refresh rewrites it to its sheet, with the existing notice.
- migration + rollback: no migration; rolling back writes the manual again through the same refresh.
- audience: N/A because the sheets are the same public tool text.
- identity: N/A because no account is read.
- failure: an unknown project role name gets the Engineer sheet, which names `help tools` for everything else.
- platforms: CLI text on macOS, Linux and Windows.

## Review Focus

- Every rule of the manual is still reachable: owned once, in a sheet or only in `help tools`, never lost.
- The launch and the refresh write the same text for the same role, so a normal start sends no extra "tools changed" notice.

## Task 1: sheets from the manual

**Files:** Create `cli/src/lib/swarmToolSheets.ts`, `cli/src/lib/swarmToolSheets.spec.ts`.

- [ ] Failing specs: blocks and owners partition the manual; sheet sizes; each role holds its commands; the union of sheets names every command of the manual.
- [ ] The parser, the table and `swarmToolsSheet(role)`.

## Task 2: delivery by role

**Files:** modify `cli/src/lib/swarmSkills.ts`, `cli/src/lib/swarmInstructionsSkill.ts` and their specs; `cli/src/superTabs/command.ts` (`help tools`).

- [ ] Failing specs: launch writes the coordinator's PM sheet and an agent's Engineer sheet; the refresh swaps a Reviewer's; `help tools` prints the manual.
- [ ] Wire them.
