# One local-window transport

Approved extraction design. Implementation starts from the combined baseline b7945879a6; prior shared-facts and packaged cohost evidence remain immutable.

## Before extraction: callers and authority

- `CoreApi.clients.sendLocal` allows the eight existing DEVICE_WINDOW_FRAMES; devices uses it for dial open/read/fork/focus/scroll/status and voice palette requests. The integration branch retains dial_swarm in this eight-frame wire set; preserve it exactly. Its spelling does not prove that product feature behavior remains or authorize a wire-contract change.
- `CoreApi.clients.sendToWindow` allows only dial_selection/dial_visit/dial_form. Both APIs exist on the real devices component, its process adapter, and the core devices link. Process calls are notices: a bridge deadline, not the notice's return value, establishes whether its window replied.
- `CoreApi.wifi.focusApp/reveal` and `wifiLink` currently construct device_focus/device_prepare_open inside core. The process adapter already fences these notices with its verified component/machine/core binding. Focus additionally requires lastView's current owner and hasWindow. Reveal is deliberately permitted without a lastView/hasWindow assertion; Store retries its durable UI intent until acknowledged.
- `BackendSocket.sendFirstLocal` owns insertion order in localClients, excludes toolClients, removes a failed sink and tries the next sink synchronously. It does not call the gateway, queue, broadcast, or return a window identity. This authority stays in core transport.
- `BackendSocket.sendLocal` is also used by ordinary core/app events. Its question-protocol transformation, toolWatches feed, and dial_status watchers must remain byte/behavior compatible. Replacing this general backend method is unnecessary for this slice.
- IMPORTANT: exact-connection delivery is NOT equivalent to BackendSocket.sendLocalTo. `localWsServer.windowSinks` owns the raw physical socket and deliberately bypasses terminalSink's suppression of dial_selection/dial_visit/dial_form. It also includes a local Desktop displaying a remote machine, which is absent from backend.localClients. Existing localWsServer tests around lines 438-471 prove that such bridge requests stay on this desk while upstream gestures are suppressed. Replacing this authority with localClients would break real devices.
- `localWsServer.windowSinks` currently contains selected tool sockets too. First-window must continue excluding tools via authoritative backend registration. This proposal preserves exact-connection semantics; it does not silently claim that the existing exact-window primitive independently excludes tools. Devices' existing focus/reply authority still chooses its actual bridge recipient.

## Exact replacement API and callers

Replace the two component client methods with one typed method:

```ts
type LocalWindowTarget =
  | { kind: 'all' }
  | { kind: 'first' }
  | { kind: 'connection'; connId: string }
interface LocalWindowDelivery {
  target: LocalWindowTarget
  frame: { type: string; payload: Record<string, unknown> }
}
clients.sendWindow(delivery: LocalWindowDelivery): boolean
```

The boolean means accepted for synchronous handoff, not acknowledged by the app. For local first/exact it is the existing sink result. For process adapters it remains the existing current-link acceptance; final focus or bridge completion still comes from its existing acknowledgement. `all` callers ignored their old void result and continue to ignore this result. No query, await, retry, observer subscription or new request/result protocol is added.

- `services/devices.ts`: convert each actual `sendLocal` caller to target all and each `sendToWindow` bridge callback to target connection. Frame type, payload, order and existing bridge request IDs remain identical.
- `services/wifi.ts`: construct the existing device_focus and device_prepare_open frames in the component using its already verified machineId. Use target first. Remove the two WiFi-only functions from CoreApi.wifi, WIFI_OFF, wifiDoors, wifiLink, wifiProcess and corresponding tests. Store's reveal retry/ack state remains in Store.
- `services/devicesProcess.ts` and `wifiProcess.ts`: send one shared `service_notice` kind `window` with `{target,frame}`. Keep no replay. WiFi's adapter retains the current component/core/machine binding before each send, and the owned-lastView condition specifically for device_focus. device_prepare_open keeps its current binding-only condition. No await is introduced and no new core connection can authorize an old component owner.
- `services/processCoreApi.ts` and ordinary manual process APIs get one explicit unavailable `sendWindow: () => false`; they acquire no arbitrary-frame capability. FakeCore changes with the real interface.
- `core/devicesLink.ts`: remove sendLocal/sendToWindow notice branches. `core/wifiLink.ts`: remove focusApp/reveal notice branches. The single generic notice is admitted before component-specific notice routing, using the service identity authenticated by serviceLinks.accept, never a payload-provided service.
- `core/main.ts`: keep one raw synchronous dispatcher: all -> existing backend.sendLocal, first -> existing backend.sendFirstLocal, connection -> existing localWsServer.sendToWindow. Keep dial_status retention at its existing composition point. A missing transport refuses. No feature payload construction remains in this dispatcher.

