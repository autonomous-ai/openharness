# Durable native hook delivery

## Durable agent cancellation

Native cancellation is also retained on the Registry row, independently of the
process journal. The immutable request records its original binding, process key
and journal frontier. An unknown owner stays unknown; recovery cannot fill it in
or gain interrupt authority. A cancelled row uses schema 3 so an older writer
refuses it instead of silently dropping the hold. Registration, process changes,
archiving and discovery must preserve the association.

Ordinary admission stays held until an explicit request first reserves a launch
token and then confirms a replacement process and conversation. Confirmation
cannot skip the reservation or change its request, target or token. Each later
Cancel has a distinct request ID. Cancel during a reserved rearm marks that exact
reservation revoked. Its receipt and token remain recorded until reconciliation
proves it never dispatched or accounts for its original allocation; elapsed time
cannot authorize another launch. An unbound Cancel records an empty conversation
only with a null process key and empty frontier, never as a journal request.

Writes publish only after the file and parent directory are synced. An uncertain
write is sticky: unrelated saves cannot roll it back, and a retry can confirm only
its original image. A recovered enabling image must be synced through descriptors
proven to be the original file and directory. Fresh reads retain the exact binding
and control image through final effect verification. Stale peer saves and removals
cannot overwrite a newer cancellation.

A corrupt Registry now remains in place and blocks writes, including after a new
daemon starts. Starting with an empty table could forget a cancellation when
truncation removed its marker. Recovery requires repairing or restoring the saved
state; the daemon does not discard it automatically. Native hook delivery accepts
both valid schema 2 rows and schema 3 rows with valid control state.

The eager Cancel controller captures the original row, native key and frontier
before revoking input and writer authority. It saves the association before
obtaining the journal's one-use interrupt capability. Disk, native owner, writer
epoch and the original five-second deadline are checked at physical dispatch and
confirmation. An uncertain physical result cannot replay C-c. Storage retries
retain the same request, rotate fairly across bounded slots and cannot renew its
deadline. A completed publication followed by a failed read is confirmed afresh;
only the exact proposed image can be recovered that way. Late callbacks cannot
replace a successor's status. Explicit rearm and atomic daemon activation remain
required before this path becomes live.

Saved agents now use the same retained private-file proof as the live Registry.
Archive writes serialize under the store's own lock. Ordinary snapshots preserve
the exact Cancel/rearm association; changing it requires a legal transition from
the original saved row. A failed publication retains its exact candidate and
original directory route until that same request confirms durability. Replacing
an ancestor while moving the same directory inode cannot renew this authority.
Receipt proofs run before the final disk-free owner/deadline fence. A native
resume reservation is never cleared merely because it is old; clearing a real
marker requires an explicit verified handoff. A missing marker remains an
idempotent Stop cleanup, while missing receipt evidence still propagates failure.

The archive checkpoint passes types and 337 cases in ten affected files, including
architecture, Stop, Resume, purge and conversation ownership, with 100% statements,
branches, functions and lines for the shared file proof
(`20261013T100749.910031Z-64556`, 94.2 seconds). The final age-based Resume fixture
also passes its complete baseline in the mutation run and types in
`20261013T101527.599022Z-2105`. All 23 archive/Registry wiring faults fail by
assertion after passing baselines (`20261013T101340.160549Z-89491`, 89.3 seconds).
Earlier failed runs retain the invalid fixture, uncovered descriptor-sync branch,
and a mutation oracle that needed an explicit rejected-promise assertion; none is
reported as a passing run. Runtime source was unchanged by the final fixture fix.

Independent review approved this persistence slice over `8aa4ff63b`, conditional
on the now-completed validation. Review corrected missing-marker handling, stale
snapshot control replacement, final local fencing and retained ancestor routes.
Receipt/rearm composition and activation remain excluded from that approval.
Implementation and review ran approximately 09:40–10:17 UTC on October 13, with
validation overlapping; merge and publication remain zero.

Native rearm now has a narrowly scoped creation-receipt confirmation. Recovery
can refine only an existing native rearm dispatch into its exact created outcome;
it never receives another process-launch callback. The original immutable intent,
claim and result remain intact, with a separately synced confirmation naming that
same claim. A late uncertain result preserves confirmed success; contradictory
results remain visible as storage failures. Status, cancellation and retries all
validate the combined evidence, including retries whose original five-second
reply expired while their effect was still occupied. Such a retry cannot adopt
a different request's coherent receipt under the same ID. Final publication checks
retain the original file routes and end with local revocation authority.

This receipt checkpoint passes types and 174 cases across creation receipts,
launch handlers, the core API and architecture
(`20261013T103915.702063Z-87704`, 38.1 seconds), and all nine deliberate wiring
faults fail assertions after a passing baseline
(`20261013T104025.053306Z-98888`, 22.5 seconds). The earlier failed receipt remains
failed; it exposed contradictory-result and cancelled-tombstone bypasses.
Independent review approved this slice over `f659a337b` after also correcting
the result-capture race, stale in-flight replies and foreign receipt substitution.
The current-main merge is included in the passing type/API/architecture checks.
Implementation and review ran approximately 10:19–10:41 UTC on October 13;
validation overlapped. Merge and publication remain zero. Replacement proof,
known-not-dispatched handling, rearm composition and activation remain excluded
from this approval and are still required before the PR can land.

A pre-exec process witness now belongs to that same exclusive dispatch claim.
Only its original successful publisher can continue to execution; reading an
identical witness, including after uncertain directory sync, grants no execution
permission. Publication retains the original open inode through link cleanup,
directory sync and final verification. Recovery gets only the recorded kernel
boot ID, PID and precise birth, and must separately prove the current engine
image. Confirmation binds the witness checksum or explicit absence, so removing,
inserting or changing a witness cannot silently preserve a successful result.
The reserved launch token also survives asynchronous executable installation.
The storage and token slice is independently reviewed. The launch-owned writer
now uses the shipped standalone hook artifact, with an explicit capability
header. Its fixed foreground shell publishes its kernel boot ID, PID and precise
birth before exec. A repeated witness, failed publication, interrupted writer or
changed original control/dependency proof holds without executing. A final paired
process probe retains both the original writer and shell through publication.
The shell resets interruption handlers before its final decision and suppresses
inherited startup files and functions. macOS uses the concrete Bash image because
its `/bin/sh` shim execs that image. Exec preserves the witnessed incarnation;
the existing outer wrapper continues to own Stop/Continue and final exit.

The writer checkpoint passes types and 323 tests across ten files, with one
unavailable row skipped (`20261013T115339.055975Z-40272`, 111.7 seconds). This
includes the unchanged launch golden, architecture, standalone hook behavior and
private real-shell/tmux acceptance. All 13 writer faults and 18 receipt faults
fail assertions after passing baselines
(`20261013T115747.862855Z-54457`, 47.5 and 36.2 seconds). The earlier failing
process runs remain failed: they exposed the macOS shim mismatch and a fixture
replacement-string error that changed literal shell PID syntax. The corrected
fixture also avoids signaling already-reaped process groups. Independent review
approved the writer-only delta over `7f0af2d58`, conditional on those completed
checks. Implementation and review ran approximately 11:20–12:00 UTC on October
13, with validation overlapping; merge and publication remain zero.

Replacement recovery now proves only the recorded kernel boot/PID/birth in its
original live tmux pane, including the older-tmux daemon-owner wrapper. The current
engine must be the original pane root's direct child. A final paired probe retains
both incarnations, the full original pane command and the exact receipt/control
fences. Captured callbacks cannot be replaced during a wait. Replies expire after
three seconds; timed-out work retains its actual read slot until settlement, and
an expired setup cannot consume a slot it never started using.

An exec witness alone does not prove that the engine started. Pre-exec shells and
launchers remain held. For Node-based Cursor, the native probe supplies only an
optional digest of the current direct entry; neither argv nor environment text is
emitted on macOS. Its original opaque command identity is unchanged. The parser
uses XNU's exact target-pointer alignment, including the removed executable-path
prefix, instead of skipping NULs into an empty argv0 or environment. Unknown,
rewritten or unsupported boundaries omit the digest. Display text can supply
bounded complete-path candidates, including spaces, but only the native digest
can authorize one. The final paired observation must preserve that digest too.

This replacement-proof checkpoint passes types and 180 cases across six files
(`20261013T124842.949501Z-29666`, 5.2 and 29.3 seconds), including architecture,
the unchanged native-control golden, original Stop/Continue, a held shell that
execs Node in the same incarnation, rejection of a manually started successor,
the older-tmux wrapper, spaced paths and sh/bash/zsh/dash/tcsh. All five shells
were available. The 21 native protocol/packaging/private-process cases pass
(`20261013T124038.743602Z-97125`, 3.9 seconds); the final stricter spaced-argv0
case is also covered by the subsequent native mutation baseline. All 18 deliberate
recovery faults fail by assertion after passing baselines
(`20261013T125001.878288Z-35774`, 25.1 seconds). The intermediate failed receipt
retains a test callback type error; its passing process checks were not reported
as a passing aggregate.

Independent review approved the replacement-proof delta over `a6ca7856f`,
conditional on the now-completed validation. Review corrected bounded reply
settlement, the older-tmux wrapper, mutable callbacks, complete spaced paths and
setup-expiry capacity loss. Implementation/review ran approximately 12:00–12:52
UTC on October 13, with validation overlapping. Merge and publication remain
zero. This remains inactive machinery: controller composition and final installed
client acceptance are still required before the PR can land.

Native rearm preparation can now observe actual receipt settlement separately
from its five-second client reply. The promise resolves only after preparation,
any claimed effect and receipt cleanup finish, including lost claims and errors.
Authority is revoked and the old in-flight entry is removed before subscribers
can retry. A directory-close failure still releases capacity and remains a failed
receipt operation. The pending-launch wrapper also waits for its underlying
preparation: its own timeout cannot release an occupied dependency slot.

Types and 137 cases across five files pass, including the unchanged launch golden
and architecture (`20261013T131304.527202Z-4609`, 5.0 and 48.7 seconds), with 100%
statements, branches, functions and lines in the touched pending-launch module.
All seven deliberate settlement faults fail by assertion after passing baselines
(`20261013T131445.663379Z-8449`, 20.7 seconds). The earlier receipt remains failed:
its cleanup fixture targeted an incidental descriptor rather than the retained
directory; the corrected fixture closes the real descriptor before injecting the
failure. Independent review approved the settlement delta over `237ea9a20`,
conditional on these completed checks. Implementation/review ran approximately
12:58–13:17 UTC on October 13, with validation overlapping; merge, publication and
external waiting remain zero. Controller integration and final acceptance are
still required; this checkpoint is not approval to activate or land the PR.

The reservation now retains its original live/saved source and optional requested
Resume permission mode. Reconstruction preserves omission and the exact bytes of
a revoked request; it does not infer missing metadata from current defaults.
Source and mode cannot change during confirmation. Original persisted permission
mode and normalized bypass choice participate in the target identity. The writer
requires those original permissions through its final check; requested permissions
belong to the prepared launch and confirmed replacement, not a premature source
rewrite. Witness and replacement proof reject option/source disagreement.

The controller must reserve this complete R before publishing its creation
receipt, checking existing receipt compatibility first. Saving the receipt first
would leave a crash window in which a later Cancel cannot revoke an absent R.
Recovery must scan reservations in both stores after readiness, reconstruct the
same request, and durably cancel a revoked missing receipt before clearing R.
Older incomplete reservations remain visibly held. This ordering and controller
recovery are still integration requirements, not completed behavior.

Types and 365 cases in ten files pass with 100% intent-rule coverage and unchanged
launch/native-control goldens (`20261013T133034.824357Z-64179`, 26.0 and 61.9
seconds). All nine deliberate option/target/writer/proof faults fail assertions
(`20261013T133335.013257Z-75406`, 18.7 seconds). The complete reservation format
also passes types and all 16 private packaged-writer/process/tmux cases
(`20261013T133439.678226Z-78114`, 5.1 and 22.7 seconds). Independent review approved
the reservation-semantics delta over `ba6980d4b`, conditional on these completed
checks; it does not approve controller recovery or activation. Implementation and
review ran approximately 13:18–13:36 UTC on October 13, with validation overlapping;
merge, publication and external waiting remain zero.

The rearm controller now reserves complete control before its creation receipt,
with immutable receipt compatibility checked before the store write. Recovery of
a revoked reservation creates the missing cancellation tombstone instead of
dispatching. Dependency preparation occupies at most four actual work slots;
the five-second reply cannot release preparation or a running physical callback.
Only the exclusive receipt claimant receives a one-use physical begin guard.
Both that guard and continuing checks retain the exact original control, process,
pane, conversation and permissions. Callback completion revokes its guard before
recording the outcome. An effect cannot declare success; original-allocation
reconciliation remains separate. The known-not-dispatched receipt marker is an
internal outcome that the still-unwritten public adapter must present as held,
never as a service-caused launch failure.

Types and all 66 cases across the controller, unchanged launch golden and
architecture pass (`20261013T140633.744336Z-37565`, 4.8 and 25.9 seconds), with
100% statements, branches, functions and lines in the new controller. All 14
deliberate dispatch faults fail assertions after a passing baseline
(`20261013T140947.111713Z-56352`, 22.7 seconds). Earlier runs remain failed: they
exposed missing coverage, a fixture's incorrect expectation for an in-flight
receipt, and an attempted mutation of frozen test control. The first mutation run
timed out on an unsafe capacity release; the final oracle directly asserts that
the original physical guards remain live instead of awaiting the broken retry.

Independent review approved this reservation/dispatch slice over `156b498dc`,
conditional on those completed gates. Review corrected authority after a changed
target, retained guards after callback return, a mutable committed-row alias and
the ordering of the final receipt proof before the last local revocation check.
Implementation and review ran approximately 13:37–14:11 UTC on October 13;
validation overlapped, and merge, publication and external waiting remain zero.
Reconciliation, both-store recovery, public held-state mapping, physical adapters
and production activation remain required before this draft can land.

Original-allocation recovery now reads the recorded witness while the source
still has its former PID and permissions. It does not publish a provisional
binding to make the native proof fit. The proof retains the full original
Cancel/rearm image, target and complete request together with its receipt
fingerprint. Actual Registry composition exposed a route-key mismatch hidden by
earlier synthetic fixtures: the primary key is `terminalRouteKey`, including its
NUL separator, rather than the display label. Both production and fixtures now
use that canonical key.

Live replacement publication writes the proven process, requested permissions
and admission in one image. Its full authority check runs immediately before
rename; the exact writer descriptor, intended bytes, original parent route,
receipt and final native deadline remain checked through directory confirmation,
before live memory changes. A close that consumes its descriptor and then reports
failure cannot lose the uncertain image through a second close. Equal bytes in a
substituted inode and an in-place rewrite before stamp capture both hold.

An uncertain replacement has a separate read-only recovery proof. It retains
this Registry's exact unpublished record, written inode/image, original owner
and original parent route; it grants no admission. A retry requires a fresh
native observation and can confirm only that image. Reload, peer Cancel,
substitution or changed ownership revokes the proof. The original route proof
stays flat: eight consecutive failed-sync retries keep the same verification
work and then recover without another dispatch.

Types and 331 cases across ten files pass in
`20261013T145537.143014Z-68744` (5.4 and 87.3 seconds), including real retained
receipts, Registry recovery, the shipped standalone writer on private processes
and tmux, unchanged launch/admission goldens and architecture. All twelve
publication/recovery mutations fail assertions after their passing baselines
(`20261013T150303.128922Z-95634`, 53.6 seconds). Earlier receipts remain failed:
they exposed the route-key mismatch, fixture/compile errors, an expectation for
a later peer-Cancel error, and two mutation oracles that needed explicit
recovery assertions. The final oracle edits change no production code; their
complete reader/storage baselines pass in the mutation receipt, and final types
pass in `20261013T150521.438585Z-5139` (4.9 seconds).

