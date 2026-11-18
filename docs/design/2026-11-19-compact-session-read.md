# Compact complete session records

## Design

Root reviewed and approved the fixed labelled tuples and lossless equality marker only on
2026-11-19. V10 remains a performance HOLD. The 19 actual-caller REDs failed on unchanged
integration 85b659e509f2c5e5e9a432f1beabcd07319d2440 before runtime edits. The compact format
is implemented and the selected source, coverage, architecture and type checks are complete.
No native or timing run is authorized here; performance acceptance remains open.

The first correction replaces the repeated nested session-record representation with a fixed,
typed private wire row. It keeps one physical record per member and the existing settled-record
pump. It does not batch members yet: batching would change the exact current-per-emission boundary
or require a lookahead record retained through another send. That needs a separate design if still
necessary after this smaller correction. No core catalog, retained mirror, global schema registry,
dictionary, cache, broker, optional trust flag or component presentation policy is added.

### Evidence and the work this addresses

Frozen V10 candidate is d59f36ad9802851297634d75e2c06f18a032f049. The fixed comparison is
`/tmp/core-wifi-snapshot-cost-timing-v10-20261119`, manifest
3eeb6de77962ffbd09d606bde73d1b900a235bcb7f57d758dffb5c8714360f29. All 36 arms and the independent
verifier passed; root independently verified all 14,022 hashes and 864 observations. This is
synthetic source transport, not actual socket/daemon cost acceptance.

At 1,600 rows, median full WiFi refresh is 53.071 -> 168.545 ms wall and 53.248 -> 152.007 ms CPU.
Core-only CPU improved 53.781 -> 36.032 ms; making only the producer faster cannot close this hold.
The independently modelled current body is 756,707 bytes; 1,602 per-row envelopes raise the complete
WiFi transfer to 997,409, versus 399,995 old bytes. The repeated envelopes account for exactly
240,702 bytes. This proposal does not claim to remove that remaining envelope cost.

The valid historical large case sends 7,408,529 bytes versus 3,611,203 old bytes. Two legal 1.6 MB
package strings are each repeated as stored DSH and published DSH. The proposal removes equality
duplication without resolving package-selection policy in core or dropping either distinct value.

The earlier accepted attribution3 packet remains immutable. It separated boundedJsonBytes producer,
input validation and projected-output walks; synthetic transport JSON encode/decode was separately
attributed (candidate 104.564 ms versus old 15.519 ms across its fixed block). Projected-output sizing
has since been corrected. The remaining input walk must stay: it rejects proxies/getters/toJSON and
counts an unknown inline record before use. The compact representation reduces the objects, keys and
string copies it traverses; it does not skip that security boundary. No new allocation-churn claim is
made from retained heap or sampled surviving allocations.

### Actual callers and fields

There are exactly two runtime projection callers of readSessionView:

- WiFi: wifiView.ts, used by wifiProcess.ts and the existing inline startWifi composition. It needs
  current session/engine, active, cwd, launch, terminal availability, name, exact turn-running, stored
  DSH and string-valued published DSH. It computes canonical workspace, runtime, package fallback and
  Store/device rows in its component. Cloud members still contribute to read membership but are not
  WiFi rows.
- Devices: devicesProcess.ts. Its real DeviceSession/FleetSession boundary reads agentId, sessionId,
  engine, registeredAt, transcriptPath, lastHookAt, displayName and selectedModel/runtimeProfile.
  fleetRouter.activityTimes actually reads transcriptPath/engine/lastHookAt; localAgents uses date,
  id, engine, name and profile; session-addressed card fences use agentId/sessionId. The projection
  must preserve its currently retained narrow fields too; this slice does not silently widen or
  discard the existing local view object.

The WiFi wrapper's typed observer uses only begin header identity/window facts and checks the current
component/core binding on every record. It continues to run only after successful validation and
before projection. Its commit and current-owner failure invalidation are unchanged.

