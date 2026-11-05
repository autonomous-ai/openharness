# Team account update recovery implementation plan

> Implement task by task in this Engineer session, test first, with independent security reviews and user-flow testing of the completed pull request.

**Goal:** Keep the macOS Team account available through CLI updates, offer Restart when it is offline, and finish the handed-sign-in trust fixes.

**Architecture:** Keep Team lifecycle policy in `cli/src/team`. Reuse existing setup for the password-protected Restart action. Pin a redeemed handed sign-in to its account through the guarded session update, and discard the departing owner's trust on Team account switches.

**Tech Stack:** TypeScript, Node, Vitest, launchd; Flutter/Dart widget tests.

**Spec:** Swarm task #3307, conversation `faf4f30958d4f61cdf6a8119`; prerequisite PR https://github.com/autonomous-ai/openharness/pull/3159.

## Global Constraints

- Two independent security reviews; no real sign-in/out or account creation in tests.
- macOS recovery and Desktop action; preserve Linux and Windows lifecycle behavior.
- Swarm code stays out of cli/src/core. Keep the owner's session separate from Team work.
- Show Amon the ASCII row mockup and obtain his yes before implementing the row.
- Use targeted local tests; component suites come from PR CI. Run relevant checks CI omits.
- First PR-body line: Requested by kelvin1295 through Harness.

## Review Focus

- An update interrupted after stopping its own daemon must recover without a second daemon.
- An intentional stop or sign-out must not be undone by recovery.
- Delayed account lookup must never annotate a replacement sign-in.
- Failed redemption must preserve the old sign-in and trust.
- A remote viewer or another member must never get an administrator action on this Mac.

## Design

- Growth: one existing session account field; no new history. Departing Team trust is deleted rather than retained per owner.
- Concurrency: session writes use updateAuthSession and match the exact epoch; daemon starts retain the existing spawn lock.
- Read cost: one bounded auth/me lookup after redemption; existing machine observations drive the row.
- Scale: constant local work per handoff/update; repeated failures are surfaced in existing logs/status.
- Compatibility: existing optional signInAcct field; old clients ignore it. No backend protocol changes.
- Migration + rollback: no database migration; old binaries ignore the account pin. Deleted old-owner trust is intentionally not restored; another setup can recreate trust from the signed device log.
- Audience: only the local machine's own signed-in contributor sees Restart; existing setup validates and prompts for administrator authority.
- Identity: redeemed Team token authenticates account lookup; never the machine owner's login.
- Failure: failed lookup preserves existing fallback and reports a bounded diagnostic; restart failures use existing setup status.
- Platforms: recovery is macOS-specific; shared handoff fixes retain Windows/Linux tests.

## Task 1: Reproduce and fix the update lifecycle

**Files:** `cli/src/team/script.ts`, `cli/src/team/script.spec.ts`, `cli/src/team/refresh.ts`, `cli/src/team/refresh.spec.ts`; update command integration only if the traced cause requires it.
**Interfaces:** existing `teamLaunchdPlist`, `TEAM_JOB_WRAPPER`, `teamUpdateArgv`; no new public command.

- [x] Trace stop, stage, relaunch and launchd exit handling. The owner refresh runs update in a shell hosted by the Team daemon that update stops; closing that process group reproduces the interrupted update. Keep the updater independent before acknowledging its launch; preserve intentional-stop semantics and failure-only launchd policy.
- [x] Commit a regression simulating that update through isolated fake processes and temporary files; prove daemon availability afterward and intentional-stop behavior. Watch it fail.
- [x] Commit the smallest lifecycle correction; run affected Team lifecycle tests and typecheck.

## Task 2: Finish handed sign-in isolation

**Files:** `cli/src/team/command.ts`, `cli/src/team/command.spec.ts`, `cli/src/team/handoff.ts`; `cli/src/lib/e2ee/accountTrust.ts` and its spec, `cli/src/gateway/start.ts` for the departing-stash policy.
**Interfaces:** existing `TeamCommandDeps.get/updateSession`, `teamSession`, `switchAccountTrust`; integrate prerequisite #3159 before changing its handed epoch.

- [x] Commit failing cases for account pin after redemption, failed lookup, and epoch replacement during lookup; observe failures.
- [x] Pin auth/me's account using the redeemed token and exact sign-in epoch; preserve sign-in on lookup failure. Commit green code.
- [x] Commit failing temporary-store cases for Team owner switch deleting the departing stash and preserving ordinary account stash/identity/device pairings; observe failures.
- [x] Implement the Team-specific discard policy outside core; commit green code and run affected trust and handoff specs.

## Task 3: Offline row Restart

**Files:** `desktop/lib/super_tabs/machines.dart`, `desktop/test/super_tab_team_machine_test.dart`, relevant existing setup widget fixtures.
**Interfaces:** add an optional local-owner-only `restart` flag through `AppNotifier.setUpTeamAccount`, the existing setup dialog, `superTabs/service.ts`, and `TeamAutoSetup.offer`; Restart invokes the same password-protected setup without replacing a valid sign-in.

- [x] Post the ASCII mockup to Amon and notify his Buddy; Amon replied "ok" on 2026-11-05 before Desktop implementation.
- [x] Commit failing widget cases for local-owner offline reason + Restart, no action for remote/other-owner/offline-host cases, and standard button invoking setup; observe failures.
- [x] Implement approved copy/action with existing standard button; commit green code.
- [x] Run affected macOS Flutter tests and capture light/dark fixtures using memory state and fake sign-in.

## Added scope from the PM

River requested that status reflect a Team sign-in that no longer works. Regressions cover a missing session at daemon startup and loss during observation, replacing historical success with signed-out.

## Completion

- [ ] Post red/green evidence in a PR comment; mark ready at a stable head.
- [ ] Hand the Integrator the PR for two security reviews and independent Team-account testing.
- [ ] Resolve findings test first, record all task acceptance checks, then report the exact head and evidence through work status.

## Security review correction: departing device-log archive

SecLarch found that deleting the departing trust stash still left the same owner's device names, keys and suspensions in the device-log archive. The refresh and confirmed-review switch paths must both discard the departing log (including a pre-existing archived copy) for Team sign-ins. Ordinary sign-ins continue archiving. Historical stashes for unrelated owners and status recovery are recorded minor findings, outside this correction.

- [x] Commit four regression cases before implementation: Team and ordinary switches, through refresh and confirmed review. Both Team cases fail without the fix.
- [x] Apply the same Team epoch policy as trust-stash cleanup when archiving the departing log.
- [ ] Validate device-log/store/trust tests and importer tests, publish red/green evidence, and request delta reviews at the new head.
