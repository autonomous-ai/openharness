# A direct proof that a process no longer exists

Close currently reads the complete process table even when its exact saved PID
has already been reaped. V17 nominates the retirement publication path at about
101 ms above the original build; the fresh native observation must remain on
both sides of asynchronous publication. This change reduces the observation's
work instead of removing the post-durability check.

## Design

- Growth and read cost: one signal-zero kernel check in `checkPidRuntime`, only
  for a positive signed 32-bit PID on macOS or Linux. `ESRCH` proves there is no
  process at that number now, so return the existing gone result without a
  census. No cached fact, timer, queue, retained state or new process is added.
- Identity: successful signal zero proves only existence, never identity or
  liveness of the saved engine. It always falls through to the existing fresh
  PID/start/executable comparison. Permission refusal or any other exception
  also uses that comparison. A recycled PID therefore still needs a census.
  Zero, negative, fractional, non-finite and out-of-range PIDs never reach the
  syscall; they retain the existing reader's domain and refusal behavior.
- Concurrency: no shared state or lock changes. Both Registry native refreshes
  and final synchronous authority checks remain. An `ESRCH` fact is local to
  that invocation; every later check asks again. A later process at the same
  number cannot resurrect the exited process's identity.
- Failure and audience: only `ESRCH` permits early absence. Other errors are
  neither logged with private content nor converted into absence; the existing
  reader decides alive/gone/unknown. Signal zero sends no signal. No process
  environment, credential or external account is read.
- Compatibility, migration and rollback: no stored data, public API, protocol
  or ownership transition changes. Revert restores the extra table read.
- Scale and measurement: the check is constant space and one kernel syscall.
  Compare the actual known-live, exited and termination callers, plus mixed
  full-table demand, on the same toolchain before accepting it. Measure whole
  Close/Resume only after the focused cost gate passes. No prior hold is waived.
- Platforms: macOS and Linux take the shortcut. Windows keeps its native
  process-table path unchanged; native Windows validation remains deferred by
  the user. No process-launch behavior changes.

Selected checks: red then green exported-caller tests for absent PID with no
census; success/permission/unexpected error fallback; PID reuse; invalid and
large persisted PID domain; repeated reads and changed facts; actual owned
process termination/reaping. Existing process-table, termination, Stop and
Resume callers and TypeScript follow. Both publication refreshes remain intact.
