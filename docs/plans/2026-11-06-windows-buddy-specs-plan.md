# Buddy and start specs pass on Windows: Implementation Plan

> Way of working: this project's Engineer role. Each plan task is test first (superpowers:test-driven-development): the
> failing test is committed and watched fail before its code. Steps use checkbox (`- [ ]`) syntax.

**Goal:** On Windows, `superTabs/buddyHome.spec.ts`, `superTabs/start.spec.ts` and `engines/kit/folderTrust.spec.ts` pass in
full. The Buddy folder works there as on a Mac. The three files run in the Windows CI job. Task #3815.

**Architecture:** WinTest3348 ran the three files at main 342edb2d7 on Window of Tim (Node 22.23.2, Git 2.55.0.windows.5,
Developer Mode off): 20 failures with one worker. Two are product bugs and the rest are specs that assume POSIX:
- **Product:** `refreshCopy` compares `git rev-parse --show-toplevel` with the copy's folder through `realpathSync`, which keeps
  a path's case and its 8.3 short names (`C:\Users\HARNES~1`) as written. Git reports the long, real name, so the two never
  match. Every copy is "left where they are", and seven move tests fail on that.
- **Product:** `buddyProjectsOf` keeps a project only when its folder starts with `/`, so a Windows checkout (`C:\…`) is
  dropped and its Buddy gets no copy.
- **Specs:** they make links with `symlinkSync`, which needs Developer Mode or an administrator on Windows (EPERM, seven
  tests); the Buddy-folder group keeps vitest's 5 s timeout, which Windows git outruns (six tests, and the EBUSY of their
  cleanup); and three assertions build or split a path with `/`.

**Tech Stack:** TypeScript, vitest, the GitHub Actions Windows workflow.

**Spec:** task #3815's brief.

## Global Constraints

- docs/windows-rules.md: no window flash; nothing here starts a new process kind.
- Never weaken the link and outside-folder safety checks (security review 1 of #2436). A folder link on Windows is a
  junction, which `lstat` reports as a link exactly as the checks read it. A test that needs a file link, or a link committed
  to git, runs only where the machine can make one, and is never loosened.
- The same files still pass on Mac and Linux.

## Review Focus

1. The toplevel check still refuses a folder that lost its `.git` and finds a repository above it ("moves nothing above a copy
   that lost its .git"): only the spelling of the same folder is made equal.
2. Case is ignored only on Windows and macOS (case-insensitive by default), through the file system's own canonical path.
3. A Windows project path must be absolute (drive or UNC); a relative one is still dropped.

---

### Task 1: The copy's repository check reads the folder the file system resolves

**Files:** `cli/src/superTabs/buddyHome.ts` (`refreshCopy`), `cli/src/superTabs/buddyHome.spec.ts`

- [ ] **Step 1: Write the failing test:** on a case-insensitive temporary folder, `refreshBuddyHome` given the Buddy home in
  another letter case moves the copy to the default branch. Skipped where the temporary folder is case-sensitive (Linux).
- [ ] **Step 2: Run** `npx vitest run src/superTabs/buddyHome.spec.ts -t "letter case"` and watch it fail on a Mac.
- [ ] **Step 3: Implement:** compare `realpathSync.native` of both paths.
- [ ] **Step 4: Run** the whole spec and see it pass. Commit the test first, then the code.

### Task 2: A Windows project folder is kept

**Files:** `cli/src/superTabs/buddyHome.ts` (`buddyProjectsOf`), `cli/src/superTabs/buddyHome.spec.ts`

- [ ] **Step 1: Write the failing test:** `C:\Users\me\web` and `\\server\share\web` are kept; `relative` and `C:web` are
  dropped.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement** with `posix.isAbsolute || win32.isAbsolute` (a drive-relative `C:web` is not absolute).
- [ ] **Step 4: Run and see it pass.** Commit the test first, then the code.

### Task 3: The specs run on Windows as they read

**Files:** `cli/src/superTabs/buddyHome.spec.ts`, `cli/src/superTabs/start.spec.ts`, `cli/src/engines/kit/folderTrust.spec.ts`,
`.github/workflows/windows.yml`

- [ ] **Folder links:** made with a `linkFolder(target, path)` helper, a junction on Windows and a symlink elsewhere.
- [ ] **File links:** `it.runIf(canLinkFiles())` for tests that need a file link or a committed link.
- [ ] **Timeout:** the Buddy-folder group gets `{ timeout: 30_000 }`.
- [ ] **Paths:** built with `sep` and `basename`.
- [ ] **Codex launch test:** on Windows it passes the startup arguments a Windows launch has verified.
- [ ] **Windows CI:** the three files are added to the Windows workflow's CLI spec list.
- [ ] **Evidence:** the three files pass on Mac locally and on Linux in PR CI, and WinTest3348 runs them on Window of Tim at
  the PR head.
