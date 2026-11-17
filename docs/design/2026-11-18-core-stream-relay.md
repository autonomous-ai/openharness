# One client-stream relay

Status: runtime implementation approved after observed RED on 18 November. Integration baseline:
`0c190a62ae26d614d975d7c20f31762d07b2e4aa` (contains main `3c6d4aad5c`).
This finishes the stream portion of package 2 in [the core plan](2026-11-15-core-plan.md#2-the-agent-browser-out-of-the-core).
It changes no Browser feature. The two accepted refusal-order differences are recorded below. Focused tests may run
with one worker; native and performance validation wait for the integration owner's scheduling.

## Boundary

Both existing consumers use one core relay: HTTP/WebSocket viewers and Agent Browser screens. The relay owns only
the connection which asked, the service incarnation which may answer, outstanding requests, stream ownership,
transport bounds and cleanup. It does not know HTTP, VNC, browser readiness, Podman, viewer origins or stream profiles.
The services retain validation and protocol policy. Gateway retains E2EE and route selection. No service chooses the
recipient of screen bytes. No command supplied by a stream service runs in core.

The replacement deletes `core/browserStreams.ts`, `core/agentBrowserLink.ts`, the stream portion of
`core/viewersLink.ts`, `AgentBrowserPort`, `CoreApi.clients.browserFrame/browserBytes`, and the Browser-specific
socket/gateway-link events in the same change. `core/viewerStreams.ts` is replaced by `core/clientStreams.ts`. The viewers'
forwarding-target cache and agent following stay in their current link until their own extraction; no unrelated
Store changes are included. Client spellings and existing response payloads are declarations, not callbacks loaded
from a service into core. The compatibility rows below must be resolved before implementation.

## Existing callers and authority

| Caller/path | Current responsibility | Destination |
| --- | --- | --- |
| `localWsServer.ts` -> `BackendSocket.dispatchDown` | Local socket/Host/Origin/credential gates; real connection identity | Unchanged transport gate; one shared stream dispatcher after it |
| Gateway -> `gatewayLink.ts` -> `BackendSocket.dispatchDown` | Authenticated E2EE identity, role, guest identity; guest default deny before streams | Unchanged transport authority; payload never supplies the asker |
| `viewer_surface` in `backendSocket.ts` | Owner gate, asynchronous reply, `VIEWER_UNAVAILABLE` catch | Existing bounded request path; same wire, service-owned renderer |
| `viewer_*` in `backendSocket.ts` | Owner-only, known down-types only; unknown viewer-prefixed types swallowed | Declared client frames into shared relay; same unknown-type behavior |
| `core/viewerStreams.ts` | Immediate unavailable close, rendered-surface fallback, connection cleanup | Shared relay, both consumers |
| `core/viewersLink.ts` | Stream first-start holding, per-service socket backlog, send failure to service; service notices currently name a connection | Shared relay; bind viewer output to the connection/stream admitted by core |
| `services/viewersProcess.ts` | Stream event/notice adapter and core-disconnect cleanup | Shared service-side stream adapter, with the viewer protocol remaining in its process |
| `services/viewers.ts` -> `ViewerForwarder`/`ViewerWire` | Agent/origin/path/method/header checks; HTTP child connection; credit, half-close, timeout | Unchanged process, same policy |
| `agent_browser_open/ack/close` in `backendSocket.ts` | Special dispatch after guest gate | Same shared dispatcher as viewers |
| `core/browserStreams.ts` | Owner admission, last-published Browser readiness, pending opens, UUID uniqueness, ownership, unread bytes, all close paths | Generic ownership/bounds into shared relay; feature admission must leave core (decision below) |
| `core/agentBrowserLink.ts` | `streams` capability, current-link reset, binary input framing, notices, routes, saved-state/legacy-row wake | Shared service transport; Browser adapter and dated rollback handling in service; shared saved-state wake |
| `services/agentBrowserProcess.ts` | Own connection generation, stream events, per-client cleanup, old-core adapters | Shared adapter; preserve generation checks and dated old-core adapter |
| `services/agentBrowser.ts` -> `BrowserStreamManager` | Owner check, readiness, 4 viewers/agent, spawn, RFB/credit/pacing, product counters | Unchanged Browser process; authority predicate moves out of core |
| `localWsServer.ts`/`gatewayLink.ts` -> socket binary input | Decode local envelope; current code re-encodes Browser input in `agentBrowserLink` | Preserve original local bytes through generic binary input; inspect routing header only |
| Browser service -> `serviceLinks.receiveBinary` -> `browserStreams.bytes` -> `sendTerminalBytes` | Current service-connection gate; inspect header, route by owned UUID, send original bytes | Shared relay, same raw `Uint8Array`; no payload decoding or re-framing |
| `gateway.ts` -> Browser route/lost/error events | Pin screen to selected direct/TURN/relay transport; a lost VNC chunk cannot resync | Gateway emits trusted stream control into shared relay; only gateway can originate it; Browser service interprets it |
| `serviceLinks.ts` | Replaced links cannot send notices/binary or settle requests; delayed query checked against captured connection | Remains the service-incarnation authority; relay also clears grants on replacement/disconnect |
| Core shutdown, local close, remote disconnect/revoke, relay loss | End the connections' streams and pending requests | Single relay cleanup entry point; no stale callback can recreate a stream |

The shared relay must not trust a service-supplied `connId` as authority. For a viewer the existing client-selected
`streamId` is scoped to its admitted connection; the same ID on another connection is distinct. For Browser, a reply
must settle the same connection's pending `requestId`, then bind a lower-case UUID once. Reusing an owned UUID closes
the original and refuses the new open, as today. Binary output names only that UUID; the relay derives its recipient.
Every grant also belongs to the current service connection. A delayed answer from a replaced service must not settle
a new request with the same client request ID.

## Proposed transport shape

1. A single immutable declaration maps existing client frame names to a service, opening/continuing/closing frames,
   response names, admitted audience and existing bounds/fallback payloads. It contains no executable service code,
   Browser-state predicate or target URL. Both services consume the same dispatcher and connection cleanup.
2. The relay binds an admitted opening to an opaque internal handle and service incarnation. Client-selected viewer
   IDs bind immediately; Browser's server-selected UUID binds only to its correlated open result. Replies/controls
   are accepted only under that grant. Public IDs and JSON payloads do not change.
3. The shared service-side adapter gives each service its existing frame/bytes/closed operations and sends replies
   through its grant. Inline debugging uses the same adapter and scope invalidation; no alternate policy remains in
   core. The integration baseline positively admits immutable same-cohort workers (worker contract 1), so the new
   private transport needs no speculative older-worker adapter. Public client compatibility is independent of that
   admission and remains unchanged except for the approved distinctions below.
4. Raw screen frames keep their existing local envelope. Local and gateway ingress retain that buffer beside the
   validated header. Core forwards the buffer unchanged, with existing ownership and size checks. Gateway's existing
   encryption envelope is outside this constraint; no new JSON/base64 wrapping of binary screen payloads is added.
5. Route changes are trusted transport controls under a stream grant. Client JSON cannot select their type/source.
   Browser chooses pacing and ends streams on route loss/rate errors in its process. Viewers use the same transport
   failure/closed path; they do not gain a new route-pinning policy.

### Exact shared contract for review

The composition root constructs **one** relay with both declarations. No Browser constructor, port slot or dispatch
branch remains. The core interface is:

```ts
interface ClientStreamRelay {
  frame(connection: string, type: string, payload: Payload, asker: Asker): boolean
  binary(connection: string, framed: Uint8Array): boolean
  closed(connection?: string): void
  connected(service: string): ServiceStreamSink
  disconnected(service: string): void
  control(source: string, service: string, grant: string | null, payload: Payload): void
}
interface ServiceStreamSink {
  // The closure captures the service incarnation; the service cannot supply or replace it.
  frame(grant: string, type: string, payload: Payload): boolean
  binary(framed: Uint8Array): boolean
}
interface ServiceStreamEndpoint {
  // Connection identity and the grant are transport metadata, never read from client payload.
  frame(grant: string, connection: string, type: string, payload: Payload, asker: Asker): boolean
  binary(framed: Uint8Array): boolean
  closed(connection?: string): void
  control(grant: string | null, payload: Payload): void
  refused(grant: string, streamId?: string, connection?: string): void
}
```

An immutable declaration in the shared daemon service contract names the existing frame types, their service,
audience, ID form, open/result/close/ack roles, fallbacks, numeric budgets and binary wire kind. It cannot publish a
handler, readiness condition, executable predicate or arbitrary target. Declaration validation rejects duplicate
frame/binary owners, a reply claiming a session/terminal frame, absent closing behavior or invalid budgets. Both
`ServiceStreamSink` and endpoint registration are service-scoped; unscoped `coreApi` cannot select another service.
Service replacement invalidates the old sink before issuing a new one. Inline disable does the same.

The relay's random opening grant is private. Browser's internal request ID is that grant; its public `requestId`
is restored only on the final reply. This prevents a late answer to a timed-out request settling a later reuse of
the same public ID. The returned UUID binds the grant once and routes binary output. For viewers the grant is the
private stream ID; every public frame restores the original client-selected ID. A duplicate live viewer request
reuses the same grant so `ViewerForwarder` keeps its existing duplicate-close behavior. The service still receives
a stable connection identity, so its 64-stream per-connection limit is not accidentally changed into a per-grant
limit. Two clients selecting the same public ID get distinct grants. Translation copies the small payload object
and shares the existing base64 string; it never decodes or re-encodes viewer data. This allocation must be measured.

Unknown/invalid public IDs keep their existing silence, except that a valid viewer ID with no serving process is
still closed immediately as today. A service output naming a grant it was never given, a revoked grant, another
service's grant or an old sink never reaches a client. Viewer halves are tracked independently: its grant leaves
after both `viewer_end`s or a `viewer_close`; a client close is never echoed back. Browser close removes its grant
only after the service's close or an authoritative transport failure, preserving the existing close handshake.

The generic `control` entry is called only by the authenticated gateway link, checked against the declaration's
control-source allowlist; it is not a client JSON frame. A stream-scoped route event requires its live grant.
The existing machine-wide relay rate refusal remains a service-scoped control with no grant, allowed only from
gateway; Browser decides which of its relay/unknown-route streams end. Core neither understands that route policy
nor scans all streams to implement it. Route payloads are capped at 256 encoded bytes and never buffered/replayed.

The metadata budgets below are provisional validation targets, not final numerical acceptance. They protect the shared
core even if a service stops enforcing its own limits. Existing viewer ceilings remain the same; Browser gains
generous aggregate ceilings that did not exist in its old core relay. Capacity denial uses the existing
VIEWER_LIMIT / "Too many viewer requests" reply, never a new client error.

| Retained resource | Global | Per service | Per connection |
| --- | ---: | ---: | ---: |
| Pending + live stream grants | 2,304 | Browser 2,048; viewers 256 | Browser 256; viewers 64 |
| Unanswered opens, including viewer opens held for first start | 768 | Browser 512; viewers 256 | Browser 8; viewers 64 |
| Retained ID/key UTF-8 bytes (requests, connections, public/private stream IDs) | 9 MiB | Browser 8 MiB; viewers 1 MiB | Browser 4 MiB; viewers 256 KiB |
| First-start held frame bytes | 4 MiB | 4 MiB | Within the same shared queue and own grant limit |
| First-start held frame count | 4,096 | 4,096 | Within the same shared queue and own grant limit |

Every completed/rejected opening, close, timeout, failed send, connection close and service replacement returns its
count and byte reservations once. Empty connection indexes are deleted. Limits count pending and active together,
so a reply cannot turn one reserved slot into two or bypass the global cap. A declined duplicate does not allocate.
First-start hold byte accounting uses serialized UTF-8 byte length; an additional frame-count cap bounds
object overhead even with tiny chunks. No new queue exists on the hot path after the first connection.

Service reservations are independent: Browser cannot consume viewers' grant, pending, metadata or queued-byte share.
Their sum is the global bound. Validate actual retained state/RSS at 1/16/160 agents, 1/4 total streams and saturation
before accepting these metadata numbers. No claim of measured headroom is made yet.

Screen ingress preserves `decodeTerminalLocal`'s version/magic/kind/flag/size checks. Routing reads a validated header
but forwards the original buffer. The in-place header reader is shared by local ingress and the core relay; it does
not copy payload bytes. Core acceptance retains the existing 512 KiB framing-payload limit (24 bytes of stream
metadata included), uncompressed flags, and 1 MiB unread backstop. The Browser service still normally emits
32 KiB chunks; that normal production chunk size is not a new core rejection rule. That logical unread count retains no screen payload and gains no aggregate ceiling: sixteen normally
delivered 256 KiB windows must not be refused as if their bytes still occupied core's socket queue. Viewer credit
remains entirely in its service. Core never parses base64 content, including padding.

The accepted queue bound is the existing 4 MiB budget **per service per direction**, with independent Browser/viewer
shares (8 MiB global per direction). At the existing `localWsServer` sink, serialize JSON once as today, reserve its
actual encoded byte length before `ws.send`, and release exactly once on send completion/error/connection close.
Raw binary reserves its actual framed length. A callback from a closed incarnation cannot credit a new connection.
`serviceLinks.notify/notifyBinary` and local client sends carry the relay-selected quota; neither a client payload nor
a service notice selects its tag. Gateway traffic counts the actual encoded core-to-gateway envelope. This needs no
broker, timer, poll, per-chunk credit queue or second serialization. Existing private socket/channel backstops remain.
A rejected send closes/refuses its stream through the existing wire error path. A malformed data frame remains the
viewer service's job. No caller selects a larger binary ceiling by forging a kind, flag or stream ID.

## Admission decision and exact compatibility differences

The current synchronous Browser preflight is feature policy in core. It reads the `browser` display field to choose
NO_BROWSER versus NOT_READY. The external link's disconnect does **not** clear that projection: `frameParts` checks
`serviceHost.isOff`, not external connectivity. Consequently an unavailable Browser can answer differently per agent.
Moving that check into a generic descriptor (`browser.state === ready`) would retain the policy we are removing.

| Situation | Current exact behavior |
| --- | --- |
| Open has no string `requestId` | No reply and no service call |
| Same connection/request is pending already | Ignore duplicate; the first answer settles it |
| Local/account owner predicate fails (after guest default deny) | `{requestId,error:'NOT_OWNER'}` immediately |
| Port absent, invalid/missing agent ID, or no published Browser field | `{requestId,error:'NO_BROWSER'}` immediately |
| Published Browser state other than ready | `{requestId,error:'NOT_READY'}` immediately |
| Ready projection, but service disconnected/not stream-capable/full socket | `{requestId,error:'NOT_READY'}` immediately |
| Ready projection and service available | At most 8 pending per connection; 10-second reply deadline |
| Service replies with absent/invalid UUID, foreign request, duplicate UUID | Existing refusal/unwanted-stream cleanup; never reroute an old screen |

**Reviewer decision, 18 November:** Browser alone makes readiness decisions in its service, using its existing
`BrowserStreamManager.open` checks. A missing/non-capable/disconnected service answers NOT_READY in line through
the shared declared fallback; no open wakes or queues the Browser process. An explicitly disabled/absent service
keeps NO_BROWSER when the shared service-host off state establishes that without an agent-state read.
The transport's declared audience still
refuses non-owners before dispatch, and the Browser service checks the authoritative asker again. This changes the
disconnected/no-projection row from NO_BROWSER to NOT_READY, while the current ready-projection row stays NOT_READY.
For a connected service, absent/not-ready agents still return their existing NO_BROWSER/NOT_READY, now after one
local service hop. Pending admission occurs before that hop: under more than eight simultaneous unanswered opens,
the relay refuses further opens VIEWER_LIMIT even if the service would ultimately refuse their agent as absent.
The reviewer accepted this precise overload-order difference, preserving the existing eight-open bound. The test
holds eight invalid-agent opens unanswered, checks the ninth gets VIEWER_LIMIT, settles/closes them, and then proves
a valid open can succeed. This is not an exact-byte preservation claim for that overload sequence.

The concrete client impact is small but real at the protocol level. `desktop/lib/browser/browser_stream.dart`
passes either refusal through unchanged as `BrowserStreamError`; `browser_panel.dart:325` sends both NO_BROWSER and
NOT_READY to the same `_wait()` path. Its 20-second open timeout stays above the relay's 10-second deadline.
`VIEWER_LIMIT` instead displays a non-retrying "Browser is open in too many places" message; therefore the changed
overload ordering needs explicit acceptance. The actual panel opens one stream at a time. Current mobile contains
no `agent_browser_open` reader. `cli/src/agentClient/browser.ts` uses `agent_browser_run`, not the screen open, so its
NOT_READY/state formatting is unaffected. Golden protocol tests must record the approved changed row separately;
success, close, binary and all other refusal payloads stay byte-for-byte.

No per-agent admission projection, duplicate readiness map or Browser-state descriptor is added to core.

The last-30-day census searched current production files and reachable history since 2026-10-19 with
`agent_browser_open|NO_BROWSER`. The public screen protocol first appeared in `725056e402` (2026-11-10); its original
`BrowserPanel._refusedOpen` already grouped NO_BROWSER and NOT_READY. No later reachable commit changed that grouping.

| Reader since 2026-10-19 | What it reads | Effect of unavailable error change |
| --- | --- | --- |
| `desktop/lib/browser/browser_stream.dart` | Correlated request ID, error string, stream ID, close reason, binary ID | Both codes propagate unchanged; 20-second deadline unchanged |
| `desktop/lib/browser/browser_panel.dart` | Error code and stream lifecycle | Both codes call `_wait()` in the initial implementation and current one; VIEWER_LIMIT remains non-retrying |
| `desktop/lib/e2ee/envelope.dart` | Allowed frame type | Same names, unaffected |
| `cli/src/lib/remoteRelay.ts` | Open request ID and optional returned stream ID to pin a route | Error text opaque; no stream ID means no route binding |
| `cli/src/gateway/gateway.ts` | Request ID, stream ID, type, local envelope kind | Error text opaque; failed open still settles its route bookkeeping |
| `cli/src/lib/e2ee/applicationFrames.ts` | Frame allowlist | Same names, unaffected |
| `backend/src/lib/terminalRelay.ts` | Type, sealed frame size and rate | Cannot read sealed error text; unchanged bytes/type envelope shape |
| `cli/src/agentClient/browser.ts` | Browser command result, not screen-open result | `agent_browser_run` remains unchanged |
| `desktop/lib/measurement/product_measurement.dart`, `backend/src/types/productUsage.ts`, CLI usage contract/report | Successful browser-open product counter | Not an open-reply reader; success counter unchanged |
| Mobile, device app | No screen-open/error reader found in current files or reachable 30-day history | No change |

Viewer readers (`viewerForwarder`/`viewerWire`, Desktop viewer proxy and `viewer_surface`, remote relay and sealed
frame allowlists) retain their exact public request/reply/close behavior. No new viewer client protocol is introduced.

## Bounds and existing counters

| Boundary | Existing bound/policy to preserve | Evidence |
| --- | --- | --- |
| Browser opening | 8 unanswered/connection; 10 seconds; timer unref; duplicate request ignored | Golden refusal/duplicate/timeout tests |
| Browser screen | Core ceiling 1 MiB unacked; service pause/resume 256/128 KiB; 32 KiB chunks; stalled ack/banner 10 seconds | Ownership, malformed-header, overrun, stalled consumer, same-buffer tests |
| Browser input/send failure | End `agent` on failed input; end `backlog` on failed output; never skip a chunk and continue | Local and remote stream fixture |
| Browser service | 4 viewers/agent; existing relay/TURN pacing and direct profile; 1-second child kill grace | Existing service tests; counters unchanged |
| Viewer first-start queue | At most 4 MiB measured as existing JSON string length; existing ON_DEMAND_START_MS; stop holding after first connection or failed start | Queue, close-before-start, timeout, replacement tests |
| Viewer service socket | Refuse once buffered amount exceeds 4 MiB | Existing unavailable close bytes |
| Viewer wire | 64 streams/connection, 256 service-wide; 128 KiB credit; 32 KiB chunks; 30-second timeout; 16 KiB path; 32 KiB headers | `ViewerForwarder`/`ViewerWire` tests retained |
| Surface | 20-second service wait; request remains outside ordered terminal input queue | Existing surface fallback/native test |
| Service/socket ingress | Existing JSON/binary message-size checks and current-link authentication | Gate tests retained |

`agent_browser_stream_opened` remains emitted by `BrowserStreamManager` after opening, exactly once.
`agent_browser_stream_closed_<reason>` stays at its single end path. Other Browser product counters stay in
`services/agentBrowser.ts`; `agentBrowserProcess` still asks the generic `count` query. Viewer forwarding adds no
product counter. Diagnostic measurements contain counts/bytes/durations only, no IDs, URLs, headers or screen data.
The relay's once-per-service-incarnation malformed-frame warning remains bounded.

## Wake and deletions

Saved-state wake reuses the existing state-file wake mechanism with Browser **and** the existing experiments as
actual consumers. No Browser-specific file probe remains in core. Legacy row `browser:true` still wakes the service
through 2026-12-18, including an old Desktop's create after startup. Its replacement must be a declared legacy
agent-observation wake shared with the viewers' existing `dsh` observation; core interprets neither feature value.
The viewers' target integration keeps an empty packaged startup asleep until real demand; built-in packages alone
are not a reason to wake it. Root owns the corresponding native helper corrections.

Delete the old ports/callbacks, import-closure entries and direct Browser route switch cases in the same commit as
both consumers move. Keep `core/terminals/browser.ts` and `lib/browserShim.ts`: they are the unrelated sign-in shim.
Do not delete the dated registry field or old-client migration early. Internal protocol fallback belongs wholly
to the service process; no new fallback that loads a Browser implementation into default core is allowed.

## Design (docs/feature-design-rules.md)

Reviewed revision: this document on 18 November. Reviewer: integration coordinator. Admission, shared private grants
and queue backstop approved; metadata numerical acceptance remains pending measured evidence.

1. **Growth.** All new relay state is volatile: pending opens leave on answer, timeout, connection close, service
   disconnect/replacement or shutdown; active grants leave on close, failed send, limit, connection/service loss or
   shutdown. Recreated request IDs get a new grant. First-start queued frames leave on start, deadline or connection
   close. No archive, database, poll, per-agent admission projection or new durable file.
2. **Concurrency.** Mutations are synchronous on the core loop. Every asynchronous settlement captures both request
   grant and service incarnation. Service replacement revokes before new traffic is admitted. Per-connection IDs
   cannot name another connection's grant. Gateway controls carry trusted source, never a payload claim.
3. **Read cost.** A stream frame uses indexed ownership lookup. Screen byte payload is neither decoded nor copied by
   relay. First-start JSON serialization remains only on the bounded hold path. Closing a connection iterates that
   connection's grants; closing a service iterates only its grants. No scan of all agents per stream byte.
4. **Scale.** Fixed workloads cover 1/16/160 agents, two clients and 1/4 concurrent streams, then existing admission
   limits. First warning is core CPU per forwarded MiB, unread/queued-byte high-water and terminal echo p95. Report
   process/core/total CPU, RSS and latency; do not equate fewer source lines with runtime improvement.
5. **Compatibility.** Public reader search includes Desktop Browser panel, viewer forwarding/rendering, phone/web
   viewer transport, `harness browser`, gateway/local socket, and service rollback adapters. Their JSON spellings and
   kind-8 bytes stay identical. The two admission-order/unavailable distinctions above are explicitly accepted.
   Public Browser lifecycle/row compatibility expires 2026-12-18 independently of worker contract 1. The positive
   same-cohort admission already present on the integration baseline lets this private stream protocol replace its
   old transport outright; no second private protocol is added.
6. **Migration/rollback.** No durable schema change or production-data migration: N/A for production restore. The
   Browser lifecycle/on/off migration is existing work, untouched. Revert restores old runtime ports without changing
   saved Browser/viewer data. A disconnect drops ephemeral streams and clients reopen; no stream is replayed.
7. **Audience.** Local authenticated connection or gateway-proved owner per existing predicate; guests remain default
   denied. Core derives outbound recipients from its grant. Data copies exist only in current bounded transport
   buffers and the owning viewer/Browser process. No screen or private viewer payload is logged or broadcast.
8. **Identity.** No new command or identity path. Guests cannot open the owner's Browser/viewer; no fallback to the
   owner's execution identity. Browser's existing own-process Podman and viewer's loopback target checks remain.
9. **Failure.** Preserve named refusal/close frames above, existing viewer errors, timeouts, unavailable surface
   reply, once-per-incarnation malformed warning and service supervisor states. A failed/opened stream is never
   retried by core; the client chooses reopening. Cleanup is idempotent and does not replay input.
10. **Platforms.** Core relay affects macOS/Linux/Windows and existing local/remote clients. Native Mac and Linux
    exercise fake Podman plus actual private daemon/loopback transports; Windows exercises viewers and explicit
    Browser-unsupported behavior. Actual availability is reported, never inferred from unit tests.

## Validation picked before implementation

First add golden behavior/authority tests against baseline for both protocols, including the preflight table,
pending correlation, duplicate UUID, same viewer ID on two connections, foreign service/connection, replaced link,
invalid/oversize binary, failed send/input, queued startup, close before startup, and exact terminal byte buffer
identity. Red tests must assert the new shared boundary and deletion, not duplicate its implementation.

Then run affected unit tests, TypeScript, architecture closure, `npm run test:core` at 100% per changed core/service
file, and `npm run test:harnessd` if the declaration/wake changes touch that area. Native: private packaged daemon,
`agentBrowser.e2e.ts`, `viewersProcess.e2e.ts`, affected viewer-on-demand cases, service crash/replacement and local/
remote ownership tests. Do not use the owner's daemon, login, Podman or tmux. Root schedules all native/cost runs.

Cost baseline/candidate use the same pinned Node, packaged toolchain and fixed quiet ABBA workload: fresh empty
startup; idle 1/16/160 agents; sustained 32 KiB Browser frames with ack at fixed byte intervals; HTTP viewer upload/
download and stalled consumers; simultaneous terminal echo. Compare CPU per MiB, core and total RSS, startup/first
stream/warm stream latency, echo p95 and queued-byte peaks. Keep failures and all runs; no extra run merely to improve
the mean. Existing Browser perf notes record a previous +80% CPU from reframing; buffer-identity assertions and
actual per-byte measurements are both required. Acceptance remains pending until the coordinator reviews evidence.

Observed baseline evidence: pinned Node 24.22.2, integration `0c190a62ae`, one worker. All four new public compatibility
goldens and the 31 existing Browser cases pass. The new admission behavior test fails at "expected stream called
8 times, got 0", proving core still makes readiness decisions: 35 passed, 1 intentional failure, 3.31 seconds.
Log: `/tmp/core-stream-relay-red.log`. No runtime file had changed for that run.


## Implemented transport decisions under validation

- The shared declaration chooses the existing `target` or `terminal` gateway door. Viewers retain `target`'s
  backend-link requirement; Browser retains `terminal`'s pinned P2P/relay route. No Browser route enum or predicate
  remains in core; bounded transport facts enter through generic gateway stream control.
- Queue refusal toward a service revokes that authenticated link immediately, then its existing WebSocket owner
  closes it with 1013. Queued bytes remain charged until a send callback or physical socket close releases them.
  Unregistering a client or replacing a service never resets the server-wide counters while its old bytes remain.
- Actual transport queues also reserve one frame slot, up to 4096 per service/direction, independently of the
  4096 held-startup limit. A valid empty binary packet is 36 bytes; the byte limit alone would permit 116508
  retained callbacks per share. The new frame budget bounds that metadata while admitting the 127 complete 32 KiB
  payload frames that fit 4 MiB, plus a full 512 pending-open and 2048-grant close burst. Bytes and frame slots release
  together, exactly once, from the existing callback/physical-close owner. There is no separate control reserve.
- A failed data send to a client first revokes/refuses its grant. If the final close/refusal frame also cannot be
  queued, the existing socket owner closes that one client connection with 1013. Other connections and independent
  service reservations remain usable. There is no control reserve, credit queue, or added retry policy.
- Inline debugging and Harness OS use the same service-side grant adapter, guarded by the existing service host.
  Browser's runtime port exists only inside its component; core retains no Browser port. Viewers' core port now
  contains forwarding-target and rendered-surface operations only.
- A late old grant naming a UUID already held by a new grant cannot refuse that new stream. Current service
  incarnation, connection owner and private grant must all match; public request IDs alone grant no authority.
- The old implementation files and private adapters are deleted together. The public Browser row/lifecycle
  migration remains independently dated for removal on or after 2026-12-18.
- An initial physical connection does not finish the viewers' first-start wait; its explicit shared-stream readiness
  query does. Traffic in that handshake window keeps the same bounded first-start ordering.
- Viewer audience authorization is checked before duplicate opens and continuations, as the former socket gate
  checked each frame. A new E2EE hello already drops its old session before announcing the replacement
  (`lib/e2ee/manager.ts` `answerHello` / `dropSession`), so existing connection teardown revokes all old grants.
  The relay adds no second identity map. A connected unsupported Windows Browser answers `NO_BROWSER` in its own
  component, preserving the old immediate refusal without a Browser predicate in core.
- The session OAuth browser callback still uses the gateway's `target` door through `sendTargetFrame`; the
  similarly named experimental Browser screen continues to use its declared `terminal` door.

### Browser safety budget and supported-client census

The Browser's 2048 global / 256 per-connection grants and 8 MiB global / 4 MiB per-connection ID storage are new
explicit safety budgets, not a claimed maximum derivable from all previously legal workloads. Exhaustion uses the
existing `VIEWER_LIMIT` reply; closing old work returns the reservation and permits a new valid open. The 512 total
unanswered opens retain the existing 8-per-connection bound. Acceptance of these provisional numbers still depends
on the coordinated saturation and retained-state measurements, separately from the normal 1/4-stream samples.

| Supported source | Observed bound / behavior | What it does not prove |
| --- | --- | --- |
| `lib/e2ee/manager.ts` `MAX_SESSIONS` | 64 remote encrypted sessions | No bound on additional authenticated local sockets |
| `services/agentBrowser/streams.ts` | 4 screen viewers per agent | No global agent or stream maximum |
| `desktop/lib/browser/browser_panel.dart` | Only visible panels stream; hidden/disposed panels close; one open per panel | No daemon-wide client count |
| `desktop/lib/state/pane_layout_store.dart` | Current desk layout has 9 panes | `AppNotifier.maxPanes` still supports a 64-pane ceiling |
| `desktop/lib/browser/browser_stream.dart` | Generated short request ID, 20-second client deadline | Protocol itself did not bound retained request-ID bytes |
| `localWsServer.ts` | Public JSON frame ceiling 512 KiB | No global local connection cap |
| `lib/viewerForwarder.ts` / `lib/viewerWire.ts` | 256 viewer streams globally, 64 per connection | Browser has different admission and separate reservations |

The attribution fixture therefore includes 64 × 64 remote-panel attempts plus one overflow, held pending opens,
large legal request IDs, and first-start frame-count and UTF-8-byte saturation as distinct cases. It must report
accepted/refused counts, pre-overflow retained state, and recovery after cleanup. It cannot establish native daemon
RSS or terminal echo latency; those remain the separate packaged validation gate.

Focused test logs are work-in-progress evidence, not the final validation gate. The 0c190a62 baseline reproduces
17 existing BackendSocket fixture failures; these are recorded separately from shared-boundary regressions.
Metadata reservations remain provisional until the coordinated state/RSS and fixed-workload measurements.

Current validation: the readiness/audience/Windows cases were observed RED (3 failures), and the registered local
socket quota case was independently RED. The following focused run passed all 202 cases, including actual loopback
socket saturation, physical-close ownership, late callbacks and service cleanup. The new shared boundary files then
passed 90 tests at per-file 100% statements/branches/functions/lines. TypeScript passed. A full core/services run
passed 5614 cases and exposed two obsolete test expectations (optional transport quota and deleted inline exports).
Both were corrected and passed in the following 43-case focused run, together with the new frame-count and byte
quota regressions; the transport queue reached per-file 100% coverage. No measurement has yet been run from the
new attribution fixture. The final combined full gate remains the integration owner's responsibility.
