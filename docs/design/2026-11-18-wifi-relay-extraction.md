# Wi-Fi relay extraction

Status: coordinator approved the direct relay and following presence/replay slices on November 18,
including the new explicit overload limit below. Feed, normalized streams and focus remain design-only.
The transport/presence implementation and focused validation are now complete in the isolated worktree;
combined integration, native acceptance and cost validation remain pending. Base source is
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
existing session object, not in another authoritative session map. A new authenticated E2EE handshake
creates a new incarnation even when connId and paired identity are reused. An application `hello` on
the same E2EE session does not. The gateway's existing `deviceClients` hello index
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
before accepting new state. The record's boot epoch binds endpoint ownership; each accepted role gets
a separate fresh peer epoch in its first snapshot/presence, echoed by replies. Both the originating
channel object and this epoch must still be current. Handshake: 10 s; coalesced on-demand readiness: 15 s; physical write drain:
2 s. Reconnection is bounded backoff, reset by a new service/core connection or endpoint-file change;
no timer or listener remains when the component is stopped. Stop closes upgraded sockets explicitly,
waits for actual close within a deadline, then removes only its own matching endpoint record/socket.
The listener's generic HTTP close alone does not close upgraded WebSockets.

Gateway keeps its existing dependence on core connection lifetime: core loss stops that gateway
instance, destroys E2EE sessions, closes peers and invalidates all device views. Devices loss keeps live
gateway E2EE/hello state for bounded recovery; readiness and recap presence become false immediately.
Established direct sockets also survive this transient loss, matching the previous crash behavior.
Readiness gates accepting/forwarding work; it does not destroy encrypted sessions. First readiness
starts direct networking; an explicit unavailable/disabled wake result or gateway/core stop closes it.
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

Peer JSON traversal is iterative with at most 4,096 simultaneously nested containers. This is a private
overload policy separate from question observation's depth eight: valid add-on values may contain
about 2,045 nested arrays within their existing 4,096-byte value limit. Current Store responses are
fixed-shape arrays/records of scalars; answers are string maps and observed questions already have the
shared shallow contract. Arrays and plain records are accepted; cycles, proxies, accessors, callable
`toJSON`, unsupported scalars and nonfinite numbers are refused before full serialization. Every examined
entry also consumes a visit budget equal to the byte budget, including omitted `undefined` fields, so
a formerly huge local undefined-only object can now be refused despite serializing to a tiny object.
This does not tighten JSON-transport breadth: JSON cannot contain undefined and its entries consume bytes.
Only the exact string-byte primitive is shared with questions; neither tree policy imports the other.

#### Applied-state barrier and replay drainage

The current `reportStreams`/focus revision notice and following device answer share one ordered core
IPC lane. Direct replies cannot outrun those notices while feed/focus still live in core. After a
changed notice, issue a fresh existing `core.wifi.view` query on that original connection and gate
the component writer until it answers. This adds one existing-API round trip for a changed interest
or revision, with per-peer/current fencing; it adds no core API, waiter set or device record. One
unsettled query is coalesced, with a dirty marker for notices arriving after its request. It is deleted
with the separately approved feed/focus extraction. The core's final window-revision check remains.

`AutonomousDeviceService.replay` (`service.ts`) currently emits synchronously: either at most 500
retained events, or a resync followed by at most 512 retained results with fresh global event IDs.
The former "500 events plus 512 results" census conflated these branches. A 256-frame physical budget
cannot accept that whole synchronous producer. Increasing the frame cap is not the solution.

Use one component-owned outbound FIFO for ordinary frame jobs and lazy replay jobs. A replay source
leases the exact immutable retained frames/payloads by reference; it does not make a full payload
copy. Admission is synchronous and atomic before hello success or any fresh resync-ID/event-ring
mutation. A refusal leaves no partial replay or allocated IDs. Every reference, including the same
object referenced by multiple jobs, is counted and charged. Bounds: 64 active replay jobs; at most
500 event references or 513 resync/result references per job; 32,832 references globally; the same
16 MiB + 4 KiB outbound byte budget used by ordinary queued frames and physical writes. The physical
frame cap remains 256. The FIFO separately bounds unsent ordinary jobs at 256; they reserve bytes,
not physical slots, so frames behind a replay cannot occupy the slots its head needs. Together there
are at most 320 unsent jobs, plus at most 256 physical writes. Each replay also owns at most three
small greeting/join envelopes (192 across 64 jobs), charged to the same byte cap. At admission one
candidate array holds at most 513 references before reservation; no payload is cloned into it.
A result payload's existing bound is
32 KiB; no large source clone precedes admission. The sole internal replay consumer borrows a readonly
view of the private retained frames; it only counts and encodes them. Public event callbacks still
receive clones. No new freeze or tree walk is added to every live event for a type guarantee.

The writer takes replay frames lazily from its admitted lease. A frame's byte credit transfers from
that lease to the physical write without a release/re-reserve gap; only its callback or physical close
returns physical credit. Live and nonretained frames queue behind the replay job using that same FIFO
and byte/frame admission, so they neither overtake the replay nor create a hidden queue. Original peer
and E2EE proofs are rechecked at every physical send. Actual discard returns unsent credit; logical
peer replacement never returns physical credit. Socket callbacks drive drainage. One fixed two-second
deadline bounds the FIFO's unsent period (including waiting on an older socket's physical credit),
and each physical channel retains its existing write deadline. There is no Promise chain or timer per
frame. Expiry discards only the expired epoch before reporting failure, and closes only its captured
channel; a reentrant replacement callback cannot lose new work. A peer that never drains fails visibly.

