# Finish the Wi-Fi desk boundary

Status: root approved the boundary and scoped RED/implementation on 2026-11-19;
native and cost execution remain separately held.
Base: integration 1ec962c385. The completed sizing checkpoint stays frozen.

## Design

### Existing callers and removal

Only Wi-Fi uses the core's remaining desk methods. `wifiAgents.ts` checks whether
a local window exists and forwards step/scroll into `DevicesPort`; `wifiLink.ts`
exposes the two private calls. `devicesLink.ts` proxies them back out to Devices.
The default cohost path already bypasses these through `deviceDeskFor`, with
component/core/machine ownership, a five-second step deadline and actual-work
accounting. Explicit inline mode still uses `ports.devices`, which can also be an
external proxy in a mixed composition.

Replace the mixed path with the existing local owner service-request transport.
Delete `core/wifiAgents.ts`, `CoreApi.wifi`, `WIFI_OFF`, the Wi-Fi private query and
notice, and both `DevicesPort` members/proxies/private process handlers together.
Remove their construction/import/fake-API/architecture entries. Keep Wi-Fi's other
remaining input/delivery/resume wiring unchanged.

Devices already owns the `devices_ws` request. Add two local frame declarations
to `SERVICE_WS_FRAMES`, both routed into that existing request:

| Frame | Reply | Bound |
| --- | --- | --- |
| `harness_device_step` | `harness_device_step_result` | 5 seconds |
| `harness_device_scroll` | none | 5-second existing routing bound |

Neither declares relay RPC authority. LocalWsServer's existing physical client
connection supplies `Asker.connection`; the normal service host/link supplies its
closed signal. No new request broker, core map, service slot, endpoint or relay
grant is introduced. Devices handles these exact two frames before its existing
voice/task frame dispatch; all existing frames retain their previous handling.

### Step

Reuse `requestOnce` with `harness_device_step`, the existing owner-tool handshake,
exact result type/id and 4 KiB reply limit. Its five-second caller budget includes
connection setup. No retries; an uncertain outcome never falls back to another
route. The existing component result journal continues to deduplicate the device's
gesture idempotency key; transport request IDs remain separate.

The fixed component payload carries machineId, direction, optional currentAgentId
and a five-second absolute expiry. Devices checks shape/size, current local-owner
connection, exact current machine and expiry before invoking its desk. It passes
the same predicate through listAgents' await and the final focus effect. The
receiver's existing desk timeout still bounds its answer; expiry also prevents a
late effect when a timer callback has not yet run. The result remains an exact
target, `no_agents` or `no_app`. Unknown/unsupported or transport failure is an
unavailable step, never an empty target interpreted as success.

The component payload is at most 4 KiB; machine IDs use the existing owner-client
200-character bound and agent IDs use the session observer's existing 128-character
bound. Numbers are finite safe integers; the direction is exact. No prompt or
terminal authority is added. The shared one-shot helper's Cancel and Store context
callers retain their current limits and physical-close accounting.

### Scroll: reuse the existing physical connection

Wi-Fi already owns a `DeviceSessionFeed` owner-tool socket and waits for it before
application hello. This socket already sends an ordinary `agent_recent` request
for barriers. Add a fixed `scroll` method to this component connection, not a
generic request method, second socket or waiter map. Its only outbound frame is
`harness_device_scroll` with captured machineId and phase/dy/velocity. No request
ID or reply is needed. No scroll queue, replay or coalescing is added; the current
stroke routing and line accumulation remain in Devices/CableHost.

Before every send, require the exact live feed instance, completed local handshake,
current component/core/machine binding, the caller's current view/window and valid
gesture fields. Keep the existing integer limits: dy ±4096, velocity ±100000,
phase down/move/up. Refusal returns false and reaches the existing
`FOCUS_UNAVAILABLE` response; pressure is also logged by a fixed content-free name.

Strengthen this effect-bearing socket's existing handshake to verify its requested
machine ID, local transport and local protocol 1 as well as event protocol 1.
Wrong-machine, remote or malformed welcomes never enable scroll.

Use the existing numeric `devicePeerBudget` helper for separate outgoing credit:
64 KiB and 256 physical writes across all feeds sharing the component's pool.
Incoming event limits are unchanged. Each fixed scroll/probe frame is at most
1 KiB. Check the socket's actual bufferedAmount before sending; extend the shared
ClientSocket typing for the actual WebSocket buffer and optional send completion.
A bounded set tracks only release callbacks for writes handed to that socket.
Credit returns on its actual send callback or physical close, never logical close
or replacement. The existing drain deadline includes unsettled writes; a stalled
write revokes/closes that feed without replay. No payload is retained in another
component queue.

