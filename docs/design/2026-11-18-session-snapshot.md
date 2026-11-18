# Shared session capture and component views

## Design

Devices and WiFi now read one complete `CoreApi.agents.snapshot()` through `session_snapshot`.
The actual app formatter and both component readers use the existing `agentFacts` producer. Core
owns current session facts; components own their display rows, package fallback, workspace realpaths,
runtime readiness and Store preparation evidence. Public app/device frames and Store journals keep
their existing shapes. This replaces both private `view` routes in the same worker cohort.

The reply contains version 1, registered rows, separate cloud rows, and the existing machine/account/window
facts. A registered row contains only agentId, sessionId, engine, registeredAt, transcriptPath, lastHookAt,
active, cwd, optional dsh and optional launch state/error/detail/service. It also carries displayName,
terminalAvailable, the existing string dsh publication, selectedModel and exact turnRunning. No launch token,
grid credential, prompt, runtime/process tree, engine home or unused service-publication tree is exported.
Cloud rows contain the six fields read by devices plus their existing display name and selected model.
They never enter WiFi's Store occupancy list. Stopped history is never queried.

`FleetSession` and `DevicesCore` narrow actual CableHost, FleetRouter and devices read dependencies.
Neither adapter casts the lean capture into a fabricated full AgentView. transcriptPath is retained:
FleetRouter's actual Recent list reads it and falls back to lastHookAt. CableHost's session matching and
registeredAt ordering remain unchanged.

Capture is synchronous over current registry references. Profile and exact turn state are read before
session fields and the final shared fact producer; parts are read last, preserving the existing app
publication epoch semantics. A row replaced during a provider call refuses the capture. Each admitted
row is detached before another provider or a caller await can mutate it. The existing app formatter's
pre-await epoch capture and post-await reads are unchanged. `turns.running` uses the existing
`turnStartedAt.has` reader, also consumed by the real recaps quietTurn wiring. It adds no timestamp,
map or activity-lease interpretation. Process-only APIs leave this reader unavailable.

WiFi projects every registered row into Store evidence, including inactive and unavailable rows.
Only exact terminal membership advertises a device row. A published string dsh wins before row attachment,
then retained row dsh, then null. Explicit starting/ready/failed launch behavior remains unchanged; an
active unbound nonterminal row with absent launch is starting. This differs deliberately from the app's
existing absent-launch default. Canonical paths and launch error presentation live in `services/wifiView.ts`.

## Authority and failure

Only authenticated devices and WiFi service identities receive the shared query. `SERVICE_HOSTS.queries`
declares those rights, and the dispatcher refuses every other identity, including messages and gateway.
It checks the exact issuing connection before capture and after its await. Components retain their own
cloned-connection/generation fences. WiFi additionally verifies the reply machine against its current
component owner and core binding. Empty or malformed identity never authorizes a reply.

Malformed rows, duplicate IDs, unavailable facts or excess budget refuse the entire reply. No missing
workspace claim becomes an empty/truncated list. The existing read-only fallback stays within its owner;
it is not new complete admission evidence. Failed current WiFi snapshot reads clear only their owned
window permission. A stale connection or identity-ABA completion cannot clear the replacement cache.
A fresh valid view restores that permission. Durable Store reveal remains independent of transient
hasWindow state and keeps its existing verified-machine authority.

Creation still performs the same canonical registry check immediately before its existing creator call.
This is an explicit residual boundary: it is not a global atomic workspace claim. Confirmed cancel,
abort presentation and mixed-host desk fallback also remain separate extraction work. This slice does
not weaken or claim to finish those doors.

## Bounds and data lifetime

The provisional source-evaluation ceiling is 4096 registered plus cloud rows and 6 MiB of encoded capture.
The existing bounded JSON reader checks bytes, depth, executable objects and total work before detachment;
row count is checked before per-row construction. Registry list allocation still obtains references to
current rows, not a second retained snapshot. The component decoder allows the existing small service
reply envelope and rejects malformed/oversize input before consuming fields. There is no new retained
core snapshot, cache, pagination cursor, revision, broker or replay loop.