Independent review approved this proof/live-publication checkpoint over
`1a5a46f39`, conditional on those completed checks. Review corrected pre-rename
fencing, complete source binding, recovery from an uncertain image, final inode
and byte confirmation, descriptor-close failure and growing retry-proof chains.
Implementation and review ran approximately 14:13–15:05 UTC on October 13, with
validation overlapping. Merge, publication and external waiting remain zero.
Saved-to-live handoff, reconciliation orchestration, physical adapters, public
held-state mapping and production activation are still required; this is not
whole-PR approval.

The next live recovery checkpoint connects the original native observation,
the atomic replacement image and the existing creation receipt. Recovery has
no launch callback. A crash after the Registry commit is resolved by proving
that admitted replacement and confirming its original receipt, without another
Registry replacement or process launch. Cancel, shutdown and the original
absolute deadline revoke the attempt; its status callback cannot overwrite a
successor or strand the reply when presentation fails.

Four recovery slots follow actual native observation settlement. The reader's
three-second reply can expire while a probe is still occupied; neither that
reply nor the controller's five-second reply releases the underlying slot.
The composition test uses the real reader with a stalled injected probe and
asserts that a fifth observation cannot begin before an original one settles.

First confirmation exposed an integration gap: the process proof retained the
former absence of the confirmation file and rejected its own new confirmation.
Only the confirmation publisher may replace that absence proof. It retains
its actual written inode through directory durability and supplies its exact
final verifier to recovery. The original intent, dispatch claim, result,
process witness, routes and native deadline remain pinned throughout. Equal
bytes in another inode do not inherit the original publication's authority.

Receipt `20261013T162901.683429Z-30687` passes types (5.1 seconds) and 392
cases in ten affected files (138.9 seconds), including unchanged launch and
admission goldens, architecture and the installed writer's private process
acceptance. The new core recovery module has 100% statements, branches,
functions and lines. Receipt `20261013T163151.138877Z-44430` passes the full
reader/receipt/controller baseline and all eleven assertion mutations (51.3
seconds). Earlier failed receipts retain a fixture with an invalid kernel
witness, the real confirmation integration failure and an uncovered defensive
branch; none is reported as passing. Independent review approved this live
recovery scope over `724074128`, conditional on these completed checks. It
found the actual-read lifetime, late revoked status and throwing-presentation
issues described above. Implementation and review ran approximately
16:07–16:35 UTC October 13, with validation overlapping. Merge, publication
and external waiting remain zero for this checkpoint.

Saved Resume still needs an explicit two-store ownership handoff. The reviewed
protocol keeps one bounded transfer role in the archive envelope, tied to the
existing reservation and exact destination. It does not add another launch
claim or treat `.resume` as independent execution authority. Registry then
archive is the fixed lock order; no lock may span a native probe or tmux wait.

Before transfer, a pending live route remains inadmissible and the saved
reservation owns Cancel. Under both locks, the exact saved reservation and
pending live row must agree before a durable archive role transfers control
to that live row. Refreshed proofs of both stores then guard one Registry
commit of the replacement process, permissions and admission. Cancel after
transfer belongs to the live row and defeats that commit. The original
creation receipt must confirm before clearing the matching `.resume` marker.

A crash after transfer never makes the older archive authoritative again.
A missing or unreadable destination holds the original handoff; it cannot
permit another launch. Later Stop requires the reverse transfer: checkpoint
the latest live control while retaining its live-owned role, account for the
exact process and allocation, then publish the final saved snapshot and
strictly retire the exact live row under the same lock order. Until retirement
is durable, live control wins and a concurrent Cancel requires a fresh saved
snapshot. Ordinary archive save, generic Registry removal and an old marker's
age cannot substitute for this protocol. This handoff and production
activation are not implemented by the live recovery checkpoint.

October 13 saved Resume checkpoint: Registry now coordinates the forward
handoff through the saved Store, always taking Registry then archive locks.
It first persists an inadmissible held route carrying the original reservation
and a stable archive link. The archive then publishes a strict version-two
transfer role before Registry publishes process, permissions and admission
together. No callback can launch a process here. A recovered transferred
archive never regains saved control because Registry is missing. Later Cancel
and Restart preserve the visit's original link even when they replace R.

Each phase retains its actual publisher inode and original parent, including
the inspection immediately after publication and uncertain same-core retries.
The archive decoder is shared by catalog and control paths: changing an
envelope version or putting a live link in a legacy saved envelope cannot
restore saved authority. A known uncertain transfer also blocks ordinary
saved reads and writes if older valid bytes reappear. Registry compares
archive lineage after its three-way merge, so an unrelated stale writer can
import a peer's new live visit without dropping it or blocking forever.
Final guards recheck local ownership after external callbacks.

Receipt `20261013T171101.603948Z-95474` passes types (4.7 seconds) and
274 cases across seven files (63.4 seconds), including the unchanged admission
golden and architecture. Receipt `20261013T171407.917316Z-6247` passes both
complete mutation baselines and all eleven new archive and twelve existing
live-replacement assertion mutations (106.2 seconds). The earlier expanded
run remains failed evidence: one assertion expected the former hold wording
after the new uncertain-transfer guard correctly refused control. Independent
review approved this forward scope over `1e3b1b4ff`, conditional on the now
completed malformed-envelope regression and mutation gates. Review found
the decoder, stale-peer merge, post-publication proof retention and final
callback ownership gaps fixed above.

This continuation began at approximately 16:46 UTC October 13; implementation
and independent review ran through 17:11 UTC, with validation overlapping
16:50–17:16 UTC. Merge, publication and external waiting remain zero for this
checkpoint. Reverse Stop, physical adapters, original receipt confirmation
and marker cleanup for saved Resume, production activation and final full-PR
acceptance remain required. Forward storage approval does not approve those
unfinished paths.

The reverse protocol now explicitly retains a retirement record. First write
the latest live checkpoint as archive `returning`, then persist a Registry
retirement bound to that exact checkpoint. Only fresh retained proofs of both
may publish archive `saved` ownership. Remove the matching Registry retirement
last, retaining the closed epoch in the archive through cleanup. Missing
Registry while the archive remains live-owned or returning is a hold. Before
retirement, a concurrent live Cancel invalidates the checkpoint; afterward,
finish the metadata handoff before routing new control to saved state. No
third journal or inference from row absence is part of this protocol.

October 13 reverse Stop checkpoint: that protocol is now implemented in Registry
and the saved Store. The archive preserves the latest cancelled live snapshot;
retirement requires the exact stopped-process and original-allocation proof.
Its durable tombstone blocks discovery, rebinding and ordinary control writes.
After saved ownership is confirmed, cleanup preserves newer saved Cancel and
folder edits, and the next Resume consumes only its own closed visit. Tests cover
two complete visits and stale work from the first visit against the second.

The archive parser is shared with the pre-exec witness. A version-three saved
record can authorize its own new reservation; returning, transferred, malformed,
foreign-agent and version-downgraded records cannot. Both directions retain the
actual publisher through the first subsequent inspection and uncertain retries.
A replaced file with identical bytes does not inherit publication authority.

Receipt `20261013T175142.971421Z-33157` passes types and 393 cases in nine files,
including the unchanged admission golden and architecture (146.1 and 152.1
seconds on the loaded host). Receipt `20261013T180401.043628Z-74958` passes the
complete affected baselines and all 35 assertion mutations: twelve reverse and
witness faults, eleven forward-transfer faults and twelve live-replacement
faults (313.9 seconds). Final types after the retained-read extraction pass in
`20261013T180959.220099Z-1521` (25.0 seconds). Earlier failed receipts retain the
fixture request-ID/type errors, one typecheck timeout, and two mutation-oracle
errors. The corrected substitution oracle now replaces the file precisely before
reinspection; the former descriptor-close injection faulted an earlier verifier
and did not demonstrate the required publisher guard.

Independent review approved this reverse-storage and witness-consumer delta over
`f01172974`, including its successor tests and corrected mutation oracles, after
the completed gates. Review found and corrected discovery's in-memory reopening
of a retirement and required the witness's version-three consumer. Implementation
and review ran approximately 17:20–18:10 UTC October 13; validation overlapped
17:36–18:10. Merge, publication and external waiting remain zero. This is scoped
approval: physical Stop evidence, saved Resume orchestration and marker cleanup,
production activation and full-PR acceptance remain open.

Saved Resume integration must also handle Cancel between pending Registry
publication and archive transfer. Under Registry then archive locks, an exact
pending-handoff abort must preserve saved control, account for the original
allocation or prove it never dispatched, and retire only the matching pending
row and marker. After transfer, Cancel and Stop belong to the live visit. Native
markers bind the full permanent archive link, and later cleanup follows that
link rather than the current rearm request. Confirmed creation remains successful
when marker cleanup needs a retry; exact receipt/link evidence can finish that
metadata work even after the engine exits, without another launch.

Saved allocation lookup now runs inside the existing native proof observation.
It proves the original witness birth and a paired parent/engine identity before
reading one complete, bounded numeric tmux listing. The resulting pane is only a
candidate: the original launch token, both retained process identities and the
executed Cursor entry must still agree. Discovery and the final paired query
share the original budget and actual-I/O slot. The saved pane remains history.

Receipt `20261013T181523.019090Z-24166` passes 526 cases in eight files, including
the installed writer on private tmux with a deliberately stale saved pane, the
live recovery controller, architecture and current-main model interactions
(123.7 seconds). That receipt remains failed overall because one typed test mock
omitted its arguments. Corrected types pass as the first command in
`20261013T181919.928999Z-36728`; its mutation phase then stopped at an old indentation
anchor. Receipt `20261013T182214.106026Z-44885` passes the complete corrected proof
baseline and all 27 TypeScript wiring mutations plus the existing native entry
alignment mutation (122.9 seconds). Mutation anchors are now checked before the
baseline. No production change was needed after the first test run.

Independent review approved this lookup scope over `33a234b17`, conditional on
those completed gates. Implementation/review ran approximately 18:11–18:22 UTC
October 13, with validation overlapping 18:15–18:24. Merge, publication and
external waiting remain zero. Marker handling and recovery orchestration remain
open. The pending Cancel abort needs a persisted retirement subtype bound to the
prior archive role: without that provenance, a lost normal-return archive could
be mistaken for an untransferred abort. The final closed receipt can reuse the
existing version-three saved role.

The pending-abort protocol is now implemented. A distinct Registry retirement
records that ownership never transferred, the exact prior archive role, original
pending control and complete request fingerprint. A fresh stopped-allocation
proof is still required. Saved Cancel remains authoritative throughout; cleanup
closes only that visit and preserves newer saved Cancel and folder edits. A lost
normal Stop checkpoint cannot be interpreted as an untransferred abort.

Independent review found two additional races. Saved dispatch now confirms and
retains actual private Registry absence instead of trusting one core's stale
memory. Separate Registry instances exercise peer publication before reservation,
during preparation and at physical dispatch. An uncertain retirement retry now
confirms its exact original publisher and immutable tombstone even if the saved
store accepted later edits; it never rewrites those edits. Final dispatch checks
recheck saved target/control after the absence proof and end with local lifetime.

Receipt `20261013T184410.430562Z-14950` passes types and 284 cases in four affected
files (108.2 and 112.8 seconds), with 100% Resume controller coverage. Final
ordering and both causal regressions pass types and all 56 controller cases at
100% statements, branches, functions and lines in
`20261013T184746.977009Z-27726` (17.0 and 11.1 seconds). Receipt
`20261013T184841.406434Z-31226` passes all complete baselines and 56 assertion
mutations: 17 archive return, 16 dispatch, 11 forward handoff and 12 live
replacement faults (449.0 seconds). The earlier 357-pass/10-fail run remains
failed: it found a normalized launch-token hint, an outdated fixture Cancel
target and an undefined missing-role digest; each was corrected explicitly.

Independent review approved this pending-abort/storage/dispatch slice over
`5d8dfe12b`, conditional on the now-completed final ordering regression and gates.
Implementation/review ran approximately 18:24–18:48 UTC October 13; validation
overlapped 18:33–18:56. Merge, publication and external waiting remain zero.
Physical proof producers, marker cleanup, orchestration, activation and full-PR
acceptance remain excluded from this scoped approval.

Native Resume metadata completion now uses the existing `.resume` marker and
full original archive link, with no new dispatch journal. Cleanup requires an
explicit confirmed created receipt, an accounted closed visit, or the exact
revoked request's durable cancellation/known-not-dispatched receipt. It never
infers allocation outcome from missing process evidence. The transferred-created
path compares the full original request, including omitted permission choices;
a later Cancel cannot invalidate the original successful creation or supply
another request's cleanup authority.

Marker publication retains its actual writer and original private parent.
Cleanup pins that parent's descriptor, retains removal authority before unlink,
and confirms absence after directory sync and close. Failed unlink can retry the
same surviving inode; after-effect errors, substituted parents and reappearing
markers remain held. Legacy cleanup refuses native markers and unreadable markers
without a known saved owner.

Types and all 398 cases in eight affected files pass
(`20261013T191913.761725Z-31304`, 23.0/191.2 seconds), including architecture.
The complete mutation baseline and all 12 deliberate wiring faults pass by
assertion (`20261013T192340.928092Z-46531`, 188.2 seconds). Earlier runs
`20261013T190631.497090Z-87372` and `20261013T191504.080084Z-17800` remain
failed evidence: fixtures reused a Cancel ID, mutated a frozen request, expected
a removed durable result to stay failed, or lacked explicit legacy ownership.
No golden was changed. Independent review approved this scope over `4fbc56b11`
after correcting full-request matching, descriptor acquisition and pre-unlink
uncertainty. The approval excludes production orchestration and activation.
Implementation/review ran approximately 19:00–19:27 UTC October 13, with
validation overlapping 19:06–19:27. Merge, release and external waiting remain
zero. Saved recovery, physical adapters and integrated acceptance remain open.

Saved Resume recovery now crosses the original archive-to-live handoff without
re-reading the archive leaf that the Store intentionally consumes. It verifies
the exact committed target, cancellation and replacement before adopting that
returned owner, then retains the full original request and transferred archive
through receipt confirmation. Cold Registry/Store recovery covers interrupted
pending-route, archive-transfer and live-admission publications. Recovery never
receives a launch callback.

An already confirmed receipt is independently readable after its engine exits,
even while all four actual native-read slots remain occupied. The reader requires
the full original request, explicit confirmation and process witness. It validates
one coherent image and retains every original file and absence; later proof checks
do not recursively fsync it. A contradictory late effect whose result publication
fails still invalidates the proof through its retained in-memory result.

Independent review found and corrected three races: a saved hold must recheck its
original leaf and current target/control after Registry absence verification;
the five-second deadline starts before receipt preflight; and completed receipt
proofs must retain contradictory memory-only outcomes as well as disk evidence.
Actual native reads keep their slots after bounded replies. Final confirmation
tests call the original bound publisher, avoiding an unbound or recursive mock
that could accidentally pass by throwing before publication.

Types and all 449 cases in six affected files pass, including architecture and
100% statements, branches, functions and lines for the recovery controller
(`20261013T195146.225073Z-46072`, 5.3/145.8 seconds). Complete mutation baselines
and all 28 deliberate recovery wiring faults pass by assertion
(`20261013T195432.467497Z-55983`, 116.7 seconds). No golden changed. The earlier
`20261013T193527.857125Z-86260` remains failed: repeated durability checks caused
13 test timeouts, and an unbound fixture publisher caused another failure. The
447-case run `20261013T194617.502407Z-27662` is not reusable evidence: a readonly
fixture assignment failed types and generated coverage output changed the source
fingerprint. The fixture is corrected and coverage now goes to an ignored folder.

