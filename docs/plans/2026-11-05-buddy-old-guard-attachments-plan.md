# A Buddy opens the images its owner attaches again (task #3159) Implementation Plan

> Written by the task's Engineer, who implements it task by task, test first. There is no execution handoff.

**Goal:** Scholes's Buddy opens the screenshots he sends it again, with no wider access, and a download that fills the disk
says so plainly.

**Architecture:** #2832 (batch #3013) removed the Buddy guard and stopped the host listing the files a person sends their
Buddy. A Buddy launched before it keeps running that release's guard (`.claude/buddy-guard.mjs`, run by its
`settings.local.json`) until it starts again, and that guard opens a file outside the folder only when the host listed it
(exact path in paste-drops, device, inode, size, SHA-256). So every attachment since the update was refused. #2979 is
Windows-only and is not the cause. The host lists the owner's files again, only for a Buddy whose folder still holds
Harness's lock, and a grant keeps what is listed.

**Tech Stack:** TypeScript, Node, Vitest.

**Spec:** task #3159.

## Global Constraints

- Only the owner's own attachments, in their own Buddy chat, by exact path, checked by the old guard as before. No other
  person's files, no other paths, nothing listed for a Buddy without the old guard.
- Swarm code stays out of `cli/src/core`. Specs run with a scratch TMPDIR.
- Remove the compatibility path after 2026-12-04, with the old saved mode in `engines/claude/launch.ts`.

## Review Focus

- `listSentToOldGuard` restores the pre-#2832 list exactly; the old guard's checks are unchanged (it is the shipped script,
  `src/__fixtures__/buddy-guard-before-2832.mjs`).
- `heldByOldGuard` is the same lock test the relaunch uses to remove the guard.
- Disk full maps ENOSPC/EDQUOT to the plain line, never a path, and leaves no part file.

## Task 1: the old guard opens the owner's file

**Files:** `cli/src/superTabs/host.spec.ts`, `cli/src/__fixtures__/buddy-guard-before-2832.mjs`, `cli/src/lib/buddyGuard.ts`,
`cli/src/lib/swarmSkills.ts`, `cli/src/superTabs/host.ts`

**Interfaces:** `heldByOldGuard(root): boolean`, `listSentToOldGuard(reads, { session, files, links }, now?)`

- [ ] Red: run the shipped guard against a delivery: the owner's picture by its delivered path is allowed, also after a
      later grant; another drop, a link, a way out, a changed file, another person's or another chat's file stay denied;
      a Buddy without the guard gets no list.
- [ ] Green: list as before #2832 for a locked folder; `heldList` keeps the entries.

## Task 2: a full disk says so

**Files:** `cli/src/superTabs/attachments.spec.ts`, `cli/src/superTabs/attachments.ts`

- [ ] Red: ENOSPC while writing or copying gives "not enough free disk space", no path, no part file, no retry.
- [ ] Green: map ENOSPC/EDQUOT to that refusal.
