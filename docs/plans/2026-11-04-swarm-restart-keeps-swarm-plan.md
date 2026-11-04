# A restart never closes a Swarm or shows it under a wrong name: plan

> Way of working: this plan's Engineer implements it task by task, test first (test-driven-development), in one pull
> request. No subagents, no execution handoff.

**Goal:** A Swarm open in Desktop stays open, under its own name, while the backend or the local daemon restarts. While
its reads fail it shows the quiet "Reconnecting · 1m" pill it already has, and it recovers by itself.

**Architecture:** Today a Swarm read refused as `NOT_FOUND` or `FORBIDDEN` revokes the open Swarm at once
(`SuperTabController._readFailure`): its state, messages and poll are dropped, the view says "Conversation
unavailable.", the Swarm dropdown's label falls back to the default "Swarm", and with Personal picked the tab moves to
Personal. One such answer during a restart is enough. The fix asks the account's Swarm list first: a refusal revokes
only when a list read that succeeded no longer names the Swarm. While the list still names it, or cannot be read, the
refusal is a failed read like any other: the Swarm keeps what it shows, says Reconnecting and reads again at its next
poll.

**Tech Stack:** Flutter Desktop (`desktop/lib/super_tabs/controller.dart`, `client.dart`), flutter_test with fake
transports, memory stores and a fake sign-in.

**Spec:** Task #2647 (Dee, 2026-11-04 11:02 VN): "autonomous.ai" closed and came back under a default name while the
backend restarted twice and CLI v0.5.35 restarted daemons.

## Global Constraints

- Desktop only. No backend or CLI change; Swarm code stays out of `cli/src/core`.
- A real loss still revokes: the account's list, read successfully, without this Swarm. A first read refused for a
  Swarm the list does not name stays final, as today.
- Tests use a memory store and a fake sign-in; none touch the real CLI login.
- No new switch: the behavior ships on.

## Review Focus

- A Swarm the person really lost (removed, deleted) still closes: only a successful list read keeps it open.
- A refusal never leaves a Swarm in a state that can neither recover nor close (the poll keeps running while kept).
- One list read per refusal at most, shared by concurrent refusals; no extra reads while reads succeed.

## Design

- growth: N/A because nothing is stored; the check reuses the existing list read.
- concurrency: one check in flight per Swarm (a flag on its controller); the list read joins discovery in flight.
- read cost: a list read only after a refusal, at most one per poll; none while reads succeed.
- scale: at 10x Swarms per account, still one list read per refused Swarm read; the list's page count warns first.
- compatibility: no wire change; old and new backends answer the same reads.
- migration + rollback: N/A because no stored data changes; rollback is the previous build.
- audience: the server still enforces every read; this only decides what Desktop keeps on screen.
- identity: reads stay the signed-in person's own.
- failure: a kept Swarm says Reconnecting with how long, never nothing; a confirmed loss says so as today.
- platforms: Desktop (macOS, Linux, Windows) and the web build, which share the controller.

## Task 1: a refused read during a restart keeps the Swarm open under its name

**Files:**
- Modify: `desktop/lib/super_tabs/controller.dart` (`_readFailure`, new `stillListed` hook)
- Modify: `desktop/lib/super_tabs/client.dart` (wires the hook to the Swarm list)
- Test: `desktop/test/super_tab_first_read_test.dart`, `desktop/test/super_tab_swarm_switcher_test.dart`

**Interfaces:**
- `SuperTabController({..., Future<bool> Function()? stillListed})`: true while the account's list names the Swarm,
  false once a list read that succeeded leaves it out; a throw means it cannot be told.
- `SuperTabClient.stillListed(String id)`: reads the list (joining a read in flight) and answers as above.

- [ ] Failing test (controller): reads drop, then are refused `NOT_FOUND` and `FORBIDDEN` for a while, with the list
  still naming the Swarm (and unreadable for part of it): the Swarm keeps its snapshot and name, says Reconnecting,
  is never revoked, and shows the backend's state again when reads answer.
- [ ] Failing test (controller): the same refusal with the list no longer naming the Swarm revokes it.
- [ ] Failing test (app): Swarm "autonomous.ai" open in a tab, the fake backend drops and refuses its reads for a while:
  the tab stays, bound to the Swarm, the dropdown's label and the Swarm menu say "autonomous.ai" throughout, never
  "Swarm", and it is not moved to Personal.
- [ ] Watch them fail; implement; watch them pass; run the tests of the files changed and of their importers.