### Public compatibility and readiness

Removing private methods bumps unreleased WORKER_CONTRACT 4 to 5. Keep the derived
WORKER_PLAN equal to its real inputs; do not invent a feature fingerprint. Verify
old/new private cohort refusal. Existing public clients and frame shapes do not
change; they simply never call the two additive local declarations.

A bare old public core would silently ignore an unknown one-way frame. Do not
infer scroll support from event protocol 1. Proposed explicit component readiness:
when a new mixed-host scroll asks, use the already-open feed to send `harness_device_step` with a bounded read-only
`probe: true` body and one dedicated handshake request ID. Devices answers
`{ protocol: 1, machineId }` without reading an agent or moving focus. This is one
handshake slot, not a request map. Concurrent callers share that one in-flight
probe. A matching affirmative answer enables scroll for this physical feed;
unsupported, wrong-machine, timeout, close or a negative answer settles it false.
The probe has a five-second deadline and uses the same physical write accounting.
Negative results are not cached: a later new gesture can probe again after Devices
is enabled on the same core/feed. There is no background polling and a failed
stroke is never held for recovery. Probe shape is exact: true probe, machineId and
its request ID only; any direction/agent/expiry/unknown field refuses before focus.

Keep event observation's readiness independent, so unavailable Devices does not
disable turns/questions. Extend the existing component-only `beforeRequest`
callback with its request argument; only a mixed-host scroll waits for the feed's
bounded desk readiness after refreshing its view. The relay already checks its
physical device incarnation again after that await. The callback may return the existing typed protocol refusal. After its unchanged
physical-device incarnation check, the relay returns that refusal without calling
the service. Wi-Fi captures the feed/core lifetime and returns FOCUS_UNAVAILABLE
for a false readiness result or a changed lifetime, even if a later gesture has
already recovered. No per-gesture state is retained. Cohost calls skip the probe wait. No
effect is sent before readiness, and no failed stroke is retained to send later.

Production connectSocket and its authenticated pipe connector return Node ws
sockets, whose send callback and bufferedAmount are part of the required outgoing
contract. Missing/invalid buffer accounting refuses explicitly before reserving or
sending. A transport that accepts a send but never calls its callback reaches the
bounded write deadline, reports an unavailable feed and requests close. Acceptance remains a one-way notice, not delivery confirmation. It does
not silently release its credit; only the callback or physical
close can release it. Tests must drive both release paths and unsupported/stalled
alternates. No synthetic callback is permitted as an admission workaround.

### Receiver and composition authority

Publish the existing `DeviceDesk` from inline Devices too, only when the process
adapter has not supplied `onDesk`. Bind publication to its actual service stopper
and captured machine; revoke before stop. External Devices keeps its existing
generation-owned publication in devicesProcess. Wi-Fi resolves `deviceDeskFor`
first in every composition, replacing its core-port fallback.

The Devices step handler refreshes through its existing component reader before
reading membership; scroll stays synchronous on its existing published binding and
window facts without another complete read; inline it reads the actual CoreApi facts. Capture
the physical request closed signal and resolve the current published desk only
under that authority. The published peer keeps its owner/generation guard through
every awaited step and immediately before scrolling. Do not replace it with a
machine-ID-only check that revives after an ABA reconnect.

The existing Devices refresh now returns explicit success from its shared promise.
Display callers retain their fallback, while new step requests require successful
refresh and the same published desk owner after the await; replacement, deletion
or failure cannot admit a new effect.

Window authority is an explicit read boundary, not an atomic distributed promise:
the current component read observes hasWindow; an external Devices publication can
lag a later window change until its next existing read, as the cohost path does.
Wi-Fi already reads its own current view before each gesture; the receiver does not
repeat that complete read for each scroll stroke. The generic window sender still
decides actual physical delivery. A close after that read can make delivery fail,
as a close after the old core check could. A later completed read that says no
window must suppress effects; stale completions must not clear a replacement view.

