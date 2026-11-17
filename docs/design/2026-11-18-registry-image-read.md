# Registry image reads during initialization

## Design

The startup profile at `b3ac09ec33` measured 6.627 ms reading and decoding the 1.8 MB,
1,600-row Registry image. Startup and corruption recovery still call the synchronous
private-file reader even though Registry loading and its writer already have asynchronous
admission. Reuse `readPrivateRegistryFile` for those two whole-image reads. This removes
disk waiting from the event loop without adding a worker, store or alternate reader.

Initialization owns its existing promise until the read, descriptor close, validation and
required migration settle. Public reads remain unavailable once private initialization
starts; mutations are refused from load admission. Exit waits for the same owned load.
Quarantine reads the current image under the existing cross-process lock, compares the
complete original contents, then checks lock ownership immediately before the synchronous
rename. A changed peer image is preserved and recovery refuses.

- Growth: no new retained state. Existing complete-image and row growth remain unresolved;
  this change introduces no guessed cap, eviction, hidden rows or memory acceptance claim.
- Concurrency: existing initialization admission and Registry file lock. The asynchronous
  reader keeps its descriptor through actual close; native binding proof still starts later.
- Read cost: one existing startup image read and one existing recovery comparison. No poll,
  retry, duplicate read, new serialization or cache.
- Scale: the recorded 1,600-row profile motivates removing disk waits; JSON parsing and schema
  passes remain synchronous. Compare the unchanged 16/160/1,600-row startup workload on the
  same toolchain; report elapsed, CPU, loop hold and memory without claiming this closes growth.
- Compatibility: bytes, schemas, old readers, migration order and public APIs are unchanged.
  The existing asynchronous reader is already used by Registry persistence on all platforms.
- Migration and rollback: no data migration; rollback restores the former read implementation.
- Audience and identity: the same private root, owner, permission and no-follow checks apply.
  No other account, process environment, user content or path enters new logs or metrics.
- Failure: unreadable images retain the existing write-blocked state; missing images retain
  the empty-start behavior. A changed recovery image still throws before rename.
- Platforms: common TypeScript on macOS, Linux and Windows; native Windows evidence remains
  separate. Process creation, launch policy and dependencies are untouched.

Checks selected before implementation: RED caller tests for held initial I/O and held
quarantine I/O; existing initialization, Registry and persistence/security cases; types.
Keep real lock/native identity checks on the unsandboxed, isolated test path. Cost and final
combined-source validation are coordinator-owned; do not repeat unchanged broad gates.

## Caller validation

Both new held-I/O caller tests failed on `787c737db6`: startup and quarantine completed
through their synchronous reader instead of waiting for the owned asynchronous read. With
the two read sites changed, initialization, Registry, persistence and private-file security
tests pass 185 cases (two existing skips); recovery and growing-file cases pass another
23 (one existing skip). Typechecking passes. All commands settled normally with actual exit
zero. Logs: `/tmp/registry-image-read-{red,green,recovery,types}.log`. Fixed startup cost
comparison, independent review and combined integration were pending at that commit.

## Startup comparison

The unchanged 16/160/1,600-row workload completed its twelve fixed A1/B1/B2/A2
cases on the same Node 24.22.2 macOS x64 host. A is `787c737db6`; B is `263e001cb1`.
Only the two Registry read sites differ in the imported runtime closure. Every case
exited zero with stdout/stderr EOF, child/group/guardian disappearance and private
directory cleanup verified. No timed case was retried. Two path-normalization
preflight failures and a missing quiet-marker refusal occurred before any workload;
their original records remain retained.

| Rows | Load ms A → B | CPU ms A → B | Largest loop hold ms A → B | RSS MiB A → B |
| --- | --- | --- | --- | --- |
| 16 | 64.148 → 73.179 | 30.741 → 32.323 | 41.459 → 49.604 | 54.242 → 54.059 |
| 160 | 143.480 → 145.452 | 118.922 → 116.373 | 43.433 → 47.219 | 61.318 → 60.941 |
| 1,600 | 804.489 → 812.786 | 855.772 → 863.140 | 67.675 → 60.495 | 104.393 → 108.813 |

Values are arithmetic means of the two runs per side, not significance claims. Both
1,600-row pairs reduce the largest loop hold; both increase CPU and retained RSS.
This is an I/O responsiveness tradeoff, not a universal speed or memory improvement.
Independent source review is complete; final combined and platform acceptance remain
open. JSON parsing and whole-image retention remain in core. Receipts are in
`/tmp/registry-image-read-startup-abba-v1`; manifest SHA-256 is
`03ca91c35d41b42d743ea0fcc85ab9ce50a89fc15d5d23406e4136e485f9ab56`.

## Corruption diagnostic privacy

Review found that a JSON parser exception can quote the private Registry image in
its message. Startup quarantine now reports only the fixed reason `is not JSON`.
This follows the existing sanitization for persistence failures. The same fixed
reason covers successful quarantine and quarantine failure; neither log nor caller
error receives the parser's content. Recovery behavior and retained file bytes are
unchanged. There is no new storage, audience, migration or runtime dependency.

Two synthetic sentinel tests first failed with content in the diagnostic, on the
successful-rename and failed-rename paths. A sandbox attempt also encountered the
existing native lock probe restriction; the isolated unsandboxed RED retained both
expected content failures. After the correction, all 17 quarantine and initialization
tests pass with actual exit zero. Logs are
`/tmp/registry-quarantine-content-{red,red-native,green}.log`.

## Independent review and integration

An independent reviewer found no blocking issue in author `e72dcb3b9b`, including
initialization/flush ownership, descriptor closure, post-read lock/deadline checks,
peer preservation, migration and diagnostic privacy. The reviewer verified all twelve
result hashes and custody records, both bundles, 103 Git-backed source imports per side
and six identical external imports, without rerunning workloads. The report is
`/tmp/registry-image-read-independent-review.json`.

Integration commits are `bb9ce8b807` and `6e1e24194a`. Changed runtime and test files match
the author byte for byte; typechecking passes on `6e1e24194a`. Native Linux/Windows,
early-boot signal handling and the final combined build remain separate acceptance.