Independent review approved this recovery slice over `2803d6f2d`, conditional on
the now-completed gates. Implementation/review ran approximately 19:28–19:57 UTC
October 13; validation overlapped 19:35–19:57. Merge, publication and external
waiting remain zero. Physical adapters, orchestration, activation and full-PR
acceptance remain open and are excluded from this scoped approval.

Current main `ce68e2fac` was then integrated without conflicts. The new optional
usage ports and HTTP settings routes leave native recovery source unchanged.
Types and all 162 architecture, API, gateway-link, private HTTP and usage-signal
interaction cases pass (`20261013T195758.514021Z-72326`, 15.4/7.5 seconds).
Independent review found no native interaction blocker in this integration delta;
it does not approve activation or the full PR. Validation ran at 19:58 UTC.

The pre-exec witness now records its original PID namespace with canonical
boot/PID/birth evidence. Both scope observations prove the actual
`agent-creations` directory, including its local filesystem, and retain that
directory through the final paired writer/shell observation. Success checks the
original deadline after both descriptors close. Scope-less older witnesses remain
readable but cannot supply cross-namespace death authority. No golden changed.

Types and all 306 cases in seven affected files pass, including the installed
writer/private tmux lane, unchanged launch golden and architecture
(`20261013T201020.983441Z-15318`, 4.9/98.5 seconds). Complete mutation baselines
pass and all 24 deliberate wiring faults fail assertions
(`20261013T201309.751896Z-25571`, 135.2 seconds). Independent review approved the
slice over `0c64e141f` after correcting parent-only locality and post-cleanup
deadline checks. Implementation/review ran approximately 20:00–20:13 UTC October
13; validation overlapped 20:02–20:16. Merge, publication and external waiting
remain zero. Ordinary Cancel scope capture, physical Stop and activation remain
outside this scoped approval.

Confirmed generation sources now retain the original engine's PID namespace.
The dedicated owner reader proves the actual Registry directory, stable local
storage and kernel boot around two precise native observations, under one
original deadline. Ordinary hook admission and caller ancestry retain their
existing probe cost. Journal owner bytes remain unchanged. A later source cannot
replace the first confirmed namespace, and cold recovery restores that pin from
the saved Cancel. Cancel copies the association before revoking input; retries
cannot enrich legacy or unknown owners with later scope evidence.

All 448 cases in twelve files passed, including private HTTP recovery,
persistence, unchanged owner/journal/launch goldens and architecture
(`20261013T202953.480629Z-82853`, types 24.1 seconds, tests 269.0 seconds). That
receipt remains failed because three older retirement branches lacked coverage.
Focused complete intent/Cancel/projection files now pass all 167 cases at 100%
statements, branches, functions and lines; types also pass
(`20261013T203754.416927Z-9934`, 4.8/1.4 seconds). An intermediate focused run
missed the archive-link branch and remains failed. The earlier superseded run
was cancelled after a typed mock failure; it is not passing evidence.

Complete mutation baselines passed and nineteen of twenty-one variants failed
assertions in `20261013T203810.348276Z-10621` (237.3 seconds). Two test weaknesses
were corrected: require an explicit source notification before dereferencing it,
and use a different canonical birth so malformed-input rejection cannot mask
the process-key check. All six affected private HTTP cases and types then passed
(`20261013T204254.821167Z-26088`, 5.1/19.5 seconds); both corrected healthy cases
and their assertion-failing mutants passed
(`20261013T204328.116940Z-29069`, 16.1 seconds). Runtime source did not change
between these receipts. No golden changed.

Independent review approved this slice over `5590686ee`, conditional on these
completed checks. Review found the original namespace-substitution gap and a
missing pre-split input bound; both are corrected. Implementation/review ran
approximately 20:16–20:43 UTC October 13, with overlapping validation through
20:44. Merge, publication and external waiting remain zero. Pending-R original
engine provenance, physical Stop, activation and actual configured-client cost
remain outside this scoped approval.

Restart now preserves the original engine independently of its new allocation.
Every new R copies the original Cancel process key and namespace into immutable
`sourceProcess`; Cancel during preparation retains that association even when
the replacement has no witness. Explicit unknown ownership remains unknown, and
older R records remain readable without acquiring new authority. Exact request
matching in the pre-exec witness, replacement proof and saved cleanup includes
this association. Cold Registry and receipt recovery cover cancellation both
before and after the exclusive dispatch claim.

The initial complete affected run passed 884 cases and failed four new witness
fixtures because they attempted to mutate a frozen request
(`20261013T205053.667223Z-54392`, types 4.8 seconds, tests 263.2 seconds).
Those fixtures now copy the request before introducing their fault. All 321
cases in the four complete affected files pass with 100% statements, branches,
functions and lines, and types pass
(`20261013T205547.275064Z-70835`, 4.9/65.0 seconds). The other thirteen files in
the earlier run passed, including the installed writer/private tmux lane,
archive handoff/return, recovery, unchanged launch golden and architecture.
The earlier superseded run was cancelled after an optional-fingerprint defect
was found; it remains cancelled evidence. No golden changed.

Complete mutation baselines pass and all thirteen deliberate provenance faults
fail assertions (`20261013T205707.238296Z-75614`, 114.3 seconds). Independent
review approved the sourceProcess slice over `158315326`, conditional on these
completed gates. Implementation/review ran approximately 20:44–20:57 UTC October
13; validation overlapped through 20:59. Merge, publication and external waiting
remain zero. Physical Stop and activation remain outside this scoped approval.

The former completion and Resume cleanup golden was recorded before sharing
their five-part receipt validation, in its own commit `1034bfdcc`. It pins Linux
and Darwin, prohibits host binaries and uses disposable private files. Its
unchanged verification and types pass (`20261013T210502.204684Z-2606`, 5.6/9.4
seconds). The shared reader retains the primary, claim, result, confirmation and
process records, including exact absences, confirms durability and performs later
verification without repeated fsync. Contradictory in-memory outcomes still
revoke the proof.

The physical adapter can now account for a cancelled request or a durable
`NATIVE_REARM_NOT_DISPATCHED` result through that same reader. A bare cancelled-ID
tombstone covers Cancel between R and receipt publication, but supplies only an
ID dispatch veto: it exposes no invented request data and requires the caller's
separately retained exact R. None of these outcomes proves the old engine dead.
A claimed allocation with no witness remains unknown.

The first affected run passed 335 cases and failed ten new fixture calls that
passed functions instead of plain request data
(`20261013T210850.255853Z-15382`, types 28.1 seconds, tests 93.5 seconds). All
positive and negative calls were corrected. The complete three receipt/golden
files pass 200 cases with passing types
(`20261013T211041.741025Z-20640`, 4.8/56.5 seconds); the other three full files
in the earlier run passed 145 lifecycle/recovery/architecture cases. Complete
mutation baselines and ten assertion-failing variants passed in
`20261013T211155.150851Z-25082` (70.5 seconds). One positive fixture needed an
explicit assertion before dereferencing its proof; its corrected healthy case
and mutant pass (`20261013T211354.108942Z-32521`, 1.7 seconds). All eleven faults
are caught by assertions against unchanged production source. Failed receipts
remain failed evidence, and the golden is unchanged.

Independent review approved this extraction and reader over `1034bfdcc`,
conditional on those completed gates. Implementation/review ran approximately
21:04–21:12 UTC October 13; validation overlapped through 21:14. Merge,
publication and external waiting remain zero. Physical production wiring and
activation are still excluded. Current main remains `ce68e2fac`.

Native rearm wrappers now claim a pane-local allocation marker before engine
exec and revoke it before fallback code or shell startup. Every claim, release
and close checks the current daemon owner, original launch prefix, root PID and
pane identity inside the tmux command queue. Released and foreign markers cannot
be reclaimed. Missing acknowledgements, including a successful mutation whose
reply was lost, leave an inert wrapper. A stalled client is bounded. Original
PID and start-command evidence alone cannot authorize killing a manual successor.

Types and all 211 cases in seven complete files pass, with one pre-existing skip
(`20261013T212135.365053Z-69443`, 4.8/93.4 seconds); both launch goldens are
unchanged. Additional true lost-acknowledgement and causal identity cases pass
with types in the two complete private-tmux/writer files: 42 cases
(`20261013T212605.294350Z-91341`, 4.8/35.6 seconds). Complete mutation baselines
pass and all eleven deliberately broken marker/wrapper faults fail assertions
(`20261013T212752.116063Z-98990`, 65.4 seconds). An earlier invocation omitted
`/bin` from PATH and remains failed evidence, including its cleanup warning;
a subsequent process audit found no remaining validation children.

Independent review corrected foreign-marker overwrite and stale-prefix owner
substitution, then approved the scoped change conditional on these gates. Initial
non-rearm launches, physical Stop composition and activation remain excluded.
A future same-pane relaunch needs explicitly fenced marker transfer; it must not
weaken claim to overwrite a successor. Implementation/review ran approximately
21:15–21:28 UTC October 13, with validation overlapping through 21:29. Merge,
publication and external waiting remain zero.

The physical Stop producer now uses guarded tmux closure as its only destructive
operation, then independently proves every retained engine incarnation dead.
Numeric PID signals are not incarnation-bound and are not used. A released
allocation preserves the manual fallback; a detached surviving engine holds
retirement. The caller must supply a durable exact allocation association: every
tmux read and close uses its original explicit binary/socket and server
boot/PID/birth/namespace. An unrelated inventory or a missing socket while that
server lives cannot prove absence.

Independent filesystem scopes and receipt proofs stay alive through synchronous
Registry retirement. Only the consumed Registry source leaf is excluded from the
returned physical proof. Original ownership is checked after independent proofs,
and cheap lifetime/deadline checks run last, including after descriptor cleanup.
Four actual operations remain bounded even after their replies expire. Darwin's
maximum admitted four-allocation/four-engine/two-root path needs 228 subprocess
probes; this caller permits at most 256 under the unchanged three-second deadline.
Other native readers retain their 64-probe default. Async retirement callbacks
are rejected and later rejection is contained.

Types and 151 cases in five complete files pass, including real installed-writer
and private-tmux closure, released fallback, lost close reply, detached survivor,
architecture and the default native evidence limits
(`20261013T215231.275871Z-20187`, 5.0/47.4 seconds). Complete healthy mutation
baselines pass and sixteen faults fail assertions
(`20261013T215434.253806Z-33383`, 50.1 seconds). The seventeenth test revoked at
the first rather than final callback; its corrected complete 79-case file and
types pass (`20261013T215614.837438Z-45817`, 4.9/0.8 seconds), and its healthy
case plus mutant pass (`20261013T215648.168975Z-47884`, 1.5 seconds). All seventeen
faults now fail assertions against unchanged runtime source.

Earlier failed receipts remain failed: the initial fixture/type mistakes, tmux
format delimiters replaced under the C locale, and a fake engine surviving pane
closure. The latter confirmed the required hold behavior and exposed fixture
cleanup that assumed tmux killed its children. Fixtures now have their own
lifetime files and unconditional teardown; 24 survivors from the three exact
failed-run roots were terminated and audited absent. The two completed corrected
fixture roots also have no remaining engines. No owner daemon, home or server was
used, and no golden was changed.

Independent review approved the producer source after endpoint, final-fence,
async-rejection and probe-budget corrections, conditional on these completed
gates. Durable allocation selection, public lifecycle composition, initial
launches and activation remain excluded. Implementation/review ran approximately
21:33–21:56 UTC October 13, with overlapping validation through 21:57. Merge,
publication and external waiting remain zero.

Admitted native replacements now retain an ordered, immutable `nativeAllocation`
list on row schema 4. Each entry is the complete original creation request and
its semantic fingerprint, including the pre-admission target and any recorded
source process. Cancel may clear R without erasing these physical obligations.
Registry registration, stale merges, archive/return, saved edits and cold reads
preserve the list. Only the proven replacement admission appends; generic control
publication cannot introduce a replacement. Ordinary removal, unbinding or
process adoption cannot discard or reinterpret allocation authority.

The four-entry bound is reserved before preparation or dispatch. Reused request
IDs and launch tokens hold before effects. This is a storage/preservation slice,
not the final physical selector: the oldest source process can add a fifth engine
obligation. Exact accounting and proof-backed compaction must be composed before
activation; reaching four healthy cycles must not become permanent exhaustion.
Schema 4 currently describes rearm receipts and requires native control. Initial
creation still needs its own explicit request variant. Missing or downgraded
authority holds the complete file instead of being normalized away.

The former row-persistence golden was recorded separately in `53e34eadf` before
the move, with pinned platform/time, placeholder paths and no host subprocesses.
Its clean baseline and types pass (`20261013T220504.581892Z-84135`); the two earlier
typed-fixture/recording receipts remain failed. The first implementation lane
passed 664 of 667 cases and types but exposed the recovery owner's missing
allocation append (`20261013T221218.911348Z-16179`). The corrected nine complete
files pass all 539 cases with types and 100% statements, branches, functions and
lines for both changed core controllers (`20261013T221945.065874Z-49362`,
24.7/147.5 seconds). The other complete files in the first lane passed installed
writer/private tmux, notify, witness and architecture checks; that aggregate is
still failed evidence.

Healthy mutation baselines pass. Nineteen allocation faults fail assertions in
`20261013T222424.319027Z-69240`; the remaining fault initially caused a missing-row
exception. Its explicit existence assertion now fails causally. The corrected
fault, four affected older persistence faults, types, unchanged golden and
architecture pass in `20261013T222614.793869Z-76813` (23.8 seconds). All twenty
allocation variants are caught against unchanged runtime source. That final
receipt also bundles the actual former Registry from `53e34eadf` and confirms
that it refuses mixed schema-2/schema-4 writes while retaining the original
bytes; this is former-writer compatibility, not full installed-client acceptance.

Independent review corrected recovery's expected post-admission image, retained
token reuse, and generic replacement publication. Its scoped approval excludes
initial creation, physical selection/counting/compaction and activation.
Implementation/review ran approximately 22:00–22:26 UTC October 13, with
overlapping validation through 22:27. Merge, publication and external waiting
remain zero. No compatibility golden was changed by the implementation.

The pre-exec witness now retains its original pane/root and tmux endpoint/server
incarnation. The wrapper binds its actual tmux binary snapshot and daemon owner
into a version-2 request, and requires a separate shipped pane-witness capability
before dispatch. `TMUX` and `TMUX_PANE` supply candidates only. The writer proves
its own child relationship, the fixed exec shell, the pane root's original tmux
parent and that server's native image, under the original boot/namespace scope.
The existing bounded endpoint reader must observe the exact active token and
owner before publication and again after durability and final scope acquisition.
A final quartet probe and dependency/receipt/scope fences precede exec.

Allocation metadata is part of the immutable process checksum and confirmation.
Every receipt path checks its launch token against the original request, not the
independent dispatch claim. Nested root/server/endpoint data is copied and frozen.
Legacy version-1 requests and witnesses remain readable with their original
omissions; recovery cannot fill missing provenance from today's processes. The
private physical Stop fixture now consumes the persisted association instead of
synthesizing an endpoint after launch. This does not yet implement selection of
every retained receipt or compaction.

All 523 cases in ten complete affected files pass, with one existing skip,
including the shipped writer/private tmux, physical Stop, receipt and initial
launch goldens, and architecture (`20261013T223630.576126Z-21902`, 166.1 seconds).
That aggregate remains failed because its typecheck found an empty optional-env
test fixture. Corrected types and all 102 cases across the complete writer and
native launch/row compatibility goldens pass
(`20261013T224019.648731Z-40833`, 4.8/32.7 seconds). No golden was changed.

Healthy mutation baselines pass. Eighteen new faults fail assertions in
`20261013T224151.688876Z-47043`; the reader-loss fault initially raised a storage
error before the positive assertion. Explicit success now makes that fault fail
an assertion. Its corrected healthy/fault pair, three affected former writer
faults and types pass (`20261013T224253.441978Z-51481`, 16.8 seconds). All nineteen
new faults are caught on unchanged runtime source. Independent review found no
source blocker, conditional on these completed gates; physical selection,
compaction and activation remain excluded. Implementation/review ran about
22:29–22:43 UTC October 13, with overlapping validation through 22:44. Merge,
publication and external waiting remain zero.

