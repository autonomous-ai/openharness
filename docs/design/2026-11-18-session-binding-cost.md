# Session binding checks without repeated full serialization

The shared-input comparison records additional CPU in ordinary, tracked and correlated input. A fixed
profile identifies repeated `sessionBinding` serialization in authority checks. Replace its string API
with a captured predicate in the existing module; no component or new core module is introduced.

The predicate retains the eleven scalar binding values and the JSON fingerprint of runtimes and process
identity. Every check rereads the scalars and serializes the nested values afresh. Object identity and
registry revisions never skip a check. Absent/null and nonfinite scalar numbers compare as the previous
JSON array did; nested plain Registry data retains JSON ordering and member semantics. Executable
getters, custom `toJSON` and boxed primitives are outside `RegisteredSession`'s plain data contract.

Input, control transport and the existing screen/submission readers capture at their authority boundary.
Composer verification keeps capturing from `readingSession(operation.session)` at each existing check, preserving first-launch bind
behavior. `launchBound`, connection revocation and writer ownership are unchanged. Wi-Fi compatibility
traffic remains a separate change, held on the supervisor's worker-admission proof.

## Design

- Growth: one fixed scalar array, nested fingerprint and predicate per existing operation/control
  lifetime; released with it. No map, cache, queue, timer or persisted state.
- Concurrency: current session and original connection are checked at every existing effect boundary.
  Nested in-place mutations cannot alter the captured fingerprint.
- Read cost: the same thirteen binding fields of one session, with no scan or extra registry read.
- Scale: the existing input bounds apply. A fixed public-caller test measures serialized bytes; the
  unchanged workload comparison separately measures CPU and latency. Counts alone are not cost acceptance.
- Compatibility: private in-process API only. No backend, public client, worker wire or stored schema changes.
- Migration and rollback: no migration; revert restores the earlier comparison.
- Audience and identity: unchanged owner/session/connection authority. No new exposed data or credentials.
- Failure: existing rejection before an effect and uncertainty after a possible effect remain visible.
  No new network call, wait or retry.
- Platforms: common TypeScript on macOS, Linux and Windows; local evidence is macOS, with remaining
  platform and final combined gates owned by the integration task.

Validation is selected before implementation: a public-caller serialization regression fails on unchanged
code (1,124,400 bytes for 100 writes, against a 200,000-byte bound), then binding equivalence, scalar and
nested mutation, replacement, first-launch and revocation tests; affected input/control callers, per-file
coverage and TypeScript. The fixed cost comparison uses recorded source/toolchain and owned cleanup.

Local focused evidence on macOS (Node 24.22.2): the unchanged caller test failed first at 1,124,400
serialized bytes; the replacement passes its 200,000-byte bound for the same 100 successful writes.
The nine selected input and engine caller suites pass all 351 tests. Each changed core file has 100%
statements, branches, functions and lines with the existing per-file thresholds; TypeScript passes.
The existing 401-array and 1,802-Promise bounds remain unchanged and pass. An intermediate focused run
caught omitted alias imports and an unnecessary mapped array; its failed evidence is retained, and the
corrected run includes all readers. These are source-scoped checks; full integration and unchanged
workload CPU/latency acceptance remain with the integration task.
