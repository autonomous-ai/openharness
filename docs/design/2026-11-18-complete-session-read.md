# Complete session reads over the existing service connection

## Design

The parent explicitly selected a complete per-row read over a bounded interval for Devices and WiFi.
This is a display/preparation read, not an atomic snapshot and not create authority. The canonical
create check stays unchanged. Error-card checkpoint d440b5f4e4 is frozen; this design changes no files
in that tree and does not authorize a native or timing run. The parent approved the source implementation after review.

Replace the provisional one-result session_snapshot path, its 4096-row/6-MiB aggregate admission,
and the old full temporary snapshot construction together. The existing question observation and the
new read share one settled-record pump. No core catalog, revision/epoch, disk staging, polling or
feature broker is added. The registered session/facts projection stays narrow and parts remains last.

## Semantics

1. At admission, capture membership once in existing registry order, then existing Cloud order. Keep
   only bounded member descriptors, not registered row objects or copies of their feature trees. Each
   descriptor identifies registered versus Cloud and its agent id. The membership is private to this
   one request and discarded at end/cancel/failure; it is not a retained core view.
2. Resolve each member from the current owning source only as its turn is sent. If deleted, emit an
   explicit gone record for that member ordinal. If replaced/rebound, emit the current replacement row
   for that same agent id. An agent added after membership capture is excluded, even if the stream has
   not reached the old tail yet. A same-id deletion and re-add is a replacement, not a late new member.
3. Capture a registered row's selected model and turn-running before its existing shared display/parts
   facts, parts last, then check the same byAgent row identity before detaching. A provider that replaces
   the row during that synchronous capture makes the entire read unavailable, as before. A fact change
   after a row was sent does not retroactively invalidate that row: the read is explicitly per-row.
4. Header machine/account identity must remain the captured verified identity through each send and
   end. Core connection replacement, service owner replacement, stop, or a confirmed identity change
   cancels the read. Machine metadata/window-presence in the header are read at admission, not claimed
   to be fresh at end. Existing later notices and normal refresh remain responsible for later changes.
5. A deletion after an earlier row was emitted can remain in the completed per-row view until its next
   ordinary refresh. No consumer may interpret an incomplete read as empty occupancy. The canonical
   create check remains authoritative regardless of any complete read's age.

## Shared pump and wire

Factor core/questionObservation.ts startQuestionSnapshot's advancement/settlement/deadline state into
one internal settled-record pump. Its question wrapper keeps exactly questions_begin/row/end,
accepts-filter semantics, 20-second deadline, generation and existing send limits. Existing question
source and sink tests prove no changed app wire or interest behavior.

Use the already authenticated service connection, not an additional owner-tool socket or public app
route. Add a generic CoreConnection.read(query, payload, receive, signal) alongside query; only the
already declared session_snapshot query of devices/wifi has a record source. Ordinary service_query
continues its existing path without a new await. No other service gains a session read. SERVICE_HOSTS
records that this query uses record transfer, deriving a new WORKER_PLAN; contract 3 remains unchanged.

Request: service_read { requestId, query: session_snapshot }.
Begin: service_read_begin { requestId, generation, count, header }.
Member: service_read_row { requestId, generation, index, value }, where value is a tagged registered
row, Cloud row, or gone { source, gone: agentId }. End: service_read_end { requestId, generation, count }.
Error: service_read_error { requestId, code }, before begin or instead of end. A callback throw,
malformed source, byte refusal or expired owner makes the whole read unavailable; no retry/replay.
Exact type/request/generation and contiguous indices are required. Duplicate begin/end, gaps, more
members than count or unknown record shapes invalidate the read; an old connection cannot settle a new
one. The requesting connection owns its read; one live read per authenticated connection, no overwrite.
A bounded cancellation frame identifies the exact request; a timeout/protocol ambiguity closes the
connection if its old physical work cannot be unambiguously retired.

Extend the existing LocalClientSink/ServiceSink settled send signature for record sends. The same
localWsServer physical-send bookkeeping used by questions owns actual byte/frame credits; logical
cancellation does not free a pending ws.send. The pump advances only after the callback or physical
socket close, and yields between records even with a synchronous test sink. End settlement releases
membership; timeout cancels the iterator and closes the current connection without replay.

## Concrete proposed limits and memory accounting

- 20 seconds from admission through physical end-frame settlement, using the existing question pump
  deadline; no separate unbounded post-timeout drain. Membership and producer authority end at timeout;
  physical frame credit stays charged until callback/close.
- One active read per authenticated service connection; only devices and wifi are granted this source,
  so at most two current membership captures. Replaced connections retain only their actual outstanding
  physical frame charge, never the old member vector or another pending iterator.
