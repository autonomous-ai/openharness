# Codex restricted resume implementation plan

> Implement task by task in this Engineer session, test first, with independent pull request reviews.

**Goal:** Harness-run Codex starts and resumes continue past Open restricted without granting folder trust.
**Architecture:** Reuse the exact-screen Codex recognizer and the core's conditional input door in the existing Swarm terminal watcher. The startup handler remains responsible for pre-session starts; the watcher handles resumed sessions.
**Tech Stack:** TypeScript, Vitest, fake Codex terminal.
**Spec:** Harness task #3904, conversation 10f805b0f0832aaf73da073d.

## Global Constraints

- Never mark a worktree trusted or enable untrusted config, hooks or exec policies.
- Only Harness Swarm agents; personal sessions outside Harness are unaffected.
- Two independent security reviewers must review sandbox and trust boundaries.
- Bounded retries, conditional input against the exact captured screen, no new polling.
- Platforms: macOS, Linux, Windows; no process launch behavior changes.

## Design

No new stored or exposed data. Growth, locking, read cost, scale, compatibility, migration, rollback, audience and identity: existing bounded Swarm terminal watch and conditional input contracts remain in use. Failure: after bounded attempts the existing visible prompt alert applies. Rollback: revert the watcher change.

## Review Focus

- A Trust and continue prompt must receive no input.
- Changed or malformed screens must receive no input.
- Other engines and sessions outside the Swarm roster must receive no input.
- A stuck prompt must stop automatic attempts and retain the existing alert.
- Fresh and resumed fake Codex sessions must continue with saved trust unchanged.

## Task 1: Continue restricted Codex sessions in the Swarm watcher

**Files:** Modify `cli/src/superTabs/terminal.ts`; test `cli/src/superTabs/terminal.spec.ts`; reuse `cli/src/engines/codex/screen.ts` and its tests.
**Interfaces:** Consume `openRestrictedKeys(capture: string): string[] | null` and `inputIfScreen(harnessId, keys, capture)`; retain `TerminalHost.tick` API.

- [ ] Add fake Codex start/resume tests that wait for Enter and then expose a working composer; assert no trust/config change. Cover wrong engine, non-roster session, trust prompt, changed screen and bounded attempts.
- [ ] Commit tests; run affected tests and record the expected failure.
- [ ] Extend the existing bounded dismissal path only for a Codex agent and the exact restricted screen.
- [ ] Run affected terminal, engine recognizer and startup tests, typecheck, and compare watcher timing on the same idle workload before/after. Commit implementation.
- [ ] Push draft, record red/green evidence, mark ready and hand off for two security reviews and platform testing.
