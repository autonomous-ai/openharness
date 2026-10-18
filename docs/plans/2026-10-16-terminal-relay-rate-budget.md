# Terminal relay rate budget: size it per socket, not per stream

Requested 2026-10-16. Phase 1 of the "remote terminal keeps showing Reconnect while the network is
fine" investigation. Scope: `backend/src/lib/terminalRelay.ts` only. No client or CLI change, no app
release. Phases 2 (recovery after a host's backend link drops) and 3 (terminal failure reasons in the
desktop's file log) get their own specs.

## Problem

`TerminalRateGuard` counts terminal frames in a one-minute window, keyed by frame type. One guard is
created per socket — per web client connection (`webWs.ts:131`, and the legacy key path at `:589`)
and per adapter connection (`adapterWs.ts:219`) — so every stream that socket carries shares each
bucket. The limits in `limits()` were sized for **one** stream:

| Bucket | Limit today | One busy stream emits | Streams before it trips |
|---|---|---|---|
| `terminal_ack` (down, web socket) | 10,000 frames, 8 MiB | 3,750/min (one ack per 16 ms render window, plus one per 64 KiB) | ~2.7 |
| `terminal_output` (up, adapter socket) | 20,000 frames, 128 MiB | up to 7,500/min (`OUTPUT_FLUSH_MS = 8`) | ~2.7 |

The comment on the ack limit ("sized ~2.7x the client's own ceiling") reads that ceiling as the
socket's, but it is a single stream's.

What a user sees when the limit trips:

- **Down (ack).** Three panes of one remote machine with steady output (Codex or Claude streaming, a
  build log) on the ws relay exceed 10,000 acks in a minute. The backend answers
  `terminal_transport_error {code: TERMINAL_FRAME_REJECTED}`. The daemon's relay passes the
  unwrapped frame to the app (`remoteRelay.ts`, `unwrapIncoming` returns non-E2EE frames as they
  are). `TerminalSession` handles it with no stream filter (`terminal_session.dart:740`, same in
  mobile), so **every** pane of that machine calls `transportLost` and shows Reconnect.
- **Up (output).** Over budget, the adapter path drops the binary frame silently
  (`adapterWs.ts`, the `isBinary` branch). The client sees a sequence gap and resyncs. The pane
  flaps through "Restoring", and resync keyframes compete for the same socket.

Only streams on the ws relay are affected. Streams on a p2p data channel (direct or TURN) never
reach these guards. That explains why it shows up on some machines (a NAT'd or docker host, or after a
p2p demotion) and not others.

## Constraints that rule out the obvious fixes

1. **The backend cannot count per stream.** Terminal JSON frames carry only `{__e2e: {v, k, n, ct}}`
   (`isEncryptedTerminalFrame`), and binary frames carry the stream id inside the ciphertext. For the
   same reason, a rejection cannot name a stream, so clients cannot scope the failure.
2. **Over-budget acks cannot be dropped silently.** Acks are cumulative (`lastSeq`), but the host
   pauses output at 384 KiB unacknowledged (`PAUSE_HIGH_WATERMARK_BYTES`). If the last ack of a
   burst is dropped, the host closes the stream with `TERMINAL_RENDER_STALLED` after
   `RENDER_STALL_TIMEOUT_MS`. That is the same Reconnect, only later.
3. **The fix must work for clients already shipped.** Desktop, mobile and web all ack every 16 ms;
   only a backend change reaches all of them at once.

## Change

In `backend/src/lib/terminalRelay.ts`:

- Add `RELAY_BUSY_STREAMS = 16`: the number of streams with sustained output one socket must carry
  without tripping. Sixteen covers four full four-pane tabs of one machine. A desk is rarely that
  wide, and it leaves headroom for retained background tabs.
- Derive the two limits from it, with the per-stream figures named next to it:
  - `terminal_ack`: 16 × 3,750 = **60,000 frames/min**. Bytes: 8 MiB → **16 MiB**. A worst-case
    E2EE ack frame is 216 B as `terminalFrameBytes` counts it (JSON of the frame, `ct` the base64 of
    a 70 B payload plus the 16 B tag, with `lastSeq` and `n` at `Number.MAX_SAFE_INTEGER`), so 60,000
    of them is ~13 MB. The test below pins that size.
  - `terminal_output`: 16 × 7,500 = **120,000 frames/min**. Bytes stay at **128 MiB**: volume, not
    frame count, is what the byte cap bounds, and today's figure is not what trips.
- Rewrite the comments on both: the guard is per socket, the backend cannot see streams (E2EE), and
  the numbers are per-stream rates times `RELAY_BUSY_STREAMS`.

Unchanged:

- Every other bucket. `terminal_sync` and `terminal_alive` run at 12/min per stream (5 s intervals),
  so their limits fit about 100 streams. Clients debounce `terminal_resize` and `terminal_scroll`
  (trailing timers), and the open/input/default buckets are human-paced.
- Rejection semantics. Down: still `TERMINAL_FRAME_REJECTED`, which is fatal for the socket's
  panes. Up: still a silent drop. Phases 2 and 3 revisit how failures are reported. This phase only
  stops the legitimate traffic from being rejected.

## Tests

In `backend/src/lib/terminalRelay.test.ts`, next to "lets a busy renderer ack for a whole window":

- `RELAY_BUSY_STREAMS` streams acking every 16 ms for a full minute (60,000 acks at the measured
  frame size) all pass; the next one is refused.
- The same for `terminal_output` at the 8 ms flush cadence (120,000 frames); the next one is refused.
- The ack frame size used above is not a guess. The test builds a real `terminal_ack` frame wrapped
  the way the client wraps it (an `__e2e` envelope with a base64 `ct` of a `{streamId, lastSeq}` payload
  plus tag) and asserts `terminalFrameBytes` × 60,000 fits the byte cap. A later change that fattens
  the frame then fails here, not in production.
- The existing single-stream test stays as it is.

Validation: the backend's affected unit tests (`terminalRelay.test.ts`, plus the `webWs`/`adapterWs`
suites that construct the guard). PR CI runs the backend component checks. No CLI coverage gates or
client suites are involved.

