# Fewer Frames Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** About half the frames between daemons, backend and apps, with every app showing what it shows today.

**Architecture:** Four independent changes: the backend publishes a machine's Swarm reading at most every 30 s; the
daemon's heartbeat sends one frame per beat and repeats no unchanged activity; the daemon skips an `agent_synced` that
changes nothing but activity; and apps away from the computer get slim transcript events. A measuring script runs
before and after.

**Tech Stack:** backend Node/TypeScript (vitest), CLI Node/TypeScript (vitest), Python 3 for the log count.

**Spec:** `docs/plans/2026-10-31-live-events-relay-design.md`

## Status and handoff (2026-10-31)

- Spec and plan written. Tasks 0, 2, 4 and 5 built on branch `fewer-relay-frames` (2026-10-31), not pushed;
  tasks 1 and 3 still on hold. Built differently from the steps below, each for the reason given:
  - Task 0: the build Mac's Desktop log of 2026-10-30 is not Ken's (161,203 frames, 03:05-17:02); both are in the
    spec's Results.
  - Task 2: an unchanged activity is compared by `state` and `epoch`, not `revision` (spec, change 2).
  - Task 4: `slimForRelay` is `cli/src/lib/slimForRelay.ts`, not `src/gateway/` (the core may not import it); a tool
    input's objects are bounded to 50 keys as its lists are; the terminal app's mock sends only fields the slim
    frame keeps, so it needs no change, and `tui/tests/e2e.sh` could not be run on a current build (no Rust here).
  - Task 5: `docs/swarms.md` is unchanged: its 30 s rule is task 1's, on hold.
- **Run tasks 0, 2, 4 and 5.** Tasks 1 and 3 are **on hold** (spec, "On hold"): task 1 would make Desktop and the web
  show machines late or offline, and needs its own design with a client change, not yet decided by Ken; task 3 saves
  little that is safe to drop. Skip them; do not delete them, they are the starting point if Ken decides.
- A first version of task 0's script is in `scripts/desktop-frame-count.py` (counts by type); task 0 adds the
  `swarm_changed` gap and the `agent_synced` classes, then runs it on a Desktop log to reproduce the "before" table.
