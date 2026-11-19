# Reuse the current pending-directory proof

## Design

The current storage child checks its pinned cwd and configured absolute receipt directory on every
`PendingCreationDirectory.verify()` call. The caller then repeats the same absolute-directory lstat
before comparing with its own scan or publication image. Return the proof from that same fresh
verification and compare it directly. This changes no check location, no pinned identity and no
receipt interpretation. A return before first admission remains undefined.

The profile of the actual compiled child in
`/tmp/core-pending-index-cost-results-current-profile-v4/root-profile-analysis.json` attributes
301.104 ms of sampled occupancy to the scan directory fence, including 215.466 ms in the binding
verification and approximately85.638 ms in its repeated absolute-path proof. These are diagnostic
occupancy numbers across recovery and recurring discovery, not function CPU or acceptance timing.
Receipt reads still dominate; the historical cost hold remains.

The same adjacent duplicate occurs after directory iterators open. Both comparisons use the value
returned from the immediately preceding verification, not a stored observation. The post-durability
check remains unchanged: intervening root-path observations separate its two receipt-directory checks,
so removing its later check would change the publication fence.
Every invocation still lstats cwd and the absolute directory and checks directory kind, no symlink,
owner, mode, device, inode, birthtime and group. A mismatch still throws
`PendingCreationDirectoryLost`; the actual child exits, and only a new child can adopt another path.
The scan's expected parent proof is still compared, and authority failures stay outside damaged-record
handling. All four marker flushes, the128-entry durability cache,64-entry/20ms page budget, deadlines,
full legacy history reads and final selected core authority are unchanged.

The direct scanner test adapter previously used a no-op binding. Its replacement uses fresh absolute
path identity/security checks and the admitted proof, without changing Vitest's cwd. Actual cwd and
process-retirement controls remain in the admitted child suite. The adapter's ordinary `changed`
refusal preserves direct scanner tests; it is not evidence for production child retirement.

- Growth: no new retained state or disk format; the existing pinned proof is returned, not copied into a cache.
- Concurrency: the same synchronous fences surround classification and mutation; no await is introduced.
- Read cost: one fewer absolute directory lstat at each duplicate fence; every receipt/sidecar read stays.
- Scale: same bounded scanner and catalogue. Actual child syscall counts prove the difference; matched
  CPU/wall/RSS acceptance remains root-owned after final source freeze.
- Compatibility: no public/private wire or saved-format change; old writers with restored mtime still discovered.
- Migration and rollback: none; whole-runtime rollback reads the same receipt files and marker format.
- Audience: the same authenticated storage child and fixed private root; no new inputs or capabilities.
- Identity: same daemon account, cwd capability and final core selected-receipt authority.
- Failure: unchanged named lost-binding/changed/unsafe/cleanup refusal; no swallowed authority error or retry.
- Platforms: shared TypeScript on macOS/Linux/Windows; actual child tests on macOS; native Windows deferred
  by the owner. No process spawn implementation or mobile change.

## Tests selected before implementation

First add an actual admitted-child caller control that scans32 completed receipts and records real
bigint lstat paths between each directory entry and its primary open. Each classification must have
one cwd and one absolute-directory proof, with unchanged empty hints and actual iterator closure.
The unchanged source makes an extra absolute-path check and must fail. Existing cwd-lost and
bind-replaced controls run alongside it. No mocked result, nth-call authority flip, sleep or timing limit.

Then run the pending index, actual directory/process, custody, ancestor and storage-process suites,
plus affected receipt/discovery callers, with one worker and scoped `pendingCreations.ts` coverage.
Run source types separately. Keep initial failures and exact receipts; no benchmark/build/native
suite or broader core gate in this task.

## Evidence

The corrected actual-child control failed before the runtime change: all 32 classifications made
`cwd, absolute, absolute` checks instead of `cwd, absolute` (receipt
`20261119T082041.678333Z-93310`). The earlier fixture run is retained separately: its evidence-file
writes contaminated the counter and its first generated identifier was too short, so it is not the
behavioral red.

The seven selected suites then passed 126 tests, including all 21 actual directory-process controls,
and failed two direct scanner fixtures (`20261119T082247.907742Z-95409`). Source types passed.
The explicit-path adapter now performs two fixed admission checks; its syscall bound accounts for
those checks. The restored-mtime fixture now verifies that APFS birthtime remains unchanged instead
of rounding an mtime backwards across creation. Both corrected fixtures passed separately
(`20261119T082514.004629Z-97933`), with production source unchanged. These complementary runs cover
128 selected tests; they are not a new full suite run. Parent-process coverage does not instrument
the real child: pendingCreations.ts reports 91.62% statements, 90.4% branches, 81.81% functions and
91.72% lines. No full coverage or timing acceptance is claimed. Final matched performance remains open.