Physical Stop now selects the complete retained ownership set before any effect:
every admitted original receipt, a separate revoked pending R, their original
source and witnessed engine incarnations, and the latest non-null Cancel owner.
Unknown original scope or pane provenance holds; neither null Cancel nor a missing
witness discharges an older obligation. Only an exact known-not-dispatched receipt
can account for a pending launch without a witness. Admitted launches require their
witness. Deduplication uses the whole process incarnation and server/pane identity,
so endpoint aliases cannot conceal a conflicting pane lifetime.

Four confirmed receipts and a separate pending request can retain six engines and
five panes. The bounded complete Darwin path consumes at most 289 subprocess
probes, within an explicit 320-probe allowance; other readers retain their default
64. The selector creates the budget before cloning or receipt reads and passes
that exact object through physical I/O, the reply timer and descriptor cleanup.
A slow selection cannot grant physical work another three seconds. Expired replies
retain actual I/O slots. Independent receipt verification survives intentional
source retirement and is separate from the Registry/Store fence.

Types and all 211 cases in seven complete files pass, including installed-writer
and private-tmux cases, former receipt compatibility and architecture
(`20261013T225848.047138Z-26241`, 25.1/47.4 seconds). The initial aggregate remains
failed: its typecheck passed but the evidence constructor still capped explicit
probe counts at 256, rejecting the new 320-probe producer. Independent review also
caught a refreshed reply deadline and duplicate receipt verification; both are
corrected with composed cold-receipt/physical retirement and stalled-I/O tests.

Healthy mutation baselines pass. Twenty-one of twenty-two selector/composition
faults fail assertions in `20261013T230156.845383Z-44269` (22.4 seconds); the remaining
positive case initially raised a plain hold. Its explicit success assertion now
catches that fault. Corrected healthy/fault evidence, the affected former physical
budget fault, types and the complete final selector file pass in
`20261013T230246.991035Z-47771` (11.8 seconds). Runtime and compatibility goldens are
unchanged between these gates. Review approved the corrected source conditional
on these completed gates. Initial creation, same-pane lifetime transfer,
proof-backed compaction and public activation remain excluded. Implementation and
review ran approximately 22:44–23:04 UTC October 13 with validation overlapping;
merge, publication and external waiting remain zero.

First creation now has an explicit `native-create-v2` receipt request. It retains
the original preallocated agent ID, launch token, label and complete user choices
before preparation. Retries with the same semantic fingerprint keep that first
request; they cannot substitute newly generated identities. Initial creation has
no predecessor process or synthetic Cancel. Its request is bounded to 24 KiB
before publication, leaving room in the allocation ledger for later rearm
references. Depth, entries and array length are bounded before serialization;
sparse arrays cannot expand beyond the bound during JSON encoding.

The existing intent/claim/process/result/confirmation protocol now supports this
explicit kind. A first launch requires complete namespace and pane/server
provenance, an exact initial `created` outcome, and a witnessed confirmation.
Opening a pane alone remains unconfirmed. Only the original process-record
publisher receives an exec permit; a cold retry or an interrupted directory sync
never grants another. Rearm-only readers continue to reject initial requests,
and initial known-not-dispatched evidence has its own exact outcome code.

The former first-create receipt golden was recorded in its own commit
`f82c49ea1`, before changing the reader/writer, with pinned Linux/Darwin platforms,
UUIDs, placeholder paths and forbidden host subprocesses. Its recording receipt
`20261013T230817.392887Z-71060` is source-changed, not a passing aggregate;
unchanged playback passes in `20261013T230923.548272Z-76194` (2.1 seconds).
Six unchanged generic/rearm receipt, compatibility/golden and architecture files
pass in `20261013T231518.814704Z-1958`; that aggregate remains failed because two
new interrupted-publication tests expected an unwrapped filesystem error.
The next aggregate `20261013T231903.298126Z-17139` also remains failed: its parser
and types passed, but the already-confirmed process retry correctly conflicted
instead of returning an unconfirmed retry result. Those test expectations are
corrected. Final complete parser/initial-receipt baselines, all 18 new assertion
faults, three affected older receipt-accounting faults, and types pass in
`20261013T232228.990147Z-34287` (41.9 seconds). The earlier compatibility goldens
remain unchanged.

Independent review caught sparse-array expansion, hidden custom JSON methods,
and hidden required fields that disappear from durable JSON. The parser now
rejects custom serializers/accessors without invoking them, then checks semantics
on its bounded plain-data copy. Review also required a positive first-publisher
permit assertion. Final complete parser/receipt baselines, all four affected
parser faults and types pass in `20261013T233036.493922Z-73751` (18.9 seconds).
All 21 new faults are caught by assertions across the final and earlier receipts;
the earlier shared-receipt evidence remains applicable. The intervening
`20261013T232851.376873Z-65685` aggregate failed on a recursive accessor in its
test oracle, corrected in the passing `20261013T232953.280816Z-70432` receipt.
Independent review approved the corrected scope conditional on the now-passing
gates. This is
receipt mechanics only: pending/admitted Registry ownership, the initial writer,
same-pane transfer, compaction and public activation remain required. Work began
about 23:05 and finished about 23:32 UTC October 13, with implementation, review
and validation overlapping;
no merge or publication occurred.

Initial admitted allocations now retain that exact first receipt in version 2
of the ledger, uniquely first and followed only by rearm receipts. Schema 5 is
the admitted first launch before any Cancel; its first Cancel becomes schema 4,
which still requires native control. Losing Cancel therefore cannot reinterpret
a cancelled row as a fresh admission. Cold reads, generic registration, stale
merges and saved edits preserve this distinction and the original metadata.

Stop reads the initial witness through its dedicated reader and does not invent
a predecessor. It includes that original engine and pane alongside later rearm
obligations. A missing admitted initial witness holds, even if a not-dispatched
record exists. Real cold receipt tests cover initial-only and mixed initial,
admitted rearm and cancelled pending rearm histories, including replacement of
the initial process record after selection.

The former admitted-allocation golden was recorded alone in `1a3ff8c92`, before
the move, with pinned Linux/Darwin, time and placeholder binaries/paths. Unchanged
playback and types pass (`20261013T233613.500492Z-97781`, 2.0/4.8 seconds).
Recording receipts `20261013T233520.073451Z-94590` and
`20261013T233559.808386Z-97176` remain failed/source-changed. The first implementation
aggregate (`20261013T234102.500350Z-18498`) passed 553 cases but failed four legacy
row migrations and types: retaining the raw schema also retained an absent legacy
schema. Explicit 5/4/3/2 normalization restores legacy behavior. Corrected types
and all 296 cases in the three complete Registry/control/Stop files pass
(`20261013T234612.701772Z-42654`, 5.8/85.1 seconds); ten unchanged complete files
from the earlier run retain their passing evidence. No golden changed.

Healthy mutation baselines, all 17 new assertion faults, two affected prior
schema faults and restored types pass (`20261013T234938.041422Z-59633`, 38.3 seconds).
That gate also bundles the actual former Registry and allocation parser from
`9605c4906`: both mixed schema-2/schema-5 and schema-2/schema-4/version-2 tables
are refused without changing their original bytes. Independent review approved
the corrected decoding, preservation and Stop scope conditional on these now
completed gates. Trusted initial admission, its writer, pending ownership and
public activation remain required. Implementation/review ran about 23:33–23:54
UTC October 13, with overlapping validation; merge, publication and external
waiting remain zero.

Pending first creation now retains the original request before a pane or engine
exists. Schema 6 is inactive, unbound and visibly held; only this complete shape
may have zero routes. The original claimed callback fills resolved launch choices
once and associates the complete pane/server/root allocation. Generic discovery,
hooks, metadata changes and archival cannot promote or discard it. Cancel retains
the request and allocation, revokes further preparation and remains sticky after
a cold read. This persistence boundary does not activate a launcher or controller.

Independent review corrected late authority loss during directory sync, retained
the actual publisher through confirmation, and made an uncertain reservation retry
confirm its original timestamp and choices. The final readback checks the original
authority and exact committed owner after all filesystem work. Review approved
this persistence scope conditional on the now-completed causal checks; production
integration remains excluded.

The former admitted-row golden was recorded alone in `b75ddf090`. Unchanged
playback and types passed in `20261013T235840.196487Z-13840`; the recording receipt
was source-changed and is not passing validation. The first implementation gate
`20261014T000550.980432Z-47028` failed zero-route normalization and a required pane
type, while eleven existing complete files passed. The next focused run
`20261014T001333.886950Z-84377` passed all 44 cases but failed one test callback type.
After those corrections and the final readback cases, types and all 49 cases in
the complete pending-creation file and three unchanged goldens pass
(`20261014T002001.037178Z-15347`, 27.3/18.0 seconds). No golden changed.

Healthy baselines, all thirteen new assertion faults, three affected earlier
faults, and restored types pass in `20261014T002414.492592Z-40610` (42.6 seconds).
That gate bundles the actual former Registry source closure from `b75ddf090`:
mixed ordinary/pending tables are refused without changing bytes, for zero-route,
associated and cancelled pending rows. The extracted placement parser retains
the engine-scope check, including a coherent foreign pane/server pair.
Implementation/review ran approximately 23:58 UTC October 13 through 00:28 UTC
October 14, with overlapping validation. Merge, publication and external waiting
remain zero. The next gate is installed-client integration, not another storage
mechanism.

Before activation, compose the implemented native marker cleanup with early
Cancel: an exact durable cancel claim or on-disk known-not-dispatched result,
retained absence of process/confirmation evidence, the original revoked saved R
and confirmed Registry absence. Publish the full native intent before its marker,
finish cleanup before clearing R, and keep delayed preparation revoked. Missing
markers and request-less tombstones cannot supply that full-request proof.

The physical Stop adapter must independently account for the original engine and
reserved pane. Legacy process-table absence, executable mismatch and rounded birth
timestamps are not sufficient signal or retirement authority. Use precise native
boot/PID/birth and fresh image evidence at each signal boundary, and a token-bound
predicate inside tmux at pane close. Death observations need the existing writer
scope rules: proven local storage, a matching PID namespace/view, stable kernel
boot and canonical birth values. An unavailable observation holds. Keep the
consumed Registry source leaf inside Registry's own compare-and-publish operation;
the stopped-allocation proof retains its receipt and scope separately. These are
requirements for the remaining adapter, not claims of implemented behavior.

October 13 recap checkpoint: the recaps port now derives a bounded summary from
the exact answer retained for an owner and generation. Core copies the input
before a service wait and checks the reply's generation identity, input digest
and derivation version. Missing service or mismatched content returns a visible
hold. `ready` means derived, not saved, delivered or acknowledged.

The native journal already retains the answer; no second persistence system is
needed. This port never reads the latest transcript, changes legacy session
history or live cards, writes recap files, or emits notifications. Reconnect and
late A requests cannot overwrite B. Activation must reacquire the source proof
and the original one-use presentation token after a service wait. A successor,
Cancel or recovery revokes that token permanently; retries remain bounded and
cannot delay turn closure.

Receipt `20261013T075143.150202Z-30240` passes types and 149 cases in eight files,
including architecture and unchanged legacy recap behavior, with 100% per-file
statements, branches, functions and lines for the five covered modules. The
earlier receipt `20261013T074945.072192Z-23122` remains failed: its 144 passing
cases omitted existing conversation fallback coverage. Adding those existing
tests completed the scope without changing source or goldens. All ten identity,
digest, version, caller-mutation and service-wiring faults fail by assertion in
`20261013T075325.247733Z-36085` (11.9 seconds), after passing their baselines.

Independent review approved this delta over `1604b9b89`, conditional on the now
completed checks. It is not activation or whole-PR approval. Implementation and
review ran approximately 07:34–07:55 UTC, with validation overlapping. Merge and
publication remain zero. Durable Cancel/rearm, atomic composition, bounded recap
retry/presentation and final installed-client acceptance remain required.

October 13 task checkpoint: native turns now carry bounded, immutable task
observations keyed by agent, conversation, process incarnation, generation and
tool ID. Duplicate observations coalesce; conflicting inputs stay ambiguous.
A pre-tool hook observes a request that another hook can still deny. A parent
Stop, including one received before the task, retires only that generation's
observation. It does not claim that the child executed or succeeded. Unconfirmed
results retain an explicit reason without keeping the parent turn open.

The installed Cursor source allows a child session to be resumed while preserving
its original creation metadata. The old child reader combines an earlier terminal
marker with latest text, so neither a separate manager instance nor a fresh parent
permit makes that text the original task's result. Native snapshots therefore do
not use that reader, its timeout-success path or its delayed session-wide close.
They also do not emit ordinary tool frames: current clients can clear a successor's
activity by tool name. Optional exact-result enrichment can be added only with
native task-result correlation; it is not required for parent turn closure.

Receipt `20261013T072509.087715Z-23955` passes 211 focused cases in eight files,
including unchanged legacy task-queue cases and architecture, with 100% per-file
coverage in the three covered core modules. Its aggregate remains failed because
of test-owner type annotations; the follow-up type-only attempt also remains
failed. Corrected immutable fixtures pass types in
`20261013T072824.711021Z-36079`. All nine deliberate identity, retirement, conflict
and controller-wiring faults fail by assertion in
`20261013T072949.847197Z-40398` (6.8 seconds), after passing both full focused
baselines. Runtime source and goldens were unchanged by the fixture corrections.
Independent review approved this scope over `ff26758e5`, conditional on those
completed gates. Implementation and review ran approximately 07:18–07:31 UTC,
with validation overlapping. Merge and publication remain zero. This projection
is not activation: recap isolation, durable Cancel/rearm, atomic composition and
final installed-client acceptance remain required.

October 13 pinned-control checkpoint: model and question control reserve their
original conversation before optional preparation and retain one native proof
through every later capture, literal, paste, key and cleanup. Revocation settles
logical admission waiters immediately, but leaves the old driver's pin in place
until that driver releases it. Late reads cannot adopt replacement authority.

Cancel has a separate, fixed C-c port with its own fresh terminal lease, supplied
writer interrupt ticket and required native predicate. It cannot reuse or remove
the revoked driver's pin. Atomic activation must call it only within the original
one-use durable cancellation dispatch, through the shared writer's interrupt.

Receipt `20261013T070022.871239Z-33798` passes types and 373 focused cases with
100% per-file statements, branches, functions and lines in the five covered core
modules. The earlier `20261013T065709.733470Z-22107` remains failed: it caught
the revoked driver's pin incorrectly blocking Cancel, alongside two fixture
corrections. Independent review approved the corrected scope over `66f1af8a7`;
this is not whole-PR approval or native activation acceptance.

All nine native-control, ten writer and nine input fault oracles fail by assertion
in `20261013T071008.826384Z-67270` (34.1 seconds). The prior mutation receipt
`20261013T070825.642294Z-60683` remains failed: an extra dispatch check masked the
older deadline mutation. Extending the test to the final check immediately before
the actual process spawn catches that fault again. Production source and goldens
were unchanged by that test correction. Implementation and review ran approximately
06:45–07:13 UTC with validation overlapping; merge and publication remain zero.
Generation-scoped task/recap consumers, durable Cancel/rearm, atomic activation and
final installed-client acceptance remain required.

October 13 history/admission checkpoint: native input and answer admission now
requires a fresh confirmed generation frontier. Running work holds new input and
ordinary control; an answer can target one running generation, with its original
proof checked again at dispatch. Ambiguous generations and recovered cancellation
hold all admission. A submitted prompt alone is not execution: another native
hook can reject it without ever producing Stop.