## Rollout

Backend only. A deploy restarts adapter and web sockets (close 1012). That is the Phase 2 problem,
and until Phase 2 lands it drops remote terminals once more during this rollout. After the deploy,
every client already shipped stops tripping the guard with up to 16 busy streams per socket.

Check after deploy: on a remote machine reached over the ws relay (p2p off or failed), run steady
output in four panes for two minutes. No pane should show Reconnect or flap through Restoring.

## Trade-off

A compromised or buggy daemon or client can push about 6× more ack and output frames per minute to
Redis before the guard stops it. The output byte cap is unchanged, and the ack byte cap doubles to
16 MiB/min. That is the price of not breaking legitimate multi-pane use. Cutting ack frequency on the
clients (one ack per 64 KiB or ~250 ms) would recover most of it, and is deferred until Redis load
says it matters.

## Out of scope

- Client ack cadence (option B of the investigation).
- Phase 2: a host's `linkDown` closes p2p-carried streams silently (`backendSocket.ts:378`). Resync
  for a stream that no longer exists is ignored instead of answered with `TERMINAL_STREAM_NOT_FOUND`.
  The desktop makes one reopen attempt and then waits for a `node_status` change that may never
  come.
- Phase 3: `TerminalSession` failure reasons go to `debugPrint` only, not to
  `~/.harness/logs/app-*.log`.

## Update, same day: 64 busy streams

16 was still reachable by one person driving many harnesses on one remote machine, so
`RELAY_BUSY_STREAMS` became 64 as a stopgap, with byte caps that scale with it so neither cap binds
first: acks 240,000 frames / 64 MiB per minute (1 MiB per stream), output 480,000 frames / 512 MiB
per minute (8 MiB per stream, ~1 KiB per frame). Each frame costs the backend a parse and a Redis
publish, so the durable fix is fewer frames at the source (client ack cadence, coarser relay
flushes in the daemon), not further raises. Watch pod CPU after this deploy.
