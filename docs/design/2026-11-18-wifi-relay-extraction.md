# Wi-Fi relay extraction

Status: coordinator approved the direct relay and following presence/replay slices on November 18,
including the new explicit overload limit below. Feed, normalized streams and focus remain design-only.
No runtime changes or workloads yet. Source is
`d7f502bf799e1b5734c55083fbcfe0beb100fd4e`. This updates the private November 17 proposal after
shared question observation, Windows service transport and immutable worker admission joined the
integration. It does not describe package 12 as complete.

## Decision to review

Move opened device requests, session/hello replay, readiness and recap presence directly between the
existing gateway and devices processes. The gateway remains the E2EE authority. The devices process
keeps `AutonomousDeviceRelay` and `AutonomousDeviceService` as the business-protocol authorities.
Core loses its device session/hello maps, 256-request queue, readiness flag/waiters and relay methods.
No second core broker, device table or queue replaces them.

The first implementation slice is the direct relay, including same-identity session replacement and
physical backpressure. Presence/replay is the next slice in the same task. Feed/focus need the concrete
follow-up contracts below before their runtime changes; deleting their old checks prematurely is unsafe.

## What changed since the earlier proposal

- `services/localConnection.ts` now reconnects normal Windows services through the authenticated pipe;
  Windows no longer automatically forces this composition inline. Real Windows validation remains a
  release gate, not an unsolved design prerequisite for this slice.
- `harnessd/workerContract.ts`, entry admission and immutable cohort preparation positively admit one
  executed core/worker set. Package 12's accepted November 18 amendment replaces its former private
  30-day compatibility rule. The new core need not preserve old gateway/devices state beside itself.
  Public device v1 and durable receipt compatibility remain unchanged. Coordinator confirms the
  executed contract before integration; a published contract change must bump its literal.
- `services/wifi.ts` now uses `agentClient/questions.ts` with the actual shared app/tool observation
  contract. A lone direct device still observes questions on nonfocused agents without becoming a
  window, dial or commander. The direct peer must preserve `beforeReady: ensureQuestions` and its
  generation/disconnect handling. No replacement question-interest API is needed here.

## Current caller audit

| Source | Current responsibility | Result of relay/presence slices |
| --- | --- | --- |
| `core/wifi.ts` | sessions, helloed, held frames, serving waiters, transcript counts, tool-stream interest, focus revision | Delete the first four groups. Feed/focus remain explicitly pending, not renamed as generic core policy. |
| `gateway/gateway.ts` | authoritative E2EE sessions, direct sinks/pins, application hello index, unwrap, final sealing | Own the moved queue and peer epoch beside the existing session state; check captured incarnation at sealing. |
| `gateway/start.ts` | direct discovery/pairing waits for core's Wi-Fi readiness | Start/stop direct networking from component peer readiness; use the existing on-demand wake door only. |
| `gateway/gatewayProcess.ts` | every device request and response traverses core | Build/stop the private endpoint with the gateway instance. No device payload reaches core. |
| `lib/autonomous-device/overGateway.ts`, `relay.ts` | opened request adapter, hello/rate/active-request policy, replay, audience checks | Capture the original session incarnation before every await; use direct peer send. |
| `services/wifi.ts`, `wifiProcess.ts` | component session view, shared question observer, receipt journal, ordered core feed | Get relay snapshot/deltas from gateway; retain original core input connection and generic facts. |
| `core/gatewayLink.ts`, `backendSocket.ts` | device forwarding plus ordinary remote client ownership | Delete device relay branches only; retain ordinary web/legacy commander connection authority. |
| `core/main.ts` | feature construction, gateway tee, recap-presence OR, focus comparison, transcript arming | Remove relay construction/tee/readiness state; move Wi-Fi recap presence out. Feed/focus are separately fenced below. |
| `services/recaps.ts`, `recapsProcess.ts` | actual recap/card generation, working view | Read Wi-Fi presence directly and replay on joins; no core Wi-Fi presence mirror. |

## Design

### Session identity and ordering

