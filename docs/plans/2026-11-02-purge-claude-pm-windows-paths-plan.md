# Purge a Claude Code PM on Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Windows, purge scrubs a Claude Code Product Manager's traces from the Team home, and touches nothing outside its own folder and session.

**Architecture:** `folderOf` in `teamPurge.ts` wants a path starting with `/`, so on Windows the scrub has no folder and the sweep holds the account for good. One platform-aware folder rule replaces it, used by the scrub and the sweep alike, with `path.win32` injectable as in #2568's `isPmCodexHome`.

**Tech Stack:** TypeScript, Node `path`, Vitest with real files in throwaway folders.

**Spec:** Windows audit W3, `docs/security/2026-11-02-team-account-windows.md` on PR #2568 (task #2022).

## Global Constraints

- PR body starts with: Requested by scholes@autonomous.ai through Harness.
- Two security reviews (it deletes data): Quinn 2 and Reed.
- Swarm code stays out of `cli/src/core`.
- It fails closed: what can't be named or read holds the account, and no message names a path.
- macOS and Linux behaviour does not change, beyond refusing more forms of a root.

## What Claude Code writes (2.1.316, read from its own bundle)

- Config keys (`.claude.json` `projects`): function `U3` replaces `\` with `/` on Windows, so `C:/Users/...`. Older records and the #1647 spec have `C:\Users\...`, so both are matched.
- `githubRepoPaths`, history `project` and transcript `cwd`: the native form, `C:\Users\...`, JSON-escaped on disk.
- Project folder name: every non-alphanumeric character becomes `-`, so `C--Users-...`, and names over 200 characters get a hash suffix (`EL`). The suffix is existing behaviour on every platform and is out of scope.
- Claude Code itself compares Windows paths with `\` as `/` and lowercased (`dYe`).

## Review Focus

- A drive root, `C:`, `\`, a UNC share root or `C:\a\..` as the folder: no folder, so nothing is matched by folder.
- `C:\a\b` must not match `C:\a\b-evil` or `C:\a\b2`, in any list, in any case.
- A sweep over JSON text: `C:\\a\\b` on disk must be seen, or a purge reports clean with traces left.
- Another folder sharing the slug (`C:\a\.b` and `C:\a-b`): its transcripts stay and the memory folder holds the account.
- A POSIX path handed to the Windows rules, and a Windows path to the POSIX ones: refused, not guessed.

---

### Task 1: One folder rule for scrub and sweep

**Files:**
- Modify: `cli/src/superTabs/inCore/teamPurge.ts`
- Test: `cli/src/superTabs/inCore/teamPurge.spec.ts`

**Interfaces:**
- Produces: `FolderPaths = Pick<PlatformPath, 'isAbsolute' | 'normalize' | 'parse' | 'sep'>`, a last optional `paths` argument on `scrubClaudeSession`, `sweepForSession` and `recordsOtherFolder`, and `paths?` on `createConfidentialPurge`'s deps. All default to the host's `node:path`.

- [ ] **Step 1: Write the failing tests** in a `describe('on Windows')` with `path.win32`, a home holding `C:\Users\team\swarm\app\.worktrees\pm`: `scrubs the PM and only the PM, its memory too`; `it.each` of `C:/...`, mixed separators, `c:\...` and a trailing separator; `refuses a root` for each Review Focus form; `keeps what only looks like its folder`; `the sweep sees JSON-escaped and forward-slash forms`; `a shared slug keeps the other folder's transcript and holds the account`; `the whole purge answers ok` through `createConfidentialPurge`; `nothing outside the home is touched`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/superTabs/inCore/teamPurge.spec.ts`
Expected: FAIL, with the Windows purge answering `SCRUB_INCOMPLETE`.

- [ ] **Step 3: Implement** `folderOf(target, paths)` and `folderKey(path, paths)`. On Windows the key is the normalized path with `/`, no trailing separator, lowercased; on POSIX it is the path as given. `foldersOf`, `recordsOtherFolder`, `withoutFolder`, the history filter and the sweep compare by key; the sweep folds the text it reads the same way.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/superTabs/inCore/teamPurge.spec.ts && npx tsc --noEmit -p .`
Expected: PASS, and no type errors.

- [ ] **Step 5: Commit**

```bash
git add cli/src/superTabs/inCore/teamPurge.ts cli/src/superTabs/inCore/teamPurge.spec.ts
git commit -m "Team purge: a Claude Code PM's folder by the platform's own path rules"
```

## Design

- **Growth:** nothing new is stored.
- **Concurrency:** unchanged; `rewriteIfUnchanged` still guards each rewrite.
- **Read cost:** unchanged, plus one text fold per file on Windows only.
- **Scale:** N/A because this runs once per purged session.
- **Compatibility:** no wire or record change. A held Windows account's record finishes on its next retry.
- **Migration and rollback:** none. A rollback holds such an account again.
- **Audience, identity:** N/A because no reader or login changes.
- **Failure:** a refused folder leaves only session-id matching, and the sweep still holds the account while anything names the session.
- **Platforms:** the rule is chosen by `path`. A real Windows home could not be checked from here unless a Windows machine is free; the PR says so.
