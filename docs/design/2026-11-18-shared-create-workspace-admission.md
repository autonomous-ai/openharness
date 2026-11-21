# Shared Create admission for the device component

## Design

Implemented on integrated `46144f76b9`, isolated worktree
`/tmp/harness-core-wifi-create-admission`. This removes WiFi package/launch
selection policy from core, keeps core's authoritative session admission, and preserves the existing
creation capability. It adds no route, request map, registry column, UI setting or constraints framework.

### Actual source and the reproduced interception

`services/wifi.ts` gives the component-owned Store a package/engine/cwd create callback. The supervised
adapter in `services/wifiProcess.ts` waits for its existing verified identity promise, then asks its
current captured core binding once; after send, an uncertain answer is never replayed. Its private
query currently contains packageId, engine and cwd. `core/wifiLink.ts` delegates it to
`CoreApi.wifi.create`; `core/wifiAgents.ts` builds the fixed launch input and checks every registered
workspace before calling the ordinary creator.

The actual main dispatcher calls `answerExperimentQuery` before `wifiLink.answer`. The experiment
query set includes `create`; its existing non-experiment guard returns NOT_AN_EXPERIMENT for WiFi,
preventing its already-owned private create handler from being reached. Source-bound RED
`.harness/validation/20261118T153248.623048Z-87730/receipt.json` executes the AST-extracted actual main
answer expression with real service authentication and real experiment/WiFi handlers: expected created,
received NOT_AN_EXPERIMENT (one failure, two passing ordinary/grant/authentication controls, actual exit 1).
The expression is executed rather than copied, following existing main-composition tests.

`CoreApi.agents.create` is the existing shared ID-only Create entry. Its actual callers include the
orchestrator/experiments and `processCoreApi`; `createForExperiment` invokes the same ordinary
`BackendSocket.onCreateAgent` creator and returns only the id/refusal. It fixes grid/profile/named-agent
and permission-mode fields, so those caller-controlled identities do not leak into the launch.
The public owner-tool `agent_create` returns a full AgentFrame and is not needed for this extraction.
No full-frame reply limit change or one-shot transport expansion is proposed.

### One existing query slot, shared parser, unchanged grants

Keep the existing authenticated WiFi `create` slot, change its payload to AgentCreateRequest, and reuse
one shared parser extracted from the existing experiment create case. Only the exact WiFi create query
moves before the experiment catch-all in main. Do not move WiFiLink.answer as a whole: its unknown-query
answer is non-null and would intercept unrelated shared/experiment queries. The later WiFi branch keeps
its existing machine/recent/desk queries. The experiment set and every other experiment route are unchanged.

The shared parser admits the existing engine/cwd/dsh/prompt/name/bypass fields and the single optional
`requireUnusedWorkspace: true` precondition. prompt/name permit null for an empty launch as the underlying
creator already does; existing experiment requests retain their current string contracts/checks. A
present precondition other than literal true refuses. A request carrying it requires an absolute cwd,
no control characters and at most 4096 characters. It cannot combine with external resume or project
preparation; those are not fields of this shared Create request in the first place. The input whitelist
continues to discard unsupported grid/profile/named-agent/model identity fields before any creator call.
No client-supplied callback, expression, path list, predicate or arbitrary constraint is accepted.

WiFi's existing capability is narrower than the generic experiment capability. Preserve that boundary
in its existing core link: prompt and name must be null, bypassPermission must be false, and
requireUnusedWorkspace must be true. Refuse malformed or broader requests before any create effect.
The existing shared Create adapter still fixes grid=null, codexHome=null, agent=null and permissionMode=null;
there is no new permission to choose another account, a grid, a first task, a name or a named agent.
These are security-grant checks, not package selection: no package installation/catalog/trust/engine
selection policy moves into the parser. The component chooses installed package id/engine/workspace
and constructs that fixed safe request. Core receives dsh, never the private packageId presentation field.

A current authenticated service connection is checked immediately before the shared create invocation,
after the preceding async dispatch chain. Once admitted, the create deliberately keeps the existing operation lifetime even if that service
disconnects during creator preparation, exactly as the previous private create did. No new connection
revocation policy is imposed on already admitted durable Store work. A dropped component link is not
permission to replay an uncertain launch; the component still refuses a late completion from that link. The supervised component retains
its owner + verified machine + captured core binding checks before first send and after reply. Only an
unsent durable Store operation may wait through a same-machine identity handshake. Old-account/component
callbacks must still refuse; no new core identity state or broker is introduced.