A tempting cursor-only source with a 12-frame prefix is insufficient: a second client's ordinary
512-result resync can evict the first job's unsent range before that client is slow. Deferring fresh
ID assignment until drainage also puts later replay IDs before already queued lower-ID live frames.
The atomically admitted immutable reference lease preserves both overlapping resyncs and public order.
Regressions cover two overlapping 512-result resyncs with a concurrent nonretained event, admission
failure without partial replay, blocked revoke/replacement, and callback/close settlement exactly once.

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

Unsent joins are markers on the existing bounded `deviceClients` hello entries, each fenced by the
devices peer epoch and that entry's identity/incarnation. There is no second map or transition queue.
If A joins, then B joins and leaves before a write, A's live marker still requests one coalesced replay.
Marks clear on successful handoff, drop/revoke or peer loss; a last-audience removal leaves none.

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
pipe semantics. Explicit inline/no-master composition uses the same authenticated local socket
transport through the existing lazy inline doors; it recreates no core session map and remains an
explicitly nonisolated exception. Both inline component constructions share one lazy module-local
random authority only when no master or external-service declaration exists. Supervised/mixed
compositions require the inherited service token, including when one endpoint is inline: a missing
token fails unavailable and never generates a substitute. The key is never written to discovery or logs.

Named failures include peer-auth/version refusal, readiness deadline, snapshot invalidation, held queue
capacity/expiry and write-drain deadline. Logs/metrics carry only fixed codes and numeric counters,
never payloads, paths, identities, connIds, keys or endpoint tokens. Failure before handoff may refuse;
after uncertain handoff it never resends. Supervisor retains restart/backoff ownership.

## Planned files and validation

First slice production files: `lib/e2ee/manager.ts` (incarnation only), `gateway/gateway.ts`,
`gateway/start.ts`, `gateway/gatewayProcess.ts`; fixed-purpose `lib/autonomous-device/peerProtocol.ts`,
`peerEndpoint.ts`, `peerConnection.ts`, `peerChannel.ts`, `peerWriter.ts`, `peerJson.ts`,
`peerPresence.ts`, `gateway/devicePeer.ts`; `lib/autonomous-device/relay.ts`,
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
final combined gates remain publication requirements. The focused evidence below does not substitute for these combined publication checks.


### Inline wake deadline and actual settlement

