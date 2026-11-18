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
session_events { generation, agentId, sessionId, replay, events: LiveEvent[] }
```

An empty named scope removes interest; it does not claim foreground presence. Scope is installed
before the successful reply and the connection's ordered socket carries every subsequent event.
No event history or per-turn answer is retained in core. The existing tool/question admission is
shared: at most 64 tool connections, one admission per physical connection even if it asks for both.
Scope replacement and disconnect revoke old delivery authority without freeing writes that have not
physically settled. Devices own their existing stream subscriptions and per-turn answer state.

For real convergence, the proposed change also migrates the Desktop's local `ws_conn.dart` event
decoder to this negotiated envelope and expands each batch through its existing event dispatcher.
Legacy app connections retain their existing individual frames. Merely naming a device-only feed
`events_observe` is not the proposal. A Desktop protocol change needs its applicable instructions,
decoder coverage and a person-level session-stream test before integration.

Unresolved before approval: where the funnel emits the negotiated envelope without changing the
existing per-event app-before-input ordering or the receipt-before-recap ordering; whether individual
frames carrying bounded batch provenance produce a smaller shared change than an array envelope;
and the exact byte/count ceilings for both wire and component retention. Existing engine pages allow
1 MiB pages and fragmented 64 MiB results (`engines/worker/liveProtocol.ts`), so 16 MiB cannot be called
a historical universal event maximum. Any new overload refusal must be named and tested, including
escaped content, large tool inputs and a slow app as well as a slow device observer.

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
Replacement, truncation, overflow, stale binding, lost core connection or read failure marks the
existing receipt unknown by a fixed no-content reason and never repeats Enter.

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

Raw file observation and app events are different channels. Their ordering is not automatically the
old raw-before-normalized order: a fast app `turn_ended` can otherwise mark a native receipt unknown
before its raw result is read. The first RED must exercise that race, along with a complete first turn
written before its binding announcement. A bounded ordered handoff or a proven lifecycle adjustment
inside the component is required before the core raw side-read is deleted. There is no approval to
hide this race behind a sleep or to weaken native result evidence.

### Focus: existing mutation authority and pending decision

The complete mutation audit of `AutonomousDeviceService` finds exactly two `focusCounter` increments:
`appFocus`, which originates from an actual core window update/disconnect, and `focusSnapshot`, which
clears a focused local agent that disappeared. `focus.step` and `focus.ensure` do not independently
choose authoritative focus; they request a window move and wait for its acknowledgment. This favors
capturing existing `appFormWindow` and `appVoiceFocus` object identities over adding another generation
map. Both objects are replaced by explicit focus and cleared when their owning window disconnects.

Candidate service request: `wifi_focus_current { revision }` returns `{ current: boolean }` from the
component's current focus snapshot, after prior window notices. A conditional `app_focus` captures the
two existing window objects and the original physical socket/bound machine. After the bounded check,
the final core apply is synchronous and requires those objects unchanged, the same physical window
still open, and the target agent still current. Explicit untagged `app_focus` continues immediately,
superseding a pending conditional check. No component revision is cached in core.

This is still a proposal: `localWsServer` currently assumes a synchronous callback, and neither
`serviceLinks.call` nor `inlineHost.call` is a blanket count bound for arbitrary simultaneous callers.
The check must use existing connection-owned request custody with a precise actual-unsettled bound,
not an unbounded Promise chain or a new Wi-Fi waiter map. A reply from a replaced/disabled service
must not authorize a window move. The actual service callback and physical-window completion need
RED cases for old reply/new explicit focus, disconnect/reconnect with the same agent, replacement,
timeout/hung inline handler, target deletion and two conditional acknowledgments in flight.

### Proposed files and next validation selection

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
