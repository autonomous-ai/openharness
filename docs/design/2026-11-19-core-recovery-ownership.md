# Core recovery ownership

Linux run 44541245954 exposed a Codex reopen returning `AGENT_CHANGED` after the
terminal server died. Discovery removed the selected row while Resume was checking
its runtime. Background retirement must yield to Stop, Resume, Restart and Restore.
The independent correction review also found that input arriving after a restored
process is discovered, but before its launch is committed ready, bypasses the wait.

## Design

- Growth: no new stored data, jobs, queues or timers. Existing per-agent lifecycle
  ownership and the bounded input wait are reused.
- Concurrency: the foreground per-agent lifecycle owns retirement. Discovery checks
  ownership before side effects and carries it through archive/Registry publication.
  Input waits for the same launch revision, binding and token to become ready.
- Read cost: existing in-memory ownership lookups; no new file, process or network
  reads. Ready input keeps its existing path.
- Scale: constant work per affected agent. The paired startup/control/resume workload
  and input workload report CPU, memory and caller latency at the frozen final source.
- Compatibility: no wire, archive or Registry format changes; existing clients work.
- Migration and rollback: none; reverting the code restores prior behavior with no
  data conversion. Existing exact identity and archive publication checks remain.
- Audience: the daemon's existing authenticated control and terminal authority apply.
- Identity: no account or process identity is substituted or weakened.
- Failure: changed ownership refuses obsolete publication; restore timeout retains
  the existing visible error and never types into an uncommitted launch.
- Platforms: shared daemon code affects macOS, Linux and Windows. Validate macOS and
  Linux; the user explicitly deferred native Windows validation. No mobile changes.

## Validation

Add deterministic failing tests before implementation for retirement before and
during foreground takeover, and input arriving with an already discovered process.
Run discovery, forget, resume, restart, restore/input and architecture callers plus
types; run the native machine and Hermes cases with private homes and tmux servers.
Final per-file core coverage, exact-head gates and independent review follow once
all newly observed failures have been resolved. Keep failed evidence unchanged.

The six new cases failed against unchanged production code in receipt
`20261119T144146.762074Z-87118`. The affected caller checks and TypeScript then
passed in `20261119T144239.573087Z-88310` (99.2 seconds). Native validation and final
coverage remain pending; this does not resolve the separate Hermes Stop failure.
