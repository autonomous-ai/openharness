# Core secret custody: agent views

Design/inventory only, 16 November 2026. Package 6, step 3 of the [core plan](2026-11-15-core-plan.md),
following [the secrets notes](2026-11-15-core-plan/secrets.md) and
[audit security 7](2026-11-12-core-audit.md#security).

Source inspected: `d592d766627f53693e0e96ff7b89f95dd2d28334`. Worktree:
`/tmp/harness-core-secret-custody`, branch `codex/core-secret-custody`.
Implementation is pending the coordinating agent's source-scope review. No product files have changed.

## Proposed first pull request

Stop handing `RegisteredSession.gridLaunch` to services that read agent metadata. It contains the grid API key.
The core currently copies the whole registered row into service replies and lifecycle events. Search, devices,
experiments, viewers, the browser and handoff rendering do not need that credential. Removing these copies
reduces secret propagation and retention in feature processes, including their held-event queues.

This is an independently useful security correction, not completion of step 3. Keys remain in the authoritative
registry and stopped records, and connector plaintext still crosses the core. Those two changes remain open below.

## Design

### Contract and projection

Use the existing `core/api.ts` boundary; add no core-loaded file, store, service, port or protocol operation.

```ts
export type AgentView = Omit<RegisteredSession, 'gridLaunch'>
export function agentView(session: RegisteredSession): AgentView

CoreApi.agents.all(): AgentView[]
CoreApi.agents.live(): AgentView[]
CoreApi.agents.advertised(): AgentView[]
CoreApi.agents.byAgent(agentId: string): AgentView | undefined
CoreApi.agents.resolve(id: string): AgentView | undefined
CoreApi.agents.cloud?(): AgentView[]
ConversationReads.resolve(id: string): Promise<AgentView | null>

AgentBrowserPort.attached(session: AgentView): void
AgentBrowserPort.moved(from: string, to: AgentView, on: boolean): void
ViewersPort.attach(session: AgentView): void
ViewersPort.frameContext(session: AgentView): AgentDshContext | null
```

`agentView` returns a shallow object copy with the entire `gridLaunch` property omitted, by destructuring it
away. There is no replacement key, empty-string credential, cast back to a credential-bearing row, or partial
`GridLaunchOverride`. `grid` and `gridWebSearch` already carry the display facts the readers need.
The nested `gridLaunch` object is **not copied or retained in the view**. The authoritative object, its property,
and that property's nested object remain untouched. Other metadata keeps the existing shallow-copy semantics;
this change does not promise a deep immutable snapshot of every nested metadata field.

The type is documentation and a caller constraint, not a runtime sanitizer: TypeScript permits structurally
compatible values with extra properties. Tests must prove actual core outputs omit the property. Helpers that
accept `RegisteredSession` for metadata remain callable because `gridLaunch` was already optional; no cast is
necessary. Do not use the views as inputs to credential-dependent launch/restore functions.

`resolveAgent` in `core/api.ts` and `ShownAgent`, `AgentsView.advertised`, `isSession` and `agentsIn` in
`services/processCoreApi.ts` should name `AgentView` too, so a service read is not advertised as carrying launch
credentials. The existing parser checks remain compatible; this PR does not turn the loose metadata parser into
a new authority validator. The process parser is not the security boundary: omission happens before IPC.

### Every dispatch that needs projection

| Boundary | Exact current paths | Proposed placement |
| --- | --- | --- |
| General reads | `core/api.ts:createCoreApi` methods `all`, `live`, `advertised`, `byAgent`, `resolve`, optional `cloud` | Project immediately after authoritative lookup, preserving ordering and missing-value results. |
| Agent queries | `core/agentQueries.ts:answerAgentQuery`, queries `agents`, `live`, `advertised` | Already reads CoreApi; receives projected rows. |
| Experiment lists | `core/experimentQueries.ts:shownAgents` | Already reads CoreApi; spread includes metadata only. |
| Device views | `core/devicesLink.ts:view`, including cloud rows | Already reads CoreApi; display/profile augmentation remains. |
| Workspace events | `core/workspacesLink.ts:nameBranches` | Already reads CoreApi; its live list is projected. |
| Viewer initial list | `core/viewersLink.ts:answer`, query `agents` | Already reads CoreApi; DSH filter remains. |
| Viewer lifecycle and inline frame reads | `core/main.ts:attachDsh`, `dshFrameContextRef`, `backend.dshFrameProvider` | Project before calling the port, covering both process and inline implementations. `attachDsh` currently bypasses CoreApi. |
| Browser reconnect list | `core/agentBrowserLink.ts:connected` | Already reads CoreApi; Browser-on filter remains. |
| Browser lifecycle | `core/agents/lifecycle.ts:createAgentBrowserLifecycle`, local `attached` and returned `taken` | Project before `browser()?.attached` / `browser()?.moved`. `observed`, `set` and `move` use the local `attached`; all paths are covered. |
| Handoff | `core/conversationQueries.ts:conversationReads.resolve` | Project after live/stopped resolution; keep `null` and errors unchanged. |

Projecting only in the links is insufficient: inline services would still receive keys, and direct attach/move
events could retain them before serialization. Projecting only CoreApi reads is also insufficient: the direct
viewer/browser paths above receive registry rows. Do not rewrite `core/agentQueries.ts` and every link to add
redundant projections once their sources are correctly bounded.

The queued browser `moved` event uses `untilDelivered`; its payload must be projected **before** queueing.
Viewer attach events also need the projected row before notify. Their replay/read paths use the projected API.
For inline mode (`HARNESSD_SERVICES=none` / old-master composition), the same CoreApi and port dispatches apply;
the protection does not depend on JSON serialization or on the service having its own process.

### Caller inventory

All production `.agents.all/live/advertised/byAgent/resolve` calls at the inspected source were enumerated.
These are the callers in addition to the reply/dispatch table; none reads `gridLaunch` or `apiKey` from a row.

| Callers | Facts used / operation |
| --- | --- |
| `messages/service.ts` | Live agent identity, engine, pane and message routing. |
| `services/search.ts` | Agent/session identity, title, cwd, transcript, engine/home and conversation stamps for search/history. |
| `services/monitor.ts`, `services/fleet.ts`, `services/devices.ts` | Advertised identity, runtime/resource and display facts; cloud rows are synthesized metadata. |
| `services/models.ts`, `core/modelsLink.ts` | `grid` assignment only, for model-change announcements. Credentialed `gridLaunch` is a separate explicit request, kept unchanged. |
| `services/sharing.ts`, `services/orchestrator.ts` | Resolve identities and access/routing metadata; derive shown frames and task targets. |
| `services/hachi.ts`, `services/goals.ts` | DSH/active status, agent identity and pane ownership. |
| `services/projects.ts`, `services/workspaces.ts`, `core/workspacesLink.ts` | cwd, title, branch, identity and frame synchronization. |
| `services/agentCleanup.ts`, `core/agentCleanupLink.ts` | Live identity, engine, pane/creation facts and ownership checks. |
| `services/windowNames.ts` | Identity and title metadata. |
| `services/viewers.ts`, `core/viewersLink.ts` | DSH/viewer identity, availability and frame synchronization. |
| `services/agentBrowser.ts`, `core/agentBrowserLink.ts`, browser lifecycle | Agent identity, Browser flag, guest ownership and frame synchronization. |
| `core/terminals/sessions.ts` | Terminal/runtime/process identity and launch state for describe/exit evidence. |
| `core/main.ts` usage snapshot wiring, `core/agentQueries.ts` usage target check | Agent/session/engine identity for usage matching. |

Search command: `rg -n '\.agents\.(all|live|advertised|byAgent|resolve)\(' cli/src --glob '!*.spec.ts'`.
Also inspected the direct port calls, `agents.cloud` consumers, the process adapters, and production references
to `gridLaunch` and `apiKey`; the property search alone does not establish that a broad object copy is safe.

### Handoff's owner-only resolve

The handoff query's owner/request checks are retained. Owner-only access does not make a renderer need a key.
The sole service consumer is `services/handoff.ts:startHandoff`, through `services/handoffProcess.ts:handoffCoreApi`
when out of process. Its `prepareAgentHandoff` in `lib/agentHandoff.ts` resolves the source and fork parents to:

- validate `identityHold`, cwd and agent identity, and coordinate in-flight work;
- select transcript/history using engine, session, profile home, paths and fork lineage;
- build the output's source header and git snapshot;
- capture `handoffSessionFact` for publication freshness checks.

`lib/handoffAuthority.ts:handoffSessionFact` hashes exactly `agentId`, `engine`, `sessionId`, `cwd`,
`transcriptPath`, `registeredAt`, `boundAt`, `codexHome`, `hermesHome`, `processIdentity`, `runtimes`,
`primaryRuntimeKey`, `forkedFrom`, `evidenceRevision`, `identityHold`. Omitting `gridLaunch` does not change that
fingerprint. `lib/databaseHistory.ts` selects history by engine/session/profile; it does not consume launch keys.

Discovery is requested by agent id. `conversationReads.discover` and `core/handoffDependencies.ts` continue to
resolve original rows internally. `lib/handoffDiscovery.ts:sessionDiscovery` compares process/ownership and the
same fingerprint; publication re-resolves original rows through `createHandoffPublisher`. Only the renderer's
read result is projected. No saved conversation, discovery evidence, publication authority or retained handoff
intent is modified. The source and every resolved fork parent must be covered in the regression tests.

### Data checklist

- **Growth:** no durable or retained derivative is introduced. Each existing read returns its existing number of
  rows with a field removed; existing IPC queues retain smaller payloads until their current cleanup. No new
  cache, timer, scan or whole-state poll. Existing registry/stopped retention limits are unchanged.
- **Concurrency:** projection is synchronous and does not write, lock, await or mutate the authoritative row.
  Existing registry/stopped locking and freshness checks retain ownership. A caller holding a view cannot change
  the saved key through a shared nested `gridLaunch` reference, because no such reference is present.
- **Read cost:** no extra file or network reads. Current row-read work is unchanged; projection adds a shallow
  copy per returned row. Measure this against reduced serialization and inline frame costs before claiming a
  hot-path improvement. No optimization or cache is proposed without those measurements.
- **Scale:** the additional work is linear in the rows already returned and their metadata size. Benchmark 16
  and 160 rows, with and without grid credentials, plus repeated single-row/frame reads. Existing process/query
  timeouts and daemon event-loop measurements are the first warning; introduce no content-bearing metric. This
  PR does not claim to fix the pre-existing all-agent query/list bounds.
- **Compatibility:** no backend change; it neither stores nor serves these machine-local snapshots. Public
  Desktop/mobile agent frames already select fields explicitly in `lib/agentFrame.ts` and never include this
  property. Their requests, replies, saved data and launch/restore behavior are unchanged. Private service reply
  and event shapes retain every used field and operation; they stop sending an unused, optional credential field.
  This is a security correction to the existing private metadata contract, not a new version of a public client
  schema. Verify the old and current consumer readers as described below; do not claim it is safe just because
  the transport is private.
- **Migration and rollback:** no on-disk migration or deletion. Rollback sees the exact registry/stopped records it
  expects and can restart with the same credential. A rolled-back core may again send keys in metadata; rollback
  preserves function and does not promise the newer security behavior. A newer service attached to an older core
  continues to accept its extra fields; a newer core's metadata-only replies remain readable by supported older
  services. No legacy key is erased or moved to a second store.
- **Audience:** existing server-side query, ownership and service gates remain. Projection removes a field even
  from an authorized service. No new recipient or authority is introduced.
- **Identity:** a grid launch continues using its saved credential through the explicit launch path. No fallback
  to a machine owner's vendor login. No cross-account ownership changes.
- **Failure:** projection has no I/O or asynchronous failure mode. Missing rows and lookup failures retain their
  current result/error. The omission must not be represented as a malformed/empty credential that reaches launch.
  No key, secret or whole row is added to logs, errors, metrics or test output.
- **Platforms:** platform-neutral TypeScript object projection applies to macOS, Linux and Windows. No process
  spawning, paths or filesystem formats change. Native validation is macOS here; Linux CI and any Windows result
  must be recorded separately, never implied by a macOS pass.

### Supported old-source evidence

The oldest inspected source is `6856f736644ab28cbea6ef65e5c3599c2838e802`, dated
2026-10-16 22:08:58 +07:00, before the 30-day window starting 2026-10-17. At that source:

- `lib/restoreAgents.ts` already refuses a grid row without `gridLaunch` as `GRID_CREDENTIAL_REQUIRED`.
- `lib/stoppedAgents.ts:save` already persists the whole session in its version-1 record.
- The service/message/orchestrator/sharing/cable/DSH and handoff sources have no row-property `.gridLaunch` or
  `.apiKey` reads. The named `gridLaunch` operation in `services/models.ts` / `modelsProcess.ts` is the explicit
  credentialed launch request, not an agent metadata reader.

The same directories and handoff files at `d592d766` have the same absence of property readers. A history search
over the interval returned no changes introducing these property reads:

```sh
git log d592d766 --since=2026-10-17 -G '\.(gridLaunch|apiKey)' -- \
  cli/src/services cli/src/messages cli/src/orchestrator cli/src/sharing cli/src/cable cli/src/dsh \
  cli/src/lib/agentHandoff.ts 'cli/src/lib/handoff*' ':!*.spec.ts'
```

Current `services/processCoreApi.ts:isSession` requires an object with `agentId`, not `gridLaunch`; shown and
lifecycle readers use metadata fields. The supported old-source reader fixtures must also be exercised before
merge. This inventory is source evidence, not a claim that a native old binary has already been tested.

## Source scope and validation before implementation approval

Expected product files: `cli/src/core/api.ts`, `core/conversationQueries.ts`, `core/main.ts`,
`core/agents/lifecycle.ts`, `services/processCoreApi.ts`. Existing read-only helper signatures can continue to
accept structurally compatible metadata. Any necessary additional product file must be reported before widening
the source scope. Registry, stopped store, engine storage, launch override and connector implementations are
outside this PR and currently owned by other work.

The Browser extraction is in a separate branch. If it lands first, replace the lifecycle scope with its new
generic follow-agent dispatch, retaining projection before dispatch in both process and inline mode. Do not
restore the old Browser lifecycle merely to make this patch apply. The coordinating agent chooses integration order.

Read-only inspection of `/tmp/harness-core-browser-continue` confirms the exact integration points in
`core/agentLife.ts`: `main.ts` constructs it with `live: () => registry.list()` and calls `running` with raw rows.
`catchUp` returns those rows for both inline `follow` and process `followed` (`follow_agents`); `look` emits
`{ kind: 'running', session }` to either kind of follower. Project the returned catch-up rows and the session
in `look` only after its known/each/filter checks, before delivery. Do not add an allocation to a scan that emits
nothing. Type `AgentLife`'s running session and `catchUp` as `AgentView`; retain authoritative input types.
Browser stores the running row in its own `live` map, so this boundary removes a retained copy as well as transit.
The branch's `taken` event already contains only `from`, `to` ids and optional `guest`; it does not need a row
projection. Ended/stopped/purged events also contain no row. Keep the direct viewer frame-context projection in
`main.ts` if that callback remains. Its old-service compatibility paths that return the ordinary agents query
remain covered by CoreApi projection. Cover inline/process initial catch-up, every-look and once-only running
notifications, reconnect and unobserved scans in the combined tests. This is an integration note, not a change to
that other worktree or authorization to take over its work.

Write failing tests before source changes, using synthetic canary keys only:

1. Real `createCoreApi` reads for every method above omit the property, including present, null and absent
   `gridLaunch`, live/stopped and missing rows. Keep the original row and nested override identical.
2. Exercise real agent/shown/device/workspace/viewer/browser outgoing replies/events from those reads; check the
   serialized payload and held browser move event contain neither the field nor the canary. Avoid a fakeCore
   fixture that is already sanitized and cannot fail on the old implementation.
3. Capture direct viewer attach/frame and browser attached/moved port calls with raw authoritative rows; they
   must receive projected copies in inline mode too. Cover reconnect and the existing Browser set/observed/move
   paths through the common dispatch helper.
4. Handoff resolve returns projected live/stopped source and fork-parent rows. Preparation remains usable and
   publication fingerprints match the originals. Core discovery/publication still resolve authoritative data.
5. Read projected replies with the supported old reader shapes. Run existing grid launch, restore and resume
   regression cases proving the credential remains usable and the saved records/golden launch shapes are unchanged.

Run affected tests, TypeScript and architecture checks, then the required per-file core gate under the
coordinator's capacity schedule. Use `local-checks.py --list` on the final source diff to pick any additional
mandatory gates. Native E2E selection: relevant existing `serviceProcesses.e2e.ts`, `viewersProcess.e2e.ts` and
`handoff.e2e.ts` cases, plus a supervised read-only metadata assertion using test-owned rows and daemon state.
Do not inspect or mutate the running user's daemon or real saved keys. Record precise cases and red/green receipts.

Before/after benchmark on the same pinned Node 24 build and quiet machine: repeated real agent-query
serialization for 16/160 rows and repeated single-row plus frame-context reads, synthetic 64-byte/8-KiB keys
and rows without keys. Compare allocation/latency/bytes separately; no secret-shaped values in output, only
counts and timing. No performance result is claimed yet and no heavy tests have been run for this Design.

## Remaining custody work stays open

**Authoritative grid credentials.** `registry.ts` documents same-provider/same-credential restart and reboot.
`restoreAgents.ts`, `resumeAgentService.ts` and `launchOverrides.ts` rely on the full override; stopped files
preserve it for later resume. Removing it now strands saved work. Copying it to a new file while leaving the old
one does not remove custody. A subsequent Design must choose the existing service-owned authority, handle
non-saved grid credentials, preserve offline resume, concurrent writes, the last 30 days' builds and master
rollback, and give a dated compatibility removal. No datastore or migration is selected in this PR.

**Connector plaintext transit.** `services/connectorsProcess.ts` asks `connector_vault`; `core/connectorsQueries.ts`
checks that service and calls `lib/connectors/vaultOps.ts`. Seal/open plaintext passes through `core/gatewayLink.ts`
to/from `gateway/gatewayProcess.ts`, where the gateway owns `connectorVault` crypto. Core does not cache it,
but does relay it in the clear. No direct service-to-gateway channel exists today. A private endpoint or encrypted
envelope would require authenticated peers, capabilities, bounded messages/waits, startup/reconnect behavior and
old-core/gateway compatibility. The connectors' existing private bridge exposes scoped MCP/REST operations, not
vault authority; broadening it is not a free substitution. Keep gateway and connectors failure isolation. This
needs a separate reviewed Design, not a one-user transport mechanism slipped into core.

**Trust boundary.** Removing accidental propagation does not make services hostile-OS-user sandboxes: audit
security 8 records the current local-door trust model. This PR makes no claim that a malicious process under the
same OS user cannot read the owner's private files. Launch-input allowlists remain package 6 step 4.