Remove `CoreApi.wifi.create`, its fallback, `wifiCreate` and its fixed input builder in the same slice.
`wifiAgents.ts` then contains only the explicit mixed-host desk fallback. Inline WiFi calls shared
`core.agents.create` with the component-built request; supervised WiFi overrides that shared method with
the existing identity-wait/once-only query adapter. Do not use processCoreApi's generic error-catching
fallback for this caller: collapsing an ambiguous sent create to an ordinary failed result can invite
replay. Preserve its current uncertain-outcome behavior and Store reconciliation.

### What the workspace precondition actually promises

Current wifiCreate performs one synchronous canonical registered-workspace scan, then the creator awaits
native setup, DSH description/materialization, configuration and backend gates. It is NOT an atomic
workspace reservation. The Store already owns its own workspace reservation map, covering competing
operations in that component; ordinary app/experiment creates can still race before either is registered.
Do not claim this change supplies cross-caller mutual exclusion or change ordinary creates to enforce it.

Move the existing registered-absence predicate to the ordinary creator, gated solely by the optional
precondition. It still includes inactive, unbound and terminal-unavailable registered rows; stopped history
is irrelevant. Iterate current Registry rows directly, without a temporary whole list or second catalogue.
Canonical path comparison and the existing fallback on realpath failure must be explicit compatibility
controls. The caller cannot provide an authoritative list or reuse its interval session read as permission.

Check at preparation admission (preserving the old early refusal), immediately before DSH materialization,
and at the existing terminal onDispatch seam after backend waits. The last scan has no await between its
successful result and backend dispatch: TmuxBackend and PtyHostBackend call a synchronous onDispatch hook
without yielding when it returns void, then recheck their existing owner/current predicate. Preserve those
owner checks. Reuse the creator's existing captured workspace identity (device/inode/canonical directory)
for the opted-in precondition, so replacing the directory during an await cannot redirect its admitted
workspace. No new retained identity record is needed. A row added while preparation/backend gates are awaiting refuses before the next effect.
A same-cwd row added only after the native launch dispatched cannot be retroactively called a failed create.

Use WORKSPACE_IN_USE only for a proven pre-launch refusal. Preparation may already have written files;
a refusal never claims those writes did not occur or removes another caller's work. Existing unknown spawn/registration outcomes
stay unconfirmed. createAndRegisterPane currently collapses backend not-started into SPAWN_FAILED, so the
implementation must preserve the actual not-started evidence through that existing result boundary before
mapping a dispatch-time workspace refusal. Never infer safe retry merely from an error string or a flag
that might have been set after a successful dispatch. Durable create receipts keep their existing once-only
claim behavior; a failed post-claim dispatch is not reopened for replay.

No new scan limit is frozen here: the optional field/path is bounded, but the original predicate performs
synchronous filesystem canonicalization over current rows. Adding rechecks must not silently turn a valid
large registry into an empty/partial admission. Before acceptance, record exact scan counts and before/after
cost for hidden occupancy and aliases at 1/100/1600/4097 registered rows. Ordinary creates must do no new
workspace scan. If final scan latency cannot meet the core budget, report that as an explicit remaining
boundary gap; do not add a canonical-path cache, registry epoch or component-selected authority as a shortcut.

### RED and compatibility proof

1. The main-chain RED above, then generic safe WiFi create through the same authenticated slot; common
   count/follow/resolve/daemon paths, gateway/messages precedence, existing experiment Create, and unrelated
   WiFi experiment routes remain unchanged. No missing-token/unknown-service/stale-dispatch effects.
2. Actual shared parser and capability controls: malformed precondition, relative/long/control cwd,
   prompt/name/bypass attempts, unsupported account/grid/named-agent fields; safe empty WiFi and ordinary
   experiment creates still work. Old private payload refuses safely, never creates a plain agent by accident.
3. Actual creator REDs: occupied canonical alias at admission; a registered row arriving during native/DSH
   preparation; one arriving while the actual backend waits before onDispatch; replacement of the
   originally captured workspace directory during an await. Same-workspace ordinary
   creates remain allowed. Missing/hidden/unbound rows follow the exact old predicate. Failed canonical reads
   preserve the documented fallback; no read failure means "empty".
4. Two pending creates before either registers are a documented no-reservation control, not a false safety
   assertion. Same Store operation id still acts once; uncertain reply/dispatch never causes automatic retry.
5. Same-machine durable continuation, old component/machine refusal, final current binding after reply, and
   success reveal on the existing window route. Keep the earlier lifecycle tests; no new queue/cache.
6. Selected per-file core/services coverage and types, existing Create/launch/pending callers and actual
   backend pre-dispatch tests. Native acceptance and scan-cost timing remain coordinated separately.

### Private cohort admission

