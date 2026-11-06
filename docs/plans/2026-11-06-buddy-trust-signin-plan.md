# A Buddy never goes silent on Claude's trust or sign-in screen — Plan

**Goal:** On a computer where Claude Code was never used or is not signed in, a Buddy no longer stops on Claude's "trust this folder?" or sign-in screen with a silent chat.

**Architecture:** `trustBuddyHome` already records Claude's trust for the Buddy's own Harness-made folder, but `recordTrustIn` does nothing when `~/.claude.json` does not exist (Claude never ran here), which is exactly the reported machine. A `create` option lets that one caller write the file holding only that folder's entry. A Buddy start whose Claude reads signed out (`engineAccount('claude')`) is refused before anything is reserved or launched.

**Tech Stack:** TypeScript, vitest (cli/src).

**Spec:** task #3737. Works the same on Windows: the key written is the folder as the engine compares it (`folderText`), no process is started.

## Global Constraints
- Trust only the Buddy's own Harness-made folder, never a parent or home folder.
- #3713 (PR #3341, `superTabs/agentFolder.ts`) records trust for Swarm agent folders the same way; it gets the new `create` option by calling `record(path, { create: true })`, not by a second copy of this code. This plan touches `start.ts` only at the Buddy lines.
- The refusal never applies to a Buddy on a grid model (it does not use Claude's sign-in) or to a Codex Buddy.

## Review Focus
- `create` never overwrites or rewrites an existing file; a race with Claude Code writing its own file loses to Claude's (`wx`).
- The refusal reads presence only (`engineAccount`), never a secret.

## Task 1: trust file created for the Buddy's folder
**Files:** `cli/src/engines/kit/folderTrust.ts`, `cli/src/engines/launchPrep.ts`, `cli/src/superTabs/buddyHome.ts`; tests `folderTrust.spec.ts`, `buddyHome.spec.ts`.
**Interfaces:** `recordTrustIn(trust, file, cwd, { create?: boolean })`; `FolderTrust.record(path, { create?: boolean })`.
- [ ] Failing tests: `create` writes a missing `.claude.json` with only the folder's entry; without it the answer is still `skipped`; `trustBuddyHome` on a machine with no `.claude.json` trusts the home.
- [ ] Implement.

## Task 2: Buddy start refused when Claude is signed out
**Files:** `cli/src/superTabs/start.ts`; test `start.spec.ts`.
**Interfaces:** `BUDDY_CLAUDE_SIGNED_OUT = 'Sign in to Claude Code on this computer first'`.
- [ ] Failing tests: a Claude Buddy start with `signedIn: false` is refused with that sentence, nothing reserved; signed in, signed-out Codex, signed-out grid Buddy all start.
- [ ] Implement after the own-machine check.

## Task 3: Desktop/phone prompt note
Split to its own task: the desktop pieces (`desktop/lib/`) need Flutter widget tests, and this machine has no Flutter.
