# Viewer surface over P2P (WebRTC → TURN → WS), like terminal

Status: design approved in chat, 2026-10-08. Builds on viewer surface v2
(`docs/superpowers/specs/2026-10-08-remote-browser-design.md`, Phase 1) and is that spec's Phase 3.

## Goal

Make the remote rendered viewer surface travel the same way terminal output does: a direct
WebRTC data channel when possible, Cloudflare TURN when direct fails, and the backend WebSocket
relay as the last resort. Two outcomes, both required:

1. **Lower interaction latency** — taps, typing and scrolling come back as fast as on a local
   browser, without a backend round trip per frame.
2. **Less backend relay load** — JPEG frames are most of the relay's viewer traffic; they should
   leave the backend whenever a peer path exists.

Out of scope: a separate kill switch or TURN policy for viewers (they follow terminal's), changes
to the WS long-poll path of Phase 1 (it stays as the fallback, unchanged), the browser agent itself
(Phase 2 of the remote-browser spec).

## Current state (what this builds on)

- **Terminal P2P** (`cli/src/lib/terminalP2p.ts`): one `RTCPeerConnection` per E2EE session
  (connection id), offered by the client side and answered by the machine's gateway
  (`TerminalP2pResponderPool`). Signalling (`p2p_offer`, `p2p_answer`, `p2p_ice_candidate`,
  `p2p_abort`, `p2p_promote`, `p2p_promote_ack`) rides the sealed relay. ICE: STUN list plus one
  Cloudflare TURN URL, policy `all` (direct first, TURN last), `maxMessageSize` 512 KiB.
  Rollout: `TERMINAL_P2P_ROLLOUT_PERCENT` (backend), delivered in the relay's `connected` frame.
  One ordered data channel, `terminal-v1`; the responder accepts only that label
  (`terminalP2p.ts` `onDataChannel`). Streams opt in per `streamId`
  (`TERMINAL_P2P_DOWN_TYPES` / `TERMINAL_P2P_UP_TYPES`; gateway routing in `gateway/gateway.ts`).
- **Offerers today:** the CLI's `remoteRelay` (a desktop's local daemon reaching another machine),
  the desktop web build (`desktop/lib/web/p2p/`), and mobile (`mobile/lib/p2p/`).
- **Viewer surface v2** (`cli/src/lib/interactiveViewer.ts`): `viewer_surface` request/reply over
  the WS relay — `op:'frame'` long-polls with `after`, `op:'input'` applies input immediately;
  frames are base64 JPEG inside sealed JSON. Lives in the `viewers` service process.
- **Push path today:** `CoreApi.clients.viewerFrame(connId, type, payload)` — JSON only, routed
  by `gateway.target`, whose queue is unbounded.

## Design

### Topology: one peer connection, two channels

```
Client (mobile / web)                     Machine: gateway process           viewers process
1 offer creates terminal-v1 AND viewer-v1   ──sealed sig──▶ responder accepts both labels
2 surface_open {surfaceId, agentId, size…}   ──viewer-v1───▶ route by surfaceId ──core──────▶ InteractiveViewers
3                                           ◀──viewer-v1─── binary viewerFrame (HTRM-sealed) ◀ shot + seq
4 surface_ack {surfaceId, seq} (window 2)    ──viewer-v1───▶ credit ──────────────────────────▶ next frame
5 surface_input {surfaceId, events, size}    ──viewer-v1───▶ ─────────────────────────────────▶ apply via chain
6 no viewer-v1 / channel lost → viewer_surface long-poll over WS (Phase 1, unchanged)
```

- The client creates `viewer-v1` (ordered) in the same initial offer as `terminal-v1`, so no
  renegotiation is needed. A separate channel keeps a 1 MB frame from delaying terminal keystrokes
  (head-of-line blocking on the ordered `terminal-v1`). Reusing the peer connection reuses ICE,
  STUN/TURN allocation, signalling and rollout — no second handshake, no second TURN allocation.
