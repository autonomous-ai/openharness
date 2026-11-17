# Saved API launch freshness

Creates currently build a Saved API launch from the credential carried in the request. Relaunch builds already ask
Models to refresh it, but their preflight does not, and create/retarget can record the requested endpoint beside a
launch using a newer endpoint. Use the existing Models `refresh: true` request for create and preflight. Record and
describe the accepted launch override. Models alone reads Saved APIs; the core gains no field, reader or policy.

## Design

1. **Growth.** No new record, cache, timer or lifecycle. Saved APIs retain their existing save/edit/remove lifecycle;
   session launch records retain create/retarget/stop/archive/purge behavior. Receipts are unchanged.
2. **Concurrency.** ApiConnections reads its atomically published snapshot at preparation. Existing launch authority,
   dispatch claims, cancellation and Registry publication guards remain. Rotation after preparation does not revoke
   a credential already handed to a launch. The original native-create-v1 request, fingerprint and checksum never
   become the accepted launch record: replay still identifies the original request, and a changed request conflicts.
3. **Read cost.** Non-API Grid refresh returns the same override without storage I/O. A Saved API create/preflight
   adds the existing Models-local read, bounded to 100 connections and 2 MiB. No network model-list request, scan,
   fan-out or core filesystem read is introduced. One request and one bounded contribution remain.
4. **Scale.** Existing connection/file and launch-contribution limits stay enforced. Measure preparation at 1/10/100
   synthetic connections, including maximum supported keys; record latency and bytes. Refuse above the existing
   limits rather than expanding them. Validation workloads are scheduled with the core cost experiment.
5. **Compatibility.** No wire or durable shape changes. The Models refresh flag already serves relaunches; older
   clients and the explicit inline path receive the same result shape. Non-API launches preserve their selection.
   Registry, stopped records, native receipt recovery and old releases continue reading the same keyed override.
6. **Migration/rollback.** None. No historical record or pending receipt is rewritten. A rolled-back build reads the
   newly accepted override as before; the original credential-bearing receipt remains under its existing authority.
7. **Audience.** Existing owner checks and AgentView/frame redaction remain. The accepted credential is stored only
   where the old launch credential already lived and passed through the existing environment/config contribution.
   Tests use synthetic credentials; logs and external replies gain no credential.
8. **Identity.** Resolve only the existing connection ID in this machine's authorized ApiConnections store. Missing
   or unusable connections refuse; there is no engine-subscription fallback or owner-profile inspection.
9. **Failure.** Existing API_UNAVAILABLE/Models contribution refusals are returned before the creator's workspace,
   trust and dispatch effects or retarget's pane-control effects. Existing project-folder/native inspection ordering
   is unchanged. Authority changes while awaiting Models still refuse. No retry or recovery behavior is added.
10. **Platforms.** CLI/Models on macOS, Linux and Windows; no desktop/mobile changes. Platform-neutral unit evidence
    and macOS fake-engine evidence are recorded separately; unrun platforms are not claimed.

## Validation

Actual creator tests run through gridLaunchThrough, answerGridLaunch and a private ApiConnections fixture. They cover
rotation, deletion, accepted record/endpoint, non-API identity, original durable request/replay/conflict and cancellation.
Retarget tests use the real validation/build path to check deletion before pane effects and refreshed assignment after
rotation. Preflight tests cover the accepted connection name in refusal text. Existing contribution boundary checks,
core per-file coverage, typecheck, architecture and affected native gates remain required at integration.

The focused pre-change create run failed for the expected stale credential, deleted connection and stale durable
launch record; non-API identity and cancellation passed. The original output/exit are retained with the task evidence.
Pre-change retarget/preflight runs also showed a stale public endpoint/name and a deleted connection reaching terminal
control. The nine focused cases then passed, as did all 457 tests in the six selected caller/contribution suites.
Core coverage, architecture, native and cost validation are integration gates, not inferred from these focused runs.