ReadRecord/ReadReceiver have no other runtime producer than the complete session read. Their generic
begin/index/count/end shape is unchanged. Question snapshots use the same pump directly and retain
their exact public frames. AgentFrame, shownAgents, recaps and Cloud's current dialIds/dialRow stay
unchanged. Cloud's proposed owner layout is not an integrated dependency of this proposal.

### Existing arbitrary-field fixture extension

At the approved base, `services/devicesProcess.spec.ts:123` tests one validation per record. Line 126
adds `extra: { nested: ['kept', null, 3] }` using Object.assign on the test SessionRow, and line 135
expects that extension to survive the Devices spread. It is not a field the source can emit:
`core/api.ts:109` declares the exact SessionRow Pick plus stripped launch, and `core/api.ts:2243-2252`
constructs that object from explicit fields instead of spreading Registry data. No producer extension
point exists. The old component validator permits bounded unknown properties and Devices then spreads
them (`services/devicesProcess.ts:122`); the test exercises this defensive path, not actual core output.

The new private tuple admits only the declared row fields and exact tuple lengths. When the old helper
is adapted after RED, replace this arbitrary-extra expectation with exact retention of every actual
producer field, including optional DSH/launch and transcriptPath, and retain the count-one validation
assertion. Add explicit executable/oversized unknown-record refusal controls before typed observation;
do not treat absence of an extra slot as permission to bypass the whole-record security walk. Existing
actual producer/public outputs remain unchanged. This is the only private unreachable fixture
extension narrowed by the replacement; the source/projection comparison must prove all actual fields.

### Exact private representation

Header version becomes 2. The existing service_read_begin/row/end envelope is unchanged. Each
service_read_row still has one contiguous index and one member value. Use exported labelled tuple
types in core/api.ts, with named destructuring at the component projection; no magic numeric indexes
spread through callers and no generic serializer framework.

Registered member, exactly 16 slots:

    ['registered', agentId, sessionId, engine, registeredAt, transcriptPath, lastHookAt,
      active, cwd, storedDsh, launch, displayName, terminalAvailable, selectedModel,
      turnRunning, publishedDsh]

Cloud member, exactly 9 slots:

    ['cloud', agentId, sessionId, engine, registeredAt, transcriptPath, lastHookAt,
      displayName, selectedModel]

Gone member, exactly 3 slots:

    ['gone', 'registered' | 'cloud', agentId]

storedDsh is a string, null, or false for the formerly absent property. publishedDsh is false when
absent, a string when distinct, or true only when the captured published string equals storedDsh
(including equal empty strings). The decoder requires storedDsh to be a string for the true marker.
This is lossless within the previous narrow contract: it does not merge a published null with a
string, infer an app DSH, canonicalize a package, or introduce a retained string dictionary. The
component applies its unchanged string-publication-then-stored fallback after decoding the marker.

launch is null when absent, ['starting'], ['ready'], ['failed', error, detail | false], or
['held', service, detail]. false preserves absent failed detail versus an empty string. The old
capture already copied only these launch fields; nativeToken/other launch fields remain excluded.

The component validates the unknown full record with boundedJsonBytes before accessing fields, then
validates the exact tuple lengths, tag, each scalar and launch form. Accessor/proxy/prototype/toJSON,
cycles, non-finite numbers, sparse invalid fields, malformed equality marker and oversized unknown
rows remain unavailable before the observer sees them. No encode/decode round trip is introduced
just to validate a value. Projections destructure checked tuples directly; they do not recreate the
old nested session/facts/parts/source-row graph as an intermediate mirror.

Tuple destructuring introduces an iterator access that the old object projection did not have.
`boundedJsonBytes` deliberately counts only JSON array elements and does not inspect an own
Symbol.iterator. Therefore both member and launch tuples must have the ordinary Array.prototype
and no own Symbol.iterator override before typed observation/destructuring. Reject a non-enumerable
iterator getter or function without calling it; retain the existing proxy/accessor/toJSON walk.
No new full own-key array allocation is needed. This private format admits the plain arrays produced
by the actual source/JSON parser, not an alternate iterable masquerading as those values.

