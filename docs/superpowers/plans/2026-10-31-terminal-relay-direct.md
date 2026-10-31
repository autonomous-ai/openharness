# Terminal relay: per-connection frames go straight to their connection (Phases 1 and 2) — Implementation Plan

> **Implemented 2026-10-31** with the review changes noted in the spec (one switch instead of a queue; whole `UpBusMsg` on `uppod:`; untargeted frames local first). Task text below is the original plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `adapter-ws` up frame for one connection is delivered directly when that connection is on this worker, and otherwise published only to the worker that holds it; a per-minute log says how many workers each published frame reaches.

**Architecture:** `terminalRoute.ts` decides, per connection and per adapter socket, local, owner's channel or today's channels (sticky from the first frame). Phase 1 (Tasks 1–3) is local delivery and the counters; Phase 2 (Tasks 4–6) adds owner records in Redis, a channel per worker, and routing to it behind `TERMINAL_POD_ROUTES`.

**Tech Stack:** TypeScript, `ws`, ioredis pub/sub (`lib/bus.ts`), vitest.

**Spec:** `docs/superpowers/specs/2026-10-31-terminal-relay-direct-design.md` (both phases, one delivery)

## Global Constraints

- Both phases ship together. Phase 2 runs unless `TERMINAL_POD_ROUTES=off`; with it off, Phase 1 alone runs.
- Owner record `PX 60 000`, renewed every `CLIENT_HEARTBEAT_MS` (25 s). A non-local connection uses the machine's channels until its owner is known, then the owner's; no owner or a failed lookup keeps the machine's channels (spec, Phase 2 "One switch, in order").
- A `pod:` message carries `machineId`; a JSON one carries the whole `UpBusMsg` and is delivered with `deliverUpLocal` (implementation call, see spec); both reach only that machine's client with that `connId`.
- Untargeted adapter frames are delivered locally first, then published with `originPid` (independent review).
- Each `pod:` channel rides the subscriber connection of the channel it replaces: binary on `terminalSub`, JSON on `sub`.
- A connection's frames arrive once, in order, byte-identical to today; send rules unchanged (`guardedSend` "must", kill-water).
- "Local" means this Node worker (`registry.PROCESS_ID`), not this pod.
- The route is sticky: decided by the connection's first frame on an adapter socket, kept until the adapter socket closes.
- Frames for every client of a machine (no `targetConnId`) are unchanged.
- No stored data, no client change, backend only. No ids in logs.
- Do not commit or push until Ken asks; each task ends with a diff checkpoint. Remove dead code.
- Commands from `backend/`: `npx vitest run <file>`; `npm run typecheck`. Real-Redis tests run with `REDIS_TEST_URL=redis://127.0.0.1:6379/15` (local docker `harness-redis`; CI skips them, as `src/superTabs/cacheRedis.test.ts` does).

## Review Focus

1. A local viewer that detaches mid-stream: later frames for its `connId` are dropped, never published to other pods — Task 2 test.
2. A JSON frame targeted at a device (`commander`) connection on this worker (E2EE pairing): delivered locally like a web one — Task 2 test.
3. A guest connection (shared machine) gets only frames addressed to it, locally as through Redis (`hub.test.ts` "a guest on a shared machine") — Task 2 test.
4. Redis down (`safePublish` returns 0): a local viewer still gets frames; stats count 0 receivers — Task 2 test.
5. Two adapter sockets for one machine (a reconnect overlap): each keeps its own sticky map; closing one does not clear the other's — Task 2 test.

---

### Task 1: Relay counters and the `terminal relay` log

**Files:**
- Create: `backend/src/lib/relayStats.ts`
- Modify: `backend/src/server.ts` (start and stop beside `startRetryStats`)
- Test: `backend/src/lib/relayStats.test.ts`

**Interfaces:**
- Produces: `type RelayKind = 'termup' | 'up targeted' | 'up broadcast'`; `recordRelay(kind: RelayKind, path: 'local' | 'published', receivers?: number): void`; `startRelayStats(options?: { everyMs?: number; log?: (message: string, context: Record<string, unknown>) => void }): () => void` logging `'terminal relay'` each `everyMs` (default 60 000) with `{ windowMs, kinds: { [kind]: { local, published, receivers } } }`, nothing in a window with no frames.

