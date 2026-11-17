# Session input fingerprint cost

## Design

The unchanged nine-case version-adapter comparison of `11bca810` with integrated
`787c737d` completed all four arms and cleanup, but remains on performance hold.
At 16 agents, tracked CPU was 280.943 → 308.168 ms, elapsed time 274.511 → 296.924 ms,
and p95 0.205190 → 0.229071 ms. Correlated CPU was 416.714 → 439.836 ms, elapsed
422.346 → 451.346 ms, and p95 0.302309 → 0.310189 ms. These are whole benchmark
process values over 2,000 writes, not isolated core CPU. All original operation,
frame and byte counts match the earlier version-adapter comparison.

The existing instrumented `11bca810` → `0c190a62` profiles identify one avoidable
cost still present in the corrected source: each complete prompt constructs a
streaming `Hash`, updates it once, and immediately digests it. Tracked fingerprint
and native descendants weigh 20.458 ms in B (19.026 ms in A); the `Hash` constructor
alone has 6.991 ms sampled self time and 885,392 estimated allocation bytes.
Correlated B has 29.936 ms under fingerprint and 7.907 ms in `Hash`, before the
later correction removed unused observed-prompt hashes. Those earlier correlated
samples are not a measurement of current hash counts or a predicted speedup.

The profile also includes the fixture itself (tracked A25.505/B27.810 ms,
correlated A62.985/B69.503 ms sampled self time), the real service JSON handler
(A29.024/B29.469 ms and A71.738/B73.774 ms), source-loader and inspector work.
Required resolve queries, generic input facts, binding and caller checks remain.
The full remaining whole-process delta is not attributed to the core or to hashes.

Replace only the fingerprint's streaming API with
`crypto.hash('sha256', content.replace(/\r\n/g, '\n').trim(), 'hex')`.
It hashes the same UTF-8 bytes, synchronously, at every existing comparison.
Normalization, SHA-256, hex encoding, lazy observed hashes and receipt matching
are unchanged. There is no cache, state, format, field, retained content, new
module, authority shortcut or skipped comparison. The public API and journals
do not expose or change this internal digest.

Node's [pinned 24.22.2 documentation](https://nodejs.org/download/release/v24.22.2/docs/api/crypto.html#cryptohashalgorithm-data-options)
describes this API for complete small inputs, using UTF-8 for strings and hex as
the output encoding. It was added in Node 20.12/21.7 and is nonexperimental from
24.13.1. This repository declares Node >=22.15.0 in `cli/package.json` and runtime
minimum 24 in `lib/nodeRuntime.ts`; the frozen native toolchain is 24.22.2.
Installed Node types declare the string/hex overload. No compatibility fallback
or second implementation is needed. The same TypeScript applies to macOS, Linux
and Windows; local validation is macOS x64 only.

## Validation selected before runtime changes

First update existing work-count observations to see both the old stream update
and the new one-shot boundary, using real crypto with spies, not replacement
digests. Existing pending match/mismatch, no pending match, early start and
reentrant receipt assertions must continue to pass on the old implementation.
Then prove RED that a complete submitted prompt and matching turn still allocate
streaming hash work. Behavior cases cover CRLF, trim, Unicode, empty content,
large ready input, bare carriage return and distinct Unicode normalization.

After the two-line runtime correction, run those tests and the existing complete
controller suite, core input/receipts/deliveries/ack callers and real Wi-Fi bridge,
at one worker. Require strict 100% per-file coverage for core input/deliveries and
type checking. Keep the current event, writer, binding, mutation, revocation and
uncertainty behavior. No benchmark or profiler is authorized by this Design.
Before another full nine-case comparison, propose a bounded comparison isolating
this one runtime delta with unchanged preparation/write counts and no extra
warmup. Any timing benefit remains unproven until that comparison is reviewed.

## Author evidence

The meaningful RED run exited 1: 18 cases passed and one allocation assertion
failed, observing two streaming `Hash.update` calls after the correct queued,
delivered and started outcomes. The migrated work-count observations and all nine
normalization cases already passed on the old source. A preceding command-only
failure rejected the unsupported `--minWorkers` option before running any test;
it is retained separately and is not product RED evidence.

After the two-line runtime change, the selected nine files passed all 313 cases,
actual exit 0. Core `input.ts` and `deliveries.ts` each have 100% statements,
branches, functions and lines (305 statements, 229 branches, 58 functions and
229 lines in total). Type checking exited 0. The previous behavior assertions
are preserved; work counts now observe real one-shot calls as well as streaming
updates, so obsolete stream-only spies cannot hide hashing work.

Receipts: `/tmp/shared-input-one-shot-red-v1.log` (command error),
`/tmp/shared-input-one-shot-red-v2.log` (meaningful RED),
`/tmp/shared-input-one-shot-green-v1.log`,
`/tmp/shared-input-one-shot-coverage-v1/coverage-summary.json`, and
`/tmp/shared-input-one-shot-types-v1.log`.
Performance acceptance remains held. No post-change timing or native workload
has been run.