| Wi-Fi | Devices | Route |
| --- | --- | --- |
| same external host | same host | existing generation-owned direct desk |
| inline | inline | same direct desk, now owned by inline service lifetime |
| external | inline | local declared service request to inline Devices |
| inline | external | source/unit-only path; current master cannot select this split |
| separate external hosts | external | generic request path; current master cannot select separate hosts |
| either | unavailable/off | unavailable step / false scroll, no fallback replay |

The current selector treats a host name as that whole host. In particular,
`HARNESSD_SERVICES=devices` starts devices, wifi and machineAddons together;
`HARNESSD_SERVICES=wifi` selects only Wi-Fi. There is no supported inverse selector
or exclusion syntax. The inverse direction has source/unit coverage only, and the
native suite must not claim it from a cohost run or add a runtime setting to force it.

Startup admits no effects before verified machine/transport readiness. A service
or core disconnect revokes the captured owner before another can publish. Old
physical writes retain credit until settlement. A replacement may serve later
requests but receives no replay of previous gestures.

### Checklist

1. Growth: no persistent data. Step capacity ends at physical close; outgoing
   writes end at callback/close. Probe state and direct publication end with the
   component owner. No archive/read-all readers or migration records are added.
2. Concurrency: existing service request limits and physical connection cancellation
   bound receivers; the shared desk budget bounds actual step work. No second
   serialization queue or general waiter map is added.
3. Read cost: the current complete view refresh remains the source of window and
   machine facts. Direct cohost stays direct. Mixed steps add one existing owner
   request; scroll reuses its already-required feed socket. No polling is added.
4. Scale: 10x ordinary scroll cadence must remain bounded by fixed frame/write
   budgets and existing device request admission. Observe accepted/refused counts,
   send/settlement count, max outstanding bytes, CPU and latency in a separately
   reviewed comparison; no timing acceptance is claimed from source tests.
5. Compatibility: the table covers every supported composition. Old public servers
   cannot affirm the probe and never receive a stroke. Existing app frames and
   device response envelopes stay identical. No Windows-specific fallback remains.
6. Rollback: no schema/data migration. Roll back the complete artifact cohort,
   not one side of the removed private contract. Production backup work is N/A.
7. Audience: only this OS owner's local socket; transport supplies local/owner and
   the physical connection. No remote/guest grant, logged body or additional copy
   of private rows is introduced. Core carries generic declared requests only.
8. Identity: exact verified machine and existing component/connection lifetime,
   never a payload-selected login. Missing identity refuses before send/effect.
9. Failure: fixed DESK/scroll pressure/protocol/deadline names; existing unavailable
   device response; no uncertain retry. A future verified owner can serve new work.
10. Platforms: existing connectSocket supplies Unix sockets on macOS/Linux and the
    authenticated Windows pipe. Windows remains deferred, not claimed passing.
    Native macOS acceptance requires the actual packaged mixed compositions.

## RED and verification plan

First actual caller REDs: direct device protocol step/scroll with both old private
routes deliberately unavailable still works in each mixed composition; current
code fails. Add wrong-machine/local/protocol feed welcomes that currently permit
observation but must never authorize a scroll. Add core/window replacement during
receiver refresh/listAgents and after caller await, including same-ID ABA.

Positive/negative controls: cohost and inline direct paths, no window, Devices off,
valid step target/no_agents/no_app, five-second expiry without late focus, duplicate
device key no replay, scroll down/move/up order and unchanged accumulation, invalid
fields, old-server probe refusal, exact probe ID/type, observer readiness independent
of desk support, read-only probe never moving focus, pending write timeout/late send
completion/physical close, capacity held across feed replacement, and fresh recovery.

Selected coverage includes changed core/Devices/Wi-Fi transport files, shared
requestOnce Cancel/Store callers, device service/relay contracts and existing
public-route owner/guest controls; all changed core/services/harnessd files remain
100% per file. Types, architecture and cohort admission are mandatory. Packaged
cohost/inline/mixed cases and hot-path cost need a separately reviewed frozen
artifact/recipe. No build/native/timing is authorized by this Design alone.


## Source evidence (2026-11-19)

Pinned Node 24.22.2 and the immutable main-86558 dependency tree; plans and reports
are retained under `/tmp/core-wifi-desk-*20261119*` and this checkout's validation
receipts. These are source checks, not packaged or performance acceptance.

