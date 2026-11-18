# Bounded JSON traversal without per-call functions

## Design

The V12 Wi-Fi source comparison reduced core-only CPU for 1,600 sessions from
55.915 ms to 14.356 ms, while complete refresh CPU remained 53.636→93.266 ms.
The approved two-arm V12 diagnostic attributes 208.214 ms of sampled occupancy
across its fixed 24 operations to the shared byte walker: 119.409 ms at the
producer and 88.805 ms at the consumer. Its exact generated source creates three
named functions (`add`, `string`, `enter`) on every call. Generated name setup
accounts for 34.826 ms inclusive occupancy; descriptor lookup accounts for
60.917 ms self occupancy. These are sample occupancy, not function CPU, and the
diagnostic's fixture paths differ in length from the uninstrumented comparison.

Replace only the walker's per-call helper functions with one iterative walk.
This removes three function allocations and the production `keepNames` build's
three `Object.defineProperty` calls per invocation. It retains the same complete
traversal, descriptor reads, exact string counting, array-hole behavior,
ancestor-cycle detection, depth limit, work limit and rejection of proxies,
accessors and callable `toJSON`. There is no trusted-input bypass, new cache,
new file in the core's import closure, authority change or quota increase.
This small correction does not claim to close the whole refresh regression.

1. Growth: no persistent data. The existing stack and ancestor set live for one
   call and remain bounded by 4,096 levels; work remains bounded by the byte limit.
2. Concurrency: synchronous local state only; no locks or shared mutable cache.
3. Read cost: the same fields are examined with the same descriptor semantics.
   No getter, proxy trap, `toJSON` or complete-object serialization is invoked.
4. Scale: limits remain unchanged. Fixed before/after workload CPU, latency and
   memory remain the performance evidence; deterministic compiled-code controls
   separately show that per-call function-name writes go from three to zero.
5. Compatibility: the same byte count or `null` is returned to every caller.
   Public/private wire formats and reader admission rules do not change.
6. Migration and rollback: no stored schema, deployment ordering or migration.
   Reverting this function restores the old cost without changing accepted data.
7. Audience: existing callers enforce it; this pure counter grants no access.
8. Identity: no process, login, credential or external work is involved.
9. Failure: existing callers keep their typed refusals when this returns `null`.
   No new logging or content is exposed.
10. Platforms: shared TypeScript on macOS, Linux and Windows. Local validation is
    macOS; Linux follows final PR validation. Native Windows is user-deferred.

## Validation plan

Before the runtime edit, run the new direct semantic controls and deterministic
compiled-code cost control. The latter bundles this actual helper with the
release's `minify: true`, `keepNames: true`, Node20 target and invokes the caller
through its export while counting function-name property writes. It must fail
on the existing three allocations per call, without a wall-clock assertion.
The same semantic controls then pass with no runtime function-name writes.

Run the existing peer JSON, pending work, evidence reader, session snapshot,
Wi-Fi view, Wi-Fi process, Devices process and core session-read controls;
measure helper coverage explicitly, and run TypeScript and architecture checks.
Root runs the final combined core gate. Only after source and gates are accepted
may the unchanged fixed Wi-Fi comparison be run on a new frozen candidate.
Preserve the original V12 packet and every failed gate. No new diagnostic,
warmup or additional timing arm is authorized by this design.

## Recorded evidence

- Clean test baseline `49159bd4e0a7879760d5cca8659f747fd2b3c5c3`: four semantic
  controls passed and the cost control failed with exactly 192 function-name
  writes for 64 calls, against zero expected. Receipt
  `.harness/validation/20261118T222930.691245Z-61248/receipt.json` retains that RED.
- Runtime `e467510b8d73b9a90a9c46f6cb07b34aedb5dbd7`: all 249 caller tests in
  11 files passed, including zero function-name writes for the same 64 calls.
  TypeScript and architecture passed. The combined receipt
  `.harness/validation/20261118T223059.473167Z-62833/receipt.json` remains failed
  because helper coverage was 96.59% statements, 96.47% branches, 100% functions
  and 98.21% lines; it is not represented as an entirely passing gate.
- Two added controls cover inherited enumerable-key omission, comma/key byte
  exhaustion and a failed reflection operation. They change no runtime source.
  On clean `feacfc33a4f4cdc73022923e3beb42799f6ab335`, all 13 direct/peer JSON
  tests pass and helper coverage is 88/88 statements, 85/85 branches,
  3/3 functions and 56/56 lines. TypeScript passes. Receipt
  `.harness/validation/20261118T223239.497409Z-64683/receipt.json` is passed.

The helper is 76→82 source lines; its core import closure gains no file or
dependency. These are code and deterministic-work results only. The V12
complete-refresh performance hold remains until a separately approved fixed
comparison measures the new source. Final combined core and Linux checks remain
with the integration owner; native Windows remains user-deferred.

## Numeric array indices

The fixed V13 comparison passes all semantic and custody controls but retains
the complete-refresh performance hold: at 1,600 sessions, core-only CPU is
54.219→12.988 ms; complete-refresh wall is 53.688→80.568 ms and CPU is
53.744→85.185 ms. The existing V12 profile's 60.917 ms descriptor-function self
occupancy contains mandatory native descriptor reads as well as removable
function calls; it is not an estimate of the benefit below.

For an array element, ask `Object.getOwnPropertyDescriptor` directly using the
numeric index and traverse prototypes only when the own descriptor is absent.
The intrinsic converts its property key; an extra JavaScript `String(index)`
call is unnecessary. This removes that call and the generic descriptor-loop
invocation for present slots, preserving the exact descriptor/prototype access
order after the same visit bound. An own `undefined` entry still masks an
inherited entry, holes still read inherited data, and accessors are refused
without invocation. Object keys remain quoted strings, even numeric-looking
ones. Every other byte, visit, depth, proxy and `toJSON` check stays unchanged.

The Design points above still apply: no cache, trusted-row bypass, new core file,
wire/schema change, authority change or quota increase. Source is 82→83 lines.
The compiled cost control keeps the original 64 row calls and checks exactly
three necessary numeric-value string conversions per row. The unchanged V13
helper performs 1,408 explicit numeric conversions; the intended result is 192.
This counts calls, not allocations or elapsed time, and promises no complete
performance closure. Existing semantic controls add numeric-looking object keys
and own-undefined-over-inherited array values before the runtime change.

Run that deterministic control RED on unchanged V13 source, then the exact
reviewed runtime, the affected caller/helper coverage gate, TypeScript and
architecture checks with one test worker. No additional diagnostic or timing
round is authorized by this follow-up; source and gates return to the
integration owner first. The earlier 798ceec399/V13 worktree stays frozen.
