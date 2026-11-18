# Pending discovery directory checks

## Design

This is the next bounded correction within required session-storage extraction. It changes only the
child's repeated directory checks; primary receipt parsing, late legacy discovery, exact selected core
authority, marker durability and the public protocol stay unchanged. No historical receipt cache is added.
Root approved this scope on 2026-11-19, with actual REDs and final independent runtime review required.

### Measured cause and scope

The frozen V4 matched comparison remains a performance HOLD: at10,000 completed receipts recurring
discovery wall increased from1,381.69 to1,805.66ms while core CPU fell from1,400.90 to86.33ms. The child
still reads2,336,256primary bytes. Moving that work out of core is insufficient acceptance.

V5 added only diagnostic synchronous `lstatSync` counts/time to the unchanged V4 artifact/workload.
Exactly two10,000-record arms passed58effects each. All13,123 input records, four owned PIDs/two groups,
actual exit/close/EOF/IPC, expected storage-owner SIGKILL, private roots and cohort claims were verified.
Results: `/tmp/core-pending-index-cost-results-v5-b8b29-counts1/summary.json`, SHA256
`223e50b5372a0026abab3986f17c99fa6ff87ce619af588a9874e059733a9896`; independent proof SHA256
`74d79b4ca215184d4882f6fe9d47fa0cd567c0c579ac0fd4167e408a0e8fab24`.

Recurring candidate discovery made80,688 tracked lstats:40,342receipt-directory calls took227.443ms,
40,342index-directory calls219.380ms, and four marker calls0.030ms. Baseline recurring discovery made
zero tracked lstats. These are diagnostic wall durations around the original calls, excluding counter
accounting; they are neither pure syscall CPU nor uncontended acceptance measurements. Instrumentation
also changes how often a20ms cooperative page yields. Source explains the excess: both directory identities
are checked before and after every entry, including non-actionable claim/result/temp files.

### Authority and the narrower check placement

Only bounded IDs cross to core. `pendingLaunches.recover()` rereads `receipts.pendingIntent(id)` before
preparation, and `runIntent` preserves its existing receipt checksum, directory owner, claim and final
effect checks. That protects selected IDs, but cannot rescue an omitted pending ID. Consequently a
page-only check is insufficient: a valid primary from directory B could be classified as terminal while
the original A is moved aside, then A restored before the page ends. The successful page would omit A's
pending request and core would never reread it.

Keep one exact receipt-directory identity/security check immediately before every synchronous
`receipts.status(id)` classification, outside its per-record damaged-evidence catch. There is no await
between this check and the status read. Existing private file opens, owner/mode/size checks, JSON/checksum
validation, primary/claim/result/hold reads and sticky descriptor-close ownership remain unchanged.

Move the repeated full receipt-plus-index identity checks to:

1. the start and successful end of each bounded page;
2. immediately before each `ensure(id)` mutation and each terminal-marker retirement;
3. the existing failed-classification check before counting damaged evidence.

Keep the existing scan-open proofs and cursor ownership. Deadline checks still run before and after each
awaited iterator read, including ignored entries. Every entry consumes the64-entry/20ms work budget. A
non-file, invalid ID or non-primary sidecar supplies no status, hint or mutation, so it needs no extra
directory identity syscall between the page boundaries. A temporary replacement restored entirely while
only ignored entries are considered can therefore cease to cause refusal; no receipt from that replacement
is consumed. Persistent replacement still fails the page's final full check.

The fresh mutation check also closes a concrete source gap: current `page()` checks directories after
`dir.read()` but its pending branch calls `ensure` without comparing to the scan's directory again after
classification. If the path is replaced during status inspection, `ensure` can durably create a marker
in the replacement before the next loop check refuses the old scan. The RED must show this effect and
the correction must refuse before touching that replacement marker. `ensure`'s own exact root/parent/index
and descriptor checks remain in addition to this scan authority.

### Limits, failures and durability

