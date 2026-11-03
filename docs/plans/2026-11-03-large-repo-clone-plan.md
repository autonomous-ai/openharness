# Large repository clone Implementation Plan

> **For agentic workers:** this project's way of working (project instructions, Engineer role): the Engineer implements
> this plan task by task, test first, committing each failing test before its code. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Agents start on large repositories (lampOS: 576 MB pack, ~4,400 branches) on personal and Team accounts: the
project clone is blob-less and single-branch, gives up only when it stops making progress, and the Team account's clone
no longer fails on a repository that uses Git LFS when git-lfs is not installed.

**Architecture:** `cloneRepository` (cli/src/lib/projectFolder.ts) runs `git clone --progress --filter=blob:none
--single-branch`, then widens `remote.origin.fetch` back to all branches so `git fetch origin X && git checkout X` works as
in a full clone. Its fixed 5-minute deadline becomes a no-progress window: every chunk git writes on stderr (forced with
`--progress`) restarts it. The Team account's clone env (`swarmGitPrepareEnv`, cli/src/lib/swarmGitHub.ts) sets the LFS
filter only when git-lfs is on its PATH. A Swarm start doing another person's work fetches its base branch (not only the
default branch) with the app token and prefetches that tip's file contents, so the offline worktree needs no lazy fetch.

**Tech Stack:** TypeScript (Node 22), git CLI, vitest.

**Spec:** task #2394 brief (Swarm conversation f71071d79e80fffb12f9be82), restated in Findings below.

## Findings (MACs-Mac-Studio, 2026-11-03)

- Team-account env, throwaway clone of lampOS here: full clone 48 s (Homebrew git) — so the Mac Studio failure is not
  the deadline. Blob-less single-branch: 6 s. Longest stderr silence: 2.2 s full, 4.4 s blob-less.
- **Root cause of "Could not clone the repository" here:** lampOS tracks CAD files with Git LFS; git-lfs is not installed
  on this Mac; `swarmGitPrepareEnv` always sets `filter.lfs.process=git-lfs filter-process`. With Apple's git
  (`/usr/bin/git` 2.54, what an account without Homebrew runs) the checkout then fails — `git-lfs: command not found`,
  `fatal: the remote end hung up unexpectedly`, `Clone succeeded, but checkout failed`, exit 128 → CLONE_FAILED's
  generic message. Homebrew git 2.56 only warns and exits 0. Blob-less alone still fails the same way; without the
  filter entries, Apple git clones in 6 s, exit 0. Without git-lfs the LFS files stay pointer files, as in any clone on
  a machine without git-lfs.
- lampOS is public, so lazy blob fetches work there without a login; a private repository on a Team account has no login
  for them, hence Task 4.

## Global Constraints

- Out: a shared per-machine copy reused across agents. Existing project folders keep working (no re-clone forced).
- PR body first line: "Requested by scholes@autonomous.ai through Harness."
- Swarm code stays out of cli/src/core. Never run a test that signs the Mac out of the real CLI.
- Stop only processes you started, by id. Temp files only in mktemp -d folders.
- Optimizations ship on, with no on/off switches.
- Error codes stay what the apps know (CLONE_TIMEOUT, CLONE_FAILED); only the timeout's words change.

## Review Focus

1. A clone that keeps printing progress for longer than the window is never cut off (Task 2 test: slow but steady).
2. A stalled clone's git and its children are stopped, not left running (Task 2 test checks the fake git's pid is gone).
3. Existing full clones are untouched: `holdsRepository` still starts in them; nothing rewrites their config (Task 1 test:
   an existing checkout keeps its refspec).
4. An offline Swarm start never lazily fetches with the machine owner's login (Task 4: `GIT_NO_LAZY_FETCH=1` on the
   offline worktree add, test with an origin that logs any contact).
5. A Swarm start on `refs/remotes/origin/X` in a single-branch clone finds X (Task 4 test).

---

### Task 1: Blob-less single-branch clone that can still fetch other branches

**Files:**
- Modify: `cli/src/lib/projectFolder.ts` (`cloneRepository`, exported for tests)
- Test: `cli/src/lib/projectFolder.spec.ts`

**Interfaces:**
- Produces: `export function cloneRepository(url: string, destination: string, gitEnv?: NodeJS.ProcessEnv,
  options?: { stallMs?: number; git?: string }): Promise<void>` — `git` is the command (default `'git'`), `stallMs`
  the no-progress window (Task 2).

- [ ] **Step 1: Write the failing test** `clones only the default branch without file contents, and fetches another
  branch on demand`: a local origin (`git init`, `uploadpack.allowFilter=true`, `uploadpack.allowAnySHA1InWant=true`,
  commits on `main` and `feature`), `cloneRepository('file://' + origin, dest)`; expect `remote.origin.promisor` =
  `true`, `remote.origin.partialclonefilter` = `blob:none`, no `refs/remotes/origin/feature` after the clone,
  `remote.origin.fetch` = `+refs/heads/*:refs/remotes/origin/*`; then `git fetch origin feature` and
  `git checkout feature` exit 0 and the feature file has its content; `git log` and `git blame` on a main file exit 0.
- [ ] **Step 2: Run it, expect FAIL** (`cloneRepository` not exported). `npx vitest run src/lib/projectFolder.spec.ts`
- [ ] **Step 3: Implement**: args `['clone', '--progress', '--filter=blob:none', '--single-branch', '--', url,
  destination]`; on exit 0, `git -C destination config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'` in the
  same env; a failure there rejects as CLONE_FAILED.