An E2EE `Session` gets one nonsecret random incarnation at authenticated creation. It is stored on the
existing session object, not in another authoritative session map. A new hello creates a new incarnation
even when connId and paired identity are reused. The gateway's existing `deviceClients` hello index
records that incarnation alongside identity; drop/replacement invalidates hello immediately.

`AutonomousDeviceRelay` currently captures identity only. Merely adding a gateway check against a
token read from the service's *current* session map would still send an old async reply to a replacement
session of the same identity. Extend the relay's existing crypto/session view with `sessionIncarnation`:
each hello client, request reply closure, replay, revoke and event send captures its original incarnation.
The component checks the captured client object/identity/incarnation after waits. The gateway rechecks
peer epoch + connId + identity + incarnation + device role synchronously beside `wrapTarget`. The
payload cannot select a different current incarnation. No session key leaves the gateway.

Gateway validates device role, wrapped payload and absent dbSessionId, then unwraps once. Invalid or
unopenable requests retain their existing no-effect behavior. Only the opened body and captured routing
facts cross the peer link; neither ciphertext nor a second full original frame is retained. Refactor the
relay's common opened-body handler so the direct peer cannot consume the E2EE replay window twice.

One ordered channel carries snapshot, session/drop/revoke deltas and requests. Snapshot is installed
synchronously before any resume await. Deltas apply immediately during question/view refresh; completion
checks the original peer epoch and never overwrites a newer drop. The device session view is bounded to
the gateway's 64 sessions and cleared on loss; it is a routing view, never final send authority.

`ready(epoch)` follows resume and any required question snapshot. The gateway sends a held request at
most once to that epoch. Once handed to the socket it is removed from held application work; ambiguous
disconnect never replays an effect. Business idempotency, unknown receipts and 64 live native-input
admission stay with the existing component journal. Reconnect creates no input reservation.

### Transport, discovery and lifecycle

Use one fixed-purpose component endpoint owned by the gateway, with only `devices` and read-only
`recaps` roles. Reuse `listenLocalSocket`, `pipeWebSocket`, pipe nonce/proof primitives and private-state
checks. Do not repurpose `devicesListener` or add a master/router service. The endpoint carries no
arbitrary destination, service name or request method.

On Unix, use a private random `harness-<epoch>` component socket path derived with `socketPathIn`; on
Windows use a fresh random Harness pipe. The random basename reuses the existing nonce's endpoint
binding. The gateway writes a strictly validated, at-most-4 KiB disposable endpoint record containing
version, endpoint and boot epoch, never a token. Authentication derives a domain-separated peer key
from the already inherited service token; no daemon/client token is newly exposed. On Unix, private
socket permissions plus the same request/proof handshake establish both sides. On Windows, verify
server proof before `open`/any payload. Every handshake nonce is bound to the endpoint epoch. On Unix,
the authenticated listener is put in a verified `0700` directory and changed to `0600` before its endpoint
record is published; the generic authenticated-listener branch does not do that chmod/unlink itself.
Only the exact created socket inode is removed at shutdown. A discovery path is accepted only if it is
the expected random basename under `socketPathIn`'s derived private directory; never dial an arbitrary
path supplied by a record. The endpoint record reader itself is bounded before parsing.

The service token is shared within this daemon's service trust domain: this is not cryptographic
isolation against another compromised service. Role labels limit normal handlers, not that shared trust.
No fallback to TCP, unauthenticated local sockets or a legacy core relay.

One active devices peer and one active recap peer are allowed. Replacing one invalidates the old epoch
before accepting new state. Handshake: 10 s; coalesced on-demand readiness: 15 s; physical write drain:
2 s. Reconnection is bounded backoff, reset by a new service/core connection or endpoint-file change;
no timer or listener remains when the component is stopped. Stop closes upgraded sockets explicitly,
waits for actual close within a deadline, then removes only its own matching endpoint record/socket.
The listener's generic HTTP close alone does not close upgraded WebSockets.