| Receipt (UTC date 2026-11-18) | Actual outcome |
| --- | --- |
| 173059.819932Z-30174 | RED: 5 caller/admission failures; old receiver had no declared desk route and foreign feed welcomes were accepted. |
| 173309.691079Z-32402 | RED: 2 failed/stale refreshes returned undefined rather than explicit failure. |
| 174045.029281Z-40615 | Invalid test UUID; retained as fixture failure, not runtime RED. |
| 174120.841453Z-41185 | RED: first negative readiness lost its refusal after a later request recovered. |
| 174649.814820Z-47020 | 653 passed, 10 failed (obsolete port callers/new fixture arguments); types failed. |
| 174946.254465Z-49976 | 988 passed, 1 failed (old observation welcome fixture); one feed mock type failed. |
| 175113.990251Z-51563 | RED: external step used facade port zero rather than the component's verified peer address. |
| 175301.103251Z-53717 | 1,173 tests / 26 files, architecture and types passed; gate failed only selected coverage gaps. |
| 175715.629799Z-58261 | RED: scroll performed the unnecessary receiver refresh; empty/oversized requested machine IDs admitted a feed. |
| 180213.946667Z-63871 | 917 tests / 15 files passed; all selected core/services files 100%; type failed only a new test's inferred never[]; remaining lib branches unfilled. |
| 180734.640883Z-69364 | 24 relay tests and types passed; narrowed coverage omitted old lifecycle callers and failed. |
| 180925.395108Z-71377 | 30 relay tests / 2 files passed; relay.ts 100% per file. |
| 181150.335497Z-73767 | 129 feed/caller tests / 3 files and final types passed; sessionFeed 100% statements/functions/lines, 223/224 branches (99.55%). |

Unchanged passing per-file coverage from 175301 is retained for the new desk
protocol/client, requestOnce and the adapter/core/cohort files not changed afterward.
The corrected Devices/WiFi callers use 180213; reachable relay lifecycle coverage
uses 180925. `daemon.ts` and `overGateway.ts` changes are type-only; the latter's
actual callers passed in 175301. No failed coverage gate is reported as passing.

The sole uncovered sessionFeed branch is the retained duplicate barrier-release
guard. Real ownership transitions remove a barrier from the map before queuing or
releasing it; physical close clears the remaining map. Keep its defensive credit
protection instead of manufacturing an impossible library state. Root reviewed
the removed empty-deadline/redundant entry checks and native Promise settlement.
All required core/services/harnessd per-file coverage remains 100%; the library
branch limit is explicitly 99%, not represented as full branch coverage. Packaged
mixed composition and the earlier complete-view full-refresh performance hold
remain open.


## Packaged d59 evidence and selection correction

The once-only six-case run on the unmodified d59 artifact returned actual exit 1:
five passed and one failed, with three unrelated cases skipped. The five passing
subcases were both Store Create modes, default cohost desk/Stop/questions,
all-inline desk/Stop/questions, and Wi-Fi-external / Devices-inline gestures plus
one held hello after the worker restart. Their exact source is the frozen d59
fixture, not this later selection correction.

The sixth case failed before its gestures at the explicit assertion that no Wi-Fi
service connection existed. The selector intentionally treats `devices` as the
whole host; source `servicePlan.ts` and the existing `services.spec.ts` assertion
confirm it starts devices, wifi and machineAddons. Remove that unsupported inverse
native case and retain unit-only coverage; do not change the runtime selector or
reinterpret the original packet as passing. No repeat of the five passing cases is
needed for this fixture-only correction.

Packet: `/tmp/core-wifi-desk-native-d59f36ad98`; 171 observed owned PIDs were absent,
actual runner exit and both EOFs settled, zero forced signals/timeouts, zero fixture
roots or cohort claims. The failure's private root and log remain for review. Full
refresh performance and Windows remain unaccepted.


Independent verification (`independent-verification.json` in that packet) rehashed
12,435 source/dependency files and all 528 cohort files, checked the artifact and
runner/log receipts, and proved all 171 observed PIDs and 38 groups absent. It
explicitly records `verified-failed-packet`; the original failure is not relabeled.

The combined core gate's sole same-task coverage miss was deviceDesk's default
logger, previously replaced by injected log callbacks in its failure tests. A real
throwing step and scroll now prove the fixed public DESK_FAILED log, no private
error text and no repeat effect without an injected logger. The narrow gate passed
6 deviceDesk tests with 100% per-file coverage plus fixture/test types:
`.harness/validation/20261118T183050.853858Z-3928/receipt.json`. No runtime code or
native rerun was needed.