### Construction, authority and ownership

core/api.ts constructs the tuple directly from the same captured scalar fields. It calls
runtimeProfile and turns.running in their existing order, copies session/launch primitives at the
same point, calls facts/parts last, then performs the existing final byAgent identity check. The
same-id current replacement is read when its member is reached; deletion emits gone; late additions
remain excluded. The published equality marker is derived only after the existing final facts
capture. There is no provider after parts and no new await inside capture.

The same one-record physical callback gate, machine/computer/sign-in/environment predicate,
component/core owner fences, timeout and cancellation behavior remain. No lookahead, multi-row
temporary catalog, revision or new concurrent read is added. A failed transfer never commits an
empty/partial view. Canonical create's final core admission remains unchanged; these facts grant no
create authority. Duplicate-resume behavior still settles/drops the old provisional view rather
than closing its healthy physical connection.

The compact shape is a breaking private read change. Bump the current unreleased WORKER_CONTRACT
5 -> 6; preserve the actual current derived WORKER_PLAN unless declaration metadata really changes.
Only already authenticated Devices/WiFi readers retain their declared scopes. Mixed contracts are
refused by the existing cohort admission. This is not a claim that an individual feature has its own
fingerprint. No fallback to the removed private aggregate query and no post-send retry is added.

### Bounds, lifecycle and Design checklist

- Audience/identity: unchanged authenticated service scopes and current verified machine/account.
  No new externally visible field or capability; public app and device outputs stay identical.
- Storage/sync/retention: no durable state. Existing member ids (8 MiB), header (64 KiB), physical
  frame/global credits (16 MiB) and component projection (64 MiB) retain their exact limits.
  One current detached row per read; no second retained mirror. Membership and provisional rows are
  released at end/cancel/failure; physical credit stays charged through actual callback/close.
- Concurrency: one current read per connection, existing two declared reader scopes, existing view
  sharing per component. No new timer, polling, waiter map or worker.
- Capacity/10x: compact rows remove keys and equality duplicates; count/deadline/member/projection
  limits remain explicit. 4096 accepted, 4097 accepted, Cloud, hidden/inactive occupancy, valid 1.3 MB
  and 1.6 MB publication cases stay in the fixed comparison. No claim of unlimited history or 10x
  timing until measured; 10x admission remains bounded by those exact existing budgets.
- Measures: the existing frozen recipe measures source/core and complete consumer wall/CPU, exact
  wire/count/max-frame, retention separately, and ordinary-query/app controls. No production telemetry
  identifiers or content are introduced. The target is removal of the material complete-path
  regression; improved bytes alone does not confer acceptance.
- Failure/observability: existing fixed SESSION_READ_* errors, all-or-unavailable commit and current
  binding handling. Logs contain no row/package/path text.
- Rollback: revert this whole private-format change and cohort together before shipping, or rebuild
  matched core/services; never mix incompatible formats or replay an uncertain transfer.
- Platforms: shared TypeScript, no OS branch. Selected source gates on this Mac; Windows explicitly
  deferred by the user, mobile excluded. Actual socket/daemon native acceptance is separate and must
  use the later reviewed combined artifact. No packaging/release action is authorized by this note.

### Smallest runtime delta

1. core/api.ts: replace the old nested read-only row types and construction with fixed tuples; retain
   the exact shared facts producer and record admission before transport encoding.
2. services/sessionSnapshot.ts: replace old nested shape validation/id extraction with tuple shape
   validation/id extraction; retain full unknown-record byte/security walk and lifecycle logic.
3. services/wifiView.ts and devicesProcess.ts: named destructuring, exact same output and retained
   projection budget. WiFi's closed-projection sizing stays native JSON/UTF-8; Devices retains its
   existing guard for its constructed view until independently justified otherwise.
