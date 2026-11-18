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

## Design proposed for review

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
await. Both fresh-live rebases, global row validation, selected owner guards,
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
does not extend Registry's internal producer contract. If this source-level
contract is insufficient for review, the preflight must not seed raw fingerprints;
the alternative is to retain current capture until an explicit ownership API can
remove the cost. An unconditional duplicate pass on a changed last row is not an
acceptable fallback optimization.

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
All use private homes/data and actual store closure. First run is RED on unchanged
copy count; runtime remains unchanged until review. No build/native/cost run is
authorized by this proposal.

Pre-change receipt: `/tmp/core-grid-storage-flush-capture-red1-20261118.receipt.json`
and its adjacent log. Actual exit 1 in 4.306 s: unchanged flush failed with two
row copies instead of zero; the other four selected controls passed. No timeout
or cleanup signal was needed, and process group 7525 was absent after actual exit.
This is the caller RED, not a performance pass.