- Member descriptors: an 8-MiB request budget counting 48 bytes fixed retention charge plus twice the agent-id string length
  (a conservative UTF-16 payload charge, checked before retaining). Keep one id vector and a registered/
  Cloud split index, not one new object per id. Do not add a 128-byte agent-id limit: existing registered
  identities are not uniformly constrained by the device event contract. Array slots are bounded by
  the same fixed per-member charge. Check the elapsed deadline during synchronous membership capture. This is not a row-data/catalog
  bound: 4097 ordinary members fit, with no 4096 cutoff. No whole registry array may be allocated first.
  String/JS object physical overhead must be measured; the budget is logical retained data, not a claim
  that V8 heap size equals encoded bytes.
- One current detached row/frame per read, admitted before serialization. Proposed per-frame ceiling is
  the existing question physical allowance, 16 MiB, shared global physical credit 16 MiB, with existing
  per-connection/global frame counts. The valid 7,164,627-byte aggregate fixture consists of multiple
  rows and is accepted without retaining/serializing the aggregate in core. A single pathological row
  above the per-frame ceiling is explicitly unavailable; this remains a compatibility limit to report,
  not an unlimited-history claim. Do not reserve that maximum for every row; charge exact counted bytes.
- Client retains only its provisional projected view and duplicate-id membership validation, charged
  before retaining each record under an explicit projected-view byte allowance. Proposed component
  ceiling: 64 MiB per read, one per component owner. Existing last published view can coexist during a
  read; a failed attempt drops only provisional rows. This cap is provisional pending source/cost proof.
  No additional raw narrow snapshot array is retained after projecting rows.
- Header/end and error frames are bounded separately (header 64 KiB, complete request 4 KiB, request/generation identifiers 128 bytes, fixed errors).
  Failure logs contain fixed codes/counts/bytes only, never ids or content.

There is no arbitrary-size guarantee under a finite deadline/memory budget. These bounds remove the
specific former aggregate 4096-row/6-MiB transport regressions; remaining explicit per-record/member/
component refusal limits must be measured and documented instead of called compatibility-complete.

## Smallest source changes requiring review

Registry.list currently allocates Array.from(this.agents.values()). To honor membership admission
before allocation, expose an internal iterator of existing rows and have list reuse it; no new state
or event source. This touches the registry owner's file and requires coordination. Capture ids only
while walking that iterator synchronously, with byte admission before vector append.

Cloud dialRows currently allocates a projected array. Factor its existing per-row projection so its
current row lookup and iterator share that formatter, while existing agents.cloud callers still get
an array. This is a stateless accessor/formatter reuse, not a new Cloud catalog. Coordinate with the
Cloud owner before editing. Current Cloud membership and replacement behavior need actual owner tests.

Replace CoreApi.agents.snapshot with readSessions(receive, signal): Promise<void>. The typed begin/row/end receiver supplies the physical-settlement callback; inline projections settle synchronously, while serviceLinks forwards the actual socket callback.
The producer owns the iterator; accepts are synchronous per-row projection, with completion only at
end. Inline reads use the same row producer and yielded traversal; process adapters use the generic
service read decoder. WifiView becomes a provisional builder over registered records; devicesProcess
builds its existing visible list directly, including Cloud. Both swap view only after exact end and
current core/machine checks. No response widening or feature-only facts are added.

Remove answerSessionSnapshot's one-result route and the aggregate parser/constants once both callers
are switched. Keep the existing scope declaration and update its transport metadata/derived plan in
the same slice, with mixed-cohort refusal tests. Preserve complete native Store occupancy, absent launch/
unbound starting behavior, terminal availability, selected model, transcriptPath, package/name facts,
parts-last app phase and actual realpath work.

## Actual REDs and controls before runtime edits

- The real current process caller refuses 4097 members and the valid 7,164,627-byte aggregate; the new
  complete transfer must reconstruct identical expected Devices and WiFi projections, each in its own
  independent request. Hidden/inactive rows remain occupancy; no extra Cloud row in the 4096 control.
- A sink holding its physical callback prevents a second row and retains exact bytes until callback or
  close. Saturate shared bytes/frames, replace/disconnect with one held send, prove no early credit reuse,
  bounded deadline and successful fresh read. A synchronously settling sink must not recurse through N.
- Membership capture excludes a late append; a deleted unread member emits gone; a rebound unread
  member emits its current session; a mutation inside facts refuses the whole read; a fact changing
  after an emitted row demonstrates the documented per-row semantics without invented epoch authority.
- Core/service/peer-wrapper identity ABA, confirmed machine change, timeout, malformed/gap/duplicate/end
  count and callback failure discard provisional data and never overwrite the replacement's valid view.
