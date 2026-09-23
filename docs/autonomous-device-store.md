# Autonomous robot → Harness Store contract, v1

This is the shared implementation contract for Autonomous OS (`harness-use` → OS loopback API →
existing direct encrypted device connection → Harness CLI). It adds Store discovery and **agent
preparation**, not task delivery. English and [Vietnamese](vi/autonomous-device-store_vi.md) describe
the same contract. The machine-readable authority is
[`contracts/autonomous-device-store-v1/`](contracts/autonomous-device-store-v1/).

**Status:** implemented in this checkout; not installed, released, or deployed by this change.
Do not assume a running CLI supports it until its hello advertises the capabilities below.
Once handed to OS, coordinate changes to operation names, meanings, required fields, errors and
schemas with the OS integrator. Regenerate the schemas and fixtures/tests together. Never silently
repurpose a v1 field.

## Transport and capability negotiation

Keep protocol `proto: 1`, pairing, identity pins, PAKE and E2EE envelopes from
[the existing integration](autonomous-device-integration.md). No new credentials, listener,
transport or pairing flow. These are **decrypted application payloads**, not plaintext LAN frames.
Each request uses a fresh UUIDv4 `requestId`; each response echoes it with `<type>_result`.

An authenticated role-device application `hello` advertises these additional capability strings:

```json
["store.list", "store.inspect", "agent.prepare", "operation.get"]
```

Require all four before offering automatic preparation. If missing, explain that the Harness CLI on
the paired computer needs updating. Existing operations and old OS clients remain compatible. An
unwired/older service returns `UNSUPPORTED_CAPABILITY`; do not try `dsh_install` or `agent_create`
over the device channel. Only the paired machine is addressable. Plaintext and non-device-role
requests never reach this facade; application hello and existing rate/concurrency limits still apply.

This permission permits installing official Store packages and their reviewed official dependencies
as the paired computer's user. Setup is real local execution, not a sandbox. Uninstalled community
packages or dependencies require the owner to review/install them in Desktop first. No URL/ref,
custom engine command, arbitrary shell, permission-bypass flag, update/remove, or generic admin
operation is accepted. Existing owner-installed packages can be used. Preparation always creates a
new agent with permission bypass off and no first prompt.

## Operations

### `store.list`

```json
{"type":"store.list","requestId":"11111111-1111-4111-8111-111111111111","query":"Blender","offset":0,"limit":5}
```

Result: `{type, requestId, machineId, packages:[Package], nextOffset:number|null}`.
`query` is optional (≤200 characters), matching all whitespace-separated terms in ID/name/description/
category. `offset` defaults to 0 (0–25000); `limit` defaults to 10 (1–10). Use `nextOffset` until null.
Pages are current snapshots, not a frozen catalog transaction. Viewer packages are dependencies,
not selectable agent entries. Installed unlisted packages remain discoverable.

### `store.inspect`

```json
{"type":"store.inspect","requestId":"22222222-2222-4222-8222-222222222222","packageId":"autonomous/blender"}
```

Result: `{type, requestId, machineId, package:Package, candidates:[Agent], candidatesTruncated:boolean}`.
At most five candidate agents are returned. Use existing `agents.list` for the remaining agents.
Candidates match **recorded package identity**, not an inferred name/recap; they are suggestions only.
Neither inspect nor prepare takes control of an existing session.

`Package` contains:

