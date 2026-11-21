# Explicit Registry flush capture

## Evidence

The accepted 80932c2ef1 staged diagnostic is
`/tmp/core-grid-storage-cost-profile-final1-80932c2ef1`. It is attribution, not a
timing acceptance: wrappers add awaits and observer work, and other source checks
were allowed. One `updateTitle` followed by explicit `flush` copied 3,200 rows and
canonicalized 8,000 row values at 1,600 rows. The second 1,600 copies belonged to
the unchanged explicit flush. There was no repeated exact canonical object within
a measured phase, so an object memo spanning phases is not justified.

The final fixed timing still has PERFORMANCE HOLD: at 1,600 rows the save median
was 330.082 ms parent CPU and 48.474 ms queued callback delay, versus baseline
256.389 ms and 34.911 ms. The original packets and 80932 source remain immutable.

## Design

Only an explicit, non-exiting `flush()` may compare current persisted views before
owning full nested copies. Distinguish it with a private persist mode, not a public
option: the existing `observation` mode also serves transaction release and load or
registration reconciliation. Ordinary mutator saves, transaction release, strict
bindings, external admission, unconfirmed recovery, and exit retain their current
capture order. A missing baseline, different row count, or unsaved names also uses
the existing path. No new state survives the current invocation.

The preflight synchronously makes the same `persistedRow` views and fingerprints
each once, without awaiting or caching live objects. If every fingerprint matches
the current baseline, perform the existing private-directory check and the storage
child's exact-byte equality proof. A successful equality result updates the image
witness on current Grid references as today and returns without cloned rows,
prepared bytes, locks, or publication. This remains O(rows) comparison work.

If a local difference is found, clone every per-row view in that same synchronous
interval, seed only those owned clones' existing fingerprint map with the already
computed strings, and enter the unchanged merge path. This avoids an extra full
canonical pass even when only the last row changed. Per-row structuredClone remains
the ownership boundary; final installed rows must retain their independent nested
graphs. No clone implementation, descriptor/proxy walker, or JSON round trip is
introduced. See the actual caller contract below; this is not valid for arbitrary
`rowFingerprint(unknown)` inputs.

If exact child equality misses after an await, discard all preflight views and
strings and capture fresh rows normally. Never seed fingerprints across that
await. A local known-miss flag skips the old equality shortcut on this fallback,
so a peer-only change causes one equality proof followed by the mandatory locked
retain, not two equality reads. Both fresh-live rebases, global row validation, selected owner guards,
deadline checks, names publication, source FD custody, legacy writer locks,
prepared-image proof, rename, and directory durability remain unchanged.

## Caller contract and its limits

At 89757d4b7a, every production persistence producer installs plain records and
arrays with primitive values. This is a source-level internal contract, not a
JavaScript structural-type guarantee and not a new accepted external format.

| Structured fields | Actual producer or normalizer |
| --- | --- |
| launch, closePlan, forkedFrom | Registry's normalizedLaunch, normalizedClosePlan, normalizedForkedFrom rebuild known primitive fields |
| launchModel | storedLaunchModel and parseLaunchModel rebuild model/effort literals |
| launchArgs, earlierSessionIds | storedLaunchArgs and earlierSessionKeys return string arrays |
| externalResume | parseExternalResume plus externalSessionRequest/Fact/Owner rebuild nested records and copy string arrays; no history reader crosses |
| scmLaunch | parseScmLaunchRecord returns only `{kind: 'git'}`; workspacesLink validates the service reply |
| grid | normalizedGridAssignment, launchedGrid and gridAssignmentAnswersIn rebuild baseUrl/model literals |
| gridLaunch | required storage's validated JSON projection and private reference records; selected raw override is not installed |
| processIdentity | processIdentityOf constructs pid/executable/startMarker/startTicks from parsed process evidence; discovery, restore, and paneEngineProcess use it |
| runtimes | tmuxBackend and ptyHostBackend construct literal route records; parsed historical rows are JSON values |
| historical unknown fields | initial load enumerates known fields; late-writer merge through strictPersistedRow may retain unknown nested JSON from the child's JSON.parse |

Open/register/pending/adopt/reinstate/strict setters already capture incoming
values before an await. updateProcessIdentity assigns the typed process/Grid
objects, and normalizedRuntimes retains its typed caller objects: those producer
paths were traced explicitly rather than assuming the setter itself strips
prototypes. The external `.launch =` in core/api writes a new client projection,
not Registry state. No production writer was found installing Date, an accessor,
toJSON, a function, or a custom prototype into a persisted graph. Direct byAgent
mutation remains supported for these data graphs and is covered below.