No new retained record, cache or queue. One scan still owns at most two actual directory iterators;
close uncertainty retains custody until actual child reap and never becomes ordinary damaged evidence.
The same five-second request deadline,64-entry/20ms page budget, bounded wire frame and core retry window
remain. A stale cursor cannot close a newer scan. Refusal yields no successful partial page.

All four fresh-marker flushes remain: marker file, index directory, receipt directory and resolved root.
The V4 admission cost of200extra child fsyncs per50admissions remains a separate durability question.
Caching only stable ancestor inode identity would be insufficient: the same directory can be moved away
and back without proving its current link durable. This patch makes no ancestor-flush reduction.

### RED and selected gates

- Actual child-module RED: a complete mixed history scan returns the same IDs/damaged count but exceeds
  the proposed bound of one receipt-directory check per classified ID plus fixed page/open checks.
  Assert final hints, missing-marker retention and actual iterator closure, alongside syscall counts.
- Actual mutation RED: replace the original receipt directory after a pending status read; the old page
  must not create a marker in the replacement before refusing. Preserve the failed old behavior.
- Controls: transient A→B→A primary replacement cannot omit an original pending request; persistent
  parent/index replacement, missing/damaged primary, marker replacement, ignored sidecars, empty/missing
  roots, old writers after a completed scan with restored mtime, deadline after awaited read,64-entry
  fairness, real child replacement and sticky file/iterator close uncertainty.
- Run one-worker pending index/receipt/coordinator source gates with explicit child-module100% coverage
  and types. Do not rerun unrelated authority/full-core gates. Any changed test seam is reported separately.
- A new matched artifact/cost pass needs root integration, frozen input review and explicit coordination.
  The V4/V5 source/artifacts and accepted authority checkpoints remain untouched.

Actual RED at unchanged runtime `cacccb3a489f5243c97938afd722a913f49b0df1`:
`/tmp/core-grid-storage-pending-directory-red1-20261119.{log,receipt.json}`. Both selected cases failed:
the complete33-status scan made141receipt-directory lstats against the39check bound, and the refused
original scan nevertheless created the replacement marker. Actual exit1/0.914s, no timeout or cleanup
signal, PID/group76161 absent. Thirty unaffected cases were intentionally not selected.

## Data-design checklist

1. Growth: no new state; existing historical receipts remain indefinitely for duplicate prevention,
   pending markers retire only from authoritative terminal evidence, scan state ends on close/reap.
2. Concurrency: exact scan directory identities plus per-status receipt admission and fresh full mutation
   checks; cooperative legacy writers remain possible. Same primary hard-link/claim authority.
3. Read cost: no primary bytes or parsed records omitted; removes redundant directory metadata calls only.
   Missing/removal/damaged evidence remains visible. No entire history table or changed wire payload.
4. Scale: existing1,000/10,000 measured cases and fixed page/frame/retry bounds remain. Child scan wall/CPU
   and syscall counts expose growth; current performance remains held, with no projected acceptance.
5. Compatibility: core discovery still receives ID hints, then rereads exact authority. Old/new clients,
   terminal replay and receipt status readers see unchanged schemas and categories.
6. Migration/rollback: none. Same legacy-readable receipt/claim/result images and reconstructible markers;
   whole-cohort rollback behavior is unchanged. Production restore N/A because no durable format changes.
7. Audience: same private-root/file admission, constructor-owned paths and same-build storage child;
   no payload/credential/identifier added to logs, telemetry or public copies.
8. Identity: same daemon OS account, selected immutable child and core receipt authority; no foreign-login
   fallback or new source of process launch authority.
9. Failure: same named storage refusal/damaged count, no automatic effect replay; cleanup uncertainty stays
   sticky and physical owners are retained through actual close/reap.
10. Platforms: daemon TypeScript on macOS/Linux/Windows; same Windows directory-sync policy. Source controls
    run on pinned macOS; native Windows remains deferred. No mobile/web change.
