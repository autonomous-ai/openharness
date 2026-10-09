# The other twelve engines, out of the core

A plan, not yet built. The core still loads the code of twelve engines besides Claude Code and Codex:
OpenCode, Cursor, Kilo, Devin, Hermes, Amp, agy, Grok, Copilot, Command Code, Muse and Pi. This batch
takes that code out of the core's static import closure. It is loaded lazily, in process, so an engine
nobody runs costs nothing. Workers per engine come later, a few engines per batch.

Rules for every sub-batch:

- **No behavior change for these engines.** No feature work, no fixes. Their code moves as it is, and
  their entry modules re-export it rather than wrap it.
- **Session control never waits on a worker.** Lazy loading is an `import()` in the core's own process.
  Stop, close, the input lease, turn closing and hook admission never wait on it: their per-engine
  parts are shared code or declared data.
- **A failed import degrades one engine and never the core.**
- Claude Code and Codex never call the loader. Their e2e suites run unchanged.

## 1. What is in the closure today

**Method.** Bundle `cli/src/core/main.ts` with esbuild (`--bundle --platform=node --format=esm
--packages=external --metafile`), with a plugin that marks every `import()` external. The metafile lists
the files and each file's importers. A file's lines are its text split on `\n`, as `architecture.spec.ts`
counts them. At 734b5e497 the closure is **73,125 lines in 388 files**.