Root reviewed this design and requires WORKER_CONTRACT 3 -> 4 for the breaking private create-payload
change, as the existing contract rule says. No artificial per-feature stamp or new metadata map is added.
Both complete contract-3 rollback and complete contract-4 cohorts remain admissible to their matching
children; both mixed directions refuse before effects. The derived WORKER_PLAN still tracks actual host
capabilities and is not claimed to encode this private query shape. Old payloads fail safely regardless.

### Dispatch custody and scan cost refinements

Before broad implementation, pin the exact core request passed to the backend: original engine, canonical
workspace identity, fixed empty permission/account/prompt/name choices, exact authority/native owner and
precondition. Exercise the real backend's final onDispatch seam while its earlier gate is held. A competing
row or replacement workspace arriving during that wait must prevent the native command. An ordinary create
without the precondition remains allowed. A backend that reports dispatched/uncertain can never be relabeled
WORKSPACE_IN_USE just because a later registry read finds a conflict. Preserve actual not-started evidence
through createAndRegisterPane, including retries and cleanup ownership.

Canonicalization may deduplicate identical raw cwd strings within one synchronous scan, using a short-lived
bounded set only. Cap the set at 1024 entries; beyond the cap, continue checking rather than omitting any row
or refusing a valid large registry. The cap bounds scratch memory, not membership or admission. Every
uncached nonempty cwd is still resolved with the original realpath fallback. Discard the set before returning,
never carry it across an await, and add no filesystem timestamp cache. This does not claim an atomic external
filesystem snapshot; the target's captured workspace identity is rechecked at the existing final dispatch seam.
Record actual rows visited, unique raw cwd values and realpath calls for duplicate and alias cases at
1/100/1600/4097 rows, with ordinary creates doing zero new scan calls. Cost execution remains coordinated.


## Source validation checkpoint

The source was updated in the isolated tree after fast-forwarding to `46144f76b9`. The actual main-chain
RED above is retained. Final-dispatch RED `20261118T154757.872847Z-4416` had six failures and five passing
controls on unchanged runtime: both canonical aliases, occupied/replaced/removed workspaces at the real
TmuxBackend gate, and missing first-attempt not-started evidence. The backend executes through an
in-process command recorder, with no real terminal process; this is source behavior proof, not native proof.
WiFi capability RED `20261118T154944.197341Z-6359` had sixteen failures and five passing controls.

The first combined gate `20261118T155140.215991Z-8674` failed on remaining removed-API test fixtures
(199 passed, one failed) and four type errors. The next `20261118T155435.711688Z-15824` retained eighteen
fixture failures/327 passes: removing an identical fallback accidentally removed the fake shared creator,
plus one read-only tmux-version probe assertion; its new fixture types also failed. Those fixtures were
corrected. `20261118T155625.795926Z-18084` passed all 904 behavior tests, architecture and types, while
coverage correctly failed on missing existing Cloud checkpoint and helper custody branches.

A separate public-terminal RED `20261118T155804.255957Z-20343` showed the internal `notStarted` field
escaping through that existing wholesale return (one failure/four passes). The terminal boundary now
constructs exactly its previous public error payload. Other helper callers already construct their errors.

Final selected gate `20261118T155852.438809Z-21635` passed 924 tests in 31 files, architecture and types.
All ten selected runtime files reached 100% statements, branches, functions and lines: core API,
experiment queries, WiFi link/doors, agent creator, terminal opener, worker contract, pane registration,
and WiFi component/adapter. `backendSocket.ts` changes only the existing input type; `main.ts` is dispatch
wiring, covered by its AST-extracted real expression. Runtime working-change hash:
`dc374b54fb504297fbeac413927387573735c3f25c7b1f044a65436fe7818601`.
The receipt SHA-256 is `9ba5d3db1cfdc6dedc807e745c02b8aea7c8338d11b285de096c39651b1f68e2`.
Plan: `/tmp/core-wifi-create-final-plan-20261118.json`.

On unchanged runtime, the final authority supplement `20261118T160036.739437Z-24011` passed the actual
main dispatch and WiFi lifecycle controls plus types. It explicitly contrasts revocation during an
upstream dispatch await (no admission) with disconnect after the creator begins (one admitted operation
settles). Exact old null account/permission/name/prompt fields and no replay are asserted. Plan:
`/tmp/core-wifi-create-lifetime-final-plan-20261118.json`.

Scan-count controls visit every one of 1/100/1600/4097 duplicate rows twice, resolving the repeated raw
cwd once per synchronous scan. A 1025-distinct-path overflow control keeps checking uncached paths.
These are count controls, not timing acceptance. Unique-cwd scan wall/CPU cost, the final native Create
flow and combined artifact admission remain pending coordinated validation. Windows is deferred by the
user; mobile is excluded. The full-view v7 refresh performance hold and mixed-host desk residual are
separate remaining work; this checkpoint does not declare either complete.
