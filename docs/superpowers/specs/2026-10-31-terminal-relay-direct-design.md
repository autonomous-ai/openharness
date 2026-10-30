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
- If measured worth it (Phase 2), a terminal frame whose viewer is on another pod reaches only that pod.
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

### Phase 1 — local first, encode once, count the receivers (ships now)

- **Which frames:** every `adapter-ws` up frame for one connection: a binary terminal hop (its `connId`) and any JSON up
  frame with a `targetConnId` (`terminal_*`, `p2p_*`, and the general per-connection publish at `adapterWs.ts:565`, such
  as `e2e_welcome` and per-client RPC replies). Keeping all of a connection's frames on one path keeps their order.
  Frames for every client of a machine (no target) are unchanged.
- **Local:** when that connection is on this process (`registry.clientsFor(machineId)` holds its `connId`; `PROCESS_ID`
  is per Node worker, so "local" means the same worker), the frame is delivered there directly with today's send rules
  (`deliverTerminalUpLocal` for a hop; for JSON the same per-connection path `deliverUpLocal` takes, from the adapter's
  already-parsed frame, stringified once) and is not published.
- **Sticky route:** the first frame of a connection on an adapter socket decides its path (local or published) and it
  stays so until that connection detaches or the adapter socket closes. A connection is local or not for its whole life
  (`connId` is a new `randomUUID()` per attach and never moves), so the rule only makes that explicit.
- **Receiver count:** `PUBLISH` answers how many subscriptions received a message. A per-minute log `terminal relay`
  counts, per channel kind (`termup`, `up` targeted, `up` broadcast): frames delivered locally, frames published, and the
  receivers they reached in total. That says how many pods each published frame wakes for nothing.

### Phase 2 — publish only to the owning pod (only if Phase 1's log shows > 1.5 receivers per published frame)

- On attach a pod records `conn:{connId} → PROCESS_ID` in Redis (`SET … PX 60 000`, renewed with the client heartbeat,
  deleted on detach) and each process subscribes to its own `pod:{PROCESS_ID}` channel(s).
- A published per-connection frame goes to `pod:{owner}`; the route is decided by the first frame and sticky as above,
  including "no owner known" (old pod, expired record, failed lookup), which stays on today's channels for that
  connection. Each `pod:` channel rides the same subscriber connection as the channel it replaces (`terminalSub` for hops,
  `sub` for JSON), so a connection's frames never cross subscriber connections.
- The receiver delivers as in Phase 1 without parsing a JSON frame's text.

## Left to the builder

- Module layout (a small `terminalRoute.ts` beside `hub.ts` is one option), log and key names.
- Phase 2's exact channel names (two channels, one per subscriber connection, as decided).

## Tests

- **Phase 1:** a local viewer gets a binary hop, a JSON terminal frame and an `e2e_welcome` with no Redis publish, in the
  order sent, byte-identical to today; a remote viewer gets them through today's channels; a local connection that
  detaches mid-stream drops the rest; the `terminal relay` log counts local, published and receivers per kind.
- **Phase 2 (if built):** a remote viewer's frames go to `pod:{owner}` only and a third pod with another client of the
  machine receives nothing; an unknown owner stays on today's channels for the connection's life; 1,000 frames for one
  connection arrive once and in order, with the record appearing midway; re-attach on another pod routes the new
  `connId` to its pod.
- Existing hub, adapter, webWs and terminal E2E suites stay green.

## Measuring

After each release, from #2393's kinds and Phase 1's log: the **total** relay busy time per pod-minute across
`adapter-ws *`, `bus terminal *`, `bus main up` and (Phase 2) `bus pod *`; Redis publishes per minute; receivers per
published frame. **Done when** Phase 1 shows the local share delivered without Redis and total relay time falls, with no
rise in terminal stall reports (`TERMINAL_RENDER_STALLED`); Phase 2 then goes or not on the receiver count.

## Design (AGENTS.md rules)

- **Growth:** Phase 1 stores nothing. Phase 2: one Redis key per open viewer connection, expiring 60 s after its last
  heartbeat; one channel per process.
- **Concurrency:** no locks; a connection's frames keep one sticky path, in send order.
- **Read cost:** Phase 1 none. Phase 2: one Redis `GET` per connection, once, on the sending process.
- **Scale:** at 10× viewers or pods, a frame still costs one local send or one publish to one pod; the per-machine fan-out
  no longer grows with pods. Redis publish rate is the first thing to watch.
- **Compatibility:** old pods write no record, so frames for their viewers fall back to today's channels; new pods keep
  subscribing to those channels.
- **Migration + rollback:** nothing stored beyond expiring keys; roll back by deploying the previous release.
- **Audience:** unchanged; a frame reaches only the connection it names, as today.
- **Identity:** N/A because nothing here acts as or reads the machine owner's login.
- **Failure:** Redis unreachable → local viewers still get frames; remote ones fail as today. A missing record falls
  back to broadcast, never drops.
- **Platforms:** backend only.