The inactive history-only boundary excludes transcript replay from input,
device delivery, resumption, recap and client lifecycle. Independent review found
that existing clients still interpret replayed ends and text/tool frames as live
activity. The corrected path sends no such frames, including the first attach
queued before the funnel is armed. Native JSONL remains available through the
existing history and search read ports; native facts must supply live projection
when the pieces are activated together.

Receipt `20261013T064038.964786Z-61671` passes types and 390 focused cases with
100% per-file statements, branches, functions and lines for the four changed
core modules. All ten deliberate admission/history faults fail by assertion in
`20261013T064202.082358Z-66233` (19.4 seconds). Earlier receipts
`20261013T063515.651578Z-45432` and `20261013T063653.036521Z-50533` passed their
narrow assertions but predate the client-fanout review correction; they do not
validate that final boundary. Goldens remain unchanged.

Independent review approved this checkpoint over `6ee935a3d`, after inspection of
the corrected client boundary. It is scoped approval, not approval to activate or
land the PR. Implementation and review ran approximately 06:25–06:43 UTC with
validation overlapping. Merge and publication remain zero. Atomic native turn,
task and recap activation, durable physical Cancel/rearm and final acceptance
remain required.

October 13 input checkpoint: the inactive native input path now separates physical
delivery from generation execution. It never acknowledges a request by prompt
text, clears a composer from a hook, or retries a possibly dispatched paste/Enter.
Accepted messages retain their original owner and caller authority through an
outage, with a visible hold and no expiry. Shared writer reservations keep their
acquired epochs between attempts; unavailable capacity can recover without
renewing an epoch revoked by Cancel.

Individual cancellation revokes logical preparation and device waiters immediately.
Actual reads and pane commands retain their capacity until they settle. Every paste
and Enter rechecks the original native proof and Agent Messages' sender authority.
Unreadable screens, missing composers and multiline human drafts hold input. The
current Cursor source clears its controlled prompt after normal submission; the
tests observe that empty composer for the next message. A retained older echo is
ambiguous and stays held rather than being cleared by text equality.

Receipt `20261013T061644.504418Z-80039` passes types and 272 focused tests, including
the real terminal adapter with private subprocess fixtures, at 100% statements,
branches, functions and lines in all four changed core files. Earlier type and
coverage failures remain failed receipts. `20261013T061921.319183Z-88269` passes
all nine new input and ten existing writer mutation oracles by assertion. The
retained-epoch mutation now checks the original ticket directly: per-request
revocation also prevents the old composition from writing, so that test alone no
longer detects removal of the shared epoch guard. No golden was changed.

Independent review approved these input corrections conditional on those completed
checks. This is scoped approval; the input factory is not active in main. Atomic
history/input/task/recap activation, durable physical Cancel and explicit rearm,
private installed-client acceptance and final PR gates remain required. Native
activation must also fence delayed question/model control and retire the original
queued input on explicit Cancel/rearm. Implementation and review ran approximately
06:00–06:20 UTC with validation overlapping; merge and publication remain zero.

October 13 resume checkpoint: current main `6f0a3e6e2` is integrated in
`8ab5998dc`. The draft remains unfinished. Recovery now fixes its presentation
baseline from the confirmed process journal before this core admits a new
delivery, including native facts still represented only by pending intakes.
Each generation distinguishes a recovered start and recovered end. The first
live hook is no longer hidden merely because it beat SessionStart or the first
asynchronous read; a late response cannot repeat a recovered completion.

Three regressions fail by assertion on the former controller in receipt
`20261013T053034.829769Z-11348`. The corrected types and 176 focused cases pass
with 100% controller/content coverage in `20261013T053438.270313Z-30445`.
That aggregate is **failed**: 52 of 54 private HTTP cases pass, while two fail
on an unsealed receipt namespace and a changed directory route. A bounded
comparison of just those two cases passes against both the former and corrected
HookServer (9.5 and 9.7 seconds); it does not establish their original cause.
The earlier sandbox-denied cleanup receipt remains failed too.
Receipt `20261013T054236.311900Z-58833` passes the pending-intake recovery followed
by a genuinely new fact, and all twelve control/content/recovery wiring mutants
fail by assertion (26.7 seconds together). The journal golden is unchanged.
Independent review approved this correction conditional on the now-passing
pending-intake case; this is not whole-PR approval or final HTTP acceptance.

Implementation and review of this correction ran approximately 05:29–05:43 UTC,
with validation overlapping; merge and publication remain zero. The resumed
private Stop acceptance still fails with the verified macOS process helper
(`20261013T052456.406905Z-82664`). Its first attempt lacked that helper and failed
before launch, so it did not exercise completion. Native activation must require
the explicit recovery baseline, separate history and native execution from input
delivery, and complete the Cancel/rearm and generation-scoped consumer boundaries
below. The raw two-request client is legacy compatibility coverage; healthy
native acceptance must execute the command installed by current Cursor settings.

