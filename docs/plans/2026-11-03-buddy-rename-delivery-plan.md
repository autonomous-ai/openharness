# Buddy /rename keeps chat delivery Implementation Plan

> Way of working: this project's Engineer workflow (instructions, Engineer role): one Engineer implements every task test
> first in this session, committing each failing test before its code; the Review step on the pull request is the one
> independent review. No execution handoff.

**Goal:** After a person renames their Buddy's Claude Code session with `/rename`, chat messages still reach it, and its
Rename Buddy / Remove Buddy actions in the app work.

**Architecture:** Two independent defects, found by reproducing on a scratch Claude Code 2.1.317 session in a private
tmux server (no Buddy touched):

1. CLI. `/rename my-renamed-buddy` makes Claude Code draw the prompt box's top rule as
   `───…─── my-renamed-buddy ─`: the name, then one `─`. Harness's Claude screen reader takes a rule with text in it only
   with three or more `─` on both sides (`engines/claude/composer.ts` `CLAUDE_RULE`), so it finds no prompt box, reads
   the composer as `absent`, and every Swarm delivery is held as `prompt_hidden` (the backend cancels it as Not sent
   after an hour, deliverySettle.ts `HOLD_LIMIT_MS`). Typing by hand still works, which matches the report. The same
   strict shape is in the Windows composer finder (`engines/kit/pane.ts` `COMPOSER_RULE`) and in the takeover reader's
   composer (`engines/claude/screen.ts`, a plain rule only), whose miss makes it look for a trust or sign-in dialog
   anywhere on screen instead of below the prompt. One shared titled-rule pattern fixes all three.
2. Desktop. The Rename Buddy and Remove Buddy dialogs are wrapped in `SuperTabDialogScope(projectId: group.projectId)`.
   The one Buddy per Swarm (spec 2026-10-31-one-buddy-per-swarm) belongs to no project: its chat's `projectId` is `''`
   (`kSwarmBuddyKey`), no project has that id, and the scope shows "This action is no longer available." in place of
   either dialog. Unrelated to `/rename`; the reporter met it in the same session. The scope is given no project for the
   Swarm Buddy and is tied to the Buddy chat instead.

Recovery: the reader runs on each delivery attempt, so a Buddy already cut off takes messages again as soon as its
machine runs the fixed CLI, without being recreated or restarted. Messages already cancelled stay Not sent.

**Tech Stack:** TypeScript (vitest) in `cli/`, Dart/Flutter (flutter_test) in `desktop/`.

**Spec:** Task #2428 brief (conversation acfd840fed9ef0d72ca314f4) and River's follow-up on rename/remove.

## Global Constraints

- PR body first line: "Requested by wkpnjjhbnm@privaterelay.appleid.com through Harness."
- Swarm code stays out of cli/src/core. Never a test that signs the Mac out of the real CLI (Desktop: memory store, fake sign-in).
- Reproduce on throwaway sessions only, never on a person's real Buddy.

## Review Focus

- A long name at a narrow width: Claude Code still ends the rule with ` ─`; the pattern needs `─{3,}` at the start and `─` at the end only.
- Output in the transcript that starts at column 0 with `───` and ends in `─` must not become a second prompt box: only the rule directly above the last `❯` row counts, as before.
- A dialog drawn under the renamed box (Claude Code draws its own dialogs ruled) still reads as `absent`.
- Windows `>` composer under a titled rule reads as ready.
- The project Buddy (older chat in a project) keeps its project check in the dialog scope.

---

### Task 1: Claude Code's titled rule after /rename (CLI)

**Files:**
- Test: `cli/src/engines/claude/renamedSession.spec.ts` (new; the real 2.1.317 captures at 120 and 60 columns)
- Modify: `cli/src/engines/claude/composer.ts` (`CLAUDE_RULE`, exported), `cli/src/engines/claude/screen.ts` (takeover composer), `cli/src/engines/kit/pane.ts` (`COMPOSER_RULE`)

**Interfaces:**
- Produces: `export const CLAUDE_RULE: RegExp` in `engines/claude/composer.ts`: `^─{3,}$` or `─{3,}` at the start and `─` at the end.

- [ ] **Step 1: Write the failing test** — `screen.inspect(renamedCapture)` gives `messageHold: null` and `teamHold: null`;
      `composerState` is `'ready'`, `'ready'` with a draft (and `teamHold` `'team_waiting_draft'`), `'absent'` with a ruled
      dialog under the box; on `win32`, a `>` composer under the titled rule is `'ready'`; a renamed screen whose
      scrollback quotes the trust prompt's lines gives no `trust_open` hold.
- [ ] **Step 2: Run** `npx vitest run src/engines/claude/renamedSession.spec.ts` — Expected: FAIL (`prompt_hidden`).
- [ ] **Step 3: Implement** the shared `CLAUDE_RULE` and use it in the three readers.
- [ ] **Step 4: Run** the new spec and `src/engines` — Expected: PASS.
- [ ] **Step 5: Commit** test, then code.

### Task 2: Rename Buddy / Remove Buddy for the Swarm Buddy (Desktop)

**Files:**
- Test: `desktop/test/super_tabs/buddy_dialogs_test.dart` (new, memory store and fake sign-in via the Super Tab fixture)
- Modify: `desktop/lib/super_tabs/buddies.dart` (`confirmRemoveBuddy`, `showRenameBuddy`)

**Interfaces:**
- Consumes: `SuperTabController.kSwarmBuddyKey`, `SuperTabController.buddyChat(projectId)`.

- [ ] **Step 1: Write the failing test** — with a Swarm Buddy (`swarmBuddy: true`, a `swarm-buddy` chat), opening Rename
      Buddy shows its name field and saving sends `buddy.rename`; opening Remove Buddy shows "Remove Buddy?" and Remove
      sends `buddy.remove`; neither shows "This action is no longer available."
- [ ] **Step 2: Run** `flutter test test/super_tabs/buddy_dialogs_test.dart` — Expected: FAIL (the unavailable dialog).
- [ ] **Step 3: Implement** — pass `projectId` only when it is not `kSwarmBuddyKey`, and `conversationId` of the Buddy chat.
- [ ] **Step 4: Run** the test and the existing Buddy tests — Expected: PASS.
- [ ] **Step 5: Commit** test, then code.
