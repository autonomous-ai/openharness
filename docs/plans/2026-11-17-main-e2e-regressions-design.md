# CLI end-to-end regressions on main: design

Date: 2026-11-17. Branch: `fix/main-e2e-regressions`.

## Goal

`cli-e2e.yml` is red on main (1e17b388ce). Every failure below passes at 3bde211303 or before the PR named.
Each one is classified as a product bug (fixed with a red test at the layer where the behavior lives) or a test
bug (the test asserts what the PR changed on purpose, or races), then fixed, until the workflow is green on main.

Evidence: cli-e2e runs 44045512447 (feat/dial-cmux, includes #4356 and #4390), 44036082775, 44024889572; local
reproductions of races, modelSwitch, diskfull, workspacesProcess and viewersProcess on macOS.

## Delivery

The causes are unrelated across PRs, so three pull requests:

| PR | Branch | Scope |
|---|---|---|
| PR1 | `fix/main-e2e-regressions` | #4356 registry persistence: causes A, B, C, D, E below |
| PR2 | `fix/viewers-core-restart` (from main) | #4390: viewers across a core restart, the workspacesProcess test race |
| PR3 | later, only if needed | macOS-only: sandbox (#4181), serviceProcesses memory budget, handoff `IDENTITY_UNAVAILABLE` |

PR3 (PM, 2026-11-17): the sandbox crash (`Registry.load()` writes its `registry-own-modes` marker unguarded, so a
read-only `harness status` in a sandbox crashes; from 3a393e7e34, not #4181) and the service memory budget that
compressed or swapped leaked Buffers escape on macOS. It is designed on its own branch. The handoff
`IDENTITY_UNAVAILABLE` seen only locally is a follow-up: not reproduced here.

## PR1: registry persistence (#4356)

#4356 moved registry lock waits and saves off the core loop and made explicit choices wait for a durable save
(docs/design/2026-11-16-registry-persistence.md). Those intents stay. What broke are side effects of it.

### A. A launch marked `ready` reads as a changed owner (races, modelSwitch): product bug

`confirmLaunch` now writes `launch: { state: 'ready' }` on every restart or retarget commit
(`cli/src/lib/registry.ts` `confirmLaunch`). The relaunched engine's own SessionStart then re-registers its
conversation, and `register` rebuilds the row without `launch`. That commit lands after the reply. A second
request from the same client that captured the row in between sees `launchIdentity` (`registry.ts`
`matchesLaunchReceipt`) or the launch authority's identity (`core/agents/launchAuthority.ts`) change and answers
`AGENT_CHANGED`. For two restarts at once this happens after the second restart has already terminated the
engine: the agent is left with none. A retarget right after a restart fails the same way before any kill.

Fix: a launch in state `ready` and no launch are the same launch for identity. Both `launchIdentity` and the
launch authority's `identity` normalise `ready` to absent; `restoreAgents.ts` `restoreOwner` gets the same
rule where it compares launches. `register` is not changed: discovery treats absent and `ready` differently.

Red test: `cli/src/lib/registry.launchCallers.spec.ts`, a restart queued behind another keeps its target when
the first restart's engine re-registers its conversation (`confirmLaunch`, capture, `register` same session and
process, `matchesLaunchReceipt` still true), and the same for a retarget's launch authority.

### B. Restore publishes the probed engine only after settle (adopt): product bug

The restore watcher used to record the probed engine process at first sight. Since #4356 it calls
`confirmLaunch` only after its 10 s settle window (`core/agents/restoreAgents.ts`). Hooks that arrive in that
window wait for a process record, so a turn the person sends then is folded as history and no live
`turn_ended` reaches the client.

Fix: publish the probed process before the settle window and move the watcher's ownership check onto that
receipt; keep the terminal hold through settle and release it after. An engine that dies during settle still
falls back to a fresh launch. Effort `xhigh`: concurrency in the restore path.

Red test: `cli/src/lib/registry.launchCallers.spec.ts` (or the restore spec beside the watcher), restore records
its probed engine before the settle window while keeping the terminal held (settle above 0, controlled clock,
no fixed sleeps).

### C. A storage outage makes the hook path fail (hookclient): product bug

`transaction()` now awaits the batch's durable save. The terminal agent reconciler does not catch a storage
failure there, so a hinted pass rejects, `resolveHookAgent` rethrows it and the hook gets HTTP 500 before the
admission queue can show its "Waiting for durable hook admission" hold. Its 5 s timer (`void this.trigger()`)
logs an unhandled rejection for the whole outage.

Fix: the reconciler catches storage failures of a pass's batch save (`RegistryPersistenceUnavailable`,
`AtomicWriteUnconfirmed`), logs them by name once per outage, keeps its observations for the next pass and
finishes the pass. Ownership changes still propagate.

Red test: `cli/src/lib/terminalAgentReconciler.spec.ts`, a pass whose observation batch cannot be saved still
completes and answers a hinted trigger, with no unhandled rejection.

### D. The master cannot tell a full disk from a broken build (updateHostile): product bug

`persistenceFailure` (`registry.ts`) turns `ENOSPC`/`EDQUOT` into "has no available space" and `EROFS` into
"write failed". The core's startup save is now strict, so a core started on a full disk enters safe mode with
that text. The master's `namesTheDisk` (`harnessd/supervisor.ts`) looks for `ENOSPC|EDQUOT|EROFS` or "no space
left on device", does not match, and rolls a good build back: the round 40b defect again.

Fix: `persistenceFailure` keeps its fixed categories and appends the error code, which carries no path or
content: "has no available space (ENOSPC)", "(EDQUOT)", and a new "is read-only (EROFS)". `namesTheDisk` is
unchanged.

Red test: `cli/src/lib/registry.persistence.spec.ts`, a strict save refused for want of room (`ENOSPC`, `EDQUOT`,
`EROFS`) rejects with a message `namesTheDisk` accepts.

### E. Full disk: rename and create (diskfull): test bug plus two product gaps

Decided (PM, 2026-11-17): keep #4356's rule. A rename while the disk is full is refused with
`PERSISTENCE_UNCONFIRMED` and applies nothing; a new agent's binding must be saved before it is acknowledged.

- Test: `cli/e2e/diskfull.e2e.ts` expects the rename while full to answer `PERSISTENCE_UNCONFIRMED`, the create
  while full to be refused with a reply that names the disk, and a rename once there is room to survive the
  restart. Turns on existing agents while full, and both agents after the restart, stay as asserted.
- Product gap 1: a create while full answers `REGISTRATION_FAILED` "tmux pane could not be registered after 3
  attempts" and opens and drops three panes. Fix: a storage refusal of the pending agent's save is not retried
  as a pane failure; the create answers `PERSISTENCE_UNCONFIRMED` with the storage category (which now names
  `ENOSPC`, D) and closes its one pane. Red test at the create path's spec (`core/agents/create` or the
  registry's `openPendingAgent` caller).
- Product gap 2: the daemon logs `[fatal-guard] unhandledRejection: … name storage has no available space` while
  full. Fix: find the caller that drops the save promise (C's reconciler timer is one; the "name storage"
  subject points at the names path too) and handle it with a named log line. Red test where the dropped promise
  lives.

### Design (docs/feature-design-rules.md)

1. Growth: N/A, nothing new stored.
2. Concurrency: A changes only identity comparison; B moves an existing publication earlier inside the same
   writer; C catches errors, no new lock.
3. Read cost: none on a request path.
4. Scale: N/A.
5. Compatibility: no format or protocol change. Error text gains a code suffix; no client matches on it.
6. Migration and rollback: none; a revert restores today's behavior.
7. Audience: N/A.
8. Identity: N/A.
9. Failure: C and E turn silent failures and unhandled rejections into named log lines and named replies.
10. Platforms: shared TypeScript, macOS, Linux and Windows; the full-disk job runs on macOS, the rest on Linux CI.

## PR2: frame parts and Git facts (#4390)

### F. Viewers restart on every core restart (viewersProcess): product bug

`cli/src/services/viewers.ts`: on a `running` event whose `frameEpoch` (lease) differs from the one it had, the
viewers process detaches the viewer (stops its server) and attaches a new one on a new port. Every new core has
a new lease, so every core restart restarts every viewer under a new URL, which breaks the contract that viewers
outlive a core restart.

Fix, in the viewers process only (no core change): on `running`, store the new session, attach (a no-op for a
viewer already running for that harness and folder) and publish under the new lease. `ended` still detaches; a
changed folder or harness still replaces the viewer. `docs/design/2026-11-16-frame-parts.md` line on lease
replacement is corrected in the same PR.

Red test: rewrite `cli/src/services/viewers.spec.ts` "a new core lease replaces producers before accepting their
next asynchronous result" as "a new core lease keeps the running viewer and republishes its URL under the new
lease": no `viewers.stop`, no `verdicts.unwatch`, the last publish carries the old `viewerUrl` under the new lease.

### G. workspacesProcess "crashing on every start, it is parked": test bug

The `workspaces.crash` fault exits 200 ms after start. On a restart the process can connect after the agent is
registered, publish real Git facts, then crash; the frame keeps them, as frame-parts.md says ("a process
disconnect keeps the last known display fields"). The test means "no service has observed this agent". Fix: in
`cli/e2e/workspacesProcess.e2e.ts` create the agent after the wait for the master to park workspaces. No product
change. Red: the e2e with the crash delay temporarily raised to 2 s fails before the reorder and passes after
(recorded in the PR, not committed).

### Design

N/A for data: nothing stored, synced or newly exposed; the viewer URL already in the frame stays the same.
Platforms: shared TypeScript; viewers run on macOS and Linux.

## Verification

- Each task's red-then-green unit test; `npm run test:core` and the other local gates AGENTS.md names for the
  touched areas.
- `cli-e2e.yml` on each branch (workflow_dispatch, one heavy run at a time, slot from the PM): all Linux shards
  and the macOS full-disk job green. PR1 must turn races, modelSwitch, adopt, hookclient, diskfull and
  updateHostile green; PR2 workspacesProcess and viewersProcess.