Gateway keeps its existing dependence on core connection lifetime: core loss stops that gateway
instance, destroys E2EE sessions, closes peers and invalidates all device views. Devices loss keeps live
gateway E2EE/hello state for bounded recovery; readiness and recap presence become false immediately.
Service disable prevents new wake requests and clears its moved transient queue. Ordinary core sessions
continue when any optional process is absent, stalled or killed.

Reuse the existing `wifi_serving` query only as a stateless `serviceLinks.call` wake/readiness bridge to
the existing on-demand devices host. There is no core `serves` flag, waiter set or replay queue. The
peer itself proves readiness; the response cannot manufacture it. This one named coupling stays in the
audit until a real existing shared service-wake caller can replace it; it is not a new generic broker.

### Concrete bounds and source census

The protocol schema does not establish a finite maximum for all legal messages. In particular,
`question.answer.answers`, hello requestId, agent-list fields and several Store response strings have
no schema byte limit. Do not claim every legal request fits 64 KiB.

| Existing source | Bound / consequence |
| --- | --- |
| E2EE manager | 64 sessions, including non-device sessions. |
| `core/wifi.ts` | 256 held entries, 30 s age; currently no byte accounting and silent oldest eviction. |
| device direct WebSocket | 65,536 received wire bytes. This does not bound relayed requests. |
| backend `WS_LIMITS` | device 256 KiB, web 1 MiB, manager 16 MiB, adapter 16 MiB. Gateway WebSocket default incoming ceiling is 100 MiB. |
| local authenticated service WebSocket | 6 MiB +4 KiB, from 6 MiB binary-paste ceiling. The old proposal's 16 MiB assumption was wrong. |
| `turn.send` | prompt16,384 UTF-8 bytes, plus request metadata/JSON escaping. |
| add-on publish |16 values ×4,096 serialized value bytes; topic≤96characters. Valid aggregate exceeds 64 KiB. |
| retained device events / receipts |500 events;512 receipt/result entries; retained result payload JSON≤32 KiB after 128 KiB text precheck. These are component state, not peer queue credit. |
| question observation |16 MiB frame/aggregate admission; a status reply adds a small wrapper. |
| streams |2 subscriptions per device; final text 16 KiB; tool input 1 KiB; event metadata still needs transport accounting. |

The following paths must not be conflated:

| Former actual path | Earlier limit before opened device request is handled |
| --- | --- |
| Direct device→gateway |64 KiB incoming encrypted wire frame. |
| Backend device socket→gateway |256 KiB incoming device wire frame; backend also supplies its routing envelope. |
| Backend web socket with an authenticated device-role session→gateway |1 MiB incoming web wire frame. |
| Manager relay→gateway |16 MiB incoming manager frame; its nested routing/encryption reduces available request body. |
| Gateway→core→devices, supervised |Gateway's original ciphertext plus opened body are duplicated inside a service frame; core's 6 MiB+4 KiB transport is a further cap. |
| Explicit inline/no-master |No core service-frame cap. The gateway's own 100 MiB incoming WebSocket ceiling remains the local bound; external backend ingress limits are not a substitute for this local guarantee. |
| Devices→gateway reply, supervised |The devices→core service frame has the 6 MiB+4 KiB cap. |
| Devices→gateway reply, inline |No private service-frame cap. Agent lists/Store fields and generated replies are not universally schema-bounded. Public network/client limits vary. |

The approved new 16 MiB + 4 KiB peer ceiling preserves the former supervised service range and the public
backend ingress ranges above. It deliberately tightens formerly unbounded inline behavior: an oversized
inline `agents.list`/Store reply or request can now be refused. This is a new explicit overload policy,
not the former legal universal maximum. It never truncates a reply, silently drops an effect, or retries
ambiguous work. Use existing public unavailable/backpressure errors where defined and a named local
content-free failure state; close/reconnect only where the protocol already does so. Tests must cover
the formerly unbounded inline oversized reply and keep any already-reserved receipt uncertain.

