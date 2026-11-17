# Shared question observation

The core owns questions. Actual application and tool connections own the interest in seeing them. This cut
replaces the Wi-Fi contribution to that interest with the device component's real local client, including its
initial state and reconnect reconciliation. It does not finish the remaining relay, recap presence, focus,
transcript or stream extraction in [package 12](2026-11-15-core-plan/wifi-input.md).

## Design

**Growth.** Reuse the local and remote connection lifetimes. Windows and remote apps observe all questions;
tools keep their existing eight named metadata watches and may explicitly observe question content. Content
observation and metadata watches share the existing 64-tool admission budget, counting a connection once.
Opted-in windows share that same 64 explicit-observation budget; ordinary window connection admission stays
unchanged. One exact count of implicit legacy windows avoids scanning their uncapped population. There is no
new global observer map, window connection cap, per-agent copy of an all scope, durable schema or
production datastore. Each bounded snapshot owns one iterator, canceled on replacement, disconnect or deadline.
The authoritative question map remains session state; pressure never truncates a question or deletes it.

**Concurrency.** The physical connection and observation generation fence every yield and callback. One
snapshot row may be outstanding at a time. Advance only after the actual send callback and a `setImmediate`
boundary. Live upserts and closes use the same ordered socket; each snapshot row is read from current state
immediately before its synchronous send. A repeated row is idempotent. Begin/end generation frames let the
receiver reconcile existing records in place, without a second complete map or an array of final IDs. An
incomplete snapshot never claims absence. Closes name the original question ID and cannot close a replacement.

**Read cost and scale.** Subscribe once, walk the existing map without copying it, then push changes. There is
no new polling, transcript read, replay effect or per-request Registry scan. New observation traffic uses the
same physical-socket accounting owner as client streams, with a distinct declared budget, not a fake service:

- Maximum serialized frame and aggregate outstanding bytes: 16 MiB each, globally across all physical
  observation connections and replacement generations.
- At most 256 outstanding frames per physical connection and 4,096 globally.
- Initial snapshot deadline: 20 seconds total, the existing local tool request budget; progress does not reset it.
- Capacity/deadline refusal closes only that observer with 1013. Charges retire only on the send callback or
  physical close, exactly once; logical unregister, timeout and replacement do not release transport ownership.

These are provisional implementation capacities approved for tests and measurement, not performance acceptance.
Measure ordinary 1/16/160-agent cases, the admitted maximum frame, 64 tools and replacement/saturation. Report
count/byte high water, refusals, snapshot completion and latency without content, IDs or paths. Compare CPU,
latency and memory before/after in a coordinated quiet slot. The existing unbounded app connection count and
authoritative question count remain explicit residuals.

**Serialized census.** Hosted screen replies are bounded to 1,048,576 serialized bytes. Question shaping can
repeat the question as key, text and permission dialog, giving a conservative three times source size plus
envelope/identities. Generated pane question IDs are fixed hashes, repeated in notification metadata. Default
Cloud service input is bounded to 6,295,552 bytes, but its accepted `cloud_q_` request ID has no length cap and
is duplicated in the output. Including both outer agent/session IDs and envelope gives a conservative
12,595,200-byte output bound. Built-in provider samples are smaller but do not replace this contract.

Inline Cloud and legacy admitted Registry IDs have no production aggregate length bound. Their new observation
frame may therefore be refused visibly while the legacy behavior remains intact. Count the exact JSON bytes
before full-frame serialization, including escapes and lone surrogates, stopping as soon as the limit is
exceeded. Preflight may encode primitive string fragments of at most 4,096 UTF-16 code units, never an object;
each temporary serialized fragment is at most 24,578 bytes. No unbounded temporary arrays or strings, and no
silent trimming of those fields.

**Compatibility.** Real existing windows/remote apps and named tools must use the shared interest contract in
this slice; the device component cannot be its sole consumer. Metadata `agents_watch` behavior stays intact,
including its bounds. The existing unsolicited full replay on ordinary tool `machine_select` is preserved;
changing that public behavior requires its own caller test and compatibility note. New observer clients opt in
with `questionProtocol: 1` at select, suppressing only their legacy replay before their bounded subscription.
The connected frame confirms that version. An old daemon without that confirmation is visibly unsupported
before the helper subscribes; its already-triggered legacy output is an old-server limitation, not a bounded path.