- [ ] **Step 1: Write the failing test** `'counts local and published frames and the receivers each publish reached, per kind'`: record `('termup','local')` ×2, `('termup','published',2)`, `('up targeted','published',1)`; with `everyMs: 50` expect `{ termup: { local: 2, published: 1, receivers: 2 }, 'up targeted': { local: 0, published: 1, receivers: 1 } }`, and a later empty window logs nothing.
- [ ] **Step 2: Run** `npx vitest run src/lib/relayStats.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** the module and wire it in `server.ts`.
- [ ] **Step 4: Run** the test — PASS; `npm run typecheck` — passes.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 2: Sticky per-connection routes

**Files:**
- Create: `backend/src/lib/terminalRoute.ts`
- Test: `backend/src/lib/terminalRoute.test.ts` (mock `./bus.js` as `hub.test.ts` does; attach clients with `attachHubClient`)

**Interfaces:**
- Consumes: `deliverTerminalUpLocal(machineId, packet)` and `deliverUpLocal(machineId, msg)` (`hub.ts`); `publishTerminalUp`, `publishUp` (`bus.ts`, they resolve to the receiver count); `registry.clientsFor(machineId)`; Task 1's `recordRelay`.
- Produces: `createConnectionRoutes(machineId: string): ConnectionRoutes` with
  - `hop(packet: Uint8Array, connId: string): void` — a binary terminal hop for `connId` (a `web` client);
  - `targeted(msg: UpBusMsg & { targetConnId: string }): void` — a JSON up frame for one connection (any client kind; `msg.targetKind` as today);
  - `close(): void` — forgets the sticky map (adapter socket closed).
  First frame per `connId`: local when `registry.clientsFor(machineId)` holds a client with that `connId` (and, for a hop, kind `web`), else published; the decision is kept in a `Map<connId, 'local' | 'published'>` for this object's life. Local → deliver with the hub function and `recordRelay(kind, 'local')`; published → today's publish, then `recordRelay(kind, 'published', receivers)`.
- [ ] **Step 1: Write the failing tests:**
  - `'delivers a hop and a targeted JSON frame to a local web connection without publishing'`: attach a web client, send a hop and a `terminal_output` JSON frame; the socket gets both, in order, the JSON text equal to `JSON.stringify(frame)`; `publishTerminalUp` and `publishUp` not called.
  - `'publishes for a connection that is not on this worker, as today'`: no client attached; `publishTerminalUp`/`publishUp` called with today's arguments.
  - `'keeps a connection on its first route: frames after a local viewer detaches are dropped, not published'` (Review Focus 1).
  - `'delivers a frame targeted at a local device connection'` (Review Focus 2).
  - `'sends a guest only frames addressed to it'` (Review Focus 3).
  - `'still delivers locally when Redis takes no publish'` (Review Focus 4; `publishUp` resolves 0).
  - `'keeps one adapter socket\'s routes when another closes'` (Review Focus 5).
- [ ] **Step 2: Run** `npx vitest run src/lib/terminalRoute.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** `terminalRoute.ts`.
- [ ] **Step 4: Run** it with `src/lib/hub.test.ts` — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 3: `adapter-ws` sends per-connection frames through the routes

**Files:**
- Modify: `backend/src/lib/adapterWs.ts` (create one `ConnectionRoutes` once `machineId` is known; binary hop at ~427; JSON `terminal_*` at ~443; `p2p_*` at ~458; the general publish at ~567 when `env.targetConnId` is set; `close()` in `cleanup`)
- Test: `backend/src/lib/adapterRoutes.test.ts` (copy the harness of `adapterShortTurns.test.ts`, lines 1–60, and mock `./terminalRoute.js`)

**Interfaces:**
- Consumes: Task 2's `createConnectionRoutes`; Task 1's `recordRelay` for the untargeted general publish (`'up broadcast'`, `'published'`, its receivers).
- [ ] **Step 1: Write the failing test** `'routes a hop, a terminal frame, a p2p frame and a targeted reply by their connection, and publishes the rest as before'`: through the adapter socket send a binary output hop (connId `c1`), a JSON `terminal_output` with `targetConnId: 'c1'`, a `p2p_offer` with `targetConnId: 'c1'`, an `e2e_welcome` with `targetConnId: 'c2'`, and an untargeted event; expect `hop(packet, 'c1')`, `targeted` ×3 with today's message fields (`webEligible`, `commanderEligible`, `targetKind`, `targetConnId`, `frame`), and `publishUp` once for the untargeted event; the route's `close` is called when the socket closes. Today's validation still drops a bad frame before routing (one invalid terminal frame is not routed).
- [ ] **Step 2: Run** `npx vitest run src/lib/adapterRoutes.test.ts` — FAIL.
- [ ] **Step 3: Implement** the wiring; keep every existing check (rate limits, sizes, encryption) before routing.
- [ ] **Step 4: Run** it with `src/lib/adapterShortTurns.test.ts`, `src/lib/hub.test.ts`, `src/lib/hubLiveness.test.ts`, `src/lib/webWs*.test.ts` — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 4: Owner records (Phase 2)

**Files:**
- Modify: `backend/src/lib/bus.ts` (owner record functions), `backend/src/lib/hub.ts` (`attachHubClient`, the detach path, `clientHeartbeatTick`), `backend/src/config/env.ts` (`TERMINAL_POD_ROUTES`, default `'on'`)
- Test: `backend/src/lib/connOwnersRedis.test.ts` (real Redis, `describe.skipIf(!process.env.REDIS_TEST_URL)`), `backend/src/lib/hub.test.ts` (mocked bus)

