# Design: copy less Swarm state per request (DB roadmap 2.6)

Date: 2026-10-30. Code read at `origin/main` (2bbcad4c4). Spec 2 of 8 in the CPU-ranked series; it assumes spec 1
(`2026-10-30-swarm-changes-shared-light-read-design.md`) ships first.

## Why

`structuredClone` is 9% of the backend's non-idle CPU in prod (`cpu profile` log, 2026-10-30, 3 pods), and garbage
collection another ~10%, much of it from those copies. The roadmap's item 2.6: readers' views clone the whole state
before filtering it, and writes clone what they load before applying.

**Where the copies come from.** The prod profile has no call stacks, so the split below combines a local profile of
`npm run bench:swarm-state` (stacks), prod request rates, and the sizes of the busiest Swarm's parts (`c51479bd…`):

| Path (prod rate per pod) | What it clones each time | MB cloned per pod-minute |
|---|---|---|
| `changes` poll → `readerView` → `visibleState` (110/min) | light state: ~625 light start conversations 162 KB, progress 79 KB, machines 46 KB, agents 12 KB | ~35 |
| machine report → `observeMachine` (125/min) | observed state: Lead + running conversations 86 KB, progress 79 KB, machines 46 KB, agents 12 KB | ~28 |
| commands → `applyCommand` (8/min) | active state: 125 conversations 510 KB, progress, machines, agents | ~5 |
| native events → `native.append`, `firstLoad`, others | small in prod | < 2 |

Measured locally on that Swarm's real data (670 KB): `structuredClone` 1.05 ms, a plain recursive copy 0.68 ms,
`JSON.parse(JSON.stringify())` 2.74 ms.

**Spec 1 already removes most of the first row:** the light state loses the start conversations and progress, so a
`changes` clone drops from ~320 KB to ~80 KB (~35 → ~9 MB a minute). This spec takes the rest worth taking.

## Goals

- A machine report neither reads nor copies the progress part, which it never uses.
- `visibleState` copies only what it returns.
- The copies that remain are made by a faster plain-data copy.
- Every reply, every stored write and every message is unchanged.

## Non-goals

- Copy-on-write (structural sharing with `immer` or `mutative`) for commands and machine reports. Measured on the
  busiest Swarm's real active state (650 KB, frozen, Node 22):

  | Work | `structuredClone` + mutate | `immer` | `mutative` |
  |---|---|---|---|
  | Command that reads every conversation 5 times, changes 2 records | 1.3 ms | 0.65 ms | 0.51 ms |
  | Same, reading every conversation 50 times | 1.4 ms | 5.3 ms | 3.3 ms |
  | Reader's view (filter, number every conversation, rewrite agents) | 1.2 ms | 0.9 ms | 0.2 ms |

  Proxies make read-heavy work slower than a copy, and `applyCommand` and the liveness sweeps read the whole state many
  times. After spec 1 and sections 1–3, the remaining copies are estimated at ~2% of CPU (commands 8 a minute per pod,
  reports ~150 KB each), so a refactor of every mutation path, a new dependency and proxy pitfalls (identity checks,
  `structuredClone` of a draft) would buy about 1%. Not done; revisit only if `cpu profile` says otherwise.
- The cache's `freeze` (2.6% of CPU): it guards shared values against mutation and stays.
- Commands loading every live part (DB 2.1) and machine reports reading members and agents whole (DB 2.5): later
  specs.

## Anti-goals

- A reader seeing anything their view hides today, or a write storing anything different.
- A copy helper that silently mangles a value it does not understand (a `Date`, a `Map`).

## Design decided

### 1. Machine reports do not load progress

- `parts/load.ts loadObserved` loads `progress: live` today. A report never reads project progress: only commands
  and native events note project reports (`projectUpdates.ts noteProjectReports`, called from `store.ts:1347` and
  `native.ts:229`), and `observeMachine` calls neither.
- `loadObserved` stops reading `SwarmProgress`. `commitParts` compares loaded parts with the split result; with no
  progress loaded, none is in either, so nothing is written or removed. The builder proves this with a test that a
  report leaves the progress part's version unchanged.
- Prod: `SwarmProgress.findMany` runs 123 times a minute per pod under this route (1.4 MB a minute per pod); it goes,
  with its decode, freeze and copy.

### 2. `visibleState` copies only what it returns

- Today `model.ts visibleState` does `structuredClone(state)`, then drops dormant conversations, deleted fields and
  unreadable items.