The legacy application adapter sends exactly the old question rows followed by one complete
`commander_questions_open` ID list. Mobile interprets each such list as the whole state: paging it or sending
an empty list before rows incorrectly closes still-open questions and changes notification timing. This old
adapter remains **unbounded**. Its removal date must derive from the first shipped public clients that support
the new generation protocol, not from unshipped code dated today. No mobile implementation or broad public
client migration belongs to this slice. Cloud questions remain local-only; gateway guest filtering is retained.

**Migration and rollback.** No persisted data changes. Disconnect destroys scopes/iterators. A component facing
an unsupported observer reports unavailable; it never selects itself as a window, commander or dial. The
existing immutable private-worker cohort gate handles private cutover. It does not retire public app compatibility.

**Audience and identity.** Only authenticated local connections may request the new content observation. A
remote request cannot claim local authority. Existing app and guest audience checks remain. Observation is
read-only and grants no answer/input lease. Existing core session/engine checks continue to own every answer.

**Failure.** Malformed scope replacement preserves the current one; admission refuses by name. Capacity,
disconnect, oversized state and incomplete snapshots are unavailable, never successful readiness. No input
effect is retried. A device component owns one shared observation snapshot. At most one hello waits per real
relay client; duplicate pending hello is refused. After awaiting readiness, check the original client
incarnation/identity before replying. Preserve `hello_result` before replay/events. Validate the existing relay
client bound rather than adding a speculative cap.

**Platforms.** Common TypeScript over the existing authenticated Unix socket or Windows named pipe; no TCP
fallback, new launcher or native API. Explicit inline mode uses the same observation client semantics. Native
Windows process-isolation evidence is a separate integration gate; host mocks do not prove it.

## Actual component cutover

`startWifi` owns the local tool observation while it has a real relay audience. The external adapter uses the
configured local connector and authenticated machine selection; inline uses the same socket. No Wi-Fi entry
is added to a core daemon-query allowlist. A reconnect completes the snapshot before advertising restored
readiness. Existing device question records receive generation marks in place, and repeated IDs do not create
duplicate `question.open` notifications when their question and permission content are identical. A same-ID
content update remains a live event. The consumer retains the old cloud choice-only policy in its process.

Once that client is functional, stop question frames at the former Wi-Fi card adapter and remove
`wifiCore.connected()` only from the question-interest predicate. Keep summary/tool/error cards and unrelated
recap/presence/feed behavior until their own extraction. The old route and new route must not both feed questions.

## Checks selected before implementation

Focused red/green tests cover actual window/remote/named-tool registration and cleanup, shared admission,
legacy frame order, Wi-Fi as the only observer including a nonfocused agent, initial/reconnect question state,
stale close and replacement ordering, physical callback/close accounting, JSON escaping/oversize, snapshot
deadline and saturation, cloud/guest audience, duplicate hello and identity change during readiness. Run one
worker after the coordinator releases its quiet benchmark slot. Required core coverage, architecture, e2e,
typecheck and before/after cost checks remain integration gates; do not claim them from focused tests.

## Focused implementation evidence

The focused gate passes 196 tests in 12 files with one worker. Each changed covered core/service file
(`questionObservation`, `questions`, `toolWatches`, `wifi`, `wifiProcess`) has 100% statement, branch,
function and line coverage. TypeScript and the architecture suite pass. Caller regressions cover an
opted-in window receiving one scoped path, repeated select, same-ID replacement, independent metadata
admission, malformed helper frames, same-ID content updates and the last pending hello leaving.

Exact preflight counting rejects accessors and callable `toJSON` before they can change the serialized
value. A counting or serialization failure stays inside the physical sink and settles its callback once.
The existing two-mode Wi-Fi e2e question case now closes its only window before asking from the device;
its real-daemon run, merged stream accounting, full core gate and cost acceptance remain pending.

## Maximum-frame responsiveness correction