**Interfaces:**
- Produces in `bus.ts`: `recordConnOwners(connIds: string[], processId: string): Promise<void>` (one pipeline, `SET conn:{connId} processId PX 60000` each); `forgetConnOwner(connId: string): Promise<void>`; `connOwner(connId: string): Promise<string | null>`. Hub calls `recordConnOwners([connId])` on attach, `forgetConnOwner` on detach, and `recordConnOwners(all local connIds)` in `clientHeartbeatTick`, all only when the switch is on.
- [ ] **Step 1: Write the failing tests:** real Redis: a recorded owner reads back, expires after 60 s (use `PTTL`), is gone after forget, and a batch of 500 is one round trip (`MONITOR`-free: count commands with a wrapped client). Mocked bus: attach records, detach forgets, the heartbeat renews every local `connId`; with `TERMINAL_POD_ROUTES=off` none of these are called.
- [ ] **Step 2: Run** `REDIS_TEST_URL=redis://127.0.0.1:6379/15 npx vitest run src/lib/connOwnersRedis.test.ts src/lib/hub.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 5: A channel per worker (Phase 2)

**Files:**
- Modify: `backend/src/lib/bus.ts`, `backend/src/lib/hub.ts` (subscribe once at startup when the switch is on)
- Test: `backend/src/lib/podChannelRedis.test.ts` (real Redis), `backend/src/lib/hub.test.ts`

**Interfaces:**
- Produces in `bus.ts`: `publishPodHop(processId: string, machineId: string, packet: Uint8Array): Promise<number>` on channel `termpod:{processId}` (payload = 2-byte length + `machineId` UTF-8 + packet); `publishPodJson(processId: string, msg: { machineId: string; connId: string; targetKind?: 'web' | 'commander'; text: string }): Promise<number>` on `uppod:{processId}`; `subscribePod(processId: string, on: { hop(machineId: string, packet: Uint8Array): void; json(msg: …): void }): Promise<() => void>` — `termpod:` on `terminalSub`, `uppod:` on the JSON `sub` connection.
- Produces in `hub.ts`: `deliverTargetedTextLocal(machineId: string, connId: string, text: string, targetKind?: 'web' | 'commander'): boolean` — sends `text` to that one client with the same checks and send rules `deliverUpLocal` applies to a `targetConnId` frame; `false` when no such client of that machine. The hop side calls `deliverTerminalUpLocal(machineId, packet)`, which already checks the client is that machine's.
- [ ] **Step 1: Write the failing tests:** real Redis: 1,000 hops and 1,000 JSON texts published to one worker arrive once and in order on their own connection; a message for `machineId` A with a `connId` that belongs to machine B is not delivered (both hop and JSON). Mocked: `deliverTargetedTextLocal` sends byte-identical text, honours `targetKind`, returns `false` for a closed connection; a guest gets only its own frames.
- [ ] **Step 2: Run** them — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them with `src/lib/hub.test.ts` and `src/lib/bus.test.ts` — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 6: Routes publish to the owner (Phase 2)

**Files:**
- Modify: `backend/src/lib/terminalRoute.ts`
- Test: `backend/src/lib/terminalRoute.test.ts`, `backend/src/lib/terminalRouteRedis.test.ts` (real Redis)

**Interfaces:**
- Consumes: Task 4's `connOwner`; Task 5's `publishPodHop`, `publishPodJson`; Task 1's `recordRelay` with new kinds `'pod hop'` and `'pod json'`.
- Produces: the same `ConnectionRoutes` API. The first frame of a non-local connection starts `connOwner(connId)`; frames for that connection queue in arrival order until it answers (or 250 ms pass); then the route is fixed: an owner that is not this worker → `pod:` publishes (the JSON frame stringified once, as `text`); no owner, a failure, a timeout, or the switch off → today's channels. The queue drains in order before any newer frame.
- [ ] **Step 1: Write the failing tests:** an owner on another worker → `publishPodHop`/`publishPodJson` only, never `publishTerminalUp`/`publishUp`; no owner → today's channels for the connection's life, even when an owner appears later; a lookup that takes 300 ms → today's channels, frames sent in order; 50 frames sent while the lookup is pending go out in order after it; switch off → no lookup. Real Redis: two subscriber connections standing for two workers, an owner record for worker B, 1,000 frames from worker A for B's connection arrive at B in order and none at a third worker.
- [ ] **Step 2: Run** `npx vitest run src/lib/terminalRoute.test.ts` and the Redis test — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them with Tasks 2–5's tests — PASS.
- [ ] **Step 5: Checkpoint** `git diff --stat`.

### Task 7: Checks

- [ ] **Step 1:** `npm run typecheck`; `npx vitest run src/lib src/routes` — only failures already on clean `main`, listed in the PR.
- [ ] **Step 2:** Run the real-Redis tests locally: `REDIS_TEST_URL=redis://127.0.0.1:6379/15 npx vitest run src/lib/*Redis.test.ts`; record the result in the PR (CI skips them).
- [ ] **Step 3:** After release, from `cpu by kind` (`adapter-ws *`, `bus terminal *`, `bus main up`, `bus * termpod|uppod`) and `terminal relay`: total relay busy time before and after, the local share, and receivers per published frame. If receivers were already about 1 before, set `TERMINAL_POD_ROUTES=off` and file the removal of Phase 2.