October 12 pause checkpoint: the owner requested the finished idle Close/Stop
safety correction be landed as [#1251](https://github.com/autonomous-ai/openharness/pull/1251),
then further daemon work paused. This draft (#1172) remains unfinished and must
stay draft. The focused correction does not activate this native-turn integration.

The shared pane-writer checkpoint `afa181901` was independently reviewed. Its
integration with main, `c9a6ef858`, passed typecheck, full core/services and
harnessd per-file coverage, and the selected input, hook, terminal and unchanged
golden checks in receipt `20261012T080128.104292Z-15248`. This is scoped evidence,
not final native-client acceptance or whole-PR approval.

Native generation activation in the composition root, generation-specific turn
effects, durable Cancel/rearm and the private healthy/running/paused completion
acceptance remain unfinished. The earlier failing acceptance below remains a
landing blocker; storage and writer reviews do not supersede it. Preserve the
existing journal/outbox and golden evidence when resuming. No release is authorized.

This checkpoint keeps the previously validated draft source. Before activating
it, integrate #1251 from main and pass the draft's synchronous
`nativeRecoveryReady` authority into `createAgentClosing`; that composition-root
connection is not active in this checkpoint. The completed Close correction is
preserved in its own PR rather than duplicated as unfinished draft edits.

Status: implementation design, not a completed boundary. The former HTTP behavior
is recorded in golden-only commit `cb60ad66b`. Three private HTTP/registry regressions
in `d771b8836` fail on the former implementation: an owned pending delivery is lost
on restart, a completed delivery is notified again, and a changed payload under the
same delivery ID is accepted after restart. Receipt
`20261011T072723.699358Z-96575` records those assertion failures and the unchanged
passing Linux/macOS golden.

Replay checkpoint (October 11, 22:10 UTC): core starts bounded retained-outbox
replay after readiness. Existing-only catalog handles preserve exact saved bytes,
original origin, phase order and durable ACKs without allocating new namespaces.
One productive attempt runs at a time; expired work retains its actual I/O slot
until cleanup, with four actual operations as the cap. HTTP transport consumes
the original remaining budget and checks complete bounded replies. Read-only
catalog scans use complete pinned directory listings, while publication yields
retain the exact published file identity and original owner/deadline.

Receipt `20261011T214443.458514Z-39792` passed all 28 replay mutation oracles by
assertion. The bounded broad run `20261011T214620.021521Z-46197` was not green:
its types passed, several complete test files passed, six catalog cases failed,
and the aggregate reached its 420-second bound. Five catalog failures came from
a later dynamic test spy targeting a different module after an earlier module
reset. A static import corrects that isolation; independent review agreed.
Receipt `20261011T220316.603983Z-24640` passes all 83 catalog cases (117.6 seconds).
The earlier capacity failure's precise reason was not retained before the broad
run timed out; its later passing case does not establish that cause. Another
setup run held on unrelated temporary-directory ancestor churn before its fault
was installed. Neither failed receipt is represented as passing.

The remaining affected lane `20261011T231619.123932Z-5589` passes types
(5.3 seconds), all 249 cases in fourteen previously incomplete files (20.6
seconds), and all thirteen protocol mutation assertions (137.2 seconds).
This completes that selected unit scope using combined unchanged-file evidence;
it does not make the failing private Stop acceptance green.

The four-shard real-HTTP workload completed in 25.4–27.1 seconds with mocked
flush callbacks, approximately 19–20 seconds of process CPU and 0.50–0.52 seconds
maximum event-loop delay. These measure traversal and transport, not physical
flush latency; they are not final runtime acceptance.

The October 11, 23:39 UTC cost correction separates cheap owner/deadline checks
from full retained publication authority. The full proof still runs before work,
namespace mutation and acknowledgement, including each joining caller's own
proof. Actual flush ownership and cleanup are unchanged. Receipt
`20261011T232937.404392Z-60443` passes types, all 121 file/journal/staging/golden
cases and seven selected catalog/protocol cases. The same four-shard workload
takes 12.4 seconds, with 6.1 seconds of process CPU and 325 ms maximum event-loop
delay. This is a scoped local improvement, not a latency guarantee. Independent
review approved the five-file implementation slice over `82cbee164`.
Receipt `20261011T233428.138677Z-82150` catches all 34 replay/publication mutants
by assertion. The preceding mutation run reported a missing-file exception for
the removal mutant; its oracle now asserts the observed absence directly.
The unchanged private Stop acceptance still fails both running and paused cases
in `20261011T233631.069065Z-90673`. This correction does not unblock landing.

The actual shipped Cursor client exposed a landing blocker. In receipt
`20261011T220611.845027Z-36324`, both continuously running and paused private cores
leave an otherwise completed turn held. The original registration exceeds the
client's 500 ms transport budget; linked Stop overtakes durable admission and
becomes permanently unmatched. The identical independently reviewed test against
unchanged main `4f92ee5e9` passes the running case in 3.7 seconds and fails only
the paused case (`20261011T220851.747681Z-50781`). Thus healthy Stop completion is
a regression introduced by active catalog adoption; delayed-core completion is
an existing failure. The server slice cannot land independently of the required
client/Stop fix. The regression remains enabled. Scoped storage/replay reviews
are not final PR approval, and no merge or release occurred.

The October 11, 23:49 UTC source check strengthens this acceptance case. Static
inspection of the official [Cursor 2026.10.01-e373342 package](https://downloads.cursor.com/lab/2026.10.01-e373342/darwin/x64/agent-cli-package.tar.gz)
found that its successful path awaits Stop hooks, then writes a `turn_ended`
record. The error path writes the record before invoking Stop. JSONL strips the
native generation and message identities. Its serialized writer resets to a full
rewrite on the next turn, removing the former terminal marker. The package was
neither installed nor executed.

That source does not establish generation ordering: the running-turn reference
is cleared before the awaited successful Stop, so a direct new prompt can start
before the old completion writes from the then-current conversation state.
Independent review confirmed that caveat. The native database has an optional
request ID, but its relationship to retries and the JSONL has not been proved.
Neither marker presence nor a parser captured at HTTP entry grants permission to
close a later turn or delete its tasks.

The private acceptance now keeps the original unmarked cases and adds the
current success sequence, including generation input and a marker written only
after the actual client exits. Receipt `20261011T234635.588126Z-42811` passed the
two additional cases, but only observed the early completion. Waiting for Stop
registration to reach its core notification exposes the late hold: receipt
`20261011T234802.221548Z-50820` fails both running and paused cases by assertion.
The transcript closes the turn, then durable admission creates an unmatched-Stop
hold. The earlier pass is not evidence that admission settled safely. These
stronger cases remain enabled; the blocker is not limited to a missing marker.

The [Cursor hook schema](https://cursor.com/docs/hooks) supplies `generation_id`
per user message. The current client drops it, and the transcript normalizer has
no matching generation authority. It cannot safely close a reconstructed turn
until both sides preserve a verifiable correlation; arrival time or the current
parser alone cannot substitute for that evidence.

The October 12, 00:09 UTC generation checkpoint supplies the eager, bounded core
projection for that integration. It keeps submitted prompts separate from actual
execution, accepts Stop without an observed start, preserves terminal and Cancel
tombstones across late facts, and holds selection when multiple generations are
running. Contradictory terminal statuses stay closed with an unresolved outcome;
an idle selection is not evidence of success. Authority includes the original
engine incarnation and the complete confirmed fact frontier, rechecked before
each effect. An appended Stop, Cancel or successor invalidates the older view.

Receipt `20261012T000826.157162Z-34820` passes TypeScript, all 63 projection and
architecture cases, 100% projection statements/branches/functions/lines, and all
19 deliberately broken variants by assertion. Independent review approved this
primitive over `3bd0dd7cb` after the source-owner proof and precise process-key
corrections. The initial receipt `20261012T000233.067555Z-10802` passed its earlier
55-case scope; it does not cover those later corrections. Durable source,
generation-specific effects, native-client migration and the private Stop
acceptance remain unfinished. This checkpoint is not a completed Stop fix or PR
approval. Validation and review overlap implementation; no merge or publication.

The October 12, 00:38 UTC durable-generation checkpoint retains native observations
and core Cancel facts in the existing process journal. Endpoint and exact received
bytes identify native facts; core cancellation additionally binds each target
generation, so one Cancel can revoke several ambiguous targets. Facts never grant
an effect claim or settle a legacy claim. Reconstruction preserves Stop/Cancel
tombstones, and the core adapter copies bounded scalar facts before asynchronous
confirmation and checks the complete original frontier at every effect boundary.

An executing generation reserves the same conservative 40,960 bytes and two records
as an unresolved legacy intake. Both share the existing namespace and catalog
limits. Submitted, queued or rejected prompts do not reserve execution; late
activity cannot reopen a terminal reservation. Matching first Stop/Cancel can use
reserved terminal staging when normal staging is exhausted. Mirror repair cannot
lend that lease to a new unreserved fact. Each retention has one original
4.5-second operation budget, including repair and append. The existing staging
ceiling remains conservative: each outstanding legacy or generation obligation
already allows two terminal publication/repair pairs, and normal leases bound
late unreserved observations. Integration must synchronously revoke old effect
authority on terminal facts; persisted observations alone do not settle callbacks.

Receipt `20261012T003531.934891Z-48442` passes types, 144 journal/source/projection/
architecture/unchanged-golden cases, 100% statements/branches/functions/lines for
both new core modules, three exhaustion/repair cases, all fourteen real-process
crash/contention cases, and all nineteen assertion mutation oracles. Source stayed
unchanged throughout the 121.7-second run. Independent review approved this scoped
slice over `637296613`, conditional on those completed checks. The earlier
`20261012T003152.481367Z-33490` is not passing evidence: sandbox restrictions denied
the wrapper's process-group inspection, and a foreign-fact mutant exposed an
incomplete test oracle. Exact fact counts and foreign Stop cases now catch it.
Earlier attempts also exposed a type error, an incorrect PATH and an obsolete
two-operation test expectation; their failed receipts remain preserved locally.

HTTP producers, generation-specific effects, durable Cancel wiring, native-client
migration and the actual private Stop acceptance remain open. This checkpoint
does not fix the live Cursor regression or approve the complete PR. Implementation,
validation and independent review overlap; no merge or publication has occurred.

Client coordination checkpoint (October 11, 20:16 UTC): all linked phases are
retained before the first send. Retries preserve their original bytes, ID and
native time, and use versioned mutation routes that an older core rejects before
effects. An ownership receipt binds the exact endpoint as well as phase, ID,
time and body hash; it never grants Cursor task-deletion authority. A paired
client self/parent proof protects the entry-time caller from PID reuse while
routing waits. Original Cursor routing is copied before that first proof yields.
Deadline expiry revokes ACK publication and later phases while late openers keep
their cleanup owner. Reconstructed outboxes must replay saved bytes directly,
without recapturing the exited caller.

Read-only journal enumeration now discards an observation invalidated solely by
ancestor sibling activity, at most three times under the original path identities
and one budget. Changed history, missing records and changed namespace authority
still hold; no publication is retried by this read boundary.
Receipt `20261011T201339.592433Z-37921` passed types (4.8 seconds) and all 99
client/origin/journal/unchanged-golden cases (22.8 seconds).
`20261011T201504.588400Z-44002` caught fourteen wiring mutations by assertion; the
deadline mutant timed out because its fixture blocked every subsequent send.
The fixture now delays only the first send, so broken next-phase dispatch reaches
a decisive ownership assertion. `20261011T201604.314633Z-48560` passed the baseline
and all fifteen assertion-failing mutants in 16.7 seconds. Independent review
approved the scoped client/origin/journal slice over `860d2a4ac`, after fixes for
mutable Cursor capture and cross-endpoint receipts. Implementation and review
overlapped these separately recorded validation intervals. This checkpoint is not
production client wiring: versioned server admission, durable Stop/event outcomes,
saved-delivery replay and final PR acceptance remain open. Merge and publication
remain zero for this draft PR.

Implementation checkpoint (October 11): the immutable journal and read-only
registration preparation are now connected to HTTP admission and background
recovery. The three original restart regressions pass. Native client outboxes,
precise process revalidation, global capacity and linked Stop completion remain
unfinished; this is not a completed delivery boundary.
Journal receipt `20261011T111043.022808Z-75081` passed TypeScript and 38 tests,
including every first-initialization fsync boundary, both directory-creation
interruptions, competing claims, immutable result retries and completion near the
actual history limit. Registry receipt `20261011T111651.613829Z-3216` passed
TypeScript, the prior admission cases except the three recorded restart regressions,
new staged-claim tests, transcript proofs and the unchanged Linux/macOS delivery
golden. A controlled ten-second disk wait preserves the prepared native facts;
replacement during that wait still holds.

Independent storage review found and prompted fixes for stale consumed records,
iterator redirection, descriptor acquisition races, terminal capacity, unconfirmed
visible results, interrupted initialization and claim revocation. The mechanics
review found no remaining storage blocker; process contention, HTTP integration,
native conversation ordering, client migration and final acceptance remain open.
The same review found mutable staged registration inputs and expired evidence
budgets; preparation now copies inputs and retains facts verified with fresh budgets.

HTTP checkpoint receipts `20261011T115141.118304Z-65604` and
`20261011T115706.434998Z-88317` cover confirmed restoration of accepted native prompt
times before a delayed Stop, no credit for an unconfirmed visible result, immediate
shutdown revocation, and the transcript recovery barrier. The unchanged delivery
golden, 162 queue/attach/golden cases, 40 journal cases and TypeScript pass. The first
full HTTP/admission run passed 77 cases and found one regression: a newer pending
intent could starve an already-owned effect. The queue now finishes its exclusive
claim before selecting a successor; that regression and all six restart/Stop/
shutdown cases passed the focused follow-up. This is combined evidence, not a
second uninterrupted full admission run. Full coverage and end-to-end gates remain
pending.

The HTTP review also identified cross-core pending-intake order, acknowledgements
after capacity refusal, registration callbacks after terminal publication, native
process changes during disk waits and recovered Stop/Cancel authority. The first
three have implementation fixes: claims compare the entire inspected frontier,
pending conversations participate in ordering, capacity is reserved before intake,
and synchronous registration dispatch precedes the terminal slot. Review of those
fixes and separate-process contention evidence remain outstanding. Exact native
birth evidence and durable Stop correlation are still open blockers.

The next checkpoint, validated through October 11 at 13:36 UTC, supplies precise
kernel boot and process-birth evidence, retaining the original caller ancestry
before asynchronous resolution. Revalidation still checks the Registry's declared
executable. The identity-only native probe excludes changing file descriptors;
descriptor completeness remains required by consumers that actually need it.
Unavailable caller evidence now receives a retryable hold rather than a terminal
ignored acknowledgement. Recovery isolates unreadable sibling rows and restores
its barrier after a failed ownership probe.

Attachment recovery retains the first-turn replay request across overlapping
attempts. Cancel revokes an in-flight candidate and replays its original byte
boundary before any later prompt. Cursor passes the exact complete prefix and
opened-file identity from that recovery fold to its watcher, so a prompt appended
between folding and installing the watcher remains live. Rewrites, incomplete
cutoffs and omitted history hold visibly. The recovery reader allows 64 MiB while
the watcher prefix allows 32 MiB; a larger controlled Cursor prefix remains held.
The complete bounded Cursor reader migration remains in the completion checklist.

Independent review found and verified corrections for overlapping attachment
requests, Cancel during attachment, recovery-barrier loss, Cursor's newer-EOF
baseline, and blank prefixes falsely classified as omitted history. Private
acceptance also reproduced recovery and admission racing one journal's namespace
initialization; callers now share only in-progress authority verification, never
completed disk observations or effect claims. Shutdown revokes every waiter.
The reviewer approved this slice over `956dbc881`; full PR approval remains open.

Receipt `20261011T133306.338423Z-24372` passed TypeScript, all 308 attachment/watcher/
tail/golden cases with 100% attachment coverage, and all 43 journal cases. Receipt
`20261011T133416.104343Z-30207` passed all 159 admission/core-hook/architecture/golden
cases and both affected private daemon cases: a real native prompt held across
Registry failure and Cursor Cancel superseding a linked Stop. Earlier failed
receipts preserve the blank-prefix and initialization-race regressions; the
passing acceptance followed the product fix, not a retry of unchanged source.
Native client outboxes, complete global storage accounting, separate-process
contention, durable linked Stop completion, final coverage/mutations and full CI
remain required. These validation and review intervals overlap implementation;
they are not summed as elapsed task time. PR #1172 is still draft, with no merge
or publication.

The client transport checkpoint (October 11 at 14:03 UTC) preserves the former
wire contract recorded in golden-only commit `d919061fc`. A connected reset,
truncated response or HTTP refusal cannot authorize an offline Registry write.
Acknowledgements require complete bounded JSON and endpoint-specific, typed,
consistent flags. In particular, a registration `ignored` reply or a malformed
Stop reply cannot delete Cursor's pending tasks. A total request deadline bounds
streams that never finish, destroys the request and suppresses late callbacks.
This fixes transport ambiguity; durable client outboxes remain required.

Receipt `20261011T135250.330481Z-21890` records eleven wrong-acknowledgement assertion
failures before correction. It also records the first fake-clock fixture attempt
timing out; that attempt is not passing evidence. The HTTP golden now uses native
HTTP requests with a frozen application clock, avoiding fetch's shared timer
scheduling and host-dependent selection of the 100 ms pending response. Neither
golden artifact changed. Receipt `20261011T135750.961288Z-46072` passed TypeScript
and 84 selected transport/client/golden cases (40 unrelated cases were excluded).
`20261011T140007.933057Z-55961` caught all fifteen deliberate transport mutations
with assertion failures. `20261011T140148.787638Z-64632` passed the complete
85-case standalone client baseline and both pending/duplicate Stop task-loss
mutations. Independent read-only review approved this slice over `d919061fc`;
it did not approve the unfinished delivery protocol. Validation and review ran
alongside implementation; the draft PR has no merge or publication.

Separate-process ownership evidence now covers seven real OS-process cases:
same-ID and distinct-ID claim contention, mismatched agent views of one retained
ID, a paused witness confirmation repaired by a peer, SIGKILL before that
confirmation returns, stale inspection before an equal-time intake, and completed
retry/conflict after process exit. Only a recognized journal/publication hold can
satisfy the losing contender assertion; fixture timeout or exit cannot pass it.
Receipt `20261011T141330.641854Z-19434` passed TypeScript, the pre-extraction native
probe golden and all seven process cases, then caught four deliberately missing
claim/order/completion/immutability fences with assertion failures. Independent
review approved the corrected process tests. This proves journal mechanics across
processes; final HTTP/native-client crash acceptance remains open.

The shared native control probe now takes an explicit helper provider; immutable
helper preparation and the kernel boot reader have no daemon configuration or
migration imports. Golden-only commits `742697a59` and `d24d78bdb` preceded these
extractions. Their Linux/macOS artifacts remain unchanged. Receipt
`20261011T143337.167967Z-16980` passed TypeScript, 35 caller/probe/architecture cases,
all 48 journal cases, all seven OS-process cases and five assertion-failing journal
mutations. Receipt `20261011T143607.014866Z-28081` caught all eight helper, precise
birth, kernel boot and Registry executable mutations by assertion. The preceding
recording run passed each check but reports `source_changed` because recording
created the new golden; only the later stable run is aggregate passing evidence.

Private acceptance exposed another race between confirmation of identical
immutable records. Nonexclusive confirmations may now join an in-flight sync;
each waiter retains its own record, route and owner fences. Exclusive publication
never joins, and confirmation cannot inherit dispatch permission. Three regression
assertions failed before correction in `20261011T142328.934198Z-67294`. Independent
review approved the probe extraction, confirmation fix and subsequent verbatim
boot extraction over `d24d78bdb`. Its requested producer-revocation test confirms
that a surviving observer can retry confirmation but cannot inherit a claim.

Receipt `20261011T142435.161799Z-72981` passed types, journal/preparation/delivery
goldens and the private Cursor Cancel case; the native Codex prompt case failed
waiting for its first acknowledgement. Earlier receipt
`20261011T142014.809689Z-49892` failed both private cases. Neither is full passing
acceptance. The remaining client has no durable retry after a pre-intake refusal
or an uncertain response; migration and a new private acceptance run are required.
No release or merge occurred during this checkpoint.

The server now accepts a bounded versioned original-caller envelope. Its ordered
ancestry retains boot, precise birth and a SHA-256 digest of the complete v1 native
identity, including argv boundaries; a retry never expands that prefix from a new
caller. Cursor alone may retain its unique original agent/process/routes/primary
snapshot. Malformed or unsupported origins hold without live ancestry fallback.
Selection is only a restriction on subsequent native proof: the core still checks
the Registry executable and rechecks full process evidence after claim sync. Origin
bytes participate in the immutable delivery fingerprint and linked Stop provenance.
The client does not yet emit or persist this envelope.

The initial origin run `20261011T144212.626440Z-54874` passed types and 144 tests,
including unchanged caller/delivery goldens, and failed one new HTTP assertion
whose expected fixture prompt was misspelled. Receipt
`20261011T144621.205226Z-73389` passed types, all origin baselines, the corrected
HTTP case and two composed HTTP/real-owner-reader cases requested by independent
review. Wrong engine digest and changed Cursor route receive retry without intake,
registration, prompt credit or live capture. All eight deliberate origin mutations
failed assertions. This is combined evidence, not an uninterrupted full suite.
Independent review approved this origin slice over `96578014d`; client persistence,
linked Stop completion, global budgets and final PR acceptance remain open.

The client outbox storage now has its own persisted log kind. Golden-only commit
`955065fc1` records the former effect journal before this extension; its records
and HTTP delivery golden remain unchanged. The outbox wrapper freezes the exact
wire bytes before its first await, includes namespace/UUID/time/port/endpoints/body
in its fingerprint, and chooses a shard from namespace/UUID alone. Registration
and linked Stop have separate append-only ownership acknowledgements. Compatible
owned-pending and completed registration responses normalize to one fact;
registration never acknowledges Stop or authorizes task deletion. Intake reserves
every remaining ACK record and both copies' bytes under the exclusive frontier.
No effect claim or finish API is exposed by an outbox.

Independent review found and prompted two corrections: reconstructed/duplicate
delivery proofs now retain namespace and close/current fences without freezing
sibling appends, and canonical base64 avoids double JSON expansion of large
escaped bodies. Two maximum 256 KiB request bodies and their ACKs fit the outbox's
720 KiB intake envelope and existing 1 MiB record limit; the effects limit remains
300,000 bytes. Recovery confirms durability before exposing ACK flags. Corrupt
encoding, changed immutable bytes, unavailable sync and missing authority hold.
The reviewer approved this storage slice over `955065fc1`, conditional on the
subsequent passing affected checks; it is not final-head PR approval.

Receipt `20261011T150641.977884Z-72716` passed types and the initial storage/journal
regressions. `20261011T150937.744247Z-85420` passed nine actual OS-process cases
(including outbox capacity contention and SIGKILL after registration ACK) and
the five existing effect mutations, but failed the new mutation gate: redundant
conflict checks masked two incomplete fingerprint oracles, and one changed-input
test threw before its assertion. Those oracles were strengthened rather than
counted as passing. Final storage receipt `20261011T151558.627196Z-14856` passed
types, all outbox regressions, thirteen assertion-failing outbox mutations and
both unchanged effect/delivery goldens. Its checks took 4.3, 16.3 and 1.0 seconds;
implementation and independent review overlapped from approximately 15:00 to
15:17 UTC. The golden recording receipt reports `source_changed` as expected;
unchanged baseline receipt `20261011T150105.879117Z-47508` is the passing evidence.
This is storage machinery, not yet a shipped client: catalog sealing, global
logical/physical budgets, production staging wiring, bundled client emission/replay,
durable server Stop completion and final private acceptance remain required.
No merge or publication occurred.

The staging mechanics are now implemented behind an optional publication seam;
production journals still use their former staging path until catalog integration.
Eight immutable writer lanes bound payload scratch space. Exclusive ownership is
remembered immediately after atomic metadata publication, before any fallible
verification. Interrupted acquisition and initialization retain exact cleanup
authority for retry by the same live writer. Complete initializer history,
metadata bytes, directory iterator acquisition and authority rebinding are
verified; missing history cannot create a new owner. Cleanup checks its generation
and route before unlinking, survives request revocation, and confirms absence after
actual directory flushes. A dead predecessor's cleanup has the same final fence.
The shared disk limiter permits at most two actual flushes and 32 queued flushes;
16 acquisition slots retain real work after a bounded reply expires. A refusal-only
preflight skips full or live lanes, but never replaces full history verification
before granting a new lease. No success cache or general record pruning was added.

Receipt `20261011T162242.788937Z-24623` passed TypeScript, 59 focused publication/
staging/golden cases and thirteen assertion-failing mutations. The earlier
`20261011T161841.850935Z-4438` passed its functional checks but failed the newly
added initializer mutation oracle: removing one redundant guard still held safely.
The corrected mutant restores the original unsafe early-break scan and is rejected
by the regression assertion. Receipt `20261011T162606.968009Z-39654` passed types
and all 25 final OS-process, capacity, architecture and unchanged launch/journal
golden cases. Real OS-process cases cover exclusive contention for the last lane,
SIGKILL during a real file flush, and refusal to borrow a live writer's stage.
Child exit and timeout cannot masquerade as successful contender holds.

The final local capacity run recovered generation 8,192 in 1.43 seconds; its final
lease fence took 0.82 ms and the largest timer callback gap was 22.8 ms. A free lane
after full and live histories was acquired in 89 ms without enumerating either
skipped history. This measures real metadata reads with mocked fsync callbacks;
it does not establish physical flush latency or Linux CI acceptance. Independent
review approved this staging-mechanics slice over `4c113bc67`, with its final
process/capacity condition now met. Implementation, review and validation overlapped
from approximately 15:29 to 16:27 UTC; receipt durations remain separate from that
elapsed interval. Production catalog/budget wiring, client replay, linked Stop
completion and overall PR review remain open. No merge, release or publication.

Writer reclamation now requires positive local-storage and kernel-scope evidence.
Every writer admission and cleanup checks the same retained local-root proof;
checking only the reaper would wrongly admit a network client whose files a local
server could reclaim. Linux accepts a conservative native-filesystem allowlist,
captures the PID namespace device/inode, and requires a canonical single-PID
`NStgid`/`NSpid` view plus `/proc/self`. Darwin's verified helper requires APFS/HFS
and `MNT_LOCAL`. Unknown, layered and remote filesystems hold. This follows the
[kernel's proc namespace semantics](https://www.man7.org/linux/man-pages/man5/proc_pid_status.5.html);
it does not use a machine ID as exclusive-host evidence. A retained directory
descriptor pins the admitted filesystem and original route, avoiding a fresh
mount lookup for every record. At most 32 scope descriptors are retained; an
uncertain close keeps its capacity reservation. Pool shutdown revokes admission,
waits for actual acquisitions, lease cleanup and release, then closes that proof.

The new staging claim format includes namespace identity. Same-boot namespace
mismatches hold before PID inspection. Reboot, explicit ESRCH and a different
precise birth can prove death only between matching fresh local-root observations.
Canonical birth validation rejects alternative spellings and impossible Darwin
microseconds before any death branch. Existing draft-only v1 staging claims are
held, never guessed into the new format; neither format has production wiring yet.

The first actual-scope capacity runs exposed ancestor sibling churn, rather than
a capacity pass: receipts `20261011T170035.270812Z-7112` and
`20261011T170405.733557Z-22026` failed their populated-lane assertion. Recovery
now discards and retries only an affected synchronous read batch, at most three
times with yielding. The original namespace and both directory frontiers stay
pinned. Malformed records, changed leaves, missing authority and mutations never
enter that retry. Repeated churn holds without publishing from discarded reads.

Receipt `20261011T170833.816322Z-41357` passes types (4.4 seconds), all 142 focused
writer/scope/staging/origin/architecture/unchanged-golden cases (14.2 seconds), nine
assertion-failing writer mutations (19.6 seconds), and five process/capacity cases
(35.2 seconds). Native macOS scope with a freshly built helper recovered generation
8,192 in 1.697 seconds, with a 1.23 ms final fence and 25.0 ms maximum callback gap.
The Linux fixture uses real root descriptors, route checks and metadata, mocking
only unavailable host kernel interfaces: 1.633 seconds, 1.39 ms, and 20.8 ms.
Both capacity runs mock flush latency; separate OS-process cases exercise actual
flush lifetime. Native helper receipt `20261011T165245.537118Z-71783` passed all
18 native cases; that C source has not changed afterward. These are local receipts,
not Linux CI acceptance. Implementation, review and validation overlapped from
approximately 16:31 to 17:12 UTC. Receipt `20261011T171132.840774Z-53907` also
rejects all thirteen existing staging mutations by assertion after these changes
(21.9 seconds). Merge and publication remain zero. Catalog
allocation, complete quota enforcement and client/server recovery integration
remain required.

The catalog now reserves fixed effect/outbox namespaces before journal intake.
Independent review of `e1645fd07` found three remaining gaps: initialization lost
its empty-history proof across awaits, fixed-name reads did not fence ancestor
content changes, and record/byte reservations did not reserve staging capacity.
The first two proofs now remain live through durable publication. An unrecognized
legacy journal also holds first initialization; its receipts are never silently
treated as a new catalog. Confirmation proofs stay flat, and catalog replies are
bounded while their actual disk operations retain their slots and descriptors.

Each public journal operation now reuses one staging lease for bootstrap, repairs
and both record copies. Each lane has 4,441 normal generations and 3,751 terminal
generations. Terminal work tries normal capacity first. The reserved suffix opens
only after all eight normal prefix-end witnesses are positively validated and
durably confirmed; busy or unreadable lanes cannot establish exhaustion. Pool
authority pins both limits. Bootstrap and intake cannot use terminal capacity.
The reserve covers at most 25 pending effects in each 1 MiB namespace, 64 pending
two-phase client deliveries in each outbox, and independent successful repairs:
`2 × (256 × 25 × 2 + 16 × 64 × 2) + 272 + 40 = 30,008` generations. The 272 cover
one already incomplete outside tail per namespace. The final 40 cover one late
intake from each of at most eight still-live normal leases: its mirror and two
terminal publisher/repair pairs. Every public retain has its own normal scope;
it cannot inherit an ambient terminal lease. Repeated additional failures
can exhaust finite reserved capacity and then hold; no unlimited-crash guarantee
or receipt pruning is claimed.

Journal scopes retain actual preparation promises, including joined and
stage-free confirmations, after both the journal and preparation reply deadlines.
Catalog shutdown waits for those scopes before its enclosing storage may close
the retained writer proof. This closes a separate lifetime gap found while
implementing operation-scoped leases.

Receipt `20261011T175858.918998Z-64648` passed types and six catalog race/deadline
regressions. The first reserve run, `20261011T180519.370389Z-93207`, passed 153
cases but failed its new independent-repair fixture because it shared in-process
preparation locks; two unchanged outbox cases also encountered ancestor directory
churn. It is not passing evidence. The isolated repair fixture and those outbox
cases pass in `20261011T180905.806648Z-8599`. Final focused receipt
`20261011T181300.279242Z-24739` passes types (22.0 seconds) and the reserve,
initialization, legacy-storage and actual-I/O lifetime cases (55.7 seconds),
including completion of every retained phase ACK after normal staging exhaustion.
Implementation, review and validation overlapped from approximately 17:57 to
18:15 UTC. Exact-head independent review, process/mutation/capacity gates and
production wiring remain required. No merge or publication occurred.

The subsequent review adds 40 terminal generations for normal operations still
holding leases at cutover (the final bound above), and retains each original
publication identity until its flat confirmation proof is captured and checked.
First-version replacement now holds before any mirror or allocation is written.
Main `61ba12536` is integrated, preserving both agent-settings routes and hook
recovery in the composition root and using its common native-evidence budget.
Receipt `20261011T181847.402265Z-48512` passed four real-process/capacity cases but
failed types because the new child-exit fixture had not exposed its PID. That
fixture is corrected; `20261011T182246.008112Z-65737` passes types and those four
cases plus the first-publication regression. Its additional synthetic reentrancy
fixture failed because destination exclusion acts before staging admission; that
fixture cannot establish its intended capacity assertion and was removed. These
mixed receipts are not overall passing suites. The measured complete-lane reads
remain approximately 1.8 seconds, with 1.5–1.9 ms final fences and 21–24 ms maximum
callback gaps; flush latency is mocked in capacity cases, real in process cases.
Storage teardown must await catalog close and then pool close: an acquisition's
reply can expire before its actual work, and only the pool owns that final barrier
and the writer proof's close. Production composition remains outstanding.

Catalog integration validation exposed harmless ancestor sibling churn during
fixed-name reads. The catalog now discards and reacquires the entire synchronous
observation, at most three times on the same deadline. Nested pair reads share
that bound. Original root identity, the full scan frontier and published-record
identities remain pinned; only read observations can retry. Initial absence is
re-enumerated when its complete route changes. A temporary redirection therefore
finds the original allocation on its fresh read, while repeated redirection holds
without allocating again. All nine new catalog/reserve/I/O wiring mutations fail
assertions, as do the thirteen former staging mutants. The complete catalog suite
passed after the correction (`20261011T183531.217597Z-19078`); the preceding full
slice passed all eleven real-process cases and 204 cases overall but failed five
catalog churn cases, so that receipt is not a passing suite.

`openNativeHookStorage` now composes precise writer capture, fixed staging and the
sealed catalog through the configuration-free kernel probe. Each death proof is
fresh. Closure revokes catalog admission synchronously, waits for actual journal
work, and only then closes the staging pool, whose cleanup owns the retained
writer descriptor. Construction failures close exactly the resources acquired.
The new composition has no daemon configuration or service import. The daemon
and bundled client still need to adopt this factory; composition alone does not
complete their recovery behavior.

The daemon now adopts the production storage factory. It opens only on demand
after readiness, shares only an in-flight opening, and rechecks the precise owner
after opening and allocation. Shutdown revokes admission immediately and waits
for owned storage, including an opening that finishes after shutdown. Six real
private HTTP/disk cases cover readiness, unavailable opening, replacement during
opening, close during opening, sequential contention/restart/corruption, and
actual byte exhaustion with same-ID completion. Existing admission tests use an
explicit legacy-limit fixture adapter; they are not production quota evidence.

Nested read-only proofs now share one synchronous, three-attempt observation.
An invalidated observation and all its results are discarded. Immutable seal
confirmation is reused only after this exact boundary has successfully synced
it; reconstructed or unsuccessfully confirmed observations must sync again.
Cheap owner/deadline guards run after the last complete proof and immediately
before publication. Expiration cannot grant a lease or publish its mirror.
Lease delivery remembers cleanup ownership before a throwing final guard, so a
failed release remains owned until cleanup really finishes.

Receipt `20261011T194250.972883Z-5598` passes types, all six production HTTP cases
and the affected catalog lifetime cases. Its staging failure was an overly narrow
deadline-message assertion, corrected without changing production code. All 48
catalog/read-fence cases passed in `20261011T193837.971199Z-87272`. The unchanged
admission/delivery/other-engine goldens pass in the focused receipts; their JSON
artifacts remain unchanged. All twelve catalog mutants fail assertions in
`20261011T194743.101653Z-27436`; all 39 staging cases and fifteen staging mutants
pass in `20261011T194948.966910Z-36907`. The first cleanup mutant raised ENOENT
instead of an assertion; its oracle now explicitly requires the release entry.

The 133 journal/publication/outbox/composition/architecture/golden cases pass in
`20261011T195035.085295Z-39120`. Its concurrent process lane failed two cases:
separate Vitest invocations shared `/tmp/vw1`, and a paused claim did not complete.
The two isolated diagnostic cases passed; the full serial lane then passed all
sixteen real-process/capacity cases in `20261011T195434.734237Z-55640`. This is
combined evidence, not a passing concurrent run. Independent review approved
the storage/HTTP source conditional on these checks; exact-commit attestation
follows the checkpoint. Implementation, validation and review overlapped through
19:56 UTC on October 11. No merge or publication occurred. Bundled client replay,
durable linked Stop completion, final coverage and overall PR acceptance remain.

Client packaging will retain one self-contained `notify.mjs` artifact under the
existing updater, checksum and rollback protocol. The shared native probe must
receive its helper artifact and routed runtime directory through a pure interface;
it cannot import daemon configuration, legacy migrations, Registry or services.
Development output must expose a checked protocol version. Missing output or a
missing verified Darwin helper holds delivery rather than activating offline
fallback. Preserve the original UUID, time, body and caller across loading, and
bound all work by the hook deadline. These requirements received independent
design review; they are not yet a completed client implementation.

## Generation admission and terminal capacity

The October 12 HTTP integration retains a Cursor generation observation before
the original registration can claim or bind. The eager generation source is
installed before the recovery barrier releases attach. Its effect proof covers
the complete retained frontier, the original conversation and process, and a
fresh native process read after asynchronous confirmation. An unavailable
consumer or incomplete provenance keeps admission held.

A matching Stop for an already-running generation uses the terminal space that
execution reserved. It does not require a new ordinary intake or registration
claim. Its minimal receipt includes the original process-image digest and exact
wire identity; duplicate receipt lookup remains read-only after the engine exits.
The ordinary and direct representations are mutually exclusive under the
journal's exclusive append boundary. A retry with an existing intake must finish
that representation even if later activity made the generation running.

The crash regression exposed a queue deadlock: an interrupted original Stop had
no in-memory admission job; newer activity queued ahead of it, then waited on
that same durable predecessor. Equal-time retries could never release the queue.
Newer intake now remains owned but unqueued until the original predecessor has
an admission job. Recovery and the original retry can restore that job without
replaying a completed effect. Separate-process tests cover competing receipt
formats, partial publication and confirmation races.

Receipt `20261012T011733.111620Z-15321` passes types and all 321 cases in thirteen
files, including four unchanged goldens. Its mutation aggregate failed: eighteen
mutants were caught and two initially survived. The claim proof is protected by
both the server and the journal; removing both fences is caught by assertion in
`20261012T012650.657955Z-52930`. The retry fixture initially bypassed Registry's
session index. Binding through its real publication API makes the isolated HTTP
guard deletion fail the required completed-receipt assertion. Types, the selected
HTTP/mapper baselines and that corrected mutant pass in
`20261012T013401.203035Z-80921`. Together these establish all twenty mutation
oracles, not an uninterrupted passing mutation run. Earlier fixture failures and
the mutation-runner syntax error remain failed receipts.

Independent review approved this HTTP/journal scope over `a1eb2b74d`, including
the queue recovery and symmetric format exclusion. Controller, input, Cancel,
task, response and recap effects remain outside this approval. The production
client still needs the versioned protocol and the actual Cursor acceptance
remains a landing blocker. No merge or release occurred at this checkpoint.

The October 12, 02:32 UTC launch checkpoint selects the generated client only
when Cursor hook preparation runs. A missing, old or changed artifact holds that
launch without delaying readiness. The artifact's original path and file version
remain in the settings proof and the serialized post-login guard. macOS requires
the exact header declaration for its pinned process helper. Settings publication
rechecks that dependency before its final owner/deadline fence; acknowledgement
only composes already-checked proofs. The former five-event descriptor remains
explicitly historical in its unchanged golden. Production installs the six-event
generation protocol, including the native response event.

Types and all 69 focused activation, artifact, producer/joiner and actual-client
cases pass in `20261012T022446.736494Z-88074`; that aggregate failed its build-child
cleanup check. Explicit esbuild shutdown requests and validator cleanup are now
covered by `20261012T023153.974251Z-24318`: both build layouts, identical artifact
bytes, real launch selection of each emitted artifact, baseline activation cases
and all twelve assertion mutants pass. The preceding mutation run caught eleven
faults; its command-path fixture selected the same path for the legacy and native
clients. A private layout transition now proves that distinction and catches the
twelfth fault. Earlier fixture failures remain failed receipts. Independent review
approved the corrected activation scope over `19879f7cf`, including the final
fixture and build-shutdown changes. This is not controller or final PR approval.
Generation effects, durable Cancel integration and actual private completion
acceptance remain open. No merge or release occurred.

The October 12, 02:49 UTC read-port checkpoint supplies a fresh confirmed source
for an exact agent, conversation and process incarnation after asynchronous
work. It uses the already-recovered journal and re-probes native ownership after
confirmation. Pending admission cannot lend effect authority. The read never
replays the controller callback, changes readiness, or releases an attach barrier;
its proof still revokes on a changed binding, appended fact or shutdown.

Types and all 144 protocol, mapper, source, projection, unchanged journal golden
and architecture cases pass in `20261012T024133.185963Z-62112`. The complete
mutation run catches 24 assertion failures; the last mutable-request fault rejects
correctly but its test initially awaited without an explicit success assertion
(`20261012T024356.320544Z-71496`, failed aggregate). That assertion and the selected
HTTP/mapper baselines pass with the final mutant in
`20261012T024824.075630Z-95582`. This is combined evidence for all 25 faults, not an
uninterrupted passing mutation run. Independent review approved this read-port
scope over `82bdb13be`, conditional on those completed checks. Controller wiring,
durable Cancel and final acceptance remain open; no merge or release occurred.

## Atomic cancellation of a native incarnation

The cancellation foundation records one immutable event naming its request ID,
nonce, original agent and conversation, and original journal prefix (record index
and digest). That prefix selects every observed nonterminal generation for that
owner, including submitted work. Later observations cannot enlarge the request.
One event retains the entire target set; recovery never sees a partially written
sequence of cancellation facts. Repeated requests cannot change their identity or
prefix. Synthetic tombstones are deduplicated across requests by owner/generation,
so the existing 4,096-record journal produces at most 4,608 retained facts.

Even an empty target set records a barrier for the whole native process
incarnation. It survives restart and conversation or agent rebinding. Late facts
remain available as history but cannot authorize input, a new turn or other live
effects through that barrier. The first Cursor intake or generation observation
reserves one of the existing conservative 40,960-byte/two-record terminal
obligations for this control record. It is counted inside the existing 25-obligation
namespace bound, preserving the staging reserve calculation above. The first
barrier can use terminal capacity after ordinary staging is full; a later new
request cannot. An exact retry only confirms the original record.

Only the exclusive original publisher receives a one-use interrupt capability.
Recovery never reconstructs it. Both original outside/mirror publication proofs
survive append readback, cancellation reconstruction and dispatch. Identical bytes
in a replacement file do not inherit that authority. Dispatch also proves that the
request's original prefix was still the complete prefix at publication and that
nothing has since been appended. The caller must recheck the supplied verifier at
the actual input boundary after any await; the full disk proof ends with a cheap
owner/shutdown check. Consuming the capability never makes an uncertain interrupt
safe to repeat.

This storage and projection boundary does not yet activate live Cancel. The
controller still has to combine it with fresh kernel ownership, input dispatch,
generation-scoped tasks and recap content. Rearming also needs explicit user
authority for a fresh native incarnation or a proven exact request/generation
correlation. Automatic restore, arrival order, a new PID or an uncorrelated prompt
hook cannot clear the saved barrier. Until those paths and private acceptance are
complete, this remains an unfinished integration.

The October 12 Cancel-port checkpoint joins the journal barrier to the recovered
HookServer owner. It freezes the requested owner and cancellation before yielding,
allows pending admission to retain a cancellation, and confirms the original
publication identity and exact barrier membership before notifying core or
restoring readiness. Equal-byte replacement, loss of both copies, an omitted
barrier or conversation rebinding cannot publish cancellation success. Exact
retries retain their original record proof but never receive another interrupt.
Only the first publisher can dispatch, after a fresh non-notifying source read;
pending admission withholds that interrupt, and the supplied verifier rechecks
the retained journal and renewed native authority at the final effect boundary.
This is still a port: it does not yet send physical C-c or activate the controller.

Receipt `20261012T060942.849676Z-99621` passes TypeScript and all 173 affected
HTTP, cancellation, source, projection, unchanged golden and architecture cases
(183.7 seconds). All 25 prior HTTP assertion mutants pass in
`20261012T061651.074101Z-65248`; that aggregate failed because the new empty-barrier
readiness test had never started recovery and therefore always read false. The
fixture now proves readiness before the fault. Its full 14-case Cancel baseline
and all eleven Cancel-port assertion mutants pass in
`20261012T062314.323234Z-48630` (125.9 seconds). The earlier sandbox-denied private
HTTP run is not passing evidence. Independent review approved the corrected
production scope conditional on these checks; final integration review remains
open. Corrections and validation ran approximately 06:04–06:26 UTC; no merge or
publication occurred.

The next activation must switch Cursor history ingestion, busy state, input,
tasks and recaps together. Replaying JSONL with a replay flag still reaches live
input and recap consumers today; it needs a separate history-only route from
first attach. Native content must join each fact to its exact retained intake,
with late responses updating only their generation and unordered responses never
silently selecting the latest arrival. Physical Cancel also needs an interrupt
lane: the existing device writer guard excludes device-held writes but does not
serialize legacy writers against one another. It must wait for actual writes,
pin original terminal ownership, and retain the one-use verifier through dispatch.

## Ownership before acknowledgement

The October 12 native turn-controller checkpoint copies each prompt, response
and tool payload from its exact retained intake before source confirmation
yields. Late responses stay with their generation; distinct unordered responses
remain ambiguous. Stop closes a generation independently of missing response
text. Content allocation is bounded before building lookup tables.

The inactive controller shares one actual inspection between refresh and effect
permits. Revocation and a five-second monotonic deadline settle waiters without
releasing an unsettled I/O slot. Absolute deadline checks also reject results
after an event-loop stall. A settled old permit can expire only itself; it cannot
invalidate a newer inspection. Validated recovered cancellation permanently
revokes the incarnation, even if a later source omits its barrier. Every effect
rechecks its original generation proof; presentation recovery is quiet.

Independent review found and closed unbounded permit reads, timer-only expiry,
forgotten recovered cancellation, and old-permit expiry revoking newer reads.
The reviewer approved this inactive scope over `4518b78f8`, conditional on the
now-passing final checks. Receipt `20261012T070011.098130Z-74950` passes types,
167 projection/content/controller/source/golden/architecture cases, 100% per-file
coverage for both new core modules, the exact HTTP response-content baseline,
and all eight assertion mutations (35.4 seconds). The earlier sandbox-denied
process cleanup receipt remains failed despite successful test exits. Review
corrections and validation ran approximately 06:51–07:01 UTC. No merge or
publication occurred. Physical Cancel, explicit durable rearm and the atomic
history/input/task/recap activation remain required; this checkpoint does not
activate them or provide final PR approval.

## Shared pane writer before native activation

The October 12 writer checkpoint separates revocable message preparation from
actual pane commands. Cancel settles logical waiters immediately; it waits only
for already dispatched pane I/O. The physical lease lasts until the command
settles, including after an interrupt caller's deadline. Each paste, literal and
key retains its original ticket through validation, worker reads, retries and
queue draining. Released pins cannot write or release a replacement pin. A
launch may bind its first conversation once without adopting unrelated route,
process, activity or identity-hold changes.

The same gate reaches SessionInput, device input, TerminalControl, the backend
coordinator and tmux. Device cancellation and forgetting revoke preparation at
the final dispatch boundary; a later worker rejection releases only the original
item without reporting another delivery. Queued work, lane storage and actual
unfinished preparations are bounded separately. Cancel does not turn an
abandoned worker promise into free capacity.

Independent review closed stale literal ownership, replaced pins, final proof
deadline ordering, first-bind compatibility, cancelled-device dispatch, detached
preparation capacity and cancelled-read cleanup findings. Scoped approval covers
the writer/input delta over `d23fa3843`, conditional on the now-completed checks;
it is not approval of native activation or the whole PR. Receipt
`20261012T075135.919301Z-78474` passes types and 390 cases, including the unchanged
journal golden and architecture checks, at 100% statements, branches, functions
and lines in all four changed core files (50.1 seconds of checks).
`20261012T075514.342679Z-92902` passes the composition/unit baseline and all ten
assertion mutations (11.9 seconds). The preceding mutation receipt caught nine
faults by assertion and one only by timeout; its corrected test asserts the
physical write before awaiting the optional reader. Earlier failed coverage,
fixture and typecheck receipts remain failed.

Correction and review work for this checkpoint ran approximately 07:27–07:56 UTC
October 12, with validation and review overlapping. Merge and publication remain
zero. Native turn activation, durable Cancel/rearm and atomic history, input,
task and recap integration remain open. Native input admission must preserve a
visible, retryable hold for writer-capacity refusal; the legacy controller's
revoked-write exception handling is not that admission boundary. Full core/master
gates, private end-to-end acceptance and input-cost comparison are still required
on the final integrated implementation.

Core must durably retain the immutable native body, delivery ID, native time,
original routing hints and proved engine process incarnation before acknowledging
owned pending work. A write that cannot be confirmed receives an unowned retry
response and a visible hold. Neither a service nor readiness waits for this work.

Use private, bounded, immutable intake/claim/result records under the daemon data
root. Each process-incarnation order namespace is keyed by kernel boot identity and
native engine birth identity. Agent ID is a separately checked ownership field,
not part of that key: two registry views of the same process must share one order
authority. A delivery ID is never reused within that process namespace. An
unavailable kernel boot identity holds new ownership instead of guessing from
wall-clock time. An immutable witness outside the record directory names its
identity and durable frontier: a missing or replaced history is unavailable
evidence, never an empty history that permits replay. The existing bounded native publication mechanism supplies
asynchronous file and directory sync, route/owner checks and actual-I/O capacity
retention. An exclusive bootstrap intent precedes directory creation; authority
pins both directory identities and a permanent seal confirms initialization before
any intake. All three records live outside the history directories. An incomplete
bootstrap may recover only empty private directories; established missing metadata
holds. This detects individual namespace and receipt loss, not erasure of all
independent outside evidence; a higher-level catalog must retain that boundary.
Existing corrupt, unsafe or contradictory records hold the delivery;
they are not absence. No record or user data is deleted to admit another event.

Healthy completed and held replies retain the former protocol. Distinct native
IDs remain distinct prompts, and one ID with another payload remains a conflict.
Legacy headerless callbacks can be durably owned under a generated ID, but cannot
prove that a later callback is their retry; the client protocol migration remains
necessary rather than pretending the server can infer that identity.

## Binding and crash recovery

An undispatched intake can be recovered after fresh proof that the exact original
engine process still owns the named route. Recovery must not depend on the original
short-lived hook parent PID. A replacement engine, reused PID, changed route,
unavailable process table or unavailable transcript cannot grant it authority.

Before binding and notifications, publish one exclusive effect claim. Only the
exclusive publisher, still in its original live attempt, may dispatch; confirming
an existing claim or its directory sync never grants dispatch ownership. Complete
results name that exact claim and are durable before the completed acknowledgement.
A receipt which already completed suppresses duplicate binding and notification.
An interrupted claim without a conclusive result is held visibly; it must never be
blindly dispatched again. Read-only reconciliation may establish facts already
committed, but cannot invent evidence that a callback or a turn-closing effect did
not occur. Completed prompt-time facts must be restored before they can contradict
a delayed Stop; optional notifications are not replay authority.

Every process has a recovery barrier. Before admitting a fresh conflicting hook,
applying a Stop, or publishing recovered interpretation, restore its complete
order frontier, maximum accepted prompt time for each conversation, unresolved effect claims and linked
Stop obligations. An incomplete scan holds that process with a visible reason.
It does not delay readiness or unrelated processes. A per-delivery claim alone
cannot serialize different delivery IDs from two cores: publication must share
per-process durable order authority: one immutable effect-slot chain per canonical
process key. Each exclusive slot names its validated predecessor result digest and
intake/frontier selection. Slot N+1 cannot dispatch until N has a durably confirmed
terminal result; an uncertain predecessor holds this process. Fresh frontier checks
alone cannot substitute for this shared chain. After each asynchronous durability boundary,
reprove current ownership and order, then check both again under the registry
commit boundary. An older claimant may not publish after a newer acceptance.

Recovery scans and active attempts need separate bounded capacities and fair
cursors. One stalled disk operation retains its actual I/O slot, while a bounded
reply keeps unrelated control responsive. Scans start after readiness, yield between
bounded batches, and cannot discard an old receipt to make room for a new delivery.
Shutdown revokes future effects before waiting for any outstanding operation.
Each process history is capped at 4,096 records, reserving claim and terminal
records before intake. This fits the complete final verification's operation
budget; the 196,608-record global allowance is not a safe per-process limit.
The active-memory budget remains 64 pending deliveries per process and 16 MiB
of retained active payload. The fixed on-disk catalog revises the initial 65,536
retained-delivery / 256 MiB proposal: 256 effect namespaces reserve 1 MiB each,
and 16 fixed client outbox shards reserve 8 MiB each. These quotas include both
record copies, framing, initialization metadata and reserved terminal outcomes.
Every namespace retains at most 4,096 records, including completion reservations.
The resulting conservative intake bound is 382,208 retained copies: 349,440 effect
intakes (256 × 1,365) plus 32,768 one-phase outbox intakes (16 × 2,048). A two-phase
outbox reserves two ACKs and therefore fits fewer intakes. The byte caps normally
bind sooner; these counts are upper bounds, not promised useful capacity.

The complete retained-content ceiling is 512 MiB. Its fixed partitions reserve
256 MiB for effects, 128 MiB for outboxes, 56.75 MiB for mirrored staging claims
and releases (8 × 8,192 × 2 × (384 + 70) bytes), 8 MiB for staging payloads and
1 MiB for catalog and staging initialization metadata. Their total is 449.75 MiB;
the unused remainder does not authorize additional files. Filesystem block and
inode overhead is separate from this content budget. Journal and metadata names
are bounded too. A complete catalog scan precedes exclusive allocation; a slot
is never recycled, and an interrupted initializer retains its original quota.
Outside allocation seals pin the journal authority before intake. Missing or
populated unsealed history holds. Individual record/directory loss is detectable;
erasure of the entire root and all independent outside evidence is outside this
local storage guarantee. Permanent exhaustion holds new intake visibly while
reserved completion and same-ID recovery remain available. No receipt pruning
or user-data deletion is part of this design. Production wiring and measured
representative capacity remain acceptance requirements.
Count concurrent reservations before publication, then reserve capacity before
acknowledgement and hold visibly when full; never prune
completion records to reclaim authority. Recovery inspects at most 64 directory
entries or 20 ms per slice, rotates processes fairly, and allows four recovery
attempts and eight actual disk publications globally. An expired reply retains
its I/O reservation until the underlying operation settles. These are resource
bounds, not measured performance targets.

The existing random staging names do not yet provide the cross-process bound:
crashed clients can leave files before winning the exclusive publication. The
reviewed replacement design uses eight writer lanes with immutable generation
claims and releases. Only an exclusive claimant may write; observers may confirm
release but never inherit a writer lease. Each stage has a generation/nonce/step
name that cannot be reused, and a lease serializes its stages. Cleanup touches
only that generation's exact files. A dead-writer reaper must prove the original
boot/PID/precise birth is gone; unavailable evidence holds the lane. Mirrored
claim/release metadata, initialization authority and reserved release headroom
count toward retained bytes. Those metadata records need bounded atomic
publication themselves, without using the random staging helper recursively.

Revocation stops new publication immediately but keeps the lane until actual I/O,
FD closure, stage removal and directory sync finish. Cleanup has narrow generation
authority separate from the expired request: releasing in the caller's outer
`finally`, or attempting cleanup with its revoked `attempt.flush`, is unsafe.
Directory identity and destination filesystem remain pinned; cross-device
publication holds. The 8,192-generation lane cap has the local recovery and
final-fence evidence recorded above. Retained content and bounded staging
bytes are distinct from filesystem block/inode allocation. This is independently
implemented staging machinery, not a production capacity boundary or final acceptance; no broader
cleanup, record pruning or user-data deletion is authorized by it.

Linked Cursor/Command Code Stop reserves a durable completion obligation with
its first registration intake. Registration completion and Stop completion are
separate states; recovery installs unresolved Stop obligations before attach can
publish interpretation. Calling the current void `onTurnStop` callback does not
complete that obligation: it schedules asynchronous drain/grace work. Keep the
obligation until core records an authoritative terminal outcome under fresh turn
ownership, or conservatively hold it. Optional notification dispatch can be marked
as dispatched; asynchronous session control cannot use that marker as completion. After restart the former in-memory Cancel witness is
gone: completion must remain held unless durable correlation and Cancel/forget
revocation prove which turn it can affect. Rebuilding an in-memory witness after
restart does not grant new permission.

The native client persists its immutable UUID, original fired-at time, exact body
and engine incarnation before the first send. Owned pending and retryable 202 are
different protocol states; HTTP success alone is not acknowledgement. Retained or
possibly sent work must not fall through to offline registry mutation. Recovery
after the original caller exits must reprove the saved engine incarnation and
route, rather than reuse the short-lived caller PID. Generated plugins migrate to
the same identity/time contract; already-loaded legacy plugins retain an honest
hold explanation. Client outbox recovery and server intake recovery are separately
bounded, and neither may invent ownership for the other.

## Required evidence

Keep the former delivery, admission and installation goldens unchanged for moves.
Add crash-boundary tests before/after intake sync, effect claim, binding publication,
result sync and reply, plus same-ID contention, immutable conflicts, original-process
revalidation, pressure/fairness and corrupted storage. Include separate-process
contention on different IDs and different agent IDs for one process, a paused
predecessor claim, receipt/directory disappearance, delayed Stop arriving
before recovery finishes, linked Stop then Cancel then core crash, and a crash
during asynchronous Stop handling.
Deliberately broken wiring must fail assertions. Private daemon acceptance kills
the core while a real native hook is held, confirms readiness and unrelated control,
then recovers exactly once without using an owner's daemon, homes or tmux server.
The final client-protocol change needs its own explicit compatibility evidence;
installer source snapshots must not be silently re-recorded to hide behavior changes.