- [ ] **Step 4: Run, expect PASS**; the whole file passes.
- [ ] **Step 5: Commit** test, then code.

### Task 2: Give up only when the clone stops making progress

**Files:**
- Modify: `cli/src/lib/projectFolder.ts` (`cloneRepository` deadline; `CLONE_STALL_MS = 120_000`)
- Test: `cli/src/lib/projectFolder.spec.ts`

**Interfaces:**
- Consumes: Task 1's `cloneRepository(..., { stallMs, git })`.

- [ ] **Step 1: Write the failing tests** with a fake git (an executable sh script in a mktemp folder, passed as `git`):
  - `gives up on a clone that stops making progress`: script prints one progress line, writes its pid to a file, sleeps
    30 s; `stallMs: 300`; rejects with code `CLONE_TIMEOUT` and message `Cloning stopped making progress. Check the
    connection and retry.` within 5 s; the pid no longer runs.
  - `never cuts off a slow clone that keeps making progress`: script prints a line every 100 ms for 1.5 s (5× the
    window), creates the destination, exits 0; `stallMs: 300`; resolves.
- [ ] **Step 2: Run, expect FAIL**: the stalled one hangs past 5 s (fixed 300 s deadline); old message.
- [ ] **Step 3: Implement**: the timer is (re)armed at spawn and on each stderr chunk (`timer.refresh()`); on expiry,
  SIGTERM then SIGKILL after 2 s, as now.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** tests, then code.

### Task 3: Team clone on an LFS repository without git-lfs

**Files:**
- Modify: `cli/src/lib/swarmGitHub.ts` (`swarmGitPrepareEnv`)
- Test: `cli/src/lib/swarmGitHub.spec.ts`

- [ ] **Step 1: Write the failing test** `sets the LFS filter only when git-lfs is on the clone's PATH`:
  `swarmGitPrepareEnv(token, { PATH: emptyDir })` → `GIT_CONFIG_PARAMETERS` has no `filter.lfs`; with an executable
  `git-lfs` in a mktemp dir on PATH → it has all three `filter.lfs.*` entries.
- [ ] **Step 2: Run, expect FAIL** (entries always present).
- [ ] **Step 3: Implement** `hasGitLfs(path: string | undefined): boolean` (any PATH entry with an executable
  `git-lfs`, `git-lfs.exe` on Windows; `accessSync(X_OK)`), used to include the three entries.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** test, then code.

### Task 4: Swarm start for another person's work in a single-branch, blob-less clone

**Files:**
- Modify: `cli/src/lib/gitProject.ts` (`fetchStartBase`, offline `worktreeAdd` env)
- Modify: `cli/src/superTabs/projectFolder.ts` (`prepareSwarmStart` passes `request.branchRef`)
- Test: `cli/src/lib/gitProject.spec.ts`, `cli/src/superTabs/projectFolder.spec.ts`

**Interfaces:**
- Produces: `export async function fetchStartBase(source: string, env: NodeJS.ProcessEnv, branchRef?: string):
  Promise<boolean>` — fetches `branchRef` when it names a remote branch (`refs/remotes/origin/X`), else the origin
  default branch, with exactly that ref's refspec; then, in a partial clone (`remote.origin.promisor`), fetches the
  tip tree's missing objects (`git rev-list --objects --missing=print <tip>^{tree}` → `?oid` lines →
  `git fetch --no-tags --no-write-fetch-head --filter=blob:none --stdin origin`) in the same env. `fetchDefaultBranch`
  stays as `fetchStartBase(source, env)`.
- `prepareSwarmStart`'s `deps.fetch` becomes `typeof fetchStartBase`, called with `request.branchRef` when it is a string.

- [ ] **Step 1: Write the failing tests**:
  - gitProject: `fetches a start's remote base branch and its file contents, so the offline worktree needs no fetch`:
    blob-less clone of a local origin; commit on origin `feature`; `fetchStartBase(clone, env, 'refs/remotes/origin/feature')`
    → true; move the origin away; `prepareGitProject(clone, { worktree: true, offline: true, ref:
    'refs/remotes/origin/feature', ... })` succeeds and the new file has its content.
  - gitProject: `an offline worktree never fetches missing contents`: blob-less clone, new commit on origin main fetched
    without its blobs (`git fetch` with explicit refspec only); `prepareGitProject(..., offline: true)` rejects and the
    origin's upload-pack was never run (origin's `uploadpack.packObjectsHook` writes a marker file).
  - superTabs/projectFolder: `prepareSwarmStart` passes the request's `branchRef` to `fetch`.
- [ ] **Step 2: Run, expect FAIL** (`fetchStartBase` missing; offline lazy fetch reaches origin; branchRef not passed).
- [ ] **Step 3: Implement** as in Interfaces; the offline worktree add runs with `GIT_NO_LAZY_FETCH=1`.
- [ ] **Step 4: Run, expect PASS**; `gitProject.spec.ts`, `projectFolder.spec.ts` (both), `cloneTrust.spec.ts` pass.
- [ ] **Step 5: Commit** tests, then code.

### Task 5: Evidence

- [ ] Typecheck (`npm run typecheck` in cli) and the affected spec files; red/green evidence as a PR comment.
- [ ] Before/after start times on lampOS in the PR: throwaway clones above, plus a real Team-account start on lampOS
  once the build runs on a Team account (log, blame, checkout of another branch in its folder).
- [ ] PR notes the lampOS LFS case (no git-lfs: pointer files, warnings only on Homebrew git; Apple git failed).