- The responder accepts `viewer-v1` in addition to `terminal-v1`; any other label is still refused.
- **Capability:** the machine's encrypted `e2e_welcome` carries `p2pViewer: 1`. Without it the client
  never sends on `viewer-v1` and uses WS. Old machine ↔ new client and new machine ↔ old client both
  keep working.
- **TURN:** viewer frames follow terminal exactly (direct, then TURN, then WS). Kill switch:
  `TERMINAL_P2P_ROLLOUT_PERCENT`.

### Binary frame: kind `viewerFrame`

A new kind in `cli/src/lib/terminalBinary.ts`, sealed in the same HTRM v3 envelope as terminal
binary frames (`e2ee.wrapTerminalBinary` path):

```
streamId (16 bytes) = surfaceId (32 hex chars)
u64 seq | u16 part | u16 parts | u16 width | u16 height | u16 scale×100 | JPEG bytes (raw)
```

- Raw JPEG, no base64: about a third less traffic.
- Each part ≤ 480 KiB, under the channel's 512 KiB `maxMessageSize` including the seal.
- The client draws a frame only when all `parts` of one `seq` have arrived; a part of a newer `seq`
  discards an unfinished older frame.
- Surfaces carried over P2P must use a 32-hex `surfaceId` (the clients already generate 16 random
  bytes as hex); a request with any other id stays on WS.

### Control frames on `viewer-v1` (sealed JSON)

Payload shapes reuse `viewer_surface` v2, so validation (`surfaceFrame`) and limits are shared.

| Direction | Frame | Fields |
|---|---|---|
| ↑ | `surface_open` | `surfaceId, agentId, open, width, height, scale, mobile, touch, dark, after?` (`open`: the client's id for this open, 1–64 letters, digits or dashes, the same rule the core uses for ids it echoes) |
| ↑ | `surface_input` | `surfaceId, input, open, events[], width, height, scale, mobile, touch, dark` (a resize is an input with no events) |
| ↑ | `surface_ack` | `surfaceId, seq, open` — returns credit up to `seq` |
| ↑ | `surface_close` | `surfaceId` |
| ↓ | `surface_state` | `surfaceId, open?, seq, input?, editable?, clipboard?, hostActions?` (host actions always name the push's `open`; an input's answer echoes `open` only when the input carried one) |
| ↓ | `surface_error` | `surfaceId, open?, input?, unapplied?, error, detail` (codes: `INVALID_VIEWER_REQUEST`, `VIEWER_UNAVAILABLE`, `VIEWER_LIMIT`, `VIEWER_BUSY`, `VIEWER_CLOSED`, `VIEWERS_UNAVAILABLE`; `unapplied: true` only on an input refused before it reached Chrome) |

The surface stays owner-only (same `asker.owner` gate as `viewer_surface`) and is never a general
CDP bridge (same event whitelist).

### Push with backpressure (machine side)

- `InteractiveViewers` gains a push mode per surface: while the surface has credit (at most 2 frames
  un-acked), it takes the next frame (`next(after)`) and hands it to the gateway. The gateway sends a
  connection's frames one after another, for all its surfaces, and starts each only once the
  connection's `viewer-v1` channel holds under 1 MiB; then all of that frame's parts go. So the
  channel's buffer holds at most about 1 MiB plus one frame (a frame is at most 16 parts of
  480 KiB, 7.5 MiB). That bound is per connection, and the buffer sits on the SCTP association the
  channel shares with `terminal-v1`. Screencast ack-on-take is unchanged, so Chrome paints the next
  frame only when the last one was taken; a slow client slows production instead of queueing.
- The frame travels viewers process → core → gateway over a new bounded binary push (the existing
  `clients.viewerFrame` is JSON-only with an unbounded queue). The credit bounds it: at most two
  frames per surface are ever on their way.
- `surface_input` and resizes go through the surface's existing CDP chain; `surface_state` answers
  them (editable, clipboard) and carries host actions under the existing 500 ms throttle.