4. harnessd cohort constant/tests, test-only snapshot fixture generator and affected source tests.
   No change to serviceLinks/process local transport, shared settled pump, Registry, Cloud owner,
   lib/agentFrame, recaps, localWsServer, Create, desk, Stop or question paths.

### RED and proof plan before implementation

- Actual source-producer RED: capture records through createCoreApi/readSessions, require the compact
  exact row shape and no duplicate equal DSH string. Distinct/absent/null/empty DSH and all launch
  variants must reconstruct the same independently specified outputs, including published-string
  precedence over a different stored package and raw fallback after publication absence.
- Actual WiFi/Devices caller controls: all current output rows/order/fields, full occupancy,
  transcript reads, name/profile, turnRunning and hasWindow match the old independent model. Keep
  escaped quotes/backslashes/controls, multibyte Unicode, paired/lone surrogates and the formerly
  valid large rows, including equal and distinct long DSH values. No synthetic full AgentView.
- Actual boundary controls: wrong length/tag/scalar, unsafe getters/proxy/toJSON/prototype, invalid
  DSH equality marker and oversized record are refused before typed observer/projection. Existing
  generation/machine/connection ABA, duplicate/index/count/end and no-partial-commit controls stay.
- Source current-row/facts replacement, parts-last app phase, late addition/removal/rebind and held
  physical send controls remain unchanged and pass; question public frames and ordinary query route
  are untouched controls. Current old/new cohort refusal is explicit.
- Select only affected source suites, per-file 100% for changed core/services/harnessd, architecture
  and types before execution. Preserve actual RED/failing receipts. Root reviews runtime before
  checkpoint. The approved base is 85b659e509f2c5e5e9a432f1beabcd07319d2440 on branch
  core-session-read-compact-20261119 in the existing isolated desk worktree; prior commits/receipts
  and frozen d59/before comparison inputs remain untouched.
- After source review, prepare a new immutable functional packet from V10 using the same nine
  scenarios, old baseline, fixed operation bodies and exact outputs. Only candidate source/tuple
  byte model needs adaptation; keep old packets immutable. No new samples, timing or native run
  without root's explicit release. If this correction is insufficient, the remaining per-record
  envelope/pump cost stays an explicit HOLD and batching gets a separate authority/memory design.

## RED evidence and selected validation

`/tmp/core-session-read-compact-red-plan-20261119.json` selects exactly 19 new cases in four existing
suites: eight producer DSH-state cases, one real producer large-string nonduplication case, eight
actual WiFi projection/occupancy cases, one actual Devices refresh retaining every declared field,
and one old/new private-cohort refusal case. The existing runtime and fixture encoder are unchanged
for this gate. Pinned Node 24.22.2, one worker, 60-second deadline, source-bound validate-change
receipt. It ran after Launch V5 settled, on the unchanged runtime: receipt
`.harness/validation/20261118T195308.839266Z-59502/receipt.json`, actual exit 1, all 19 selected
cases failed (63 skipped). Failures demonstrated the old nested shape, duplicated equal DSH,
refused new-format caller view, and admitted old cohort. Dirty source hash stayed
`aa32053344832ed082529d45c4c8f24b8f593a3f2740f6d1ead4b5f83291cb90` throughout.

The first implementation gate is preserved as failed/incomplete:
`.harness/validation/20261118T195726.060996Z-64083/receipt.json`. Architecture passed (actual 0);
types failed (actual 2) on two stale test-only shape/type declarations; the selected coverage command
hit its 180-second deadline (actual 143), so it supplies no passing-suite or coverage claim. The
completed Devices and Store cases exposed old header/direct-projection fixtures, corrected afterward.
The subsequent one-file WiFi isolation is also preserved as failed/incomplete:
`.harness/validation/20261118T200220.518490Z-69262/receipt.json`, 60-second timeout. Verbose output
isolated the shared `testing/fakeCore.ts` default read still emitting header 1, preventing mixed-desk
readiness. That test double now emits header 2; unrelated input-contract version 1 is unchanged.
No production fallback or weaker validation was added to make those fixtures pass. The corrected WiFi isolation passed all 77 tests, actual 0, in receipt
`20261118T200934.788001Z-77208`; no result from either timed-out gate is represented as acceptance.

