# Component startup policy outside core

Source-only design. Base751be6f42e, worktree /tmp/harness-component-startup-extraction-20261119. No runtime edit or tests yet.

## Ownership

The always-running edge host gets one small `componentStartup` runner. It starts no socket and receives no core credential. It owns the saved-state presence checks for experiments/Browser, Grid state, paired/direct devices, orphan viewer servers, and Unix /dev discovery. The core stops loading devicesWake/modelsWake/gatewayWake/viewersWake and the saved-state functions of experiments.ts. The saved paths leave EXPERIMENTS and CLIENT_STREAMS for a component-owned declaration.

The core retains the already reviewed single pre-bind signed-in gateway request: its own session/account transport needs that process. It neither reads pairing files nor parses a feature's state. Agent/session stream wake remains the existing shared declaration-based agent follow. Hachi's existing account-settings transition requests Store directly through the same existing channel, without a viewers-specific tracker. Account settings synchronization is unchanged shared launch authority, not claimed extracted here.

## Peer start contract

`ServiceSpec.wakes` declares a fixed list of peer service names allowed for that host. Only edge has it, matching componentStartup's finite catalogue (devices, wifi, models, gateway, viewers, orchestrator, sharing, cloud, agentBrowser). The master accepts existing `harnessd:want` only from the current physical child, while not ending/stopping, and only for a declared present peer. It calls the existing idempotent want owner; parked/restarting peers are not restarted out of policy. Unknown/malformed/undeclared requests have one bounded content-free refusal log per sender incarnation. No files, feature conditions, arbitrary argv, environment or network enter master.

The detector must stop /dev scanning if another caller already started Devices. Retaining a core callback for that would preserve feature policy in core. The minimal companion is a generic `harnessd:peer-started` message naming one declared service. Supervisor sends it only after the target is owned for startup/retry, and sends the current active peer set once when the subscribing physical child starts. Per event the fixed capability list bounds fan-out; no retained queue, payload data or historical records. The watcher records at most the fixed peer names. A target under restart/park remains owned by master, so the detector stops looking just as it did after its own want. Stale physical senders cannot request or receive, and shutdown cannot start a peer.

The runner installs its channel listener before discovery. An initial snapshot arriving later still stops its sole timer. A want is issued once per peer per runner life; reliable spawn-channel delivery either reaches the master or the host exits and the next incarnation retries its bounded initial inspection. Send refusal is logged with STARTUP_UNAVAILABLE, without paths/content. There is no retry/poll of IPC or whole daemon state.

This additive IPC and changed ownership are tied to the immutable private worker plan. Old retained masters cannot silently omit the runner or ignore peer starts: cohort admission refuses mixed plans before effects and the existing whole-runtime rollback applies. Root integrates the final plan with Paste and Cloud. A contract bump is appropriate if required by the combined private semantics; public clients are unaffected.

## Explicit subset, disabled and inline behavior

componentStartup belongs to the existing edge process and is master-only (alongside the updater in the runner's no-core-connection set). Default: edge starts concurrently with core and runs discovery. Explicit `HARNESSD_SERVICES` subset: every selected on-demand host already starts immediately, so no detector is needed for omitted peers; even if edge is selected it can only wake present peers. `none` / Harness OS: all existing services start inline, no on-demand discovery is needed and componentStartup is not run. This adds no new feature-off setting and no process at idle.

## Design

- Growth: no new persistent state. At most one /dev timer, one Set bounded by the nine declared peer names, and one bounded directory/file observation at a time. No core retention is added.
- Concurrency: synchronous component-only inspection; physical master child identity fences every peer request. Peer ownership stays with existing ServiceSupervisor. All stop and scan cancellation is idempotent.
- Read cost: saved state inspected once per edge incarnation; Unix /dev retains the existing two-second cadence only until Devices is owned. No whole-core or service polling. Directory scanning must be bounded (proposal: stop at4096 entries and conservatively wake that component if the limit is hit, with STARTUP_SCAN_LIMIT log); saved JSON remains at1MiB, read through a bounded descriptor read rather than stat/read TOCTOU. Overflow never silently declares the component off.
- Scale: matched fresh-core/edge startup and60s idle fixtures: core vs total CPU/RSS; absent vs first dial, saved state, and externally requested Devices. Core should perform zero startup-feature file reads and zero /dev scans; no extra process. Timing held until root freezes combined source.
- Compatibility: same public frames. Existing saved paths retain their meaning; new conservative overflow behavior only affects workloads beyond the explicit observation bound. All normal and error goldens migrate with functions. Invalid/missing JSON keeps existing no-state result, but malformed/oversized/read failures receive content-free diagnostic names; ENOENT is normal absence.
- Migration and rollback: no data migration. Runtime cohort/plan prevents unsupported mixed composition. Previous complete runtime reads the same unchanged files after rollback.
- Audience: only master-owned current host IPC; declared peer starts, no user-provided names or payload forwarded to spawn. Started-peer notices reveal no PID or content.
- Identity: same owner's process; no login/token is read by componentStartup.
- Failure: startup worker failure costs only edge services; core sessions continue. Existing master restart/park behavior applies. A refused send or unreadable/oversized feature state is logged without paths/content; supervisor states expose unavailable peers.
- Platforms: macOS/Linux discovery preserves USB prefix semantics and isolated test-dial input. Windows still requests Devices at startup unless cable disabled; no new process spawn implementation. Native Windows validation deferred by user. Mobile untouched.

## Exact caller REDs and selected checks

Before runtime edits, add behavior tests to existing serviceSupervisor caller fixture: a current edge child asks for a declared off peer and the peer must start once (fails today); positive undeclared/old-child/ending restrictions; initial/delta peer-started notice proves a detector can stop without a core feature callback (fails today). These run through actual child message callbacks and spawn records, not nonexistent imports.

The architecture guard proves the final eager closure excludes the four old wake modules and the three new component modules, and the core composition/contracts contain none of the moved feature paths. This is supplementary boundary evidence; no separate architecture RED was run.

After runtime edit, migrate existing devices/models/gateway/viewers/wakeExperiments behavior controls to their component owner. Add componentStartup caller tests for empty/saved files, repeated/externally started devices, Windows/cable disabled, stopped detector, corrupt/bounded files, directory bound, send refusal and channel shutdown. Include runtime source-exit checks that core no longer loads the old files.

One-worker affected batch: harnessd/services.spec, harnessd/protocol.spec, harnessd/servicePlan.spec, serviceProcess.spec, new services/componentStartup.spec, migrated component-state/device discovery specs, core/experiments.spec, architecture.spec, leanEntry.spec, harnessd/workerContract.spec, harnessd/childAdmission.spec; source typecheck. Changed harnessd/services/core runtime coverage100% by complementary focused gates, keeping initial failures. Root owns final full core/harnessd gates and native existing experiments/devices/models/gateway/viewers on-demand suites in final artifact. No build, timing or extra CI here.

## Expected source paths

Master metadata/supervision: harnessd/services.ts, serviceSupervisor.ts, protocol.ts, workerContract.ts and their callers/tests. Component: serviceProcess.ts, new services/componentStartup.ts and componentStartupProcess.ts, moved wake policy modules/tests (possibly consolidate small Grid/gateway/viewer checks). Core: main.ts wiring, experiments.ts saved-state deletion, api.ts EXPERIMENTS state deletion, lib/clientStreamContract.ts state deletion, architecture.coreFiles.txt and import-boundary test. Docs: applicable AGENTS references and this Design. No account credential module or Desktop change.