### Switching between P2P and WS

The machine-side surface is the same object across transports (same `connId/surfaceId` key, same
Chrome); only delivery changes between push and long-poll.

- **Open:** if the peer advertises `p2pViewer` and `viewer-v1` opens within the terminal's
  `openWaitMs` (backend `OPEN_WAIT_MS`, 2500 ms), open over P2P; otherwise long-poll over WS.
- **P2P lost mid-stream:** the client long-polls over WS at once with `after = last seq`; the
  daemon's clamp of `after` keeps a recreated surface from freezing.
- **P2P comes up later** (`p2p_promote`): the client waits for its WS poll to finish before it sends
  `surface_open` on the channel with `after = seq`; the daemon then switches to push.
- Closing the channel leaves the surface for the WS fallback; it expires after 30 s of silence.
  Closing the connection releases it exactly as `closeConnection` does today.

### Measurement

Needed to show both goals were met:

- **Client:** histogram of input-to-frame latency — record the `seq` when an input is sent; latency
  ends at the first frame with a higher `seq`. Tagged with the path in use: `direct`, `turn` (from
  the selected candidate pair in `getStats`) or `ws`.
- **Machine:** bytes of viewer frames per path and `renderMs` per frame, so relay load saved can be
  computed.

## Components to change

- `cli/src/lib/terminalP2p.ts` — offer creates `viewer-v1`; responder accepts it.
- `cli/src/lib/terminalBinary.ts` — `viewerFrame` kind, parts, codec.
- `cli/src/gateway/gateway.ts` — route `viewer-v1` frames by `surfaceId`; allowlists; bounded binary push.
- `cli/src/core/api.ts` and the viewers link — binary push port from the viewers process.
- `cli/src/lib/interactiveViewer.ts`, `cli/src/services/viewers.ts` — push mode with credit.
- `cli/src/lib/e2ee/manager.ts` — `p2pViewer: 1` in the welcome (the desktop `remoteRelay` offerer is deferred; see Decisions).
- `desktop/lib/web/p2p/*`, `mobile/lib/p2p/*` — second channel, codec, plugin routing (kept identical between the two apps).
- `desktop/lib/viewer/interactive_viewer.dart`, `mobile/lib/surface/interactive_viewer_session.dart` — a transport seam: P2P push when available, WS long-poll otherwise (both copies identical).

## Testing

- **CLI unit:** `viewerFrame` codec (split, reassemble, drop an unfinished frame on a newer `seq`);
  push credit and `bufferedAmount` backpressure; responder accepts `viewer-v1` and still refuses
  unknown labels; capability flag; gateway routing by `surfaceId`; owner-only on the channel.
- **Dart:** codec and plugin tests on mobile and web (identical copies); session switches
  P2P ↔ WS without losing `seq`.
- **E2E:** a `werift` offerer against a responder with a fake surface: frames
  arrive over P2P; cutting the channel mid-stream falls back to WS. "Promote returns to P2P" is
  covered by the Dart unit tests (`p2p_viewer_transport_test.dart`), not end to end.
- **Manual:** phone on the same LAN (direct path) and on cellular (TURN path), with the latency
  histogram and per-path byte counts recorded.

## Risks

1. **Data channel throughput on mobile** — large binary messages over SCTP can stall on weak links;
   mitigated by the 2-frame window and `bufferedAmount` gate, measured on cellular.
2. **TURN cost** grows with viewer use behind hard NATs (accepted: same policy as terminal);
   the rollout percentage is the brake.
3. **Three offerer implementations** (werift, `flutter_webrtc`, browser `RTCPeerConnection`) must
   agree on channel creation order and labels; covered by the E2E and both Dart suites.

## Decisions made during implementation

