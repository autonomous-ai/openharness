# Team account on Windows: W4, W5 and W7 Implementation Plan

> Brought to the writing-plans format after the code was written: that rule arrived while this task was running (Ken, 2026-11-02). Steps below are marked as they happened.

**Goal:** The Team account can no longer stall the owner's Swarm service, redirect the elevated removal's deletes, or print escape codes to the administrator's console.

**Architecture:** Status reads on Windows run in a short-lived child process with a deadline. Removal deletes what the Team account could write through handles opened relative to their parent, from a small C# helper compiled before anything is removed. Setup cleans each line the Team account wrote before printing it.

**Tech Stack:** TypeScript, vitest, Windows PowerShell 5.1 (`Add-Type`, C# 5), the manual Windows workflow.

**Spec:** `docs/security/2026-11-02-team-account-windows.md` on PR #2568, findings W4, W5 and W7.

## Global Constraints

- Nothing here may stop the owner's Swarm service, whatever the Team account does to its own files.
- An elevated script deletes nothing through a link, and changes nothing if it cannot prepare to delete safely.
- Windows PowerShell 5.1 and C# 5: what `Add-Type` compiles there.
- Nothing unsigned is started; the child is the managed Node, the compiler Microsoft's `csc.exe`.
- Other platforms' behavior does not change.
- Two independent security reviews before merge (cleanup, deletes data).

## Review Focus

1. A status file held open for good: the owner's service keeps running, each read ends at its deadline, and children do not pile up. Pinned by the FIFO tests in `privacy.spec.ts`.
2. A folder swapped for a junction during removal: what the junction points at survives. Pinned by the junction cases in `windowsTeamRemove.real.spec.ts`; the moment of the swap itself is not interleaved in a test, so it is argued from handle-relative opens.
3. A removal that stops partway, then runs again: its renamed folders go too. Pinned by `windowsScript.spec.ts` and `windowsTeamRemove.real.spec.ts` (`Remove-Renamed`).
4. A machine where `Add-Type` is blocked: removal stops with nothing removed and the daemon running. Pinned by `windowsScript.spec.ts`; the blocked state is not produced on a real machine.
5. A very deep tree the Team account built: no crash, and what is left is named. Pinned by the depth case in `windowsTeamRemove.real.spec.ts` for a long path; the 512-level limit itself is not reached in a test.

---

## Decisions

- **W4, a child process rather than a worker or the thread pool.** A worker stuck in a synchronous open cannot be stopped and would hold up the daemon's exit; an async read stuck in the thread pool holds a pool thread, which every file operation shares. A child can be killed. The daemon's read waits on it without blocking and allows one child at a time, so a stuck one never piles up. `harness team status` and setup use the same child synchronously with the same deadline.
- **W5, handle-relative deletes.** Each child opens relative to its parent's open handle, without following a link, and a link is deleted as itself. The rename into a new random name comes first and is best effort: Windows refuses it while it holds a profile's registry.
- **W5, the helper compiles before step 1.** A computer where `Add-Type` cannot run stops with nothing removed, rather than falling back to deleting by path.
- **W5, the Team account's own tasks** are disabled with the daemon's task, enabled again if removal stops, and deleted once the account is gone.
- **W7** cleans lines where they are read, so every print and error that uses them gets clean text.

## Design

- **Growth:** nothing is stored. Each read's child exits or is killed.
- **Concurrency:** one status child at a time. A read during a stuck child answers "no status", as an unreadable file already does.
- **Read cost:** one short child process a minute, on Windows computers with a Team account only.
- **Scale:** N/A because there is one reader per computer.
- **Compatibility:** other platforms keep today's read. Scripts run once and are not versioned.
- **Migration and rollback:** none; the code can be reverted.
- **Audience:** Windows ACLs enforce it, as before. No server is involved.
- **Identity:** tasks are matched by the Team account's SID or name, never the owner's.
- **Failure:** a read past its deadline is logged and is no status. A compile failure stops removal before anything changes. What cannot be deleted is reported, as today.
- **Platforms:** the changes apply to Windows; the status read is proven on macOS with a FIFO, and the rest by `windowsTeamRemove.real.spec.ts` on Windows.

## Tasks

### Task 1: W4, the status read

**Files:**
- Modify: `cli/src/team/privacy.ts`, `cli/src/team/refresh.ts`, `cli/src/superTabs/service.ts`
- Test: `cli/src/team/privacy.spec.ts`, `cli/src/team/refresh.spec.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `readTeamStatusOffThread(path, options?) -> Promise<TeamStatus | null>`; `readStatusFile(path, platform?, deadlineMs?) -> string`.

- [x] **Step 1: Write the failing tests:** a FIFO stands in for the oplock, as an open waits on either.
- [x] **Step 2: Run them to verify they fail:** `npx vitest run src/team/privacy.spec.ts src/team/refresh.spec.ts`, 13 failed.
- [x] **Step 3: Implement** the child, with one running at a time, and wire the daemon to it.
- [x] **Step 4: Run them to verify they pass.**

### Task 2: W7, setup's output

**Files:**
- Modify: `cli/src/team/windowsScript.ts`
- Test: `cli/src/team/windowsScript.spec.ts`

**Interfaces:**
- Produces: `WINDOWS_CLEAN_LINE`, PowerShell's `Clean-Line`.

- [x] **Step 1: Write the failing test.**
- [x] **Step 2: Run it to verify it fails:** `npx vitest run src/team/windowsScript.spec.ts`.
- [x] **Step 3: Implement** `Clean-Line`, applied where `As-Team` reads its lines.
- [x] **Step 4: Run it to verify it passes.**

### Task 3: W5, removal

**Files:**
- Modify: `cli/src/team/windowsScript.ts`
- Test: `cli/src/team/windowsScript.spec.ts`

**Interfaces:**
- Produces: `windowsRemoveHelperLines() -> string[]`; PowerShell's `Remove-Held`, `Remove-Renamed`, `Team-Tasks`, `Restore-Tasks`.

- [x] **Step 1: Write the failing tests.**
- [x] **Step 2: Run them to verify they fail:** 8 failed in `windowsScript.spec.ts`.
- [x] **Step 3: Implement** the helper, the rename, and the task handling.
- [x] **Step 4: Run them to verify they pass.**

### Task 4: Real Windows

**Files:**
- Create: `cli/src/team/windowsTeamRemove.real.spec.ts`
- Modify: `.github/workflows/windows.yml`

**Interfaces:**
- Consumes: `windowsRemoveHelperLines`, `WINDOWS_CLEAN_LINE`, `readTeamStatusOffThread`.

- [x] **Step 1: Run the Windows workflow:** real junctions, a read-only file, a real task, escape codes, both architectures. The helper compiled and 8 of 9 cases passed; one failed on this spec's own fixture.
- [ ] **Step 2: Fix that fixture and run it once more.**
