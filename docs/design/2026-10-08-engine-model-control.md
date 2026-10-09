# Engine model control

Claude Code and Codex choose model commands and walk model/effort pickers in their engine workers.
The native drivers live in `engines/<engine>/modelControl.ts`, behind `Engine.modelControl`.
Core still owns the user's requested target, accepted profile, session identity and exclusive input lease.
Other engines keep their existing controller implementations for their own migration batches.

## One request, one grant

`lib/runtimeControl.ts` validates a requested profile and takes the agent's input lease. Its native
control port is bound before its first await. Core snapshots the agent/conversation, process and
terminal binding as scalar data; editing the registry row in place cannot retarget an old request.
Native preflight rules (Codex's effort policy and plan scope) run in the worker against supplied facts.
The catalog snapshot used for preflight is also used for the first picker walk; the native driver can
request its existing single refresh if the picker has a model missing from that snapshot.

After generic admission and `beginControl`, `core/engines/modelControls.ts` gives the authenticated
engine service a random, single-operation grant. The worker receives a plain session and target,
never a tmux locator, registry handle or general core API. Its host permits bounded capture, text,
keys, catalog refresh and waits for core's profile confirmation. An effort confirmation must match
the target. Core uses its own bound agent for every terminal effect and its own conversation for
confirmation state. The ordinary denial of all other engine-worker queries remains in place.

Both ends validate the private v1 messages and routing metadata. Core checks the connection generation,
current binding, deadline and grant on each operation. It rejects overlapping host requests, more
than 128 queries or 32 writes, captures beyond 100 lines/256 KiB, control bytes in text, and requests
outside the finite key vocabulary. Four controls per engine may run concurrently; excess UI intent
is refused without queuing it for later. Validation has a five-second budget, apply has 30 seconds,
and a host query has ten seconds. Worker deadlines recycle that worker, never core.

A disconnect, replacement, timeout, completion or invalid host response revokes the grant. Core checks
that revocation after awaited terminal validation. The tmux submission pipeline also checks it after
its room queue, after loading a buffer, and immediately before Enter. A delayed callback cannot dispatch
another command after revocation. An OS command already dispatched can have an uncertain outcome;
revocation does not undo it, and core never retries an uncertain model change automatically.

Native Codex cleanup uses the same grant. Losing the worker can therefore leave its picker open.
Core does not guess an Escape after that loss. The user can close the picker and make a new request;
newly observed CLI settings remain real evidence even when the requesting control failed.

## Compatibility and composition

The parent-bound `HARNESSD_ENGINE_MODEL_CONTROL=<master-pid>:1` capability is additive. An older master
or explicit inline mode selects inline native facets at composition time, using the same core grant
broker. An unavailable worker never selects inline execution. `lib/runtimeProfileController.ts` is an
explicit compatibility wrapper for direct embedders and recorded controller fixtures; normal core
imports only `lib/runtimeControl.ts`. Architecture tests exclude native model drivers and picker
interpretation from the normal core import closure.

## Validation scope

Recorded controller/picker cases preserve command selection, catalog refresh and refusal behavior.
Broker/worker tests exercise malformed requests, grant limits, disconnects, timeouts, in-place rebinding,
late effects, missing capabilities and explicit inline mode. Terminal tests cover revocation during
validation, buffer loading, queue admission and the final Enter check.

`e2e/engineModelControl.e2e.ts` runs real supervised workers, core and tmux under private homes. It checks
Claude commands in isolated and inline mode, freezes either worker after its model command reaches the
fake CLI, and verifies failure, no resumed control, continued CLI/core processes and a new explicit
request after recovery. `e2e/models.e2e.ts` keeps Codex's model-list/effort/refreshed-catalog cases.
These are deterministic CLI fixtures, not real-model/account acceptance evidence. The opt-in
`PERF_MODEL_CONTROLS=1 PERF_READERS=1` workload measures model-change latency and core plus both workers
alongside the existing empty/idle/active windows; compare identical fixtures/toolchains on both builds.

This completes only model control. Native question-answer navigation, submission verification,
hook admission/installers, launch/discovery/resume and native control connections remain to migrate.