The frozen `787c737db6` / `bcd046627e` maximum-frame ABBA run retained all 60 measured samples,
with one warmup and ten samples per route per worker. The matched legacy window's synchronous send
median was 18.485 / 18.390 ms, with the same 18,886,467-byte complete-ID snapshot. The candidate-only
observer's synchronous send median was 68.524 ms, maximum 92.606 ms; the core event-loop maximum was
100.794 ms. This did not pass responsiveness acceptance, despite staying within the byte/frame budget.

A separate bounded five-sample CPU diagnostic on the exact candidate traced 54.74% of non-idle sampled
time to `questionFrameBytes`, including 44.15% in its character scan. Its emitted source locations and
both live/snapshot stacks were checked, rather than attributing by minified function name. The diagnostic
is not timing acceptance. Both runs proved actual zero outer/worker/receiver exits, physical socket closure,
group/guardian/EOF cleanup, unchanged frozen hashes and private-root removal. The failed earlier fixture
preparation remains separate evidence with zero measurement samples.

The first correction changed only string counting: refuse by UTF-16 length before any scan, count native UTF-8
bytes, then scan runs requiring extra JSON escaping. Unicode regex mode excludes valid surrogate pairs;
each lone surrogate needs three more bytes than native UTF-8 replacement. Only one bounded match is held
at a time. Getter, `toJSON`, nesting, plain-object and exact pre-serialization refusal rules stay intact.
Oracle tests cover repeated/alternating escape costs, every UTF-16 unit, valid pairs and orphan mixtures,
and exact budget boundaries. The actual socket caller failed first because it scanned an already oversized
string; the corrected path refuses it without a scan or serialization. Final frozen maximum-frame ABBA,
ordinary cases and merged/native acceptance remain pending.

The unchanged maximum-frame ABBA at `363fbf5276` retained all 60 samples: candidate observer synchronous
send median/max 47.831/50.112 ms and loop maximum 66.290 ms. Matched legacy synchronous medians were
18.741/18.326 ms, with unchanged complete-ID wire output. A separate ten-sample candidate-only probe used
the same legal service byte limit with alternating quote/NUL characters in the accepted question ID. It
preserved semantics but exposed synchronous median/max 185.973/196.369 ms and loop maximum 215.089 ms.
That is failed responsiveness evidence, not a baseline improvement comparison. A bounded CPU diagnostic
on the exact source attributed 71.69% of non-idle samples to counting, 70.87% to the per-escape loop itself.
All three runs proved actual exits, physical sockets, groups/guardians/EOF, hashes and root cleanup.

The second correction retained the UTF-16 lower-bound refusal and native UTF-8 count, with a native
no-escape test. When escaping is present, native replacements count three escape classes in chunks of at
most 4,096 UTF-16 code units. A boundary between a valid surrogate pair moves back one unit. No full-string
copy, match array or callback per escape is made; only bounded chunk copies are held. Exact preflight limits
and the caller's JSON/depth/getter/`toJSON` rules are unchanged. The physical caller failed first under an
explicit bounded scan/copy guard; the corrected caller delivers the same Unicode content. Oracle tests
cover pairs and orphan surrogates across each chunk boundary, as well as the previous byte boundaries.

That correction passed 39 focused counter/socket tests and TypeScript. Its 29 tests selected by the
canonical core configuration independently give `questionObservation.ts` 100% in all four coverage measures,
without relying on the socket spec that the core gate excludes. Frozen maximum-frame/escaped probes,
ordinary cases, merged/native acceptance and shared string-primitive extraction remain pending.

At `197f6938cb`, the unchanged maximum-frame ABBA retained all 60 samples: matched legacy sync medians
18.843/18.067 ms; candidate observer sync median/max 32.689/36.624 ms and loop maximum 48.103 ms. The
separate same-input escaped probe retained all ten samples: sync median/max 76.251/89.006 ms, loop maximum
100.008 ms, server CPU median 210.659 ms and snapshot median 209.071 ms. Its bounded exact-source profile
still attributed 40.08% of non-idle samples to counting, 38.90% to the string chunk body. Physical send self
was 26.87%; V8 did not isolate stringify from bookkeeping/inlined work, so this is not claimed as pure
serialization time. Custody, actual exits, hashes and cleanup passed; responsiveness acceptance stayed open.

