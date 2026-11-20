# Share the native census and materialize only requested rows

V12 profiles nominate process-table parsing/copying. Native PID selection was
rejected after measurement: it reduced single-check core CPU, but a late full
request or timer-separated lifetime checks launched a selected read plus a
census. The fixed actual termination caller regressed by 30–34% main CPU.
Same-turn batching did not fix that production shape. Neither experiment ships.

## Design

- Read cost: keep the existing full `ps` formats, parallel reads and native
  invocations. Hold their bounded raw outputs until both have settled, then
  parse and copy only rows requested by known-PID lifetime callers. A full
  discovery caller joining while I/O is in flight promotes the same read to
  full parsing; it never starts an extra native read beside it. Command-path
  enrichment also parses only requested PIDs. The existing single-row parser
  and exact UTF-16 ownership are unchanged.
- Concurrency: one in-flight census with a requested-PID set, or full mode.
  Calls join it throughout native I/O, including separate timer callbacks.
  Up to 128 distinct requested PIDs are retained; further demand promotes to
  full mode. Seal the scope before synchronous parsing. Once sealed, a caller
  asking for an uncovered PID or a full table must start a fresh read instead
  of consuming a partial result. By then both old native reads have settled.
  Only the matching read can clear the pending slot, including source reset.
- Growth and deletion: one bounded scope and the existing two bounded native
  output strings. Each native output remains subject to the existing 1 MiB
  exec limit and patient timeout. No completed result or process fact is cached.
  Scope, raw outputs and excluded rows are released at settlement. Only returned
  rows receive independent field copies. No new file, dependency, timer, process
  role, persistent storage or public protocol is added.
- Identity and audience: `checkPidRuntime` still compares PID, executable and
  start identity. No signals, environment reads, account access or logging are
  added. Windows/injected sources retain their full-reader contract and PID
  domain. Invalid native selection is unknown, as a conservative refusal.
- Failure: a native read failure is unknown. A selected read must parse the
  reader's own row as a live witness before reporting absence. Leading-PID
  admission uses only the numeric prefix; a malformed row naming a requested
  PID or the witness refuses the selected batch. Unrelated malformed lines
  remain irrelevant, as the original census already skipped them. Full mode
  preserves its original parser/refusal behavior. Thus selected invalid rows
  may make up to 128 selected checks unknown; this bounded fail-safe coupling
  needs explicit tests. A failed command-path supplement still preserves the
  original base identity. Zombie filtering and Linux start ticks are unchanged.
- Scale: single checks still receive the full native output but avoid most
  row parsing, Buffer copies and enrichment in core. No new native fan-out.
  Measure single/same/distinct requests, both same-turn full orderings, late
  full demand and the actual timer-based termination caller against `2bac9e`.
  Report all arms. Core-only numbers are not total-process or release acceptance.
- Compatibility, migration and rollback: existing no-argument discovery calls,
  return fields, stored identities and Windows source are unchanged. No data
  migration. Revert restores full materialization. Native Windows is deferred;
  native macOS and Linux still need mapped evidence.
- Platforms: same POSIX `ps -axo` and fixed locale. No new OS selector or PID
  list syntax. Native filesystem/process checks retain their existing platform
  handling. Unrelated optional features gain no core policy.

Selected checks before runtime changes: RED native-call counts through actual
exported lifetime/full callers across I/O and microtasks; selective field-copy
counts; late full promotion; 128/129 scope cap; sealed-result rejection; failure
fan-out and fresh retry; source reset; witness and malformed selected rows;
exact identity/command-path/Linux tick/zombie controls; existing heap-backing
regression and reader ownership; affected callers, types, independent review,
private native fixture, and the fixed seven-case ABBA. No old hold is closed by
source review, source size or one helper test.