- **Control frame names are `surface_*`** (`surface_open`, `surface_input`, `surface_ack`,
  `surface_close`, `surface_state`, `surface_error`), not `viewer_*`: the backend proxy already
  uses `viewer_*` names, and a distinct prefix keeps the two apart. The body above uses the final names.
- **`surface_state` and `surface_error` travel over the sealed relay target**, not the binary
  `viewer-v1` channel; only frames (`viewerFrame`) and the client's control frames use the channel.
- **The desktop native offerer (`remoteRelay`) is deferred** to the browser-agent phase. Mobile
  and web are the offerers in this phase.
- **Offerers create `viewer-v1` only when the machine's welcome says `p2pViewer: 1`.** A
  machine without the feature refused the unknown label, which crashed the werift initiator.
- **The viewer channel accepts data from the primary connection or from the TURN→direct shadow
  entry**, so a promote does not drop input in flight.
- **Client-owned keepalive:** the client sends `surface_ack` every 10 s; the machine expires a
  pushed surface that stays silent for 30 s.
- **Credit recovery:** `surface_open` resets credit to 2; if no ack arrives within 5 s the
  outstanding frames count as lost and credit is restored; acks are cumulative.
- **A WS long-poll (`frame` request) stops the push** for that surface: the client has moved to WS.
- **In-flight inputs settle `ok` when the channel is lost**, so the client does not retry them
  over WS and apply them twice. When the machine ends the push instead, they are left to the
  machine's own answer to each, which says whether it was applied (below).
- **Each open names an id the machine echoes** (`open` on `surface_open`, echoed on every
  `surface_state` and `surface_error` about that push, and on answers to the acks and inputs that
  carry it). The client ignores what names another open, so a late error about a push a reopen
  replaced cannot end the new one. This replaced a 2 s timing heuristic before the protocol shipped.
- **A push the machine ends is reported.** An ack or input for a surface with no push (the sink
  refused a frame, the viewers process restarted, the surface expired) is answered
  `surface_error VIEWER_CLOSED`, as is the sink's refusal itself; the core answers every
  `surface_*` frame except `surface_close` with `VIEWERS_UNAVAILABLE` while the viewers are off (a
  close needs no answer). For any error but `VIEWER_LIMIT` and `INVALID_VIEWER_REQUEST` (shown to
  the person) the client falls back to its WS poll from the last frame shown and reopens the push
  at the next frame request. An input refused before it reached Chrome (the machine had no push for
  it, or the viewers are off) is answered with `unapplied: true`, and only such an input goes again
  over WS. An input answered `VIEWER_CLOSED` without it may already have been applied (the surface
  went while it ran), so the client settles it `ok` instead of applying it twice. Input rides the
  channel only while a push runs. Before this, the client's keepalive went unanswered and the view
  froze on its last frame.
- **Viewer sends are not held to the terminal's 2 MiB `bufferedAmount` ceiling.** The gateway waits
  for the channel to drain under 1 MiB before each frame and sends a connection's frames one at a
  time, which bounds the buffer to about 1 MiB plus one frame (at most 7.5 MiB) per connection; the
  ceiling only cut a dense frame (> ~1.4 MB, parts 3+) short after it began.
  A part that does not go drops the rest of its frame.
- **Bytes per path:** the gateway counts sealed bytes handed to `sendViewer` as `viewerP2pBytes`
  (only on success), and `InteractiveViewers` counts base64 frame bytes served to WS long-poll
  clients as `viewerWsBytes`. Neither process has a status frame to carry them, so both are
  exposed as getters/fields and printed in the `[viewer-p2p] <conn> closed` and
  `[viewer-ws] closed` log lines. The counters are per process lifetime. Base64 inflates the WS
  figure by about a third relative to the raw JPEG; compare accordingly.
- **Per-frame `renderMs` was not implemented** (deferred). The client's input-to-frame latency
  log covers the user-visible number. Byte counts are logged once per connection when it closes
  (`[viewer-p2p] <conn> closed bytes=<conn> total=<process>`, `[viewer-ws] ...` likewise).