The final correction replaces those three native replacements with `JSON.stringify` of each bounded
primitive string fragment and `Buffer.byteLength`. It preserves the two lower-bound refusals, no-escape
fast path and unsplit surrogate pairs. Only the complete frame waits for admission; the explicitly bounded
fragments cannot invoke object or `String.prototype.toJSON` behavior. The prior measured escaped-input hold
and profile are the performance failure. A preliminary codec-specific test also failed, but is recorded
separately and is not evidence of caller misdelivery. Final physical caller tests enforce only resource and
behavior contracts: bounded temporary inputs/outputs and calls, no prototype getter/method or object effects,
unchanged Unicode delivery and full-frame admission/refusal. They do not require one codec API or a positive
fragment/copy count. Forty focused tests and TypeScript pass; thirty tests
under the canonical core configuration independently cover all four measures at 100%. Its same frozen
maximum/escaped probes and shared string-primitive extraction remain pending.

At `272c6a3183`, the unchanged maximum-frame ABBA retained all 60 samples: matched legacy sync medians
18.776/18.409 ms, with the same complete-ID output; candidate observer sync median/max 33.153/36.112 ms
and loop maximum 44.073 ms. The separate escaped probe retained all ten samples: sync median/max
57.822/65.664 ms, loop maximum 77.595 ms, server CPU median 161.461 ms and snapshot median 192.954 ms.
Both runs proved actual zero outer/worker/receiver exits, physical socket/group/guardian/EOF cleanup,
unchanged frozen hashes and private-root removal. These are isolated caller measurements; responsiveness
acceptance remains open pending a matched escaped legacy comparison and final merged/native gates.

## Shared string primitive

The measured counter is frozen. Move only its primitive string counting into `lib/jsonStringBytes.ts`,
exporting `jsonStringBytes(value: string, limit: number): number | null`, including both JSON quotes in
the result. It keeps the exact UTF-16/UTF-8 lower-bound refusals, bounded primitive fragments and unsplit
surrogate pairs. It introduces no state, options, tree traversal or transport policy. The core still owns
the question frame's depth, plain-object, descriptor and admission rules. Its architecture file list gains
this pure helper because session questions need exact bounded byte admission; no feature code is imported.

The second actual caller is the Wi-Fi process's peer-frame preflight. That process owns its own iterative
tree traversal and accepted JSON policy: existing addon JSON can be over 2,000 levels deep within its byte
budget, so the question-specific depth limit must not move into the helper. Extracting the shared primitive
does not expand the core's authority, inputs or budgets. Direct primitive contract tests and the existing
physical question caller tests will verify the move; final-source cost and native gates stay separate.

The extraction passes 44 focused tests in three files with 100% per-file coverage for the primitive and
question module, plus TypeScript and all 30 architecture checks. The canonical core configuration's 30
question tests independently retain 100% coverage. The shared API test first failed because its new module
was absent; that verifies the extraction contract, not a newly discovered behavior bug. An initial restricted
sandbox run could not bind its private loopback sockets (`EPERM`); its exact runner group was interrupted
and verified gone before the same focused command passed with loopback access. No new cost run was made.

## Merged-source escaped comparison

One fixed ABBA block compares baseline `787c737db6` with merged `7aa0903a8b`, including the shared
primitive and physical stream/question accounting. The source freeze precedes a later metric-only
correction; this is the selected question caller comparison, not whole-daemon or native acceptance.
It retains the same legal 6,295,552-byte escaped Cloud input, routes, one warmup and ten samples per
route per worker, with all 60 measured samples preserved.

Matched legacy window baseline/candidate synchronous send medians were 33.576/32.440 ms, maxima
36.331/36.049 ms; loop maxima were 55.837/59.048 ms. Server CPU medians were 148.424/148.737 ms and
snapshot medians 208.384/208.451 ms. Both retained the complete final-ID snapshot: 18,886,467 bytes in
three frames. The candidate-only observer had synchronous median/max 55.810/62.146 ms, immediate probe
maximum 62.210 ms and loop maximum 72.810 ms; CPU median 172.076 ms and snapshot median 187.017 ms.
Its snapshot was 12,591,613 bytes in five frames, with no refusals. The bounded route therefore adds
23.370 ms median synchronous work against the same candidate's legacy route for this maximum escaped
input; that increment is not attributed to intrinsic old serialization. The algorithm stays frozen.