`SESSION_SNAPSHOT_TOO_LARGE` and `SESSION_SNAPSHOT_UNAVAILABLE` are fixed failure names. Core logs only the
name, never content, paths or identities. The existing caller single-flight behavior bounds concurrent
refreshes. Component state is cleared with its existing connection/component lifecycle. No persistence,
new data store, background polling or cross-account retention is added.

These ceilings are **not final cost or large-history acceptance**. A coordinated identical-fixture
comparison must measure encoded bytes, CPU, latency and RSS before they are frozen. Include 1600 current
rows, a small advertised subset, near-bound publication strings, and ordinary app list controls. Native
acceptance uses the coordinator's combined full/lean artifact; no standalone build or timing run is
claimed here.

## Compatibility and source evidence

Contract 3 remains unreleased and unchanged. The exact derived worker plan changes from
`ad3cd3af3b497aa0ac8422ed823ff3da403497dc16f4623fc53001ea75645467` to
`ccb4cefd1b9f5a47e2cc45c245414d95564efa9a765e8932238c78d0192e9d36`.
Admission tests accept each complete historical/current cohort and refuse either mixed plan. There is
no old private-view fallback or public protocol widening. Windows is deferred by the user; mobile is
outside this task. Source checks run on macOS with pinned Node 24.22.2 and the immutable dependency tree.

- Actual device-list and WiFi/Store behavior REDs: `/tmp/core-wifi-session-snapshot-behavior-red.log`
  and `/tmp/core-wifi-session-snapshot-wifi-red.log`. The first WiFi attempt had a fixture-await error;
  the corrected WiFi RED was the real empty-list assertion. Both selected controls then passed in
  `/tmp/core-wifi-session-snapshot-first-green.log`.
- Initial types failure `/tmp/core-wifi-session-snapshot-types-initial.log` retained references to
  removed fixture APIs; these were migrated, not described as runtime REDs.
- Initial selected receipt `.harness/validation/20261118T070213.576981Z-76180/receipt.json` records
  929 passed and four migrated fixture failures, one invalid synthetic credential type, coverage gaps,
  and the intended old-plan admission RED. It is a failed gate, not a passing suite.
- A first cache-RED invocation used the wrong working directory for its preceding edit and selected no
  tests (`/tmp/core-wifi-snapshot-window-failure-red.log`); it proves nothing. The actual two-case RED
  `/tmp/core-wifi-snapshot-window-failure-red-actual.log` reproduced retained window permission after
  malformed/machine-mismatched replies before the binding-scoped reset.

Final selected source receipt `.harness/validation/20261118T070852.874720Z-82590/receipt.json` passes:
995 tests in 23 files and every one of the 14 changed core/service runtime files at 100% statements,
branches, functions and lines (3135/2065/1076/2285). The three-file worker gate passes 62 tests and
services/workerContract at 100%; actual app formatter, CableHost, Store and architecture pass 277 tests
in four files. CLI types pass. This documentation-only evidence update follows those frozen runtime
checks; no runtime source changed afterward. Coordinated cost/native evidence remains pending.

### Final producer and unrelated-query review

Coordinator review found a final producer fence gap. `/tmp/core-wifi-snapshot-final-facts-red.log`
records three actual REDs: replacement/removal during the last facts call returned stale success,
and an invalid null producer returned a raw TypeError. The final registry identity check now runs
immediately after that producer, before detachment; no provider follows the parts read. The declared
producer and actual `agentFacts` never return null, but a malformed runtime return also gets the fixed
unavailable error. No retained revision or new authority map is added.

Receipt `.harness/validation/20261118T071640.418077Z-90249/receipt.json` passes 122 selected tests in
seven files, core/api.ts at 100% (305 statements, 162 branches, 128 functions, 253 lines), and types.
The shared query await in main is also guarded by the exact query name, so unrelated dispatch retains
its existing microtask path. Wiring/architecture/query checks and types pass in
`.harness/validation/20261118T071936.868357Z-92994/receipt.json`. The earlier broader checks apply to
unchanged component runtime. The cost recipe includes ordinary-query and app controls; none has run yet.