The corrected selected gate completed all 863 tests in 30 suites and types successfully, receipt
`20261118T201009.841695Z-78077`. That gate remained failed solely because Devices projection branch
coverage was 135/138; the other four changed runtime files reached 100% in every metric. Six real
Devices refresh controls were then added for absent/empty DSH and each launch form. The narrow
supplement `20261118T201123.399860Z-79290` passed all 40 Devices cases and types, with Devices
statements/branches/functions/lines all 100% (138/138 branches). Its dirty source hash stayed
`035d49c610fa2f43af4d199f73250b28c30a5d2b7dc956d0b3d993a7752c8e30` throughout. No runtime code
changed between the corrected broad selection and narrow supplement. The earlier architecture pass
is reused because runtime imports and source remained unchanged. All five changed runtime files
therefore have source-bound per-file 100% evidence without another broad repeat.

Plans are `/tmp/core-session-read-compact-final-corrected-plan-20261119.json` and
`/tmp/core-session-read-compact-devices-final-plan-20261119.json`; the former deliberately omits the
already-passing architecture command. The separate runtime review packet contains exactly api.ts,
sessionSnapshot.ts, wifiView.ts, devicesProcess.ts and workerContract.ts. No build, native fixture,
new diagnostic, smoke or timing run has been made for this correction.

## Actual authenticated socket supplement

`services/process.pipe.spec.ts` adds two fixed reads through the real authenticated local socket,
localWsServer, serviceLinks, createCoreApi/readSessions, answerSessionRead, settled-record pump,
readCoreSessionRecords, WiFi projection, and actual Devices advertised refresh. The registry members
and hardware port are synthetic; the row producer, scopes, transport, validator and projections are
production code. One case has 4097 registered members; the other has 1600 members and two equal
stored/published 1,600,000-byte strings admitted through real frameParts, one advertised at index 0
and one hidden at index 8. Both cases include a Cloud row, hidden/inactive occupancy, exact launch
forms, names/model/transcript fields, and absent/empty stored values. Both services first refuse the
other service's scope, then complete their valid reads on the healthy connection. Whole consumer
values are checked, not just row counts; cleanup stops the services and awaits local server/pipe close
before removing the owned endpoint root.

The focused five-test pipe selection (the two new cases plus its three existing authentication and
reconnect controls) and fixture types passed in
`.harness/validation/20261118T202140.520104Z-95943/receipt.json`, actual 0 for both checks. Source stayed
at a08a5fd9c3706cc4432874da205040e9b5801d97 with dirty test hash
`0d44b9602e5d94466d9e02839114924e3bbee12ad7e5ef57bf7733d9355608a4` throughout. The selected plan is
`/tmp/core-session-read-compact-transport-plan-20261119.json`. This is source-level real socket
acceptance on macOS; it does not claim separate production processes, Windows named-pipe execution,
real hardware, native packaged cohort acceptance, or performance. No runtime code changed.

The next V11 comparison is prepared source-only from V10 with the identical nine scenarios, 18 smoke
and 36 fixed timing arms, both old readers, operation bodies and custody. Only the candidate pin,
versioned paths, independent compact-row byte model, and untimed row-body byte checks change.
Manifest preparation waits for the reviewed clean combined candidate. The later native gate retains
the existing five supported packaged WiFi cases; it adds no inverse host selector and must use the
matched contract6 artifact. Both execution releases and complete-path performance acceptance remain
open.