Actual outer, four worker and four receiver exits were zero. All EOF/reap/group/guardian checks passed,
198 of 198 sockets physically closed, all four private roots were removed, and all 426 frozen input
hashes plus report/evidence hashes matched. The remaining ordinary/new-observer/boundary cost phases
and final native gates are separate; these numbers alone do not close responsiveness acceptance.

## Merged-source ordinary comparison

The fixed ordinary ABBA compares the same baseline `787c737db6` and merged `7aa0903a8b`, before later
metric and launch changes. It retains all 840 measured samples across 1, 16 and 160 agents: existing
window/default-tool snapshots, legacy live delivery and the actual question predicate with no audience,
a window, a remote app or 64 named tools watching eight agents each. Every matched legacy wire byte
and frame count agrees between the two sources, including the original complete-ID reconciliation.

At 160 agents, window snapshot medians were 4.933/4.891 ms and default-tool medians 4.997/5.020 ms
(baseline/candidate). Median timed live send was 21.391/21.619 microseconds; server CPU for 1,000 live
operations was 31.535/31.540 ms. Predicate nanoseconds per query were 42.53/54.17 with no audience,
15.72/22.66 with a window, 30.43/47.33 with a remote app and 289.38/239.88 with 64 named tools.
The worst recorded loop hold across these ordinary cases was 6.042/4.858 ms; the worst snapshot loop
hold was 2.431/2.449 ms. These are selected caller costs from one ABBA block, not aggregate daemon costs.
Server CPU includes fixture/control work; receiver CPU is separate. Snapshot latency includes receiver
parsing and assertions. Recorded memory includes the bundle, fixtures, timing arrays and prior cases,
so it is not a measurement of isolated retained core state.

Actual outer, all four worker and all four receiver exits were zero. All 6,252 sockets physically closed;
EOF/reap/group/guardian and independent live absence checks passed, all four private roots were removed,
and all 426 input hashes plus report/evidence hashes matched. All samples and cleanup receipts are retained
in `/tmp/core-question-final-ordinary-results-20261118a`. Candidate-only stress, maximum plain input,
exact-boundary and final native acceptance remain separate.

## Merged-source observer stress

Two fresh candidate-only `7aa0903a8b` workers retain all 360 samples: three warmups and ten samples
per case, 1/16/160 agents, 64 explicit observation interests for the predicate, snapshots with one
observer, 64 observers or one opted-in window, and live delivery to one or 64 observers. Each snapshot
sample contains twenty complete connection cohorts; each live sample sends 1,000 operations. The full
phase opened 103,350 physical WebSockets. The earlier 49,920 shorthand counted only the 64-observer
snapshot route in one worker; the frozen loops were unchanged when this reporting error was corrected.

At 160 agents, one-observer snapshot median/p95 was 8.312/10.713 ms. A 64-observer cohort completed in
303.356/313.720 ms median/p95; its individual clients had a median of 277.982 ms. The opted-in window
snapshot median was 8.220 ms. Median timed live send was 0.040277 ms for one observer and 1.577567 ms
for 64, with a maximum of 3.843 ms for the 64-observer case. The worst measured loop hold across all
cases was 9.445 ms; the 160-agent, 64-observer snapshot maximum was 8.815 ms. These are new-route
measurements, with no baseline or per-phase improvement comparison.

No observer refused a frame and no content/state assertion failed. Each arm accounted for 5,687,175
question frames and 8,055,092,175 bytes, including warmups and all routes. Final callback-owned peaks
were 131,586/109,631 bytes and 104/69 frames for the two arms. Accounting emits on physical close:
sample deltas do not describe still-open live cohorts. Memory snapshots are retained with the same
fixture/timing-array caveat as the ordinary comparison; they do not establish isolated core retention.

Actual outer, both workers and both receivers exited zero. All 103,350 sockets physically closed, with
no owned sockets or cleanup failures; EOF/reap/group/guardian and independent absence checks passed,
both private roots were removed, and all 426 frozen inputs and report/evidence hashes matched. All
samples and receipts remain in `/tmp/core-question-final-candidate-results-20261118a`. Maximum plain
input, exact-boundary and native acceptance remain separate.