Routing metadata is bounded and separately tested so a 16 MiB content frame
plus its private wrapper fits 16 MiB + 4 KiB. Held requests have a different aggregate budget:256 entries,
30s and 16 MiB of complete serialized opened-entry bytes, including routing metadata. An entry larger
than 16 MiB is immediately refused while the service is unavailable even if it is within the ready-peer
message ceiling. That is deliberate overload behavior, not an assertion that the entry fits the queue.
Reject new work visibly when full; never silently discard the oldest. No second pending-send array.

Each peer direction charges actual serialized bytes and frame count until the write callback or physical
socket close, once. Budget:16 MiB + 4 KiB and 256 frames, allowing one maximum frame. Logical peer replacement
does not free an old socket's charge; close/settlement does. `bufferedAmount` is included, not substituted
for retained callback bytes. Saturation closes/refuses that component peer and exposes a named unavailable
state; it never queues an unbounded Promise list. Presence uses at most one coalesced unsent transition.
Incoming WebSocket byte length is checked before JSON parse/copy. The receiver reserves its own bounded
active-body bytes before parsing and keeps them until the actual handler settles, even after peer
replacement/close. This is in-flight admission, not another retry queue. Business relay admission (four
active requests per session,64 pending hellos) precedes the shared view-refresh await; otherwise a hung
refresh hides an unbounded Promise list before the rate limiter. Saturated admission refuses new work.

No source-only number here is a heap/RSS claim. Fixed native/quiet measurements must report transient
serialization copies, peak queues and whole-process memory, including devices and gateway.

### Presence, replay and questions

After direct relay is correct, recaps reads Wi-Fi presence directly from the gateway, ORing it with the
existing non-Wi-Fi lifecycle flags in its own process. Presence means application hello on a currently
ready peer and a current E2EE session. It does not imply active commander rendering.

A boolean alone loses behavior: every successful hello currently calls `onCommanderJoin`, which calls
`mirror.replayAll()` even when another device already exists. The proposed recap role therefore receives
an initial presence value and a coalesced `joined` transition, with no identity or prompt. A join is
accepted only from the current peer for the captured hello's current E2EE incarnation; a delayed old
hello cannot restore presence. Last-audience drop/revoke or peer loss changes presence to false and
invalidates any unsent joined transition. Recaps replays
from its own existing `working`/mirror state on join; no all-agent snapshot is requested from core.
Joining while recaps is down is covered by its next initial-present snapshot. Questions already have
their bounded shared snapshot and no longer need the old global `questionWatcher.reset()` call.

Cards still cross the pre-existing recap→core→device publication path until the follow-up shared event
contract is approved. This slice removes core relay/presence state but does not claim all device feed
traffic is gone. Removing that final tee requires a component-owned card subscription or convergence
with another actual existing session event consumer, not a new Wi-Fi-only core broker.

### Feed and focus decisions still requiring review

The public `agents_watch` API carries metadata only; question observation carries question content only.
Neither transports normalized tool events or raw transcript lines. Pretending they are replacements
would lose device input/result evidence or subscribed tool streams.

The narrow candidate for raw receipt evidence is a devices-owned transcript reader armed before the
existing input query, using `resolve`'s existing engine/session/transcriptPath and generic agent-life
invalidation. It reads only appended bytes of the captured file identity. It must buffer bounded data
until the corresponding input `dispatching` fact arrives, because the filesystem can beat the IPC fact.
No finite buffer may silently turn lost evidence into success: overflow, missing/replaced/truncated
file, unsupported late binding and connection loss leave receipt unknown, never retry Enter. However,
the pre-dispatch offset and late first-bind behavior need actual caller RED tests before approving this
reader. This is not runtime-approved by the direct relay decision.

Normalized stream/final semantics are separate: current `AgentStreams` keeps 16 KiB of the current answer
for every agent so a mid-turn subscription gets the whole final. Opening many fake window/tool
connections, full-history polling, or changing this to only post-subscribe text is not equivalent. A
bounded shared observation contract must converge actual app/window and device consumers, or reuse
the existing engine process feed without making core a device-only broker. No such new door is proposed
as already approved.