- Task 2: activity states are only `working`, `idle` and `unknown` (`cli/src/lib/turnActivity.ts`); write the tests
  with those (the plan's "waiting" example becomes `idle`).

## Global Constraints

- Windows on this computer and everything inside the daemon (the dial's cards, recaps, the Swarm, search, the
  orchestrator, local tool clients) keep full events; only frames for apps away from the computer change (task 4).
- `cli/src/lib/e2ee/core.ts` is not edited (its hash is pinned with other repositories' clients).
- `updatedAt` changes are always sent in `agent_synced` (the phone sorts agents by it).
- `turn_heartbeat` stays the frame sent while working (the phone reads only it).
- Backend tests: `cd backend && NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= npx vitest run <file>`.
- CLI tests: `cd cli && npx vitest run <file>`; files under `src/core/` need `npm run test:core` (100% per file).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; no push, PR, merge or release
  without Ken.

## Review Focus

- A Swarm whose only changes are machine readings for an hour: apps still see machine cards update at least every
  30 s. (Task 1 test.)
- A main change 5 s after a machine push: it goes at once and also carries any machine part held since. (Task 1 test.)
- An agent waiting on a question for 10 minutes: one `agent_activity` when it starts waiting, none after, and one
  again when it resumes working. (Task 2 test.)
- The same agent synced 100 times with only `activity` moving: one frame to the apps, every one to the dial. (Task 3
  test.)
- A `Write` tool whose input is 2 MB: the remote frame is under 2 KB, the window here gets all 2 MB. (Task 4 test.)

---

### Task 0: The frame count script, and the "before" number

**Files:**
- Create: `scripts/desktop-frame-count.py`
- Modify: `docs/plans/2026-10-31-live-events-relay-design.md` (Results section)

**Interfaces:**
- Produces: `python3 -I scripts/desktop-frame-count.py <app-log>` prints, for one Desktop log, the window, the total
  `↓` frames, and per type the count, share and logged bytes, most frequent first; plus `swarm_changed` median gap and
  `agent_synced` classes (first, identical, activity-only, other) as in the spec.

- [ ] **Step 1:** Write the script (stdlib only; read the file as bytes and decode with `errors='replace'`; the line
  format is `[YYYY-MM-DD HH:MM:SS] DEBUG ws      ↓ <type> {...}`).
- [ ] **Step 2:** Run it on `~/.harness/logs/app-20261030.log`.
  Expected: 170,666 frames; `swarm_changed` 54,282; `agent_activity` 32,819; `turn_heartbeat` 28,411; `agent_synced`
  17,099 with 4,239 identical and 181 activity-only.
- [ ] **Step 3:** Add a "Results" section to the spec with the command and the "before" table; leave an "after" row.
- [ ] **Step 4:** Commit: `git add scripts/desktop-frame-count.py docs/plans/2026-10-31-live-events-relay-design.md`,
  message "Frame count: a script that counts a Desktop log's frames by type, and the before number".

### Task 1: A machine's Swarm reading published at most every 30 s (backend)

**Files:**
- Modify: `backend/src/lib/swarmClientPushes.ts` (`coalescer`, `announced`, `announceSwarmChanges`)
- Test: `backend/src/lib/swarmClientPushes.test.ts` (beside "publishes at most once per Swarm a second")

**Interfaces:**
- Produces: `MACHINE_COALESCE_MS = 30_000` (exported for the test); `coalescer(merge, emit, windowMs)` takes its window
  instead of the module constant; `announceSwarmChanges(change)` keeps its signature.

- [ ] **Step 1: Write the failing tests** (each uses a Swarm id of its own, as the existing publish test does):

```ts
it('publishes a machine reading at most every 30 s per Swarm, the first at once', async () => {
  announceSwarmChanges({ tabId: 'tab-readings', userIds: ['kim'], lastChangedAt: 1, parts: ['machine'] })
  expect(bus.published).toEqual([['kim', { tabId: 'tab-readings', lastChangedAt: 1, parts: ['machine'] }]])
  for (let at = 2; at <= 20; at++) {
    await vi.advanceTimersByTimeAsync(1_000)
    announceSwarmChanges({ tabId: 'tab-readings', userIds: ['kim', 'lee'], lastChangedAt: at, parts: ['machine'] })
  }
  expect(bus.published).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(MACHINE_COALESCE_MS)
  expect(bus.published.slice(1)).toEqual([['kim', { tabId: 'tab-readings', lastChangedAt: 20, parts: ['machine'] }],
    ['lee', { tabId: 'tab-readings', lastChangedAt: 20, parts: ['machine'] }]])
})
it('sends a main change at once, carrying the machine reading it held', async () => {
  announceSwarmChanges({ tabId: 'tab-mixed', userIds: ['kim'], lastChangedAt: 1, parts: ['machine'] })
  await vi.advanceTimersByTimeAsync(5_000)
  announceSwarmChanges({ tabId: 'tab-mixed', userIds: ['kim'], lastChangedAt: 2, parts: ['machine'] })
  announceSwarmChanges({ tabId: 'tab-mixed', userIds: ['kim'], lastChangedAt: 3, parts: ['main'] })
  expect(bus.published.slice(1)).toEqual([['kim', { tabId: 'tab-mixed', lastChangedAt: 3, parts: ['main', 'machine'] }]])
  // The machine reading went with it: none is left for the end of its window.
  await vi.advanceTimersByTimeAsync(MACHINE_COALESCE_MS)
  expect(bus.published).toHaveLength(2)
})
```

- [ ] **Step 2: Run them**: `… npx vitest run src/lib/swarmClientPushes.test.ts`. Expected: FAIL (the 1 s coalescer
  publishes the readings every second; `MACHINE_COALESCE_MS` undefined).
- [ ] **Step 3: Implement.** Give `coalescer` a `windowMs` parameter (`relaySwarmChanges` and `announced` pass
  `COALESCE_MS`). Add a second process-level coalescer `announcedReadings` with `MACHINE_COALESCE_MS` for changes whose
  parts are only `machine`. In `announceSwarmChanges`: a machine-only change goes to `announcedReadings`; any other
  change takes what `announcedReadings` holds for that Swarm (a `take(key)` on the coalescer that returns and clears the
  held value, leaving its window open), merges it, and goes to `announced`. Update the comment above `COALESCE_MS`
  with the measurement (54,282 machine pushes a day for one Swarm of ten machines, 2026-10-30).
- [ ] **Step 4: Run the file.** Expected: PASS, the existing tests included (the old "publishes at most once per Swarm
  a second" test still passes: its machine part rides with the main change).
- [ ] **Step 5: Commit** `backend/src/lib/swarmClientPushes.ts backend/src/lib/swarmClientPushes.test.ts`, message
  "Swarm pushes: a machine's reading is published at most every 30 s; main changes still at once".

### Task 2: One heartbeat frame per beat, and no unchanged activity repeated (CLI core)

**Files:**
- Modify: `cli/src/core/turns/heartbeats.ts` (`createHeartbeats`, `beat`, `stopHeartbeat`)
- Test: `cli/src/core/turns/heartbeats.spec.ts`

**Interfaces:**
- Produces: no new export; `createHeartbeats` keeps its deps and return value.

- [ ] **Step 1: Write the failing tests** with the file's `setup()` and `sentTypes()`:

```ts
it('sends only turn_heartbeat, with its activity, while working', async () => {
  const { deps, beats, set } = setup()
  set({ activity: { state: 'working', epoch: 'e', revision: 1, validForMs: 30_000 } as ActivityFrame })
  beats.startHeartbeat('s1')
  await vi.advanceTimersByTimeAsync(15_000)
  expect(sentTypes(deps)).toEqual(['turn_heartbeat', 'turn_heartbeat', 'turn_heartbeat'])
  expect(vi.mocked(deps.clients.send).mock.calls[0]![0]).toMatchObject({ payload: { activity: { state: 'working' } } })
})
it('sends a waiting activity once, and again only when it changes or the heartbeat restarts', async () => {
  const { deps, beats, set } = setup()
  set({ activity: { state: 'waiting', epoch: 'e', revision: 2, validForMs: 0 } as ActivityFrame })
  beats.startHeartbeat('s1')
  await vi.advanceTimersByTimeAsync(600_000)
  expect(sentTypes(deps)).toEqual(['agent_activity'])
  set({ activity: { state: 'working', epoch: 'e', revision: 3, validForMs: 30_000 } as ActivityFrame })
  await vi.advanceTimersByTimeAsync(5_000)
  set({ activity: { state: 'waiting', epoch: 'e', revision: 4, validForMs: 0 } as ActivityFrame })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(sentTypes(deps)).toEqual(['agent_activity', 'turn_heartbeat', 'agent_activity'])
  beats.stopHeartbeat('s1'); beats.startHeartbeat('s1')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(sentTypes(deps).at(-1)).toBe('agent_activity')
})
```

  Use the activity shape `ActivityFrame` really has (`lib/turnActivity.ts`); compare by `state`, `epoch`, `revision`.
- [ ] **Step 2: Run**: `cd cli && npx vitest run src/core/turns/heartbeats.spec.ts`. Expected: FAIL (both frames every
  beat). Update existing tests in the file that expect both frames to the new rule.
- [ ] **Step 3: Implement.** A `lastActivity = new Map<string, string>()` keyed by session, holding
  `${state}:${epoch}:${revision}`; working → send only `turnHeartbeatFrame(...)`; otherwise send `agent_activity` only
  when the key differs, then store it; `stopHeartbeat` deletes the entry. Comment why (2026-10-30: 32,819
  `agent_activity` and 28,411 `turn_heartbeat` a day, the same activity twice; the phone reads only `turn_heartbeat`).
- [ ] **Step 4: Run** the file, then `npm run test:core`. Expected: PASS, 100% for `heartbeats.ts`.
- [ ] **Step 5: Commit** `cli/src/core/turns/heartbeats.ts cli/src/core/turns/heartbeats.spec.ts`, message
  "Heartbeats: one frame a beat, turn_heartbeat while working; an unchanged activity is not repeated".

### Task 3: `agent_synced` skipped when nothing but activity changed (CLI)

**Files:**
- Modify: `cli/src/lib/sessionSync.ts` (`createSessionSync`)
- Test: `cli/src/lib/sessionSync.spec.ts`

**Interfaces:**
- Produces: `createSessionSync` keeps its signature and callers; exported `SYNC_MEMORY_LIMIT = 2_000`.

- [ ] **Step 1: Write the failing tests** with the file's `harness()` and `row()`:

```ts
it('sends the apps an agent only when something besides its activity changed, and the dial every time', async () => {
  let activity = { state: 'working', epoch: 'e', revision: 1 }
  const h = harness({ project: vi.fn(async (session) => ({ ...agentFrame(session, { selectedModel: null, terminalAvailable: true }), activity })) as never })
  await h.sync(row())
  await h.sync(row())
  activity = { state: 'idle', epoch: 'e', revision: 2 }
  await h.sync(row())
  expect(h.send).toHaveBeenCalledTimes(1)
  expect(h.sendCommander).toHaveBeenCalledTimes(3)
  await h.sync(row({ title: 'Renamed' }))
  expect(h.send).toHaveBeenCalledTimes(2)
})
it('sends in full after the agent was unavailable, and remembers at most SYNC_MEMORY_LIMIT agents', async () => {
  let available = true
  const h = harness({ terminalAvailable: () => available })
  await h.sync(row()); available = false; await h.sync(row()); available = true; await h.sync(row())
  expect(h.send).toHaveBeenCalledTimes(2)
  for (let i = 0; i <= SYNC_MEMORY_LIMIT; i++) await h.sync(row({ agentId: `agent-${i}` }))
  await h.sync(row({ agentId: 'agent-0' }))   // the oldest was forgotten: sent again
  expect(h.send).toHaveBeenCalledTimes(2 + SYNC_MEMORY_LIMIT + 2)
})
```

- [ ] **Step 2: Run**: `npx vitest run src/lib/sessionSync.spec.ts`. Expected: FAIL (every sync is sent).
- [ ] **Step 3: Implement.** A `Map<string, string>` agentId → `JSON.stringify` of the agent without `activity`
  (insertion order = age; on a set, delete then set; above the limit delete the first key). Skip `deps.send` when equal;
  always call `deps.sendCommander` as today. On the unavailable branch, delete the agent's entry. Comment why
  (2026-10-30: 4,239 of 17,099 `agent_synced` identical to the one before).
- [ ] **Step 4: Run** the file and `npx vitest run src/lib src/core/agents` (callers' tests). Expected: PASS.
- [ ] **Step 5: Commit** `cli/src/lib/sessionSync.ts cli/src/lib/sessionSync.spec.ts`, message
  "Agent sync: an agent is not sent to the apps again when only its activity changed".

### Task 4: Slim transcript events for apps away from the computer (CLI)

**Files:**
- Create: `cli/src/gateway/slimForRelay.ts`, `cli/src/gateway/slimForRelay.spec.ts`
- Modify: `cli/src/backendSocket.ts` (`toRemoteApps`, ~620)
- Test: `cli/src/backendSocket.spec.ts` (or the relay socket tests that cover `send`)

**Interfaces:**
- Produces: `export function slimForRelay(frame: Frame): Frame` — pure; returns the same object for a type not in the
  spec's table; never mutates its input.

- [ ] **Step 1: Write the failing unit tests**, one per table row of the spec ("4. Transcript events"), with these
  exact values: string values in `tool_start.input` cut to 200 characters, arrays to 50 items, nesting to depth 4;
  `done.result` cut to 500; `user_message.images` dropped; `thinking_delta` and `context_compact` keep no payload field
  but `activity`, `agentId`, `sessionId`, `replay`; `tool_end` keeps `id`, `tool`, `parentToolUseId`, `isError`;
  `subagent_finished` keeps `id`, `status`; the envelope (`type`, `agentId`, `dbSessionId`, `replay`, `subagent`) is
  identical; a 2 MB `Write` input yields a frame whose `JSON.stringify` is under 2,048 bytes; `TodoWrite`'s `todos`
  (10 items) survive whole; an `agent_synced` frame is returned unchanged (`toBe`).
- [ ] **Step 2: Run**: `npx vitest run src/gateway/slimForRelay.spec.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `slimForRelay` with a per-type table of kept payload keys plus the four always-kept ones.
- [ ] **Step 4: Write the failing socket test**: a `tool_end` with `output` sent through `socket.send` reaches a local
  client with `output` and reaches the gateway (`upstreamOf(socket).queue`, unsealed in the test's setup or read
  through the gateway's `broadcast` spy) without it. Run it; expected FAIL.
- [ ] **Step 5: Implement** in `toRemoteApps`: `const frame = this.forApps(slimForRelay(given))`.
- [ ] **Step 6: Run** `npx vitest run src/gateway src/backendSocket.spec.ts` and the gateway product-usage test
  ("passes only lifecycle scalars to product reporting"). Expected: PASS.
- [ ] **Step 7: The terminal app**: run `tui/tests/e2e.sh` (it uses `tui/tests/mock-daemon.mjs`) after making the mock
  send slim frames (pass them through the same table, by hand, for the frames it sends). Expected: plan, sub-agents and
  "doing" still render.
- [ ] **Step 8: Commit** the new files, `cli/src/backendSocket.ts`, the socket test and any `tui/tests` change, message
  "Relay: apps away from the computer get slim transcript events, no tool output, thinking text or images".

### Task 5: Docs, and the "after" number

**Files:**
- Modify: `docs/swarms.md` (the push section: machine readings at most every 30 s), the spec's Results section.

- [ ] **Step 1:** Update `docs/swarms.md` where it describes Swarm pushes (search "swarm_changed" / "push") with the
  30 s rule and why.
- [ ] **Step 2:** After release, on a comparable day, run Task 0's script on that day's Desktop log and fill the
  "after" row in the spec. (Done after release; leave the row marked pending until then.)
- [ ] **Step 3: Commit** `docs/swarms.md docs/plans/2026-10-31-live-events-relay-design.md`, message
  "Docs: Swarm machine readings pushed every 30 s; frame counts before".

## Validation and release

- Backend unit (`src/lib`), CLI unit (`src/core/turns`, `src/lib`, `src/gateway`, `src/backendSocket.spec.ts`),
  `npm run test:core`, both `tsc`, `tui/tests/e2e.sh`.
- Release order: backend (task 1), CLI (tasks 2-4); each is compatible alone.