## Scope without a new authority/cache

Move the existing devices frame allowlists out of the broad unscoped CoreApi implementation and into the existing immutable SERVICE_HOSTS service declarations, adding target-specific window permission metadata beside existing frameParts permissions:

- devices/all: precisely the current integration DEVICE_WINDOW_FRAMES;
- devices/connection: precisely the three current DEVICE_BRIDGE_FRAMES;
- wifi/first: device_focus and device_prepare_open;
- every other service, or any undeclared target/type pairing: denied.

Use the stateless validator/sender in existing `core/api.ts`. It takes a trusted declaration plus raw transport; it does not keep a recipient, revision, owner map or queued operation. Validate the target discriminant, exact-connection ID, frame object/type, plain payload and allowed target/type pairing before forwarding. Refusal logs only `[services] WINDOW_FRAME_REFUSED`, with no payload or IDs.

The unscoped CoreApi's sendWindow is unavailable. Composition hands only the devices and WiFi inline starts scoped CoreApi client clones; each bound sender receives its trusted declaration. The inline host binds that sender to its existing stoppers entry function identity, installed before the component starts. Revoke that identity before ordinary guarded stop, switch-off and failed/null startup. A replacement gets a distinct stopper, so an old API never revives under the same service name. Preserve repeated stop error/fallback behavior; no additional owner map or feature cache is introduced. A bare isOff check is insufficient. Other inline components get the unavailable method. Out-of-process traffic uses the authenticated service identity and existing serviceLinks connection fence. No public CoreApi method accepts a service name or permission declaration.

A stateless generic service-notice admission path reads the declaration for the authenticated service and calls the same validation/transport function; no factory cache or new lifecycle record is needed. This relocates the existing permissions and lets the shared transport serve two real components. It does not introduce a WiFi-only core operation or per-feature state.

There is no new fanout or queue: all inherits the existing local broadcast, first stops after one successful sink and exact examines one physical connection. Token-authenticated service notices retain the existing MAX_WS_MESSAGE_BYTES transport ceiling (6 MiB + 4096 bytes); localWsServer explicitly exempts an admitted service link from the ordinary client JSON limit of 512 KiB. This is the existing inbound notice bound, not a new per-feature or outbound list bound. No new arbitrary command/raw backend forwarding route is exposed. This does not claim to fix the pre-existing lack of an explicit total local-client count bound.

## RED / compatibility and ownership proof selected before implementation

1. Actual devices component emits identical old frames through all and exact selections; a remote-tab physical window still receives its bridge request, while upstream injection remains suppressed.
2. Actual WiFi component emits the exact old device_focus/device_prepare_open payloads from its verified machine owner. The removed WiFi-only core methods are absent and cannot be the exercised path.
3. Core sender rejects undeclared service, target/type cross-use, arbitrary frame type, malformed target/payload and prototype keys. WiFi cannot broadcast or address a chosen window; devices cannot issue device_focus or device_prepare_open. Unscoped APIs refuse. A stopped inline component's retained sender refuses.
4. Actual backend transport: zero windows false; tool-only false; tools inserted first never receive first-window; first healthy window only; failed first sink removed and second healthy window receives once; no gateway/tool-watch replay. A closed old first window is never selected via a stale component claim because the component supplies no window ID.
5. Actual local socket: exact connection preserves physical socket routing while showing a remote machine, no relay-side delivery, closed exact recipient refuses; existing bridge reply machine/connection rules remain unchanged.
6. Process adapter controls: same reused CoreConnection reconnect, stale lastView, reconnect before identity handshake, changed machine/component, disconnected and stopped all refuse old WiFi effects. A verified same-machine new owner may send fresh work; same-machine durable Store reveal continues, and no sent transient request is replayed. Existing fresh focus/Store ack controls remain.
7. Authenticated service notice from a replaced connection cannot invoke the generic sender; adversarial payload `service` cannot switch authority. The actual old component routes are removed, not retained as a second implementation.
8. Source gates: per-file100% for changed core/service runtime files; affected BackendSocket/localWsServer transport behavior, actual devices/WiFi/process callers, existing Store reveal cases, architecture and types. All source gates use validate-change with fixture/process visibility. Parent coordinates any native artifact/timing workload.
9. Native combined fixture: existing six WiFi cases retain focus/reveal/reconnect checks and the frozen b5b cohost proof; add assertions only if current cases cannot observe first-window exclusion/final acknowledgement. No separate build cycle without parent coordination.