| Field | Meaning |
|---|---|
| `packageId`, `name`, `description`, `category`, `engine` | Catalog/installed manifest facts |
| `catalog`, `installed` | Independent booleans: being listed is not being installed |
| `verified`, `installAllowed` | Official source recognition and permission for automatic installation; not a security or usability guarantee |
| `viewerPackageId` | Known shared-viewer dependency, or null |
| `version`, `broken` | Installed tree/commit if known; broken installation reason or null |
| `capabilities` | `{source:"package_metadata",description,category}` — descriptive claims from metadata, not tested semantic capability tags |
| `requirements` | `{engine,viewerPackageId,applications:null,note}` — app/dependency names are not structured in current manifests; do not invent them |
| `installation` | `not_installed`, `installed`, `installing` (this service's active install), or `broken` |
| `readiness` | `{state,scope:"package_doctor",engineAuthentication:"unknown",taskSuccess:"unknown",checkedAt?,version?,lines?}` |
| `lastPreparation` | Latest in-memory preparation's `{state,phase,error,updatedAt}` for this package, or null; use operation.get for durable history |

Readiness is `not_installed`, `unknown`, `passed`, or `failed`. Merely listing/inspecting never runs
scripts. A prepare runs the package and shared viewer doctors and caches up to ten 400-character
output lines, time and version. A changed version or daemon restart invalidates that in-memory check.
A package without a doctor has unknown check coverage. A passed doctor is a dated observation, not
a promise that login, licensing, GPU capacity, all app features, or the user's task will work.
Installation done elsewhere may only be reflected when its installed index changes.

`Agent`: `{agentId,machineId,packageId,engine,workspace,state,runtime,error?}`.
`runtime` is `starting`, `ready`, or `unavailable`. `workspace` is a canonical absolute directory where
available. `agents.list` also gains optional `packageId`, `workspace`, and `runtime` fields. An absent/
null package identity is unknown, never inferred from recap. Runtime ready requires a live terminal,
engine process and bound native conversation (plain terminal tiles are a special case). Authentication
is not independently verified. Caller decides whether a candidate belongs to the user's intended
project; explicit use of that agent goes straight to existing `turn.send` without prepare.

### `agent.prepare`

```json
{
  "type":"agent.prepare",
  "requestId":"33333333-3333-4333-8333-333333333333",
  "machineId":"mac-example",
  "packageId":"autonomous/blender",
  "idempotencyKey":"prepare-airplane-001",
  "workspace":{"kind":"new","name":"airplane"}
}
```

Workspace is required, exactly one of:

- `{"kind":"new","name":"airplane"}`: same `~/harnesses/` convention as Desktop/`harness new`.
  Optional name is 1–100 ASCII letters/digits/`_`/`-`, beginning with a letter/digit. Without a name,
  Harness chooses its normal package/time folder name. An existing named folder is an error, not reused.
- `{"kind":"existing","path":"/Users/example/harnesses/airplane"}`: absolute existing directory,
  ≤4096 characters, no control characters. Symlinks are canonicalized. Owner explicitly selects it;
  materialization follows the package's normal instructions/template behavior. A workspace used by
  another registered agent is refused; prepare never changes that agent's project. Device requests
  competing for one canonical workspace are serialized/refused before creation.

No `text` or `prompt` is allowed. No implicit installation update. The implementation reuses catalog,
Store install/setup/doctor, `prepareProjectFolder`, `onCreateAgent` and `AgentCreationReceipts`.
Already-installed packages skip setup/install but run doctors again. Missing/unusable viewer or
application requirements produce action-needed with doctor evidence. A review-required dependency
is not silently installed. Broken installs are not overwritten.

The response is immediate after durable reservation:

```json
{
  "type":"agent.prepare_result",
  "requestId":"33333333-3333-4333-8333-333333333333",
  "status":"accepted",
  "operation":{
    "operationId":"c733824e9af646c6ff8d0e19f1e2e368d02608b0fe99b1f2936a4d740244829d",
    "machineId":"mac-example","packageId":"autonomous/blender",
    "state":"accepted","phase":"accepted",
    "createdAt":1790000000000,"updatedAt":1790000000000,
    "agentId":null,"workspace":null,"error":null,"guidance":null,"doctor":[],
    "taskDispatched":false,"engineAuthentication":"unknown"
  }
}
```

The ID above is illustrative; **store the returned ID**. Exact executable examples are in
[blender.fixture.json](contracts/autonomous-device-store-v1/blender.fixture.json).
Retry identical parameters and key with a new requestId → `status:"duplicate"`, same operation.
Changing any preparation parameter under the same key → `IDEMPOTENCY_CONFLICT`.

### `operation.get`

```json
{"type":"operation.get","requestId":"44444444-4444-4444-8444-444444444444","operationId":"c733824e9af646c6ff8d0e19f1e2e368d02608b0fe99b1f2936a4d740244829d"}
```

Result: `{type:"operation.get_result",requestId,operation:Operation}`. Query on the same paired
identity. An unknown ID or another device's ID returns `OPERATION_NOT_FOUND`.
Poll about every 2 seconds, back off on rate limiting. There is **no new progress event in v1**;
`operation.get` is the authoritative status/progress mechanism. Existing event replay/resync and
`serverInstanceId` still apply to turn delivery. After reconnect/resync, poll retained operation IDs.

| State | Meaning and caller action |
|---|---|
| `accepted` | Intent persisted; nothing should be inferred about install/create yet |
| `running` | Work or engine startup in progress; keep polling the same operation |
| `ready` | Package preparation completed and the returned agent's runtime/conversation is available; task has NOT been sent |
| `failed` | Definite failure such as package not found; inspect error before a deliberate new attempt |
| `needs_user_action` | Show `error.message` and `guidance`; may mean dependency/login/workspace repair or uncertain side effects; never blindly create again |

Phases: `accepted → install / clone / setup → doctor → workspace → create → launch → complete`.
Installed packages skip clone/setup. Shared dependencies may repeat installation phases.
`createdAt`/`updatedAt` are Unix milliseconds, doctor output is bounded. `agentId` may already be
present before ready or alongside an action-needed error: open that agent, do not create a duplicate.
No task is dispatched in any state; `taskDispatched` is always false.

Ready is a **preparation** result, not an airplane, tool output, login certification, or model success.
`engineAuthentication:"unknown"` is explicit. If launch/binding is absent for ten minutes, polling
reports `ENGINE_ACTION_REQUIRED`; a known launch failure reports it sooner. Complete engine prompts
in the returned agent and poll again: the same operation can become ready, without creating again.
If an agent disappears/changes workspace, a previously ready operation can require action again.

## Idempotency, timeout and recovery

- Preparation key scope is `(paired identity, idempotencyKey)` on this machine; keys use 1–64
  ASCII letters/digits/`_`/`-`. Parameters are fingerprinted; requestId is excluded.
- Reserve an operation privately on disk before install/workspace/create. Operation journals and
  creation receipts are **not expired automatically**. Preserve them under `ADAPTER_DATA_DIR`.
- Four active preparation jobs maximum; concurrent device requests for one package share its install.
  Existing Store package locks also cover Desktop/CLI mutations. `DSH_BUSY` can require waiting for
  an external installer; it does not authorize a parallel setup.
- RPC timeout/disconnect does not cancel accepted work. Retry the same prepare key/parameters to
  recover the operation ID, or poll it. Never infer “not executed” from a timeout.
- On daemon restart, a completed creation receipt can recover agentId even if the final operation
  update was lost. It is rechecked against registry package/workspace/runtime; it is never recreated.
- A persisted interrupted operation without confirmed creation becomes `needs_user_action` /
  `RECOVERY_REQUIRED`. No install, setup, folder creation or agent launch is replayed automatically.
  The owner inspects the machine first. A new key means a deliberate new operation and can create
  another session; OS must not manufacture new keys as a retry strategy.
- If pairing is revoked, already-running setup/doctor/spawn cannot necessarily be undone. Future
  preparation steps stop at the next boundary. Created files/agents may remain for inspection.
  No automatic delete or rollback of user work. Revoked transports cannot read/send more requests.
- Preparation receipts are separate from `receipt.get` (which remains for turn/stop/answer). The
  latter's existing in-memory delivery dedupe does **not** become durable with this change.
  After an ambiguous `turn.send` across a daemon restart, inspect/reconcile; do not resend just
  because the old receipt is absent. Consult `serverInstanceId` and existing recovery rules.

## Errors

Before reservation, errors have `{type,requestId,error:{code,message}}` and no operation. After
acceptance, inspect `operation.error` and `operation.guidance`, including on duplicate replies.

| Code | Handling |
|---|---|
| `UNSUPPORTED_CAPABILITY`, `PROTO_UNSUPPORTED` | Update CLI/use supported interface; no generic dispatcher fallback |
| `HELLO_REQUIRED`, `RATE_LIMITED`, `BACKPRESSURE` | Establish existing session / back off; preserve keys |
| `INVALID_REQUEST`, `MACHINE_MISMATCH` | Fix request schema/target; unknown fields rejected |
| `PACKAGE_NOT_FOUND` | Refresh catalog, choose an actual package |
| `PACKAGE_REVIEW_REQUIRED` | Owner reviews/installs package or dependency in Desktop |
| `PACKAGE_BROKEN`, `DEPENDENCY_NOT_READY` | Show bounded doctor/broken-install findings; repair locally |
| `INVALID_WORKSPACE`, `WORKSPACE_IN_USE` | Choose a suitable project or explicitly select an existing candidate |
| `IDEMPOTENCY_CONFLICT` | Same intent key was reused with different parameters; reconcile caller state |
| `OPERATION_NOT_FOUND` | Wrong/missing ID, identity or state storage; never assume work did not execute |
| `STORAGE_FAILED` | Cannot safely read/reserve/persist; inspect local state, retry same key only |
| `INSTALL_UNCONFIRMED`, `CREATION_UNCONFIRMED`, `PREPARATION_UNCONFIRMED`, `RECOVERY_REQUIRED` | Side effects may exist; inspect before any new attempt |
| `ENGINE_ACTION_REQUIRED`, `AGENT_UNAVAILABLE` | Open returned agent on machine, resolve launch/login/trust or stale target |
| `REVOKED` | Preparation authorization ended; inspect any already-created artifacts |
| `INTERNAL` | No confirmed result; retry same key or poll, not a new intent |

Existing Store/creator error codes can also be carried without rewriting their meaning, e.g.
`CLONE_FAILED`, `SETUP_FAILED`, `DOCTOR_FAILED`, `DSH_BUSY`, `TMUX_UNAVAILABLE`, `CWD_NOT_FOUND`,
`TMUX_TOO_OLD_FOR_DSH`, `PROJECT_EXISTS`, `PROJECT_PREPARATION_FAILED`. Consumers must display unknown
codes and guidance, not treat them as success. Setup error details can be tool/platform-specific.

## Full Blender flow and OS implementation checklist

1. Persist an OS user intent for “I want to use Blender to draw an airplane for me.” Negotiate all
   four capabilities. Never infer Blender readiness from an agent's name or recap.
2. `store.list(query:"Blender")` → select `autonomous/blender`; `store.inspect` → inspect metadata,
   installation, doctor evidence and candidates. If the user explicitly chooses a suitable existing
   candidate, use its exact machine/agent IDs instead of preparing another session.
3. Otherwise persist `prepare-airplane-001` and workspace choice before sending `agent.prepare`.
   Store returned operationId. Poll; narrate installation/checking/launching. Surface action-needed
   exactly, including authentication uncertainty. Let Harness own tool setup.
4. At `ready`, persist returned machineId/agentId and a **different** task key, `task-airplane-001`.
   Send the original user task once through existing `turn.send`:

   ```json
   {"type":"turn.send","requestId":"55555555-5555-4555-8555-555555555555","machineId":"mac-example","agentId":"agent-example","idempotencyKey":"task-airplane-001","text":"Use Blender to draw an airplane for me."}
   ```

   Do not bind this explicit returned target to unrelated app focus. Do not send the task in prepare,
   workspace name, an install script or an extra first-prompt call.
5. Persist delivery receipt/serverInstanceId and follow `receipt.get`, status, turn events, questions
   and recap. Existing `question.answer` cannot approve tool permissions; surface such prompts in
   Desktop. Announce actual completion from the agent's result, not from prepare being ready.
6. OS needs operation polling, durable intent/keys, capability fallback, candidate selection and
   action-needed presentation. It needs **no Blender-specific install commands or credentials**.

## Validation and limits

Automated coverage: catalog/installed/unknown readiness, package install coalescing, real local
fixture setup/doctor/materialization, permission-safe creator arguments, readiness transitions,
deduplication/reconnect, durable restart and spawn/journal recovery, workspace/symlink collisions,
revocation boundaries, errors, capability/role/encryption gates, strict schemas and replayed fixtures.
Creation/model boundary is mocked in these tests. Fixture doctor lines in the Blender JSON are
synthetic examples. This change has not installed Blender, driven a real robot, started a paid model
session, or rendered an airplane. Existing Store/creation regression suites provide additional
coverage but do not replace a future joint Lamp → real Blender acceptance test.

Regenerate/check schemas from runtime validators:

```sh
cd cli
npx tsx scripts/device-store-contract.ts
npx tsx scripts/device-store-contract.ts --check
npx vitest run src/lib/autonomous-device --maxWorkers=1
```
