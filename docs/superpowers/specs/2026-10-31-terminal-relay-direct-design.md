# Design: per-connection frames go straight to the one connection they are for (terminal relay)

Date: 2026-10-31. Code read at `origin/main` (664dd0f63). Spec 6 in the backend CPU series.

## Why

A remote terminal's output reaches its viewer like this: the machine's daemon sends it up its `adapter-ws` socket to
whichever backend pod holds that socket; that pod publishes it to Redis; every pod with a viewer of that machine receives
it and hands it to its viewer.

**Every terminal frame is for exactly one viewer connection.** A binary terminal hop carries its `connId`
(`deliverTerminalUpLocal`, `hub.ts:44`), and a JSON `terminal_*` / `p2p_*` up frame carries `targetConnId`
(`adapterWs.ts:437-470`). Yet:

- `adapterWs.ts:427` publishes every binary hop to `termup:{machineId}`, and `adapterWs.ts:443,458` every JSON one to
  `up:{machineId}`, **even when the viewer is on the same pod**: the pod receives its own frame back from Redis.
  (`managerWs.ts:255-256` already delivers locally first and skips its own echo with `originPid`; the adapter path does
  not.)
- Every pod holding any client of that machine receives the frame, decodes it, and drops it unless it owns the
  `connId`.
- A JSON up frame is encoded twice: `publishUp` stringifies the whole envelope, the receiver parses it, and
  `deliverUpLocal` (`hub.ts:59`) stringifies `msg.frame` again before sending.

**Prod (2026-10-30/31, 16 CPU profiles, 3 pods):** relay and socket work is ~13.5% of non-idle CPU (Redis bus 2.5%,
ioredis 2.5%, socket writes 6.6%, `ws` receiver 0.9%), consistent with the 17.5% of event-loop time logged as
`untagged`. #2393 names these kinds (`adapter-ws binary|text`, `bus terminal termup`, `bus main up`) from the next
release, which will say exactly how much is terminal relay.

## Goals

- A terminal frame whose viewer is on the pod that received it never goes through Redis.
- A frame whose viewer is on another pod reaches only that pod (Phase 2), behind a kill switch.
- A JSON terminal frame is not parsed and re-stringified on its way to the viewer.
- Ordering, delivery guarantees ("must" sends, kill-water) and E2EE are unchanged: the backend still forwards opaque
  sealed bytes.

## Non-goals

- Up frames that are not for one connection (status, events, RPC replies to all clients): they keep `up:{machineId}`.
- Down frames (viewer → machine): `sendDown` already goes direct when the control socket is local (`hub.ts`).
- Moving terminals to p2p, the multiplexed account socket (WebSocket roadmap Phases 4–5).

## Anti-goals

- A frame delivered twice, lost, or out of order for its connection.
- A viewer on a pod running the previous release missing frames during a rolling deploy.

## Design decided

*(Author's calls after the builder check: the phases, the sticky route, and every per-connection adapter frame.)*

### Phase 1 — local first, encode once, count the receivers

- **Which frames:** every `adapter-ws` up frame for one connection: a binary terminal hop (its `connId`) and any JSON up
  frame with a `targetConnId` (`terminal_*`, `p2p_*`, and the general per-connection publish at `adapterWs.ts:565`, such
  as `e2e_welcome` and per-client RPC replies). Keeping all of a connection's frames on one path keeps their order.
  Frames for every client of a machine (no target) are unchanged.
- **Local:** when that connection is on this process (`registry.clientsFor(machineId)` holds its `connId`; `PROCESS_ID`
  is per Node worker, so "local" means the same worker), the frame is delivered there directly with today's send rules
  (`deliverTerminalUpLocal` for a hop; for JSON the same per-connection path `deliverUpLocal` takes, from the adapter's
  already-parsed frame, stringified once) and is not published.
- **Local is for good:** a connection is local or not for its whole life (`connId` is a new `randomUUID()` per attach
  and never moves), so a local route never changes.
- **Untargeted frames go local first too** *(after the independent review)*: an adapter frame for every client of the
  machine is delivered to this process's clients first, then published with `originPid` (this process's own Redis
  subscription skips it), as `managerWs` does. Otherwise a local viewer's targeted reply would overtake an event the
  daemon sent before it. Observers and `nodeRpc` ignore `originPid` and still get the Redis copy.
- A `targetConnId` that is not a string of 1–128 characters is published as before, never used as a route or a key.
- **Receiver count:** `PUBLISH` answers how many subscriptions received a message. A per-minute log `terminal relay`
  counts, per channel kind (`termup`, `up` targeted, `up` broadcast): frames delivered locally, frames published, and the
  receivers they reached in total. That says how many pods each published frame wakes for nothing.

### Phase 2 — publish only to the owning process (built with Phase 1; Ken, 2026-10-31)

- On attach a pod records `conn:{connId} → PROCESS_ID` in Redis (`SET … PX 60 000`, renewed with the client heartbeat,
  deleted on detach) and each process subscribes to its own `pod:{PROCESS_ID}` channel(s).