## Compatibility and remaining scope

- Resolved from source after the initial proposal: docs/design/2026-11-15-core-plan.md:454 and docs/design/2026-11-18-wifi-relay-extraction.md:28 explicitly replace the private 30-day mixed-worker promise with positive immutable-cohort admission. Coordinator confirms integration WORKER_CONTRACT=3 is still unreleased. Preserve 3 and update only the exact derived WORKER_PLAN after the declaration change; future published breaking semantics require a contract bump. childAdmission.ts checks executed contract/plan literals, and master.ts:507-528 reaps services and admits a matching complete cohort; supported historical rollback runs its own inline composition. Therefore old private window notice branches can be removed together without a fallback. Public app/device frames and Store journals remain byte compatible. Coordinator owns the final contract literal. This approved slice updates WORKER_PLAN to the exact hash of its changed SERVICE_HOSTS metadata and retains positive admission/cohort tests; it must not independently choose another contract/version.
- Declarations live in SERVICE_HOSTS; only the two actual inline consumers receive scoped senders. The shared transport refuses unscoped calls and never grants the union of frame rights to every CoreApi caller.
- The complete external agent snapshot, confirmed cancel, workspace admission and abort formatting remain separate gaps. This slice extracts only the two feature-specific window payload builders, while replacing real devices transport callers with the same primitive.

## Source validation and integration custody

The implementation starts at b7945879a6 and uses the pinned Node 24.22.2 and immutable dependency tree
`/tmp/harness-core-deps-main-86558/node_modules` (lock SHA
`a578fb81a3757cfd14de2c687dfe9b7f687d56f8c0112082edf640245995ea61`). Coordinator fixture correction
925c3aa078 is included as c8f7cb9f98; the window commit itself does not alter those storage fixtures.
WORKER_CONTRACT stays 3; derived WORKER_PLAN is
`ad3cd3af3b497aa0ac8422ed823ff3da403497dc16f4623fc53001ea75645467`.

Behavior REDs precede runtime edits: `/tmp/core-wifi-window-transport-behavior-red.log` records three real
caller/lifecycle assertion failures (inline retained sender, actual WiFi builder, actual devices sender), followed
by `/tmp/core-wifi-window-transport-first-green.log`. An initial wrong-directory loader failure in
`/tmp/core-wifi-window-transport-red.log` is not behavioral evidence. During coverage review,
`/tmp/core-wifi-window-durable-reveal-red.log` caught a verified Store reveal being silently dropped before a
transient view existed: the adapter checked verified identity but its old notice helper checked lastView again.
The sender now uses its already-checked verified binding. Focus still requires a current owned view, and scroll
uses its already-checked view binding. No extra connection, replay, or identity cache was added.

The final selected validation receipt is
`.harness/validation/20261118T062715.978098Z-42184/receipt.json`: 947 runtime cases in 17 files; all ten changed
core/service runtime files have 100% per-file statement, branch, function and line coverage (2861 statements,
1777 branches, 977 functions, 2081 lines). Services and workerContract have 100% coverage, positive child
admission and cohort controls pass, and CLI typecheck passes. The prior receipts retain seven app transport
cases plus 35 architecture cases (`20261118T062248.653867Z-36383`) and three additional exact physical-window
cases (`20261118T062426.564001Z-38525`). Exact routing includes a physical window displaying a remote machine,
closed recipients, and suppression of upstream gesture injection. First-window routing includes tool exclusion,
failed-sink advance and one successful recipient only.

The failed selected attempts are retained: the first had 909/910 runtime cases passing, an invalid-machine
focus assertion corrected to expect the existing INVALID_REQUEST refusal, an integration fixture missing the
existing heldAgentLife declarations, and the new void-return annotation mismatch. The second had all 910 cases
passing but uncovered fallback/probe consumers and the redundant view helper, plus a partial test-port cast
error. These were resolved by the relevant real callers/ownership cases and narrow fixture corrections;
no failed suite is represented as passing. The heldAgentLife fixture now reflects the existing runtime
agentCleanup input and gateway input/purged declarations without changing those declarations.

Platform validation here is macOS source/socket validation. Windows is deferred by the user; mobile is outside
scope. No native build, release, or performance run was executed by this slice. Coordinator integration must
carry the existing six-case packaged WiFi fixture and frozen b5b34143b0 cohost proof in the combined artifact;
this source receipt does not substitute for that packaged run. The pre-existing total local-client bound,
external snapshot transport, confirmed cancel, workspace admission and abort presentation remain explicit
residual work.
