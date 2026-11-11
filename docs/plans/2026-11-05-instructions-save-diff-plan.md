# Instructions save shows the real change: implementation plan

**Goal:** The project-chat line an instructions save posts shows the items the save really added and removed, so a PM's
"I wrote it into the instructions" can be checked against the saved text.

**Architecture:** The save already holds both texts: the store loads the current revision into the command context
(`context.instructions`, store.ts) to refuse a stale save, and the command carries the new one. `saveInstructions`
(commands.ts) compares the two once, at save, by item: a bullet, a numbered step, a paragraph or a fenced block with its
wrapped lines joined and its list marker dropped, and each heading (Ken's review: instructions are hard-wrapped, so a
line diff showed a rewrapped bullet as fragments). The notice's text writes each changed item in words, "Added:" or
"Removed:", under its section path ("In Routing › Models:"): at most 12 items, then "and N more changes." No diff block
and no colouring (River's call on Ken's review), so it reads the same on Desktop, web, phone, CLI agents and older
clients. The notice's `source` keeps `{ kind: 'instructions', projectId,
revision }`; Desktop/web and phone add a "See revision N" link under it, which opens that revision in the existing
Instructions panel (Desktop) or a read-only revision page (phone).

**Tech Stack:** TypeScript and Vitest (backend), Flutter and flutter_test (desktop, mobile).

**Spec:** Swarm task #3021, "An instructions save shows the real lines added and removed", requested by Ken.

**Execution:** Task by task, each failing test committed before its code, by the project's Engineer workflow.

## Global Constraints

- No new query anywhere: the diff uses the text the save path already reads, computed once per save.
- The PM's summary stays the notice's first line; it never replaces the diff.
- The change is bounded: at most 12 items shown, each cut to 400 characters; the item comparison is bounded in work,
  and past that bound it reports the changed region as removed and added (still real items, never invented).
- Every line of the change starts with "In", "Added", "Removed" or "and", so a saved item's Markdown cannot open a
  heading, list, quote, code block or table in the chat. The row carries no mentions, so an `@name` in it tags nobody.
- When the earlier text cannot be read, the notice says so instead of showing no change.
- Swarm code stays out of cli/src/core. Desktop tests use a memory store and a fake sign-in.
- PR body starts with "Requested by 0xKen15 through Harness."

## Design

- Growth: N/A because nothing new is stored beyond about 2 KB more text in a notice row the save already writes; rows go
  with their conversation as today.
- Concurrency: unchanged; the save's existing Swarm transaction and revision check.
- Read cost: no new read; the previous text is already in `context.instructions` for both `instructions.save` and
  `rule.set`.
- Scale: a 64 KB document is at most about 2,000 items; the comparison trims the common head and tail and runs Myers'
  diff up to 1,000 edits (about 2 MB of trace), so a save costs milliseconds. Warns first: save latency in the command
  timing log.
- Compatibility: old clients render the new text as plain lines and show no link; new clients reading old notices show
  the link only (old text has no change). No command or field changes.
- Migration + rollback: none; reverting restores summary-only notices, and posted notices keep their text.
- Audience: the notice goes to the project chat, whose readers are the project's readers, who already read the whole
  document; the revision link uses the existing revision read and its server checks.
- Identity: the notice is written in the saver's name as today; never the machine owner's login.
- Failure: an unreadable earlier revision says "The earlier revision could not be read, so the change is not shown."; a
  revision no longer kept says so on the revision page.
- Platforms: backend for everyone; Desktop on macOS, Windows, Linux and web share the row; phone on iOS and Android.

## Review Focus

- The diff is computed from the stored previous revision and the saved text, never from the summary.
- Long changes show exactly 12 items and the right "and N more changes" count (singular for 1).
- A rewrap alone is no change; renumbered steps are no change; each change names its own section.
- A saved item holding a heading, fence, quote or table cannot open a block in the chat.
- `rule.set`, a first save from the template (revision 0) and an unchanged save keep working.

## Task 1: The line diff and the notice text (backend)

**Files:** `backend/src/superTabs/instructionsDiff.ts` (new), `backend/src/superTabs/instructionsDiff.test.ts` (new),
`backend/src/superTabs/commands.ts` (`saveInstructions`, `instructions.save`, `rule.set`),
`backend/src/superTabs/instructions.test.ts`, `backend/src/superTabs/commands.test.ts`.

**Interfaces:** `instructionsChange(before: string | null, after: string): string` returns the words that follow the
notice's summary line.

- [x] Tests: a save posts the added and removed items of the real revision; a long change shows 12 items and "and N
      more changes"; rewraps and spacing alone; joined paragraphs; renumbered steps; section paths; no block can open;
      unreadable earlier text says so; rule.set shows its added item.
- [x] Run them and record the failures.
- [x] Implement `instructionsChange` and pass the previous text into `saveInstructions`.

## Task 2: "See revision N" on Desktop and web

**Files:** `desktop/lib/super_tabs/model.dart`, `desktop/lib/super_tabs/message_row.dart`,
`desktop/lib/super_tabs/instructions_panel.dart`, `desktop/lib/super_tabs/view.dart`, and their tests.

**Interfaces:** `SuperTabMessage.instructionsRevision` (int?, from a source of kind `instructions`);
`showSuperTabInstructions(context, c, projectId, {int? revision})` opens History with that revision picked.

- [x] Widget test: an instructions notice shows "See revision N", and tapping it opens the panel on that revision.
- [ ] Implement; light and dark screenshots.

## Task 3: "See revision N" on the phone

**Files:** `mobile/lib/swarm/model.dart`, `mobile/lib/swarm/swarm_message_row.dart`,
`mobile/lib/swarm/swarm_instructions_page.dart`, and their tests.

- [ ] Widget test: the notice shows the link; the page opened with a revision reads that revision, read-only.
- [ ] Implement; light and dark screenshots.
