# A Buddy's private temporary folder Implementation Plan

**Goal:** On a computer with a Team account, a Buddy's temporary files stay in a 0700 folder of its own, not the shared `/tmp`.

**Architecture:** `lib/agentTmp.ts` gains one folder per Buddy, `<data>-buddy-tmp/<hash of its folder>`. The launch sets `TMPDIR` to it, plus `CLAUDE_CODE_TMPDIR` for Claude Code, which otherwise uses `/tmp/claude-<uid>` whatever `TMPDIR` says. The guard and the sandbox are told that one folder; every other Buddy's stays closed.

**Tech stack:** TypeScript, vitest, Claude Code's sandbox settings.

**Spec:** task #2079; audit finding M1 in `docs/plans/2026-11-02-team-private-temp-and-status-plan.md`.

## Decisions

- **Beside the data folder, not in it.** The wide guard and sandbox close the data folder. Opening a hole in that rule would be riskier than a folder they never opened. The new parent is closed the same way, so a Buddy opens only its own child.
- **One folder per Buddy, not one shared.** A shared folder would show one person's private work to another person's Buddy.
- **The guard adds reads only: Read, LS, Grep and Glob.** Write and Edit stay refused, and the shell's word-by-word rules do not change. Real paths decide, so a link out is refused, and secret names stay closed.
- **The sandbox** gets `allowWrite` and `allowRead` for that one folder.
- **Same gate as `agent-tmp`.** Owner's account, not Windows. If the folder cannot be made private, the Buddy starts on the system's folder, the log says so, and the guard opens nothing.

## Design

- **Growth:** the daily sweep deletes a Buddy folder's entries with nothing changed for 7 days, and a folder left empty for 30 days. Ending a Claude Buddy session removes that session's output, and the whole folder once the Buddy's own folder is gone: a plain session shares it with the main Buddy.
- **Concurrency:** no locks. One folder per Buddy; `mkdir` and `chmod` repeat safely. A sweep and a writer race as in `agent-tmp`, and recent files are kept.
- **Read cost:** one walk per day, off the launch path.
- **Scale:** 10x Buddies is 10x small folders. The metric that warns first is the size of `<data>-buddy-tmp`.
- **Compatibility:** only new launches change. A running Buddy keeps its guard and environment until relaunched.
- **Migration and rollback:** none. Removing the code leaves a folder the sweep no longer visits, which is safe to delete.
- **Audience:** file modes enforce it (0700, owner checked); no server is involved.
- **Identity:** the folder belongs to the daemon's account, checked by uid; no login is used.
- **Failure:** a folder that cannot be private logs a line, and the Buddy runs on the system's folder as today.
- **Platforms:** macOS only for now. Linux stays on the system's folder until the real sandbox spec has run with bubblewrap. Windows' temporary folder is already the account's own.

## Limits

- A teammate's Buddy running under the Team account itself is unchanged: this gate is the owner's account.
- M1 stays open for Buddies on Linux. Claude Code before 2.1.77 has no `allowRead`, and a wide Buddy on it would fail closed: its commands break, nothing leaks.
- A tool that names `/tmp` itself ignores `TMPDIR`. A wide Buddy's sandbox refuses that write; a narrow Buddy's guard refuses such commands.

## Tasks

- [ ] **Folder and environment:** failing `agentTmp.spec.ts` tests for 0700 parent and child, per-Buddy paths, engines, gates, links and sweep; then the code.
- [ ] **Guard and sandbox:** failing `buddyGuard.wide.spec.ts` tests for own reads, other Buddies, the data folder, `agent-tmp`, links, secret names and writes; then the code.
- [ ] **Launch and cleanup:** failing `swarmSkills`, `create` and `teamPurge` tests; then the wiring.
- [ ] **Real sandbox:** `buddyGuard.wide.claude.spec.ts` with real Claude Code: own folder writable and readable, another Buddy's refused.
