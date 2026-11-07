# Team-written trust leaves with its worktree Plan

**Goal:** The Claude folder trust a Team-written start saves in the person's own Claude settings is removed when Harness
removes that start's worktree, and a Team-written start never runs, so never saves trust, in the owner's main checkout
(task #4353, follow-up of #4307 / PR #3485).

**Architecture:** A Team-written Claude start saves trust only for the worktree Harness made for it
(`core/agents/launches.ts` `swarmCheckout`), a path that did not exist before the start, so any trust entry for that exact
path was saved during its life. The person's own answers live under other keys (the main repository, a folder above it),
and are never touched. `cli/src/superTabs/machines.ts` marks a Team-written start's worktree record, and wherever it
removes that worktree (a stopped worker, a folder already gone, a machine removed from the Swarm) it clears the trust flag of
that exact path, with one atomic write of the settings file (`engines/kit/folderTrust.ts` `forgetTrustIn`). A
Team-written start that names no worktree (the owner's main checkout) is refused in `cli/src/superTabs/start.ts` before
anything is made, saying why.

**Tech Stack:** TypeScript, Node `fs`, vitest.

**Spec:** the task brief of #4353.

This plan is implemented by its Engineer, task by task, test first.

## Global Constraints

- CLI only. Never read or copy a Claude login or credential.
- Change only the one trust flag Harness saved, for that exact folder, written atomically through `replaceConfigFile`.
- No other start or removal path changes.

## Review Focus

- Only the flag of the removed worktree's exact path is cleared; a person's earlier trust (main repository, parent folder)
  stays; no other key of the settings file changes; the write is atomic.
- A Team-written start never runs in, or saves trust for, the owner's main checkout.

## Task 1: Forget one folder's trust

**Files:** `cli/src/engines/kit/folderTrust.ts`, `cli/src/engines/kit/folderTrust.spec.ts`, `cli/src/engines/launchPrep.ts`

**Interfaces:** `forgetTrustIn(trust, file, path): 'forgotten' | 'absent' | 'skipped'`; `FolderTrust.forget(path)`.

- [ ] Write failing specs: a recorded folder's flag is cleared and every other key of the file is kept; a folder above it,
      another folder and the rest of the entry stay; a file that is missing, unreadable or not the engine's shape is left as
      it is; a TOML engine is skipped.
- [ ] Watch them fail, then add `forgetTrustIn` and `FolderTrust.forget`.

## Task 2: Remove it with the worktree

**Files:** `cli/src/superTabs/machines.ts`, `cli/src/superTabs/machines.spec.ts`

- [ ] Write failing specs: a Team-written start's worktree record is marked; its trust is saved by the start and cleared
      when the stopped worker's worktree is removed, when its folder is already gone, and when the machine is removed from
      the Swarm; a worktree kept (work or a session in it) keeps its trust; a normal start's trust and the person's own
      trust on the main repository stay.
- [ ] Watch them fail, then mark the record and forget the trust at each removal.

## Task 3: Never the owner's main checkout

**Files:** `cli/src/superTabs/start.ts`, `cli/src/superTabs/start.spec.ts`

- [ ] Write a failing spec: a Team-written Claude start off a Team daemon that names no worktree is refused before
      anything is made, saying why; one with a worktree starts as before.
- [ ] Watch it fail, then refuse it.
- [ ] Run the changed specs, the specs of what imports them, and the local checks `scripts/local-checks.py --list` names.
