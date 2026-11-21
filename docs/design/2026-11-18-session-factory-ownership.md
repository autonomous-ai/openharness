# Session factory ownership

## Design

The native launcher and the Cloud wrapper currently select factories independently: native creation checks
`ENGINES`, and the Cloud wrapper checks the provider catalogue. One immutable lookup will instead combine the
existing native list with factory ownership declared in the existing `SERVICE_HOSTS` metadata. Core composition
constructs it once and supplies its predicates to both real creation paths, including recovered native intents.
The existing service port, readiness, prepared-reply admission and physical-connection fence remain unchanged.

The declaration is finite trusted build data: 17 native IDs and three Cloud IDs. It holds no sessions, credentials
or user content, accepts no live registration, and persists only as existing compiled artifact bytes. Duplicate
IDs, a native/service collision or a declaration for a service outside its unique host are invalid build data.
The lookup is private and immutable; a disabled or disconnected service keeps ownership and returns unavailable,
never falling through to native launch. Guest creation keeps its existing own-account policy.

The pure builder lives beside `SERVICE_HOSTS`; core supplies `ENGINES`. Master imports remain unchanged and load
no engine module. The existing machine-checked `WORKER_PLAN` includes host declarations and the native IDs;
existing cohort admission and immutable artifact selection bind the runtime. No generated module, build helper,
new environment field, factory registry or process is added. A whole-cohort rollback restores the previous lookup.

Runtime reads perform one key lookup. Construction visits only the compiled catalogue once. Malformed build
declarations fail with `INVALID_SESSION_FACTORY_DECLARATION`, without content or identifiers. No per-session
state, queue, timer, file I/O or new public data path is introduced. Existing source/caller tests cover routing,
saved-intent refusal and unavailable service behavior; native/packaged integration remains a coordinated gate.

This slice removes factory selection from the feature roster in core. It does not finish Cloud's accepted-owner
read representation or change publication/journal limits. The common read schema's failed capacity and native
JSON ordering findings, and the original connected-publication cost hold, remain open.

## Validation plan

First run actual Cloud/native caller refusal REDs against the old selectors, including both saved native intent
kinds. Then run affected Cloud/native/host/cohort tests with types and per-file coverage for touched covered files,
plus the unchanged master/core architecture test. Parent integration owns combined core/harnessd and final packaged
Cloud/native flow evidence. The portable TypeScript paths affect macOS, Linux and Windows; source checks run on
macOS, Windows execution is deferred by the user, and mobile is excluded.

## Source evidence

All receipts are under this worktree's `.harness/validation/`; source base is
`89757d4b7a868c019161a527834bd6538b97a841`, with pinned Node 24.22.2 and the unchanged combined dependency tree.

- RED `20261118T152403.150283Z-74879`: 147 passed, four intended caller failures. The old Cloud selector still
  called an excluded factory, native create still launched one, and both saved native/model intent paths reached
  model resolution despite excluded native ownership.
- First implementation `20261118T152756.661252Z-82322`: 498 cases passed across 19 files, including unchanged
  master/core architecture. Aggregate **failed**: TypeScript required an explicit `return fail()` to narrow the
  new lookup key; all 25 actual-storage fixture cases failed in their common setup. This receipt also records
  sandbox refusal of `ps` during cleanup inspection; it is retained as failed, not relabeled passing.
- Bounded single-case diagnostics `20261118T153206.899253Z-86980` and
  `20261118T153305.510873Z-88049` confirmed private child HOME/data, zero child stderr, and exact `EPERM` inside
  the private registry lock before preparation. Instrumented fixture copies/diffs are retained in `/tmp` and were
  restored before validation. Both observed child PIDs (86999 and 88068) closed and were independently absent.
  Registry/storage production code was unchanged; no real user home or provider data was involved.
- Final targeted correction `20261118T153428.841460Z-89713`: types, 270 cases across 11 files and all 25 private
  storage-child cases **passed**, with process-group cleanup confirmed. The gate used an explicit private test
  environment and the process permissions required by that fixture; its private outer root was removed afterward.
  `core/agents/cloud.ts`, `core/agents/launches.ts`, `harnessd/services.ts` and `harnessd/workerContract.ts` each reached
  100% statements, branches, functions and lines. Unchanged other functional cases from the first gate are reused;
  the failed aggregate receipt remains visible. `git diff --check` passed.

The final worker-plan stamp is `025db0d70a1bf79ed16dd31bc0aef1caaf3040cb4009d9f8c19387924fc8d911`.
No master import exception, new core-file allowance, product build, native daemon or timing run was added here.
Combined core/harnessd gates and final packaged Cloud/native create proof remain integration work; this source
checkpoint does not close the common-owner capacity or original connected-publication performance holds.