The generic fingerprint helper deliberately supports broader JavaScript inputs
(including Date and inherited toJSON). Its existing tests remain unchanged; that
does not extend Registry's internal producer contract. The reviewed implementation
relies on the audited production contract only in this private, non-yielding
path. A future producer with custom object behavior must not reuse its raw
fingerprint for a clone. An unconditional duplicate pass on a changed last row
is not an acceptable fallback optimization.

## Races, names, and compatibility

An unqueued direct edit while exact equality awaits is left for the next flush,
as with the current captured unchanged fast path. A normal mutator queues its own
save. If a legacy writer changes bytes, equality misses and fresh capture includes
both that peer image and current live changes under existing merge rules. A writer
after equality is noticed on the next observation, as today. No timestamp cache
or assumption that old writers have stopped is introduced.

flush still awaits names first. If another names mutation is pending at capture,
use the old path; a names write after comparison remains queued as today. No
publication starts in the fast path, and beginPublication/error-phase semantics
remain unchanged. The disk schema, private child contract, credential reference,
rollback compatibility, and platform filesystem behavior do not change.

## Selected validation before implementation

Actual Registry + real required child controls: unchanged flush preserves exact
bytes/live owner with zero row copies; direct last-row mutation persists without
an added full fingerprint pass; actual pending launch nested metadata survives
unchanged then direct edits; a late old-writer nested JSON field survives merge and
later direct edit; a direct live mutation during held equality retains current
snapshot semantics. Add explicit late-writer/equality-miss fresh capture, names,
and excluded transaction/exit/strict/unconfirmed controls if the Design is approved.
All use private homes/data and actual store closure. The first run was RED on
unchanged copy count before the runtime change was approved. No build/native/cost
run is authorized by these source checks.

Pre-change receipt: `/tmp/core-grid-storage-flush-capture-red1-20261118.receipt.json`
and its adjacent log. Actual exit 1 in 4.306 s: unchanged flush failed with two
row copies instead of zero; the other four selected controls passed. No timeout
or cleanup signal was needed, and process group 7525 was absent after actual exit.
This is the caller RED, not a performance pass.

The peer-only control failed before the known-miss flag: two actual child equality
calls instead of one, while the late writer's value was retained and published.
Receipt `/tmp/core-grid-storage-flush-capture-peer-red1-20261118.receipt.json`:
actual exit 1 in 1.875 s, process group 23691 absent, no timeout or cleanup signal.
The final affected two-file gate passed 53 tests, and TypeScript passed; receipts
`flush-capture-affected2` and `flush-capture-types2` under the same `/tmp/core-grid-storage-`
prefix. These counts prove the removed capture and unchanged behavioral controls,
not that the prior wall/CPU performance hold is resolved.

## Names validation found by the wider gate

The first nine-file gate retained 225 passing tests and four failures in
`registry.namesCost.spec.ts` (`flush-capture-scoped1`, actual exit 1 in 186.13 s).
Three tests still held parent FileHandle close/sync calls although required
storage now owns those operations. Their fixture now holds actual child retain
and flushed prepare results, releases/discards a result if the wrapper fails,
and attempts actual store closure even if an earlier teardown step fails. The
original publication, ownership, inherited-name, and durability assertions stay.

The fourth failure was a runtime category mismatch. Untouched source 89757d4b7a
reproduced it in `/tmp/harness-core-storage-names-baseline`; receipt
`/tmp/core-grid-storage-names-category-baseline-red1-20261118.receipt.json`
records actual exit 1 in 1.666 s, group 25344 absent, no timeout or cleanup signal.
After a validated child `json:false`, persistNames now creates a local SyntaxError
so the existing sanitizer retains the historical `name storage contains invalid JSON`
category. No raw child error, name, path, or content is exposed. This matches the
already corrected Registry-image path and leaves finite disk error codes intact.

Final selected coverage gate: `/tmp/core-grid-storage-flush-capture-scoped2-20261118.receipt.json`,
230 tests in nine files passed, actual exit 0 in 144.894 s. Group 28823 was absent;
no timeout or cleanup signal was needed. The emitted coverage covers all 23
statements, 17 branch counters, and three functions in the new preflight region
(lines 3487–3523 at this checkpoint). The full existing Registry file is 82%
statements, 75.62% branches, 85.84% functions, and 86.69% lines for this selected
suite; this is not full-file 100% coverage. Full core/harnessd, native, and cost
acceptance are not claimed by this slice. The prior failed gate and both REDs
remain unchanged beside the successful receipts.
