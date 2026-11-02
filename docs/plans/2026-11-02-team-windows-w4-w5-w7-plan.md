# Team account on Windows: W4, W5 and W7 Implementation Plan

**Goal:** The Team account can no longer stall the owner's Swarm service, redirect the elevated removal's deletes, or print escape codes to the administrator's console.

**Architecture:** Status reads on Windows run in a short-lived child process with a deadline. Removal deletes what the Team account could write through handles opened relative to their parent, from a small C# helper compiled before anything is removed. Setup cleans each line the Team account wrote before printing it.

**Tech stack:** TypeScript, vitest, Windows PowerShell 5.1 (`Add-Type`, C# 5), the manual Windows workflow.

**Spec:** `docs/security/2026-11-02-team-account-windows.md` on PR #2568, findings W4, W5 and W7.

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

- [ ] **W4:** failing `privacy.spec.ts` tests with a FIFO standing in for the oplock; the child reader; `refresh.ts` and `service.ts` wired to it.
- [ ] **W7:** failing `windowsScript.spec.ts` test; `Clean-Line` in `As-Team`.
- [ ] **W5:** failing `windowsScript.spec.ts` tests; the helper, `Remove-Held`, `Team-Tasks`.
- [ ] **Real Windows:** `windowsTeamRemove.real.spec.ts` in the Windows workflow: real junctions, a read-only file, a real task, escape codes.