- Same-owner successful read commits once, empty complete read commits empty, failed partial read does
  not become empty. Concurrent refresh callers share one existing in-flight read; no new waiting list.
- Existing question snapshot/observation and ordinary-query controls are unchanged; nondeclared services
  cannot begin a session read; final old/new WORKER_PLAN mismatch refuses admission.
- Source/types/targeted 100% coverage first. Native/cost/timing remains parent-coordinated; the prior
  frozen cost rig and error-card commit remain immutable.

## Implemented ownership details

Cancellation sends the exact request id and closes that component's service connection when transport
completion is ambiguous. The read remains unavailable until physical close; pending socket credits are
not released by cancellation. A same-connection duplicate WiFi resume supersedes the view without aborting
the read or restarting that healthy connection. Each pending view has its own AbortController, revoked
on actual disconnect or component stop. Stop-command cancellation retains its existing controller.

Current machine/computer/sign-in/environment are checked before each source send and at settlement.
A consumer also checks its current component/core binding before accepting the completed view. These
are the existing reads' linearization points, not a guarantee against a later distributed identity
change. Final create admission is unchanged and this optional view grants no create authority.

`lib/recordReadWire.ts` contains only shared physical limits for the existing question path and the
new record path. Its core import is justified by both real transport consumers. No core catalog,
revision, feature map, storage or new app wire route is added. Ordinary service-query dispatch retains
its old path. SERVICE_HOSTS declares `reads` only for devices and WiFi; contract stays 3 and the derived
plan is bf081b9d36cdc601439eaad4d8952a18d06e6c89ff63c0317d218b75f1e410f7.

## Source evidence

The original aggregate implementation actually refused 4097 unique rows and a valid aggregate with
two 1.6 MB DSH publications admitted by the real existing frameParts budget. The component boundary
also refused both. The original question pump failed to release its iterator on cancellation.
Receipts: `/tmp/core-session-read-limit-red-actual-20261118.log` and
`/tmp/core-session-read-bytes-red-actual-20261118.log`. Earlier runs retain a wrong fixture expectation
for publishFrame's void return, then a fixture fact-provider binding mistake; those are not runtime REDs.
The duplicate-resume controller coupling reproduced true instead of false in
`/tmp/core-session-read-resume-red-20261118.log` before its correction.

First affected gate 142135.037542Z-79367: 373 passes, three stale-resume/old-read failures. They were
corrected; 142810.735698Z-91614 passed 136 protocol/source cases and all three exact failed cases.
That latter gate failed only three newly added test fixture types, subsequently corrected. The earlier
standalone second type check passed; no incomplete gate is called green.

Gate 143716.780040Z-7905 recorded 700 passes and the existing stopped-resume regression, which an
entry guard corrected; its types passed. Gate 144103.979532Z-14961 then passed all 701 selected
behavior tests but missed per-file coverage. Its separate physical-custody/architecture batch passed
59 cases. Both broad architecture batches hit the chosen 120-second bound in the existing leanEntry
release-script check (actual exit -9); they are not passing build evidence. The runner retired its owned
process groups, and a subsequent numeric process census found no test/lean/esbuild descendants. No
additional broad bundle run was started. The source-only architecture/cohort checks below replace
none of the eventual packaged acceptance obligations.

A refused source whose diagnostic logger throws remained pending: actual 500 ms timeout RED in
`/tmp/core-session-read-log-refusal-red-20261118.log`. The source now rejects before best-effort logging;
the shared pump owns once-only settlement. Gate 144541.481968Z-20223 passed 727 cases and source
architecture/cohort, while still reporting three uncovered lifecycle branches and one test sink
signature type error. Those actual failed receipts are retained.

Final source-bound receipt `.harness/validation/20261118T144736.206462Z-22294/receipt.json` passes:
730 tests across 26 selected specs; all 12 changed core/service runtime files reach 100% statements,
branches, functions and lines; 98 architecture/cohort cases; TypeScript `--noEmit`. The selected plan is
`/tmp/core-session-read-coverage-plan3-20261118.json` and coverage config is
`/tmp/core-session-read-coverage-20261118.config.ts`. Only this evidence note and an extra EOF blank
line changed after that gate. Prior physical-send socket evidence is retained, not rerun needlessly.
No cost, native, release or full-suite acceptance is claimed by this source checkpoint.

Platforms: product transport remains cross-platform; source/socket checks run on this Mac. Windows
is explicitly deferred by the user, mobile excluded. The 8/64/16 MiB limits remain provisional pending
the parent's complete before/after cost and compatibility review. The frozen 4097-row and
7,164,627-byte cost fixtures must be rerun against the new transport; their old refusals remain recorded.
