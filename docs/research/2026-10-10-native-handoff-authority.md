# Native Change agent handoff authority

This completes the handoff consumer in the daemon-core completion checklist.
History reading, normalization, redaction, rendering and git commands remain in the
edge service. The core owns the final bounded publication, including current session
and native identity, request lifetime, the project destination and git exclusion.
Unavailable evidence holds the original Change agent request before Close.

## Former-code baseline

Before changing runtime code, `nativeHandoff.golden.spec.ts` recorded twelve healthy
observations from `a395b72cf20d2d574b80eb737f2f39cae58e3b7e` at October 10 11:06 UTC.
Both Linux and macOS behavior are explicitly pinned. Each covers own history,
fork-parent history and discovered history through the inline service and the real
JSON service-link/query composition. Actual private native files, reader, renderer
and writer run; host binaries are forbidden. The clock, UTC and fixture identities
are fixed. No test uses an owner's home, daemon, tmux or clients.

The artifact SHA-256 is
`b921e24e4e321820fa65f14852f48ff1648c2c82447a2ea131bd7a075e958f11`.
Recording passed; unchanged replay of this golden and the prior 38-observation
native-consumer golden passed (four platform cases, two files), then typecheck passed.
An initial recording command used a doubled config path and ran no tests; the
corrected command ran from the CLI directory. The prior artifact stayed unchanged.
This baseline is committed separately before implementation.

## Accepted design and selected validation

Independent read-only architecture review approved a core-owned final commit with
injected session/lifecycle facts and an eager bounded filesystem helper. It must not
import history readers, rendering, git execution or `agentHandoff`. No architecture
exception is needed. The review requires:

- Exact descriptor identity and finite content version carried from the actual read.
- The complete fork/selection facts and fresh ownership after asynchronous discovery.
- A core-owned request deadline and connection witness checked inside publication.
- Git exclusion authorized together with every other project write.
- Private durable receipts: same ID/different input conflicts; partial publication or
  an uncertain reply is never inferred to be a completed handoff.
- Explicit holds through malformed/disconnected process replies and both Desktop and
  TUI, before Close; no fallback from unavailable identity to cached conversation data.

The former code fails twelve composed native-authority assertions while its healthy
golden passes. Additional regressions cover body replacement with an unchanged
header, ancestor/project changes, intermediate fork changes, stale request/connection,
publication failures and recovery, and both clients receiving a hold without Close.

Before landing: typecheck, architecture, full core and harnessd coverage at the
repository thresholds, affected native/reader/handoff/process specs, touched client
specs, private handoff/lifecycle/service-process e2e lanes, behavioral wiring mutations,
and matched runtime-cost samples. Record exact input/toolchain scopes before formal
validation. Keep all golden artifacts unchanged, obtain independent exact-head/base
review, and wait for every automatic check including `ci/required`. Merge with the
repository helper. No release is authorized.
