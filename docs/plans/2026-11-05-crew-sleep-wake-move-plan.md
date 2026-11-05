# Crew members sleep when idle, wake in seconds, and move when a machine fails (task #3398) Plan

> Worked by the Engineer, test first (project instructions: Engineer). No Execution Handoff.

**Goal:** A crew member idle for an hour sleeps: its session closes and frees memory and its slot, and its folder stays.
New work wakes it in the same folder in seconds. If its machine is offline over 5 minutes, signed out, out of quota for
over an hour, or low on disk, it moves to the next fallback machine. It keeps the same name and gets a hand-off note, and
its task goes back to the head of the queue. Folders and branch copies are cleaned up by four rules.

**Architecture:**
- **The rules are data.** One pure function, `crewKeep(state, now)` in `backend/src/superTabs/crewKeep.ts`, reads the
  Swarm state (agents, machines' latest readings, groups) and returns actions: `sleep`, `move`, `dropFolder`,
  `dropBranch`. Its thresholds are constants in `crewRules.ts` until the project rules record (Ledger's task) lands.
- **Where it runs.** `sweepLiveness`, the per-Swarm sweep that already runs on machine reports, applies the actions at
  most every 30 s per Swarm, in the same write. Every machine report triggers it, so a Swarm with any live machine is
  checked. A Swarm whose machines are all offline has no machine to move to, so `worker.ts` needs no new loop.
- **Sleep:** the server sets `Agent.asleep = { since }`. The host sees `sleep` on the row and closes the session with
  `closeMember`, keeping its folder. Keeper's keep-alive skips asleep rows (agreed in #3397).
- **Wake:** `work.assign` to an asleep member clears `asleep` in its own transaction. The host feed pushes the change
  within a second, and Keeper's keep-alive resumes the engine's own conversation (`claude --resume`, `codex resume`) in
  the same folder.
- **Move:** the server sets `Agent.movedTo = { machineId, startId, reason, at }`. It puts the member's active task back
  at the head of the queue (`placeAfter(…, null)`) with a lost reason `crew-moved`. It places a start on the fallback
  machine through `admitMachineStart` (Team rules, room, engines), with the same name, role, engine, model and effort
  and a `handoffNote`. On `agent.started` for that start, the new agent takes over: the crew flag, the display name, its
  groups and its `movedFrom`. The old record leaves as a retired entry, which tells the old host (whenever it is back)
  to close the session and drop the folder.
- **Cleanup:** the server says what to drop and the host does it, refusing a folder with uncommitted or unpushed work,
  as `sweepOne` already does.

**Tech Stack:** TypeScript backend (vitest, integration suite in PR CI), CLI (vitest).

**Spec:** task #3398 brief (anh Dee, Swarm redesign approved 11-05). It builds on #3397 (Keeper: `Agent.crew`,
`isCrew`, crew keep-alive and retention) and is read by #3400 (Budget: dispatch counts an asleep member as free).

## Decisions made while building (2026-11-05)

These change the plan above where they differ.

- **Fallback order (River):** the route's own order, as the project's Order and quota rule applies it: the same account
  kind as the machine left, then the account whose weekly quota resets soonest, then the most left, then the fewest
  agents working, then by name (`crewKeep.ts fallbacks`).
- **"Out of quota for over an hour"** is read without a stored clock: a used-up window that won't reset within the hour.
  Unknown quota is never trouble. A withdrawn contribution reads as offline, and the sweep never throws on it.
- **Retiring the old session uses the existing removal.** A move's take-over calls `removeAgent`, whose close record
  makes the old host close the session and drop its folder when clean, the same as any removed agent. That replaces the
  plan's `crewRetired` list and its host command, and is the "member's folder goes on retire" rule.
- **Branch copies are pruned by the host.** The server records no branch names for tasks. Each hour, in each crew
  folder, the host deletes local branches that were pushed and then merged into the default branch, or whose remote
  branch is gone. It never deletes the current branch, one tracking the default branch, or one never pushed. A
  gone-upstream branch's tip is kept under `refs/harness/dropped/`, so no commit is lost. (`crewFolders.ts
  pruneBranches`)
- **Wake after a dropped folder:** before the drop, the host remembers the folder's path and clone. On wake, it brings
  the folder back at the same path from the clone (`git worktree add --detach`) before the keep-alive resumes the
  engine's conversation there.
- **Wake grace:** `work.assign` on an asleep member resets `downSince` to now, so #3397's 5-minute reopen grace counts
  from the wake and the new task is not lost while the session reopens.
- **No new host row fields:** host rows already carry the whole agent record, so the host reads `asleep` and `movedTo`
  there, as Keeper's keep-alive does.
- **Task 4 contract for the Desktop machine row** (River opens it as its own task), from what clients already get:
  - crew sessions: `state.agents` on the machine with `crew`;
  - state: `asleep` (since), `movedTo` (moving), or awake;
  - idle hours: `now - asleep.since` while asleep;
  - free disk: `machines[].observation.resources.projectDiskFreeBytes ?? diskFreeBytes`.

## Global Constraints

- **Owns:** `backend/src/superTabs/`, `backend/src/worker.ts` (unchanged by this plan) and `cli/src/superTabs/`.
  Keeper's `crew.ts` files are not edited. Swarm code stays out of `cli/src/core`.
- **Numbers**, in `crewRules.ts` only:

  | Constant | Value |
  | --- | --- |
  | `SLEEP_IDLE_MS` | 1 h |
  | `MOVE_OFFLINE_MS` | 5 min |
  | `MOVE_QUOTA_OUT_MS` | 1 h |
  | `MOVE_LOW_DISK_BYTES` | 5 GB |
  | `FOLDER_ASLEEP_MS` | 7 days |
  | `DISK_FLOOR_BYTES` | 10 GB |
  | `RETIRED_KEEP_MS` | 7 days |
  | `RETIRED_MAX` | 200 |

- Never a PM (Lead) or a Buddy. A crew member with active work never sleeps.
- A crew member is moved at most once per `MOVE_OFFLINE_MS`. A move with no admitting fallback changes nothing and
  says so once in the project chat.
- Lifecycle code is tested with fake machines and a fake host. No test signs the Mac out of the real CLI.
- The PR body's first line is "Requested by dee through Harness." It gets one review and one security review.

## Design

- **Growth:** `asleep` and `movedTo`/`movedFrom` are small objects on the agent. `state.crewRetired` holds at most 200
  entries and drops each after 7 days, or once the host confirms it.
- **Concurrency:** the actions are written in the liveness sweep's own transaction, which conflicts with any command
  touching the same parts and retries on the next pass. Wake is inside `work.assign`.
- **Read cost:** no new read. The function runs on the state the sweep already loaded, and hosts get three optional row
  fields: `sleep`, `dropFolder`, `dropBranches`.
- **Scale:** O(crew members × machines) per sweep, a handful each. At 10x, the first warning is the "moved" notices per
  hour in the project chat.
- **Compatibility:** an older host ignores the new row fields. A sleeping member then stays open, which is today's
  behaviour for crew. An older server sends none of them.
- **Migration and rollback:** none. Absent fields mean awake and not moved.
- **Audience:** only the server sets these fields; no command lets a client set `asleep` or `movedTo`.
- **Identity:** a move's start is placed as the crew member's project's start, under the Team rules, never with the
  machine owner's login.
- **Failure:** no fallback, a refused start, or a host that can't drop a folder (dirty or unpushed) each say why once,
  and change nothing else.
- **Platforms:** the host code is platform-neutral (core close/resume, git). Windows follows the same path without new
  processes.

## Review Focus

1. A member that wakes while its sleep close is still in flight must end up open: a `work.assign` clears `asleep`, and
   the host never closes a row whose `sleep` has cleared.
2. A move while the failed machine comes back: the old session must not keep working the task. Its row reads
   `movedTo`, its host closes it, and its task was already taken back.
3. Two moves for one member (flapping machine): `movedTo` set means no second move until that start ends.
4. A folder with uncommitted or unpushed work is never deleted by any rule.
5. A quota window read as "unknown" is not "out of quota".

---

### Task 1: Rules and the decision function (backend)

**Files:**
- Create `backend/src/superTabs/crewRules.ts` and `crewKeep.ts`.
- Modify `model.ts` (Agent `asleep?`, `movedTo?`, `movedFrom?`; state `crewRetired?`).
- Test `crewKeep.test.ts`.

**Interfaces:**
- Produces `crewKeep(state: SuperTabState, now: number): CrewAction[]`, where `CrewAction` is
  `{ kind: 'sleep', agentId }`, `{ kind: 'move', agentId, toMachineId, reason: 'offline'|'signed-out'|'quota'|'disk' }`,
  `{ kind: 'dropFolder', agentId, why: 'asleep-7d'|'low-disk' }` or `{ kind: 'dropBranch', agentId, branch }`.
- Consumes `isCrew(agent)` from #3397. Until #3397 merges, a local `crew?` read guards it.

- [ ] Failing tests, using fake machines built from readings:
  - idle 59 min stays awake, 61 min sleeps, and active work never sleeps;
  - a Lead and a Buddy are never touched;
  - offline 4 min stays, 6 min moves to the first admitting machine;
  - signed out moves at once;
  - quota at 100% for 59 min stays, 61 min moves, and unknown quota never moves;
  - disk under 5 GB moves;
  - no fallback gives no move;
  - `movedTo` already set gives no second move;
  - asleep 7 days drops the folder;
  - disk under 10 GB drops the oldest asleep folder first, one per pass;
  - a merged or closed PR of the member's task drops its branch.
- [ ] Implement, run `npx vitest run src/superTabs/crewKeep.test.ts` green, and commit (test, then code).

### Task 2: Apply the actions in the liveness sweep; wake on assign; move start and take-over (backend)

**Files:**
- Modify `liveness.ts` (`sweepLiveness` applies `crewKeep`), `commands.ts` (`work.assign` clears `asleep`;
  `agent.started` takes over for a move start; `agent.crewRetired` from the host), `read/hostRows.ts` (row fields
  `sleep`, `dropFolder`, `dropBranches`; retired entries for the host).
- Test `crewKeep.apply.test.ts` (state-level) and `integration/superTabCrew.test.ts`.

- [ ] Failing tests:
  - the sweep sets `asleep`, and the host row carries `sleep`;
  - `work.assign` wakes: `asleep` is cleared and the row's `sleep` is gone;
  - a move re-queues the task at the head with reason `crew-moved`, places a start on the fallback with the same
    name, role, engine and a hand-off note, and after `agent.started` the new agent has the crew flag, the same display
    name, the old groups and `movedFrom`, while the old one is a retired entry for its host;
  - a member is moved at most once until its move start ends;
  - `agent.crewRetired` from the old host clears the entry.
- [ ] Implement, run the files green, and commit.

### Task 3: Host sleeps, drops folders and branches (CLI)

**Files:**
- Create `cli/src/superTabs/crewFolders.ts`.
- Modify `host.ts` (row `sleep` → `closeMember` without removing the worktree; `dropFolder` and retired entries →
  drop the folder; `dropBranches` → `git branch -D` when safe).
- Test `crewFolders.spec.ts` and `host.spec.ts`.

- [ ] Failing tests (fake core, temp git repos in `mktemp -d`):
  - `sleep` closes the session and keeps the folder;
  - a cleared `sleep` before the close starts closes nothing;
  - `dropFolder` removes a clean worktree, and refuses a dirty one or one with unpushed commits, reporting why;
  - a retired entry closes the session if it is open, drops the folder, and reports `agent.crewRetired`;
  - `dropBranches` deletes a merged branch that isn't checked out and leaves the current one.
- [ ] Implement, run the files green, and commit.

### Task 4: Machine rows show crew sessions, free disk and idle hours

- **Backend (this PR):** `machineRows` in the read view carries `crew: [{ name, asleep, idleHours }]` and
  `diskFreeBytes` per machine. Test in `crewKeep.apply.test.ts`.
- **Desktop:** the machine row shows them. It needs Flutter on a Mac, so it goes to the PM to give to a Desktop
  Engineer against this field contract (mockup first).
