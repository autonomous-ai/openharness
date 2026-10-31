# Terminal relay, Phase 1: per-connection frames go straight to a local connection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `adapter-ws` up frame for one connection is delivered directly when that connection is on this worker, without Redis, and a per-minute log says how many pods each published frame reaches.

**Architecture:** A small `terminalRoute.ts` decides, per connection and per adapter socket, local or published (sticky from the first frame) and delivers with the hub's existing send functions. `relayStats.ts` counts local, published and the receivers each `PUBLISH` reports. `adapterWs.ts` sends its three per-connection publish sites through it.

**Tech Stack:** TypeScript, `ws`, ioredis pub/sub (`lib/bus.ts`), vitest.

**Spec:** `docs/superpowers/specs/2026-10-31-terminal-relay-direct-design.md` (Phase 1 only; Phase 2 is not built)

## Global Constraints

- Phase 1 only. No `conn:` records, no `pod:` channels.
- A connection's frames arrive once, in order, byte-identical to today; send rules unchanged (`guardedSend` "must", kill-water).
- "Local" means this Node worker (`registry.PROCESS_ID`), not this pod.
- The route is sticky: decided by the connection's first frame on an adapter socket, kept until the adapter socket closes.
- Frames for every client of a machine (no `targetConnId`) are unchanged.
- No stored data, no client change, backend only. No ids in logs.
- Do not commit or push until Ken asks; each task ends with a diff checkpoint. Remove dead code.
- Commands from `backend/`: `npx vitest run <file>`; `npm run typecheck`.

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

### Task 4: Checks

- [ ] **Step 1:** `npm run typecheck`; `npx vitest run src/lib src/routes` — only failures already on clean `main`, listed in the PR.
- [ ] **Step 2:** After release, from `cpu by kind` (`adapter-ws *`, `bus terminal *`, `bus main up`) and `terminal relay`: total relay busy time before and after, the local share, and receivers per published frame. Write in the PR whether Phase 2 goes (it goes only above 1.5 receivers per published frame).