- It keeps its steps and their order, but copies a pruned state: the input with dormant conversations left out, and
  without the fields it deletes before any helper reads them (`sharing`, `harnessReservations`, `releasedHarnesses`,
  `overlapAlerts`, `closingSessions`). The builder check confirmed no helper before those deletes reads them
  (`syncLeads`, `ledProject`, `assignAgentDisplayNames`, `otherProjectsWork`), and that later access checks read the
  original `state`.
- *(Author's call after the builder check.)* Each project's `progress` stays in the copy. `visibleState` returns it,
  and `SuperTabStore.read` (`store.ts:989-1009`) passes it on whole. After spec 1 the `changes` poll carries no
  progress, so pruning it would save little and change an output.
- Filters that today run after `numberConversations`, `syncLeads`, `expireRemovals` or `placeRules` stay where they
  are: those helpers see the same input as today, so numbers, Leads and removals come out the same.

### 3. A plain-data copy instead of `structuredClone`

- A helper `cloneData<T>(value: T): T` (in `model.ts` or a small module beside it) copies plain objects, arrays and
  primitives recursively, keeps `undefined` values, and copies a `Date` as a `Date`. Anything else (a `Map`, `Set`,
  class instance, function) throws, so a new kind of value fails a test instead of being mangled.
- It replaces `structuredClone` on the paths in the table: `visibleState`, `applyCommand` (`commands.ts:560`),
  `observeMachine` (`store.ts:2307`), `native.append` (`native.ts:204`), and the store's other load-then-clone writes
  (`store.ts:858, 872, 917, 951, 2558, 2784, 2843, 2889, 2890`). Small clones of single values (a command, a
  configuration) may keep `structuredClone`.

## Left to the builder

- Where `cloneData` lives and its exact name.
- How the pruned input of section 2 is built, as long as the helpers see exactly what they see today.

## Tests

- **`cloneData`:** equals `structuredClone` (deep-equal, no shared references) for the read fixtures' states
  (`read/fixture.test-support.ts`) and a bench Swarm; keeps `undefined` and `Date`; throws on `Map`, `Set` and a class
  instance.
- **`visibleState` unchanged:** for the fixture Swarm and every actor kind (owner, member of a private project,
  member outside it, outsider, Buddy, worker agent, Lead agent), the new output deep-equals the old one. The fixture
  gains a project progress part and a sharing, a harness reservation, a released harness, an overlap alert and a
  closing session, so the pruned fields and `progress` are exercised. The old body stays only in the test file as the
  reference, then goes once the PR merges.
- **Reports leave progress alone:** an integration test runs `observeMachine` on a Swarm with a progress part; the
  part's version and data are unchanged, and the report reads no `SwarmProgress` document (count by the profiler as
  `integration/superTabCache.test.ts partReads` does).
- **Writes unchanged:** the existing command, native, observe and liveness suites stay green.

## Measuring

Same logs as spec 1 (`cpu profile`, `db by shape`, `cpu by kind`), before and after, same weekday hours:
- `structuredClone` and garbage collection shares of non-idle CPU;
- `SwarmProgress.findMany` under `POST /api/super-tabs/:tabId/machines/:machineId` (baseline 123 a minute per pod, 1.4 MB);
- that route's busy time per pod (baseline 1.30 s a minute).

**Done when** the tests pass, `SwarmProgress` reads under the machine route are gone, and the `structuredClone` share is
reported before and after (expected, after spec 1 and this spec together: from 9% to about 2–3%).

## Design (AGENTS.md rules)

- **Growth:** N/A because nothing is stored or kept.
- **Concurrency:** N/A because no lock or transaction changes; copies stay per request.
- **Read cost:** a machine report reads one collection less; a read copies only what it returns.
- **Scale:** at 10× conversations or machines, copies grow with what each request keeps, not with the Swarm; the
  `structuredClone`/copy share in `cpu profile` warns first.
- **Compatibility:** replies, writes and messages are unchanged, so old and new clients and pods agree.
- **Migration + rollback:** N/A because nothing stored changes; roll back by deploying the previous release.
- **Audience:** `visibleState` keeps every filter; the per-actor equality test enforces it.
- **Identity:** N/A because nothing here acts as or reads the machine owner's login.
- **Failure:** `cloneData` throws on a value it cannot copy, failing the request loudly instead of storing a mangled one.
- **Platforms:** backend only.