| Engine | `engines/<name>/` | Search reader | Other files | Total | Comes in through |
| --- | --- | --- | --- | --- | --- |
| Cursor | 1,176 (7 files) | 354 | 46 (`core/engines/cursorTasks.ts`) | 1,576 | live, history, last turn; Task hooks; `main` (discovery, pending tasks); `questionPane`; `registry`, `bind`, `kit/notifyHooks`, `lib/hooks` (home); search index |
| OpenCode | 1,178 (5) | 301 (Kilo's too) | | 1,479 | launch (`version`: `engineLaunch`, `gridLaunch`, `subscriptionModel`, `create`, `fork`, `launches`, `retarget`, `main`); `retarget` (`sessionModel`); history, last turn, attach; runtime and model control; `lib/hooks`; search |
| Hermes | 866 (5) | 478 | 53 (`lib/hermesHome.ts`) | 1,397 | history, last turn, attach; `hookServer` (source check, homes); `sessionRepair`, `sessionCheckpoint`, `purgeAgentService`, `lib/hooks` (home); discovery (`homeProbe`); runtime and model control; search |
| Devin | 945 (5) | 197 | | 1,142 | history, last turn, attach; `questionPane`; runtime and model control; search |
| Kilo | 986 (4) | | | 986 | history, last turn, attach; `questionPane`, `questionController`; runtime |
| Copilot | 489 (3) | 349 | | 838 | live, history, last turn; `questionPane`; `registry`, `bind`, `sessionRepair` (`session`); search |
| agy | 636 (4) | 120 | 69 (`core/turns/agyBackstop.ts`) | 825 | live, history, last turn, attach (`agyPaneIdle`); backstop; `questionPane`; `registry`, `bind`, `sessionRepair`; runtime; search |
| Grok | 504 (4) | 253 | | 757 | live, history, last turn; `questionPane`; `bind`; runtime; search |
| Amp | 691 (4) | | | 691 | live, history (thread export), last turn; `questionPane`, `questionController`; runtime |
| Pi | 392 (2) | 249 | 37 (`lib/legacyPane.ts`) | 678 | live, history, last turn; screen; runtime and model control; `sessionRepair` (its search reader); search |
| Muse | 465 (3) | 182 | | 647 | live, history, last turn; `questionPane`; `sessionRepair` (normalizer); runtime; search |
| Command Code | 471 (3) | 149 | | 620 | live, history, last turn; `registry` (`transcript`); runtime and model control; search |
| Shared by them | | | 44 (`lib/databaseHistory.ts`, `core/transcripts/databaseHistory.ts`, `lib/legacyScreen.ts`) | 44 | |
| **Total** | **8,799 (49)** | **2,632 (10)** | **249** | **11,680** | |

In the table, "live" is `core/transcripts/ingest.ts` and `attach.ts`, "history" is `history.ts`, and
"last turn" is `lastTurn.ts`. "Search" means `lib/sessionSearch/externals/index.ts`, which core builds
for adoption in `core/main.ts`.

Beyond those files:

- **Shared files that hold only their code: 1,123 lines, which leave too.** `lib/hooks.ts` (1,004, eleven installers) and
  `lib/questionPane.ts` (119, their dialog readers).
- **Shared files only they reach: 300 lines, which leave too.** `engines/kit/screen.ts` (43) and `lib/transcriptReader.ts`
  (257, which (c5) also works on).
- **Their code inside mixed shared files.** Not counted above, and mostly staying: see section 4.

**One file, several roads in.** A normalizer leaves only when its last importer stops reaching it. Cursor's
comes in through the live path, history, last turn, Task hooks and search (through `transcriptReader.ts`).
OpenCode's comes in through history, last turn, attach, `databaseHistory` and search. Muse's also comes
in through `sessionRepair`. So the large savings come with the last two sub-batches.

## 2. Mechanisms

| | What | Where it fits |
| --- | --- | --- |
| **Lazy module** | `engines/inProcess.ts` is the only file that `import()`s their code. It holds one module per engine (`engines/<name>/inProcess.ts`, which re-exports what core calls today), plus two shared ones: the dialog readers (`lib/legacyScreen.ts`) and the hook installers (`lib/hooks.ts`). `loadEngine(name)` returns a cached promise of the module or `null`. `engineLoaded(name)` is synchronous: the module, `null` (failed), or `undefined` (not loaded yet, and it starts the load). | Async call sites, and synchronous ones that only run after an awaited load |
| **Declared data** | `engines/<name>/contract.ts`: plain data, read by `engines/kit` mechanics, like Claude's and Codex's `hookContract.ts`. It imports only `engines/kit/*`, `engines/types.ts` and `config/env.ts`. | Synchronous paths that run before any session, or on the hook path: transcript layouts, homes, answer keys, admission |
| **Service process** | The search process keeps its readers static, since it uses all of them. | Search. Core's adoption loads providers lazily, so adoption does not depend on the search process. Handing adoption to search is a later option. |

**Preloading.** A session entering the registry starts `loadEngine` for its engine: at load, on register
and on `adoptEngine`. Attach awaits it before building a normalizer or reader. A transcript's tail starts
only in attach (`watcher.addSession`), so a line never reaches `ingest` before its engine is loaded.

**Failure.** A rejected `import()` or a throwing top level is caught once. That engine is marked
unavailable for the life of the process, with one log line (`[engine cursor] unavailable · <error>`). The
loader never rethrows and never retries: a chunk that failed to import fails again until an update or a
restart. Every caller handles `null` with the answer it gives today to an engine it has no code for
(section 3). A synchronous caller that finds `undefined` logs it and does the same. The architecture test
pins that this cannot happen on the line path.

**The bundle.** The core runs from the lean bundle, built with `splitting: true` (`build-bundle.mjs`), so
each `import()` target becomes its own `core-*` chunk, which Node reads only when it is imported. From
`cli.js` (`HARNESSD_LEAN=off`, or the fallback) esbuild keeps the code in the one file, wrapped: Node parses
it but does not run it.

## 3. Call sites

| Call site | Runs | Sync | Hot | Mechanism | Engine unavailable |
| --- | --- | --- | --- | --- | --- |
| `core/transcripts/ingest.ts` `ingestLine` | each transcript line | yes | **yes** | `engineLoaded`, loaded before the tail started | no events from its lines, as for an engine with no normalizer today |
| `core/transcripts/attach.ts` | the first attach of a session | no | no | `await loadEngine` | attached with no normalizer or reader; logged |
| `core/transcripts/{history,lastTurn}.ts`, `lib/databaseHistory.ts` | `session_get`, each turn's end | no | no | `await loadEngine` | an empty page; no last-turn text |
| `core/engines/cursorTasks.ts` `onCursorTaskStart`, `core/turns/agyBackstop.ts` | Cursor's Task hook; agy's idle watch | yes | no | built on the engine's first attach; `engineLoaded` | the Task is not followed; no backstop |
| `core/turns/turnHooks.ts`, `core/agents/forget.ts` | Stop hooks; forget | no | no | the normalizers attach built; pending tasks through `await loadEngine` | nothing to close: no turn was opened |
| `core/engines/screens.ts` `inline` (`legacyScreen`) | each pane read: activity polls, input checks, questions | its caller is async | warm (polls) | `inline` returns a promise, and `await` loads `legacyScreen` once | `null`, which every caller already reads as unreadable |
| `lib/questionController.ts` `rowKeys` | answering a dialog, per row | yes | no | declared: Amp and Kilo name their walk (`down`, `right`). `kit/questionPane.ts` turns that into keys. | n/a |
| `LegacyRuntimeProfileManager` `ingest`, `transcriptFields`, `hydrate`, `ingestPane` | each line; each pane read | yes | **yes** | `engineLoaded`, preloaded | no profile reading: the chips keep their last values |
| `RuntimeProfileController.setProfile` drivers | a model switch | no | no | `await loadEngine` | refused before any key is sent |
| `installEngineHooks` | daemon start | yes today | once | Claude Code and Codex first, as now. Then one awaited import of `lib/hooks.ts`, at the same step and in the same order. | its hooks are not installed; logged the way `hookStep` logs an install error |
| `core/agents/create.ts` OpenCode plugin | before an OpenCode spawn | in an async caller | no | `await`, through `core/engines/hooks.ts` | the OpenCode create is refused |
| adoption (`ExternalSessions`, `OpenSessions` in core) | adopting a session | no | no | each provider loads on its first scan | that provider's scan fails: today's path, which keeps the last good answer and logs |
| `lib/registry.ts` derived transcript path, `TRANSCRIPT_ROOT` | every register (hook path); load | yes | per hook | declared layouts (Command Code, Grok, agy, Copilot) and Cursor's home | n/a |
| `engines/kit/notifyHooks.ts` | building Cursor's hook command | yes | no | declared home | n/a |
| `hookServer.ts` Hermes source check | a Hermes SessionStart, off the HTTP path | no | no | declared admission, like Codex's child rule: the store, table, column and interactive values, read by kit through `lib/sqliteRead.ts` | n/a |
| `core/agents/bind.ts` transcript finders | binding a discovered process | no | per bind | `await loadEngine` | bound without a transcript path, as when none is found today |
| `lib/sessionRepair.ts`, `lib/terminalAgentDiscovery.ts` | repair, resume; Hermes's home probe | no | per pass | `await loadEngine`; Hermes's env name is declared | no repair answer for that engine |
| OpenCode's version and session model (`create`, `fork`, `launches`, `retarget`, `gridLaunchMachine`) | building an OpenCode launch | yes, in async callers | no | the probe loads with OpenCode's module, awaited only for an OpenCode launch | the OpenCode launch or retarget is refused, never given a guessed argv |

No code of these engines runs per keystroke. Terminal input goes to tmux. Message input
(`lib/sessionInput.ts`) keeps its per-engine numbers where they are.

## 4. Their code inside mixed shared files

| File | Their code | This batch | Later |
| --- | --- | --- | --- |
| `lib/runtimeControl.ts` | six pane drivers, about 430 of 670 lines | move to each engine's module in (o4) | |
| `lib/runtimeProfileManager.ts` | about 800 of 1,335 lines: Cursor's catalog and footer, plus the targets and catalogs of Devin, Hermes, Command Code, OpenCode and Kilo | parsers become lazy in (o4); the methods stay | each engine's runtime facet |
| `lib/sessionInput.ts` | verify windows for 11 engines, Cursor's composer checks (about 70 lines) | stay: input is session control | declared submission policy, as `engines/submissionPolicies.ts` does for Claude and Codex |
| `core/turns/turnHooks.ts` | Stop handling for six engines (about 125 lines) | stays: it closes turns | declared Stop rules (`kit/stopHook.ts`) |
| `lib/questionController.ts` | `rowKeys`; Devin's multi-select submit key | the walk moves to kit in (o1) | |
| `engines/kit/pane.ts` | prompt glyphs, boxed panes, Grok's pane | stays: kit, shared with Claude and Codex | |
| `lib/tmux.ts`, `lib/engineBin.ts`, `lib/engineInstall.ts`, `config/env.ts`, `lib/gridLaunch.ts` | one row per engine | stay: catalog data, read for every process row | |
| `watcher/watcher.ts`, `core/turns/funnel.ts`, `core/input.ts`, `lib/agentTokenUsage.ts` | a few branches each | stay | |

## 5. Sub-batches, in order

The order follows the remaining-facets rule: self-contained async work first, synchronous hot paths
after, and anything that shares files with (c) once (c) has landed. Each sub-batch records its golden
first, in a commit of its own. The closure figures come from the same esbuild build, with that
sub-batch's static edges marked external. Cumulative.

| | Scope | (c) overlap | Lands | Leaves | Closure after |
| --- | --- | --- | --- | --- | --- |
| **(o1) Screens and dialogs** | The loader and the architecture ratchet come in. `legacyScreen` loads lazily, as one chunk with `legacyPane`, `questionPane` and the eight `askQuestion.ts` readers. Amp's and Kilo's answer keys become declared walks. | none | now | 1,126 | 71,999 / 376 |
| **(o2) Hook installers** | `lib/hooks.ts` loads lazily, whole and unchanged, at the start step, and before an OpenCode spawn | `create.ts` with (c2) | now. The `create.ts` line comes after (c2), and the lines leave at that point. | 1,004 | 70,995 / 375 |
| **(o3) Transcripts** | Live, history, last turn and database history behind `loadEngine`. Preloading starts here. Cursor's Task hooks, discovery and pending tasks, and agy's backstop, are built on first use. | `lastTurn.ts` and `history.ts` import `lib/normalize.js`, which (c5) splits: a one-line rebase | now | 728 | 70,267 / 367 |
| **(o4) Runtime profiles and model switching** | The ten `runtimeProfile.ts` parsers, preloaded. The six pane drivers move out of `runtimeControl.ts`. | none | now | 1,098, plus about 430 of drivers | 69,169 / 357 |
| **(o5) Adoption's readers** | `externals/index.ts` loads each of the ten providers on its first scan. The search process is unchanged. | (c5): `externals/index.ts`, `external.ts`, `transcriptReader.ts` | after (c5) | 4,201 | 64,968 / 341 |
| **(o6) Identity, homes and launch data** | The registry's layouts, Cursor's and Hermes's homes, and Hermes's admission become `contract.ts` data. Bind's finders, repair, the Hermes probe and OpenCode's version and session model load lazily. | (c1) `engineLaunch`, `fork`; (c2) `create`, `launches`; (c3) discovery; (c4) `registry`, `sessionRepair` | after (c4) | 4,946, with about 150 lines of contracts coming in | 60,022 / 318 |

**End state:** about **59.7k lines**: 73,125 less the 13,103 above, less the drivers, plus the contracts.
No file under `engines/<other>/` is in the closure except `contract.ts`. The code that remains of these
engines is in the shared files of section 4. Each engine's `inProcess.ts` is then the seam for its
worker: a worker runs the same module, and core swaps `loadEngine` for a broker, facet by facet.

### Conflicts with (c)

| (c) | Its files | Ours there |
| --- | --- | --- |
| (c1) #1046 | `lib/engineLaunch.ts`, `lib/tmux.ts`, `lib/engineHomes.ts`, `core/agents/fork.ts`, `engines/launches.ts`, `dsh/adapters.ts` | OpenCode's version in `engineLaunch` and `fork`: (o6) |
| (c2) | `lib/claudeTrust.ts`, `core/agents/{create,launches,launch}.ts`, `engines/codex/portableHistory.ts`, `dsh/runtime.ts` | `create.ts`: the OpenCode plugin (o2) and its version (o6); `launches.ts` (o6) |
| (c3) | process signatures, `gridAssignment`, `codexHomeProbe`, `claudeProject`, `cwdRepair`, `engineHomes` | neighbours only: `terminalAgentDiscovery` and `bind.ts`, both (o6) |
| (c4) | `lib/registry.ts`, `engines/codex/rollout.ts`, `lib/sessionRepair.ts`, `captureResumeIdentity`, `handoffDiscovery` | `registry` and `sessionRepair`: (o6) |
| (c5) | `externals/{claude,codex}.ts`, `transcriptPages`, `transcriptReader`, `transcriptActivity`, the normalizer split | `externals/index.ts` and `external.ts` (o5); the `lib/normalize.js` import (o3) |
| all | `architecture.spec.ts` | a new test and a new list: additive |

### Risks

| Risk | Guard |
| --- | --- |
| A line or a pane reaches a synchronous reader before its engine is loaded | The preload, and the tail starts only in attach. A spec pins the order: register, then load, attach and tail. `undefined` is logged, never silent. |
| A static edge is missed | The architecture ratchet fails while any listed file is reached, and the metafile report runs per sub-batch |
| Moved code drifts | Goldens are recorded before the move. Modules re-export, so code is not rewritten. Existing specs run unchanged. |
| A chunk is missing or throws | The loader catches it, and the caller's `null` answer applies. A lean e2e deletes one engine's chunk. |
| The first attach of an engine waits for an import | A few milliseconds, once per engine per daemon life. The preload at registry load hides it. |
| Grid launches of other engines stop running `opencode --version` (today `gridLaunchMachine` probes for every launch) | The only observable difference. It is named in (o6)'s PR, or the eager probe is kept if the owner prefers. |
| From `cli.js`, the code is still parsed | Known. The lean bundle is the normal path. |

## 6. Proof

**Goldens, before each move.** No fake engine exists for these twelve: `e2e/harness/fakeEngine.mjs` plays
Claude Code and Codex only. So each sub-batch first records a golden from main, in its own commit
(`RECORD_OTHER_ENGINES_GOLDEN=1`, like `hookInstallers.golden.spec.ts`), using the inputs that exist. After
the move, the golden must pass unchanged and read through the lazy path: the spec calls core's entry
(`createIngest`, `createAttach`, `createHistory`, `screens.read`) with the real loader. Flipping any one
engine's branch must fail it.

| | Golden | Inputs that exist | Recorded | Engines |
| --- | --- | --- | --- | --- |
| (o1) | the screen matrix | `lib/__fixtures__/{permission,question}-*.txt` (31), `takeoverScreens.ts`, `rewindPickers.ts`, the captures in `askQuestion*.spec.ts` | the reading for every engine × every capture, so cross-engine misreads are pinned too | 12 |
| (o1) | answer keys | the rows of the screen golden | `rowKeys(engine, row)` | Amp, Kilo, and OpenCode's walks |
| (o2) | hook files | the kinds of file state `hookInstallers.golden.spec.ts` covers (43), per target file | bytes, mode, symlink, log lines, what threw | 11 |
| (o3) | live fold and lines | `lib/__fixtures__/*-session.jsonl` (agy, Amp ×2, Copilot, Grok, Muse), `transcript-async-subagents.jsonl`, the transcripts the normalizer specs build; the SQLite stores the reader specs build (`kilo-session.json`, `hermes-async-delegation.json`) | events from attach's fold, then line by line through ingest (`turnOpen`, aborts); the readers' start and one poll | 12 |
| (o3) | history and last turn | the same | `session_get` whole, latest and paged (sha and event types, as `transcript-contracts.json` does for Claude and Codex); last-turn text | 12 |
| (o3) | Task hooks, backstop | `core/turns/{turnHooks,agyBackstop}.spec.ts` | emitted events | Cursor, agy |
| (o4) | runtime profile | inputs to `runtimeProfileManager.spec.ts` and `runtimeProfile.spec.ts`, session fixtures, pane captures | state after hydrate, ingest, ingestPane and ingestConfig; `transcriptFields`; targets and catalogs (exec stubbed) | 11 |
| (o4) | model switch | `runtimeProfileController.spec.ts`'s scripted panes | keys sent, outcome | Cursor, Devin, Pi, OpenCode, Hermes, Command Code |
| (o5) | adoption scan | the homes in `externals/*.spec.ts` | `scan`, `owners`, `busy` per provider | 12 (10 reader files) |
| (o6) | identity and launch | hook payloads, pid records; (c1)'s `launchArgv.golden.spec.ts`, which records the other 13 engines in the common shapes | derived transcript path, bind result, repair answer, argv | 12 |

**Existing coverage**, which runs unchanged throughout:

| Engine | Own specs (files / cases) | Other specs naming it | Fixture files |
| --- | --- | --- | --- |
| OpenCode | 6 / 59 | 52 | 3 |
| Cursor | 5 / 22 | 37 | 1 |
| Kilo | 4 / 32 | 19 | 2 |
| Devin | 5 / 36 | 28 | 3 |
| Hermes | 5 / 33 | 32 | 4 |
| Amp | 3 / 33 | 15 | 3 |
| agy | 4 / 29 | 14 | 3 |
| Grok | 4 / 22 | 27 | 3 |
| Copilot | 1 / 25 | 18 | 3 |
| Command Code | 3 / 31 | 28 | 3 |
| Muse | 2 / 24 | 18 | 3 |
| Pi | 2 / 19 | 32 | 5 |

**Architecture test** (`architecture.spec.ts`, from (o1)):

- `closureOf` does not follow an `import()` written in `engines/inProcess.ts` or
  `lib/sessionSearch/externals/index.ts`, the way it passes over `services/inline.ts`. An `import()` of their
  code anywhere else is followed, and so fails the test.
- `OTHER_ENGINES_CORE_MAY_REACH` lists every file of theirs that `core/main.ts` reaches today, each with
  the sub-batch that ends it. The list only shrinks: an entry that is no longer reached fails the test.
  The list covers `engines/<other>/**`, `externals/<other>.ts`, `lib/{hooks,questionPane,legacyScreen,legacyPane,hermesHome,databaseHistory}.ts`,
  `core/engines/cursorTasks.ts`, `core/turns/agyBackstop.ts` and `core/transcripts/databaseHistory.ts`.
- **End state:** the list is empty. `engines/<other>/contract.ts` is allowed, and its own closure reaches only
  `engines/kit/*`, `engines/types.ts` and `config/env.ts`.
- Per entry, as the existing facet tests do: once its sub-batch lands, each of `core/transcripts/ingest.ts`,
  `attach.ts`, `history.ts`, `lastTurn.ts`, `core/engines/screens.ts`, `lib/runtimeProfileManager.ts`,
  `core/engines/hooks.ts` and `lib/registry.ts` reaches no file of theirs.

**The failure path:**

- **Loader unit spec.** An import that rejects and a module that throws at its top level each resolve
  `null` once and log once. `engineLoaded` then answers `null`, and the other engines still load. Each call
  site's `null` answer from section 3 is pinned.
- **`lean.e2e.ts`.** With one engine's `core-*` chunk deleted from the lean bundle, the Claude Code and Codex
  cases still pass, and the log names the engine unavailable exactly once.
- **The rest of e2e,** for Claude Code and Codex, unchanged. `perf.e2e.ts` reports the core's idle heap
  before and after (informational).