Focus must stop caching the device revision in core. Route the conditional selection through the
existing window/service request lifetime; after the devices process checks its revision, the core's
existing local window owner must recheck original connection, bound machine, and that no newer explicit
window focus arrived before applying it. `localWsServer` currently assumes a synchronous callback:
making it async alone is unsafe. Direct explicit selection still takes effect immediately. Pending
conditional selections are connection-bound and bounded; they must not become a device revision map.
The concrete request/result schema and real second consumer of any shared mutation guard remain a
separate approval before editing this part.

### Compatibility, data, identity and rollback

No new business-data schema, secret file, receipt field or event-id format. Disposable endpoint metadata
has a version and owner cleanup; growth is one record, up to 64 session metadata rows, and the bounded
transient queues above. Only changes cross the link after a reconnect snapshot. No archive or whole
historical read is introduced.

Concurrency is the E2EE session incarnation plus peer epoch. Input still uses the captured original
core connection and session binding through resolve, context, validation, paste, Enter and facts. The
new peer grants no terminal capability and cannot select executable, account or terminal coordinates.
Every audience decision remains in the business relay and again at gateway sealing.

Worker rollback selects and reaps one matching historical immutable cohort. No new-core/old-worker
relay fallback exists. Public device v1 and representative journal readers must still work, including
unresolved receipts staying unknown after process restart. No elapsed date alone retires a public
compatibility contract. macOS/Linux use private sockets; Windows uses the existing authenticated named
pipe semantics. Explicit inline/no-master composition uses the same component peer logic with an
in-process adapter through the existing lazy inline door; it recreates no core session map and remains
an explicitly nonisolated exception.

Named failures include peer-auth/version refusal, readiness deadline, snapshot invalidation, held queue
capacity/expiry and write-drain deadline. Logs/metrics carry only fixed codes and numeric counters,
never payloads, paths, identities, connIds, keys or endpoint tokens. Failure before handoff may refuse;
after uncertain handoff it never resends. Supervisor retains restart/backoff ownership.

## Planned files and validation

First slice production files: `lib/e2ee/manager.ts` (incarnation only), `gateway/gateway.ts`,
`gateway/start.ts`, `gateway/gatewayProcess.ts`; fixed-purpose `lib/autonomous-device/peerProtocol.ts`,
`peerEndpoint.ts`, `gateway/devicePeer.ts`, `services/wifiPeer.ts`; `lib/autonomous-device/relay.ts`,
`overGateway.ts`, `services/wifi.ts`, `wifiProcess.ts`; deletions from `core/wifi.ts`, `wifiLink.ts`,
`gatewayLink.ts`, `backendSocket.ts`, `core/api.ts`, and wiring in `core/main.ts`/`services/inline.ts`.
No new dependency, master feature or general service bus. Names may shrink when reuse makes a new
module unnecessary; any core import inventory addition requires an explicit review.

Presence slice additionally changes `services/recaps.ts`, `recapsProcess.ts` and removes core's Wi-Fi
presence OR/join-reset. It needs a bounded join transition in the same fixed endpoint; no content topic.

Pick before running: gateway receive→actual relay caller tests for identity reuse and same-identity new
incarnation during async hello/request/revoke; snapshot/drop/ready races; old peer callback after
replacement; single unwrap; saturated count/bytes/age; nonreading peer and physical-close accounting;
unknown receipt on ambiguous handoff; lone-device questions; reconnect cards/presence; core ordinary
input while gateway/devices absent/hung/killed. Add RED caller tests before runtime edits. Required
core/services per-file 100%, architecture/import inventory and types follow once source is frozen.

Coordinator schedules packaged native and quiet comparisons. Workload:1/16/160 agents,0/1/16/64 devices,
fixed request/payload/replay counts, same source-equivalent toolchain. Report core and entire process-tree
idle CPU/RSS, event-loop delay, input/request p50/p95, core vs peer IPC frames/bytes, queue peak and
retained state after teardown. Record actual PID reaping, physical socket closure and artifact hashes.
Linux and Windows runtime evidence, inline behavior, immutable-cohort upgrade/rollback admission and
final combined gates remain publication requirements. No test/build/performance result is claimed by
this source-only design.