The inline host's existing `answering` map remains the sole owner of executing handlers.
A shared `call(type, payload, asker, waitMs)` uses that owner and replaces both composition-root
route-to-Promise adapters (Wi-Fi wake and Agent Messages' sharing request). It adds no map or queue.
Its deadline replies `SERVICE_UNAVAILABLE`, logs `SERVICE_DEADLINE`, and aborts the existing handler
signal. Reply authority expires at the deadline, but the map entry remains until the actual handler
settles. While a timed-out handler of that type remains unsettled, another shared call of that type
is refused. Ordinary concurrent calls admitted before a deadline retain their existing behavior.
No late reply can change the already-returned unavailable answer.

The gateway retains its single wake invocation after its readiness deadline expires, until that
invocation actually settles. Concurrent or repeated serving requests share its bounded answer;
readiness from a current peer can still succeed independently. Stop revokes the result, and a late
wake completion cannot enable or stop a replacement peer. This is component state only: the core
bridge remains stateless. The host deadline does not claim to cancel a hung JavaScript handler.


During initial snapshot restore, the current snapshot's hello routes count as pending observation
audience before business clients are restored. A concurrent session replacement, drop, or revoke
notifies the observer owner after the route mutation even if no business client existed yet. Removing
one of two routes preserves observation; removing the last closes it. Restoring the original snapshot
later still checks each route's current identity/incarnation and never revives a removed audience.


The applied-view owner has one assignment while a query runs: every other caller awaits that exact
promise, including across a core reconnect. Its own `finally` therefore clears the owner unconditionally;
logical reconnect never releases the actual query charge. Question observation starts only from the
current-peer hello/snapshot admission or the single reconnect timer that stop/disconnect cancels.
The redundant initial stopped/core-connected check inside that already-fenced callback is removed.
Current-peer admission, captured view generation, pending observation epoch and the final resume check
after `await refresh()` remain authoritative; the last prevents a newer same-turn resume being replaced.


## Transport slice evidence (2026-11-18)

Behavioral RED receipts remain in the coordinator's local audit packet: incarnation replacement,
pre-refresh four-request admission, final seal, raw byte bounds, publication failure with upgraded
peers, replay atomic admission, reentrant drain failure, pending presence handoff, bounded inline wake
and restored question-audience teardown. The latest focused RED is
`/tmp/core-wifi-wake-observer-red.log`; every reported behavior has a passing regression now.

- The selected core/service caller suite passes 267 tests with 100% per-file coverage for `wifi`,
  `wifiLink`, `gatewayLink`, `recapsLink`, service `wifi`, `wifiProcess`, `recaps`, `recapsProcess`,
  and `inlineHost` (`/tmp/core-wifi-cutover-coverage-third.log`).
- The selected peer/E2EE suite passes 341 tests in 28 files, including real private Unix socket
  authentication/publication cleanup and host-mocked Windows transport bounds
  (`/tmp/core-wifi-peer-suite-final.log`).
- The real local question observation socket test passes against the new peer fixture, including
  no-window nonfocused questions, restored pending state and last-client teardown
  (`/tmp/core-wifi-question-transport-first.log`).
- TypeScript passes (`/tmp/core-wifi-cutover-types-final.log`), and architecture passes in the 75-test
  API/architecture run. API-wide coverage is 100% with its existing consumer tests: 91 passing tests
  (`/tmp/core-wifi-api-coverage-complete.log`). No unrelated fallback behavior or tests were changed.

These are macOS focused results, with Windows transport behavior mocked where stated. They do not
claim native Windows/Linux, process-tree cost, or final combined/native Wi-Fi acceptance. Feed,
normalized streams and focus remain pending as described above; this is a reviewable transport slice,
not completion of the whole core extraction.

## Remaining feed/focus caller audit (proposal, not runtime approval)

The matching inline request bound is separately approved. `SERVICE_REQUESTS_MAX = 100` lives in the
existing light `core/serviceHost.ts`; `serviceLinks` keeps its existing re-export. All request types
claimed by one inline service share a scalar count in their existing owner record. Route and call
admit against that count in constant time, before allocating an AbortController or invoking a handler.
Deadline and connection abort retain the count; only actual handler settlement releases it. A second
service has independent credit. Expired same-type admission uses another scalar on that same owner,
replacing the former scan of all executing handlers. No request queue or second handler registry is
added. Refusal is the existing `SERVICE_UNAVAILABLE` reply with fixed `SERVICE_REQUESTS_FULL` log code.
Four behavioral RED cases in `/tmp/core-wifi-inline-cap-red.log` demonstrate actual 101st admission,
cross-type bypass, and timeout/abort failing to preserve a service-wide charge before this correction.

The transport slice is committed separately at `bc326e39dd`. The following is the next source-only
review packet. It does not authorize a second core registry or claim that forwarding an app frame is
already equivalent to the removed feed.

### Actual sources and consumers

| Contract | Existing source | Actual component use | Required replacement property |
| --- | --- | --- | --- |
| Input dispatch | `SessionInputController.progress` → `deliveries.input` → the delivery maker | `service.inputProgress` records adapted input hash, actual dispatch time and bound session | Keep this shared authority and maker fencing. Arm component evidence before calling shared input. |
| Raw evidence | `transcripts/ingest.observeLine` and `transcripts/attach` side-read | `DeviceResultEvidence` proves Claude parent ancestry or Codex explicit turn membership | Component reads only a captured authoritative file/binding; incomplete proof stays unknown. |
| Normalized events | `turns/funnel` → ordinary `BackendSocket.send` app frames; separate Wi-Fi batch calls | Turn lifecycle and `AgentStreams` answer/tool/final state | Preserve original batch adjacency, live versus replay, and whole-turn final text. |
| Cards/full answer | `core/main` commander callback → `wifiCore.card` with `mirror.lastFullText` | Non-native `turn.summary`, tool and error events | Use ordinary card events plus the existing bounded conversation read or the component's full-answer state; do not recreate a core Wi-Fi cache. |
| Focus | Physical local window → `onAppFocusState`; device `focus.ensure` asks that window | Component revision and final synchronous window authority | Remove cached component revision, preserve newer explicit window choice and unavailable/replaced-service refusal. |

`agents_watch` is metadata-only and permits eight named agents per tool. The explicit questions
observer is question-content-only. Neither is a normalized event stream. The app path already carries
the normalized event payload, agent ID, engine session ID, replay bit and activity; tools are excluded
before it reaches their sockets. The component must remain a tool, never a window or desk-presence
claim. Existing input/progress and delivery events continue on their current maker-owned service link.

The original normalized batch has one observable distinction that individual app frames lack:
`services/wifi.ts` does not close a busy-input receipt on an end immediately followed by a start in
the same batch. `AgentStreams` also accumulates the first 16 KiB of the answer for every open turn,
including before a device subscribes. A replacement cannot simply send only current subscriptions,
interpret every end as an independent close, or replay historical deltas as live text.

### Proposed shared observation shape

The candidate uses the ordinary authenticated local app transport and the existing `LocalClient`
record. It adds an explicitly negotiated normalized-event scope on that record, not a broker or
service registry. Candidate wire names, subject to review:

```text
machine_select.payload.eventsProtocol = 1
connected.payload.eventsProtocol = 1
events_observe { requestId, scope: "all" | { agentIds: string[] } }
events_observe_result { requestId, ok: true, generation }
session_event.payload = { generation, frame: <existing app frame>, batch?: { id, index, count, replay?: true } }
```

Request and result fields likewise use the existing `payload` object. A negotiated Desktop window
defaults to its existing all-agent event scope; an explicit tool has no event scope before its request.
An empty named scope removes interest; it does not claim foreground presence. Scope is installed
before the successful reply and the connection's ordered socket carries every subsequent event.
No event history or per-turn answer is retained in core. The existing tool/question admission is
shared: at most 64 tool connections, one admission per physical connection even if it asks for both.
Scope replacement and disconnect revoke old delivery authority without freeing writes that have not
physically settled. Devices own their existing stream subscriptions and per-turn answer state.

For real convergence, the proposed change also migrates the Desktop's local `ws_conn.dart` event
decoder to this negotiated envelope and passes its single inner frame through the existing event
dispatcher. Legacy app connections retain their existing individual frames. Merely naming a device-only feed
`events_observe` is not the proposal. A Desktop protocol change needs its applicable instructions,
decoder coverage and a person-level session-stream test before integration.

The selected candidate preserves the funnel's exact existing per-event send point. It passes only
batch provenance (one process-local serial, index and original event count) alongside that send.
Negotiated connections receive one envelope per existing event, not an array emitted before or after
the funnel. Thus intervening heartbeat/input/recap frames keep their order. The devices consumer owns
bounded assembly of original batches; the core owns no batch queue. Existing ordinary `agent_synced`
and `agent_deleted` frames are eligible under the same session scope, without batch provenance.
The exact physical send and component assembly census still requires source review. Existing engine pages allow
1 MiB pages and fragmented 64 MiB results (`engines/worker/liveProtocol.ts`), so 16 MiB cannot be called
a historical universal event maximum. Any new overload refusal must be named and tested, including
escaped content, large tool inputs and a slow app as well as a slow device observer.

Selected negotiated transport limits are 16 MiB + 4 KiB encoded bytes per envelope, 32 MiB actual
pending send bytes across physical connections, 256 pending event frames per connection and 4,096
across connections. They extend the existing physical callback/close owner with a fixed event quota;
there is no second send queue. The pure iterative peer byte walker moves unchanged to
`lib/boundedJsonBytes.ts` for this second consumer, retaining its 4,096-depth, visit, cycle, plain-data,
UTF-8 and escape policies. Question frames keep their existing separate depth-eight policy and quota.
The exact escaped question maximum (16,777,216 serialized bytes, six bytes per NUL) fits inside the
new envelope with its metadata, as an actual socket fixture verifies. Production questions still use
the question observation protocol; normalized event observation neither duplicates their content nor
creates question interest. Legacy unnegotiated sends keep their original transport behavior.

A negotiated connection must drain its outstanding event writes within 20 seconds. The deadline
closes that physical socket with `SESSION_EVENTS_DRAIN_TIMEOUT`; callback or actual socket close
alone releases its charges. Oversize/backpressure/unavailable are fixed no-content named failures,
close that observer and leave other clients operating. Metrics count frames, bytes, peak retained
bytes/frames and refusals without content or identifiers. Batch `replay:true` distinguishes explicit
historical replay from resumed attach: both already have `frame.replay:true`, but the old devices
caller skipped only explicit replay and still received resumed batches. No core batch array is kept.

### Proposed component raw-evidence owner

The only candidate file authority is a current `AgentView` from the existing `resolve` contract,
with engine, session, transcript path, process birth, evidence revision and hold state captured before
input. A device-supplied path or session ID is never authority. `conversations.discover` is currently
authorized only for the handoff service, not Wi-Fi; it cannot be assumed available or silently added
to the Wi-Fi query switch. Prefer existing binding announcements and current `resolve` to broadening
that authority. Missing or held identity cannot be repaired by guessed directory scans.

For an already-bound file, install the filesystem watch and capture regular-file identity/offset
before invoking shared input. One actual read owns each file; notifications coalesce into a dirty bit.
Bytes that arrive before the maker's `dispatching` fact can stay in the file behind the captured
offset, rather than a second in-memory line queue. Parse only after the matching dispatch fact has
installed its exact adapted hash/time/session. Read fixed-size chunks, retain at most one bounded
partial record, and verify inode/device and the captured boundary before accepting appended evidence.
Replacement, truncation, overflow, stale binding or read failure marks the existing receipt unknown
by a fixed no-content reason and never repeats Enter. Core disconnect marks it `CORE_DISCONNECTED`
and suspends read authority while preserving the original capture as evidence, as described below.

A first input can precede both session binding and transcript creation. It therefore needs a pending
capture bound to the original live process, installed before input, followed by the first authoritative
binding announcement. The first bounded catch-up may include older records; timestamps alone never
prove a result. Only the existing exact prompt match plus complete Claude ancestry or Codex explicit
turn membership can do so. A skipped prefix, oversized record or missing parent must remain a known
gap, never inferred success. `agentLife` with its current default does not announce every same-agent
binding; this needs the actual ordinary `agent_synced`/resolve caller or a demonstrated existing
`follow({ each: true })` binding path. No new polling loop is proposed.

The existing 64 unresolved native-input admission bounds initial pending captures. It does not by
itself bound all result parser state: consumed inputs no longer count toward that admission and
`DeviceResultEvidence` currently retains up to 8,192 Claude nodes or 16,384 Codex seen IDs per agent.
Before replacing transport-bound lines with direct filesystem reads, the design must supply both
record and byte budgets for active readers, partial records, parsed ancestry and result retention.
Current output checks are 64 correlated inputs, 512 results and a 32 KiB encoded result payload;
these remain authoritative. A reused `streamRecords` reader must surface skipped oversized records:
its current API silently skips them, so it cannot be used unchanged for proof of an uninterrupted read.

Proposed explicit overload census, selected after checking the devices host's 256 MiB heap/512 MiB
RSS limits: at most 512 capture metadata owners (the existing total receipt capacity), four actual
reads with 64 KiB chunks, a single shared 16 MiB + 4 KiB raw/partial-byte budget, and 16 MiB total
retained evidence strings plus 65,536 retained nodes/IDs across agents. Per-agent parser limits remain
secondary bounds. Current-answer text shares a separate 16 MiB component budget with the existing
16 KiB per-turn limit (1,024 completely full turns); the exact mixed-size record ceiling is also 1,024.
Existing result storage remains at most 512 payloads, each at most 32 KiB encoded. Metadata, UTF-16
strings and parsed object overhead count separately: encoded-byte caps are not claimed as heap caps.
These are NEW overload policies, including smaller maximum raw records than some former inline reads.
No oversized record is truncated into proof. The affected receipt stays unknown with a fixed local
failure code, and an input whose capture cannot be admitted is never written.

For first binding, the ordinary app `agent_synced` is only a trigger to the existing current `resolve`
query. It never supplies a path or process authority. Binding already announces that ordinary frame
(`agents/bind.ts` → `announceSession` → `sessionSync`); no extra `follow({each:true})` scan fan-out or
new discover permission is needed. One existing capture owns its in-flight resolve and a dirty bit.

The reader's resource pool belongs to the devices process, not one `startWifi` construction. The
process adapter supplies the same pool when an account/machine change replaces the built component;
the old component's stop revokes logical authority but cannot reset actual read, file-descriptor or
buffer credit. Inline construction owns one pool for its component lifetime. The pool admits at most
512 capture records, including retired records with unsettled physical work, and four actual read
operations. Each reader's agent index points into those same records; it is not another work queue.
Pending records contain only a dirty bit and one shared drain promise, never a chain per notification.
No new component is allowed to silently allocate an independent pool during the process rebuild path.

Selected physical-read proposal: capture a regular file using `O_NOFOLLOW`, install its filesystem
watch before input and remember its device/inode and bounded prefix/boundary digest. For a file ending
in an unfinished record, capture the beginning of that partial record rather than dropping it or
treating its suffix as a new line. Finding that beginning reads backward in at most 64 KiB chunks and
refuses a partial record beyond the raw-byte cap. No record is emitted during unverified asynchronous
I/O. A drain captures one file-size endpoint, admits that bounded raw window, reads into its admitted
buffer in at most 64 KiB operations, verifies a second read of exactly that window against its hash
using the same buffer, then rechecks the file/boundary and fresh authoritative binding
before synchronously supplying complete records to the existing evidence parser. At most 16 MiB total
window buffers are admitted across the process; four fixed 1 KiB boundary scratch areas account for
the additional 4 KiB. There is no extra per-read 64 KiB buffer beside the admitted window. An unfinished
last record stays in the file behind the cursor and is read again when it grows, so it owns no second
in-memory partial queue. A fixed 15-second operation deadline revokes observation and reports the
gap, but physical credit remains charged until the read and descriptor close actually settle.
The second window read is required by the observed in-place rewrite RED
(`/tmp/core-wifi-evidence-rewrite-red.log`): verifying only the old cursor accepts newly read bytes
that changed before final validation. It doubles bounded snapshot read I/O; its cost must be measured
with the actual component workload, without allocating another window or adding an unbounded retry.

This selects a NEW maximum 16 MiB unread capture window, including first-binding catch-up. A larger
backlog is explicitly `EVIDENCE_TOO_LARGE` and keeps the accepted receipt unknown; it is not read
without a bound or silently skipped. First binding reads from byte zero, so it never pretends an
omitted history prefix is a continuous proof. The first-binding transition requires the original live
process birth/engine, no identity/interpretation hold, and unchanged bounded `earlierSessionIds`;
the captured empty binding becomes exactly the fresh core-resolved binding. `evidenceRevision` is a
global registry counter, so adjacent revision numbers are not assumed. Once bound, every binding
field/revision is exact within one core boot. A changed process, intervening rotation history or missing authority marks
the receipt unknown. The actual bind/rebind caller tests remain required to prove this transition.

The normalized session observer has the enabled service's lifetime, including periods without a
device hello or stream subscription: the old core feed retained each current answer in that state,
so a later mid-turn subscriber still receives its full final answer. Raw captures also remain while
accepted native receipts need evidence. The question observer retains its narrower last-hello
audience lifetime. Explicit disable/core disconnect revokes all feed authority and closes its watches;
late work keeps physical charges but cannot publish into a replacement generation.

Core replacement preserves the original capture identity, file boundary and parser ancestry; they
are evidence, not permission to read. Disconnect closes watches and revokes every in-flight read's
connection identity. It releases unused pre-dispatch reservations, but cannot release an actual read,
buffer or descriptor until physical settlement. A new core connection resolves the original agent
again. Process birth, engine, session, path, bind time, hold state and prior-session history must still
match. The old core's evidence revision is not carried across boots. A fresh revision is accepted
only after the original file boundary is verified, a bounded snapshot is read and the same fresh
core proof is rechecked. Old operations cannot regain authority when that new connection starts.
An originally unbound process may still take only its first binding under the same history/process
rules. Successful evidence can reconcile an unknown receipt; no reconnect path retries input.

The result parser accounts all agents against one 16 MiB UTF-8 retained-string budget and 65,536
record budget. Claude nodes charge their key, parent, matched input ID, answer text and message ID.
Codex deduplication keys, turn bucket keys and every member occupy records; a null unmatched member
still occupies one record. Per-agent eviction releases its exact charge before replacing a node/key,
so a full global budget does not refuse an equal-size replacement solely due to transient accounting.
Turn completion, agent removal and evidence loss release owned charges. Refusal discards that agent's
proof, logs fixed `EVIDENCE_BACKPRESSURE`, and marks its affected receipts `RESULT_EVIDENCE_MISSING`;
it cannot manufacture a partial result or repeat input. JSON parsing remains bounded by the raw
window cap; encoded retained-string accounting is not a claim about object/UTF-16 heap overhead.

Raw file observation and app events are different channels. Their ordering is not automatically the
old raw-before-normalized order: a fast app `turn_ended` can otherwise mark a native receipt unknown
before its raw result is read. The first RED must exercise that race, along with a complete first turn
written before its binding announcement. A bounded ordered handoff or a proven lifecycle adjustment
inside the component is required before the core raw side-read is deleted. There is no approval to
hide this race behind a sleep or to weaken native result evidence.

### Focus: existing mutation authority and approved caller contract

The complete mutation audit of `AutonomousDeviceService` finds exactly two `focusCounter` increments:
`appFocus`, which originates from an actual core window update/disconnect, and `focusSnapshot`, which
clears a focused local agent that disappeared. `focus.step` and `focus.ensure` do not independently
choose authoritative focus; they request a window move and wait for its acknowledgment. This favors
capturing existing `appFormWindow` and `appVoiceFocus` object identities over adding another generation
map. Both objects are replaced by explicit focus and cleared when their owning window disconnects.

Candidate service request: `wifi_focus_current { revision }` returns `{ current: boolean }` from the
component's current focus snapshot, after prior window notices. Revision is a nonempty string of at
most 128 characters. The process adapter waits its existing `heardSoFar` owner and the handler waits
its existing `focusing` owner, then checks captured core epoch and current service state. This wait
matters: a choice made before the conditional acknowledgment arrived must be applied before the
revision comparison, not merely protected against choices that happen during the check.
A conditional `app_focus` captures the
two existing window objects and the original physical socket/bound machine. After the bounded check,
the final core apply is synchronous and requires those objects unchanged, the same physical window
still open, and the target agent still current. Explicit untagged `app_focus` continues immediately,
superseding a pending conditional check. No component revision is cached in core.

The old `localWsServer` assumed a synchronous callback; six actual temporary-socket REDs exposed
pending promises treated as approval and absent named handling for rejected/thrown validation
(`/tmp/core-wifi-focus-expanded-red.log`). The approved replacement keeps explicit focus synchronous.
Conditional validation resolves `false` or a zero-argument guarded apply closure. On completion,
`localWsServer` checks the original physical sink, open socket and captured bound machine, then calls
the closure and forwards the dial update in the same stack. It does not await this on the connection's
message chain. The machine binding is fixed at the original handshake; a later `machine_select`
continues to reach the ordinary backend and does not rebind that socket. No new focus generation is
introduced. Thrown/rejected validation emits only fixed `FOCUS_VALIDATION_UNAVAILABLE`, without
content or identity, and explicit focus remains usable.

The core closure compares the captured `appFormWindow` and `appVoiceFocus` objects, exact current
`ports.wifi` object and a copied `paneReadIdentity` from the existing transcript authority helper.
That scalar detects in-place changes to session, process, evidence revision, identity hold or terminal
route. Missing/held local targets are refused; explicit remote focus is unchanged. The external Wi-Fi
connected callback publishes a fresh shallow port object; disconnect clears it. Inline service ports
already have their actual guarded lifetime. No component revision is cached in core.

The integrated
serviceLinks owner now caps all outstanding requests at 100 per service; the matching inline owner
above caps actual unsettled handlers, including after timeout/abort. The check uses that existing
bounded request custody, not a new Wi-Fi waiter map. External `call` is the core's request: closing a
window revokes final apply authority but retains request credit until reply or its 15-second deadline.
Inline `call` carries the existing asker connection for close notification and retains actual handler
credit until settlement even after abort. A reply from a replaced/disabled service
must not authorize a window move. The actual service callback and physical-window completion need
RED cases for old reply/new explicit focus, disconnect/reconnect with the same agent, replacement,
timeout/hung inline handler, target deletion and two conditional acknowledgments in flight.

The first caller RED is `services/wifi.feed.spec.ts`: shared input executes while the proposed raw
capture is held, and an app end executes while its proposed raw drain is held. It also covers empty
first binding, original end/start adjacency, and named lost/gap/oversize callbacks without effect retry.
These injected-reader caller cases do not substitute for the temporary-file identity, partial-record,
capacity, first-binding catch-up and actual close/settlement cases required in the reader itself.
The next actual-filesystem caller RED (`/tmp/core-wifi-filesystem-caller-red.log`, four failures,
actual exit 1) uses production `startWifi` without an injected reader and real throwaway JSONL files:
bound complete output, an old partial record completed before new output, and an original-unbound
process whose whole first turn is written and bound before the faster app end. All three currently
remain `RESULT_EVIDENCE_MISSING`; an unsafe symlink capture currently reaches shared input. These
prove the missing caller behavior, not a completed reader's safety or capacity validation.

### Focus slice validation

- RED: six temporary-socket cases at `/tmp/core-wifi-focus-expanded-red.log`, actual exit 1;
  four missing component-handler cases at `/tmp/core-wifi-focus-service-red.log`, actual exit 1.
- GREEN: all 77 local WebSocket cases at `/tmp/core-wifi-focus-local-green.log`, actual exit 0.
  The 209 selected core/service cases at `/tmp/core-wifi-focus-coverage.log` all pass; Wi-Fi core,
  link, service and process each meet 100% statements/branches/functions/lines. That command exits 1
  solely because the selected API tests omitted the existing connectors fallback caller. The corrected
  five-file API selection at `/tmp/core-wifi-focus-api-coverage.log` passes all 91 cases and API
  per-file 100%, actual exit 0. No unused defensive cases were added for that omission.
- Architecture: all 30 cases pass at `/tmp/core-wifi-focus-architecture.log`, actual exit 0.
  The parent's identical `d5514605d7` shared-limit export correction is included for that check.
- Types: `/tmp/core-wifi-focus-types-final.log`, actual exit 0. Diff whitespace check clean.
- Final composition authority is wired in `main.ts`, outside the unit coverage gate. Packaged native
  focus/restart cases and cost validation remain the coordinator's responsibility after integration;
  these unit tests make no claim that the real main wiring has already been exercised. Windows
  remains explicitly unverified under the user's current deferral.

### Proposed files and next validation selection

Recap cards use the existing authenticated peer with one fixed `recap` frame containing the exact
`commander_event`, its captured matching `fullText` (or null), and the current peer epoch. Only the
recaps role may originate it; devices cannot forge a recap and recaps cannot send device requests,
ready, hello, routing identities or revocations. Gateway translates only the epoch to its current
ready devices peer. Both hops retain the existing byte/frame/callback-close custody and fixed drain
deadline; no replay queue, socket or core cache is added. The producer takes `mirror.lastFullText`
in the original synchronous send callback, after `rememberFullText`; that source already clips its
stored full text to 8,192 bytes. Failed/oversized/unavailable handoff is named and the original
core/cable card continues; no accepted input is retried or completed from a missing recap.

A peer summary may arrive before the component finishes the earlier normalized end. Its receiver
therefore waits for one `agent_recent {agentId,n:1}` reply on the existing observation socket, then
for a marker appended to that receiver's existing FIFO. The returned recap text is discarded; only
the immutable peer pair is published. Causality is provided by the actual funnel: every normalized
app send precedes `mirror.ingest`, which sends the lifecycle that produces the peer summary. No
extra recaps-to-core read is needed. This promises order relative to preceding normalized batches,
not global order between independent core/cloud card producers. Live tool cards add no query.

At most four barrier requests exist across all component/connection constructions in a devices
process. Each reserves one record and its bounded request bytes from the existing 4,096-record /
16 MiB + 4 KiB feed pool, and its deadline is 15 seconds. The same FIFO holds response markers;
there is no second event queue. A missing earlier batch tail is a visible gap. Logical timeout or
disable rejects publication authority, but an unanswered query retains its barrier/frame/byte credit
until its actual response or physical socket close. The peer's incoming summary handler remains
charged until the await actually settles. This overhead needs final same-workload measurement.

Existing core/cloud commander cards continue through negotiated session observation. The shared
publisher attaches optional outer `payload.source` from trusted call-site metadata, preserving the
original `payload.frame` unchanged. It performs no producer-specific filtering. The only production
`clients.turnCard` callers are `services/recaps.ts` and `core/recapsLink.ts`; the latter is invoked only
for the authenticated recaps service in main. The inline former is the same known producer. That
existing narrow door labels publication `recaps`; direct core/cloud `sendCommander` calls default to
`core`. Incoming frame/payload fields cannot choose this outer provenance. Devices ignores observed
recaps-origin cards in favor of the captured peer pair, and consumes core/cloud cards normally.
Desktop continues ordinary dispatch of the original frame and ignores producer provenance.

Dispatch/observation ordering uses the existing activity epoch/revision and the concrete engine
session ID, not another core clock. The generic dispatch notice copies its activity stamp at the
actual write admission. Normalized frames already contain that stamp and session ID. Cancel adds
`cause: 'cancel'` to its existing `agent_activity`; it does not synthesize `turn_ended`, promise an
engine kill, or change Desktop's completed-turn count. Its publication remains before the awaited
confirmed-cancel result. A late cancel/end cannot complete or interrupt a dispatch stamped at or
after that event, or one from another session/epoch. Missing concrete proof remains unknown.

Only receipt-affecting end/cancel batches use the existing conversations resolve request on the
same service connection as input notices. Its response is followed by the notice-owner prefix
already enqueued at response time; this ensures earlier dispatch/delivery notices are applied before
the end. Normalized batches are received outside that notice owner, so this adds no self-dependency.
The reader also uses this captured-connection resolve implementation; the previous adapter's
`CONVERSATIONS_OFF` is insufficient. A query itself has no deadline. The feed's existing 15-second
deadline makes loss visible and revokes the handler's authority, while its process-owned four-slot
pool retains actual handler/frame charges until query settlement. There is no query-per-token path,
extra event queue, input retry, or claim that the extra round trip has passed cost validation.

Reader identity retention additionally has a 64 KiB selected JSON identity limit and 4 MiB total
across the physical capture pool. Each of the four reads may hold two bounded verification snapshots
(at most another 512 KiB); history remains at most 32 IDs of 256 characters. Admission counts before
copying or comparing, including a second delivery against an existing capture. Capture identity
credit remains charged after logical retirement until the actual read and FD close settle. These
are new private overload limits. Refusal reports `EVIDENCE_BACKPRESSURE` and unavailable evidence.
Complete raw records must be valid UTF-8 before parser publication; incomplete trailing bytes remain
in the file behind the LF cursor. No replacement-character text is manufactured as evidence.

Raw evidence: component `lib/autonomous-device/` reader and its specs, `services/wifi.ts` and
`wifiProcess.ts`, with deletion from `core/wifi.ts`, `transcripts/attach.ts`, `transcripts/ingest.ts`,
`core/main.ts`, `core/api.ts` and `core/wifiLink.ts`. Existing shared input delivery authority stays.
Normalized observation: existing `backendSocket.ts`, `localWsServer.ts`, `turns/funnel.ts`, a small
`agentClient/` consumer, component stream lifecycle, and the actual Desktop decoder/tests if the
batch-envelope option is approved. Focus: existing local window callback/composition, service request
owner and component focus handler, plus deletion of `core/wifi` revision state. No new dependency.

Pick before execution: bound/unbound first-turn and raw-before-progress races; end/start batch
adjacency; mid-turn full final; slow observer physical settlement; audience teardown/re-enable;
stale binding/path replacement and deliberate gaps; final focus races above. Then affected per-file
core/service coverage, types and architecture. Packaged native Wi-Fi/inline and cost comparisons stay
with the coordinator after the integrated source is frozen.

### Existing ordered-work owners: admission and actual settlement

`startWifi.appFocus` appends each window move to `focusing`, then refreshes the view before applying it.
Its callers are the core's window-focus port notifications and `wifiProcess.heard.appFocus`; these are
port calls/notices, outside both the inline and external 100-request limits. `runWifiService.inOrder`
appends resume, agent lifecycle, validated input, delivery, focus and reveal notices to `heardSoFar`.
The transport does not await `onEvent`, and the same prefix is awaited by reads and service requests.
Neither original owner bounds retained closures if its first handler never settles.

Keep those two chains. Each gets a process-owned accounting object with at most 100 accepted entries
and 16 MiB of encoded retained JSON payload, measured by `boundedJsonBytes` before retaining the
payload. This is a wire-payload budget, not an exact JavaScript heap measurement. The accounting
helper stores only two counters; it creates no queue, map or service API. Focus uses the same owner
across inline reconstruction; the process adapter supplies a shared focus owner to every rebuilt
service and retains its separate notice owner for its entire process lifetime.

Every accepted operation has a 15-second logical deadline. A timeout or admission refusal first
revokes its captured component/link generation, then emits a fixed no-content failure name
(`WIFI_FOCUS_TIMEOUT`, `WIFI_FOCUS_BACKPRESSURE`, `WIFI_NOTICE_TIMEOUT`, or
`WIFI_NOTICE_BACKPRESSURE`). Serving becomes unavailable and old queued effects cannot run. The
existing chain, payload credit and handler remain owned until actual settlement. A replacement
connection cannot release that credit. Focus callers receive the logical refusal; requests waiting
on a notice prefix race only that generation's shared revocation signal, not a second work queue.
Fresh connection/resume can recover only within remaining physical capacity.

The resume-before-connected case captures the original link wait and notice generation. Disconnect
releases that wait after revoking its generation, so an old resume cannot wait on or build against a
replacement core. Every post-await read/build/follow/resume checks the same captured generation and
connection. A rejected follower query cannot publish catch-up from a revoked generation.

The extraction removes `core/wifi.ts`, its separate stream/transcript/seen maps, normalized/raw feed
port calls and native worker `LiveFrame.observe`. Session events are already ordinary app data;
`lib/sessionEvents.ts` names their shared negotiated envelope and transport limits. The pure
`lib/boundedJsonBytes.ts` and `lib/jsonStringBytes.ts` enforce physical send admission for the app
transport and authenticated component peer without serializing an oversized frame. Those three
pure files replace the removed core feature module in the process import census; no component
reader, queue or state enters the core. Desktop is the second production negotiated consumer.


### Uncertain descriptor close

A rejected `FileHandle.close()` cannot establish descriptor release. The existing physical capture
retains the handle object, its owner, metadata credit and one of the four actual read slots until
process exit. The logical request fails with unavailable evidence and logs `EVIDENCE_CLOSE_FAILED`;
there is no close retry against a possibly reused descriptor number and no reliance on GC. A raw
buffer whose read has already settled is actually discarded and its byte credit may be released.
Stop scans this owner's captures in the existing process pool, including retired captures, and
reports `EVIDENCE_DRAIN_PENDING` after its existing two-second wait. Normal callback/close settlement
continues to release each physical charge exactly once. Inline reconstruction shares the same
process-owned raw, event and focus pools as its predecessors.

The direct recap producer and the component's core/cloud event consumer preserve the original
card policy: local-only tool-end/turn-start/reply-text cards stay off the Wi-Fi path, and processing
cards omit the cable's `update` sentence. The shared app publisher preserves its original frame.
Delayed normalized starts, as well as ends/cancels, must carry a matching later activity stamp before
they can consume the current non-native input's pending start. A prior turn's delayed start cannot
turn the newer request into an overlapping-input uncertainty.

An explicit end/cancel boundary marks the existing raw capture dirty and awaits its current physical
read. A boundary arriving during a read belongs to that same operation; its existing 15-second
deadline bounds any additional passes. Settling an old core connection may synchronously start a
fresh read, so the boundary awaits that fresh pending promise before applying the normalized end.
Token/tool batches do not force a core query or raw-file drain. Filesystem notices drive those reads.
The actual dispatch session is retained for non-native receipts too: lifecycle catch-up that changes
that binding invalidates an old receipt before a delayed old normalized end can complete it.

### Cutover validation, 2026-11-18

The selected core/service gate passed 679 cases in 26 files, with 100% statements, branches,
functions and lines in every changed covered runtime file: `core/api`, `core/input`, `core/wifiAgents`,
`core/wifiLink`, `core/transcripts/attach`, `core/transcripts/ingest`, `core/turns/cancel`,
`core/turns/funnel`, `core/turns/heartbeats`, `services/recaps`, `services/turnsLink`, `services/wifi`
and `services/wifiProcess`. Its companion suites include the existing messages/conversations/
experiments/connectors API callers and bind/resume coverage. The selected transport/peer/reader/
architecture gate passed 810 cases in 24 files. TypeScript and `git diff --check` passed.

Behavioral REDs preceded the reader, observer, admission and receipt changes. Later caller REDs
also caught a stale non-native dispatch binding, an old-reader/new-reader settlement handoff, and
per-token forced evidence drains; each was corrected with its failing caller retained. The final
service cases cover production observation over an isolated private Unix socket, actual decoder/
writer recap ordering, first binding, core replacement, file rewrite/close custody, bounded retries,
reentrant focus drainage and late callbacks. Existing encrypted peer boundary tests remain intact.

These are macOS source/fixture checks. The coordinator still owns final combined packaged Wi-Fi and
inline acceptance, restored nonfocused-question behavior, and hot-path cost measurements. Windows
execution is deferred by the user. No native, Windows or performance acceptance is claimed here.
The remaining `wifiAgents` door is stateless; this slice removes feature observation/relay state and
raw/normalized feed plumbing rather than claiming that every named feature door has disappeared.

A subsequent caller RED found that refusing an old end/cancel for native receipts still emitted an
unscoped `turn.done`/`turn.error` and cleared the agent's open-turn state. The existing receipt proof
now fences those global effects too. Matched older receipts settle independently, while any live
native dispatch refusing the exact session/epoch/revision proof preserves the newer global state.
Both mixed older/newer and only-newer native callers fail before the fix; non-native and valid-current
cancellation remain controls. The correction changes no core authority or retained maps.

### Integrated packaged checkpoint

Integration `164587caf0` preserves the independent phone shim boundary and gateway metric provenance.
The author reviewed both conflict resolutions. Selected integration checks passed 681 cases in 26 files,
with all 13 covered core/service files at 100% on every metric, 382 transport/caller cases in seven files,
and TypeScript. Receipt: `.harness/validation/20261118T033156.823876Z-99767/receipt.json`.

That same receipt is failed overall: the packaged six-case Wi-Fi file passed inline compatibility and
service-unavailable isolation, but four supervised cases timed out awaiting hello. Each reported
`SESSION_EVENTS_UNAVAILABLE` followed by `WIFI_NOTICE_FAILED` at service startup. Source diagnosis found
the process composition omitted the event observer's actual daemon address; its default read the process
facade's unknown port. A separate correction is under failure-first validation; no native pass is claimed.
The test now propagates daemon cleanup failures and checks master exit zero, actual close, both output
EOFs and private-root removal. All six cases completed those cleanup checks, including the four failures.