- **One switch, in order** *(after the independent review; replaces a queue and a 250 ms lookup timeout)*: a
  non-local connection's frames go to the machine's channels while its owner is looked up, then, if another process
  owns it, to that process's channels; with no owner (old process, expired record, failed lookup) they stay on the
  machine's channels. The switch keeps order: both channels are published from the one `pub` connection; the owner reads
  `up:`/`uppod:` on `sub` and `termup:`/`termpod:` on `terminalSub`, one subscriber connection per kind; and the owner holds
  a viewer of the machine, so it reads the machine's channels. Nothing waits for the lookup, so untargeted frames sent
  after a targeted one never overtake it.
- The receiver delivers with the existing functions: a hop with `deliverTerminalUpLocal`, a JSON message (the whole
  `UpBusMsg`, *author's call during implementation*: a device connection's frames need the machine tag and the voice
  queue `deliverUpLocal` applies) with `deliverUpLocal`. Both only reach that process's clients **of the message's
  `machineId`** with that `connId`, so a daemon's frame never reaches another machine's connection. A `uppod:` message
  without a string `targetConnId` is ignored.
- **Kill switch:** `TERMINAL_POD_ROUTES=off` stops writing records and routing to `pod:` (on by default). With it off,
  Phase 1 still runs; records already written expire within 60 s.

### Risks (and what covers each)

| Risk | Cover |
|---|---|
| A frame lost or reordered when the path changes | A route changes at most once, machine → owner, which keeps order (one publisher connection, one subscriber connection per kind); real-Redis tests of 1,000 frames across that switch |
| A viewer on an old pod during the rolling deploy | No record from old pods → today's channels; new pods keep today's subscriptions |
| A pod that crashed leaves records for 60 s | Frames to its `pod:` channel reach nobody, as frames to its dead sockets do today; its viewers reconnect elsewhere with a new `connId`, which gets a new record |
| A daemon targeting another machine's connection | The receiver checks `connId` against its clients of the frame's `machineId` |
| More Redis writes: a record per attach, renewed per heartbeat (Desktop re-attaches on every agent switch) | One `SET` per attach and per 25 s per connection, one pipeline per heartbeat; one `GET` per connection, once; at most 2,000 routes kept per adapter socket |
| A bug that only shows across real pods | A real-Redis test (two subscriber connections standing for two processes, `REDIS_TEST_URL`), the kill switch, and the `terminal relay` log after release |
| Little gain if most machines have viewers on one pod | `terminal relay` counts receivers per publish before and after; the kill switch turns Phase 2 off if it does not pay |


## Left to the builder

- Module layout (a small `terminalRoute.ts` beside `hub.ts` is one option), log and key names.
- Phase 2's exact channel and key names (two channels, one per subscriber connection, as decided).

## Tests

- **Phase 1:** a local viewer gets a binary hop, a JSON terminal frame and an `e2e_welcome` with no Redis publish, in the
  order sent, byte-identical to today; a remote viewer gets them through today's channels; a local connection that
  detaches mid-stream drops the rest; the `terminal relay` log counts local, published and receivers per kind.
- **Phase 2:** a remote viewer's frames go to `pod:{owner}` only and a third pod with another client of the
  machine receives nothing; an unknown owner stays on today's channels for the connection's life; 1,000 frames for one
  connection arrive once and in order, with the record appearing midway; re-attach on another pod routes the new
  `connId` to its pod.
- Existing hub, adapter, webWs and terminal E2E suites stay green.

## Measuring

After each release, from #2393's kinds and Phase 1's log: the **total** relay busy time per pod-minute across
`adapter-ws *`, `bus terminal *`, `bus main up` and (Phase 2) `bus pod *`; Redis publishes per minute; receivers per
published frame. **Done when** Phase 1 shows the local share delivered without Redis and total relay time falls, with no
rise in terminal stall reports (`TERMINAL_RENDER_STALLED`); with Phase 2, receivers per published frame fall to about 1.
If they were already about 1, Phase 2 is switched off (`TERMINAL_POD_ROUTES=off`) and removed in a later change.

## Design (AGENTS.md rules)

- **Growth:** Phase 1 stores nothing. Phase 2: one Redis key per open viewer connection, expiring 60 s after its last
  heartbeat; one channel per process.
- **Concurrency:** no locks; a connection's frames keep one sticky path, in send order.
- **Read cost:** Phase 1 none. Phase 2: one Redis `GET` per connection, once, on the sending process.
- **Scale:** at 10× viewers or pods, a frame still costs one local send or one publish to one pod; the per-machine fan-out
  no longer grows with pods. Redis publish rate is the first thing to watch.
- **Compatibility:** old pods write no record, so frames for their viewers fall back to today's channels; new pods keep
  subscribing to those channels.
- **Migration + rollback:** nothing stored beyond expiring keys; `TERMINAL_POD_ROUTES=off` turns Phase 2 off without a
  deploy; roll back by deploying the previous release.
- **Audience:** unchanged; a frame reaches only the connection it names, as today.
- **Identity:** N/A because nothing here acts as or reads the machine owner's login.
- **Failure:** Redis unreachable → local viewers still get frames; remote ones fail as today. A missing record falls
  back to broadcast, never drops.
- **Platforms:** backend only.
