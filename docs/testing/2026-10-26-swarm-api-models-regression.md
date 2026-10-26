# Swarm API models regression — 2026-10-26

Release gate for the 29 Oct release to the autonomous.ai org: do the API-model flows of Swarm local models
([plan](../plans/2026-10-23-swarm-local-models.md)) work on this Swarm's machines? Test and report only; no product
code was changed. Local models (engines on a member's machine) are out of scope.

- Swarm: `c51479bd73b59e58176ad9e4`, project `5701099db2a04f605ac0d4d4`, grid `swarm-626d5615ecf5`, owner ken15.
- Shared API model: `deepseek/deepseek-v4.1-flash-1017 · OpenRouter` (kind `api`), shared from MacbookPro.local.
- Source revision for the unit tests and code references: `7754ca93c`.
- Backend in production: `v1.3.35_backend`, `1b6709ae5f35` (`GET https://harness-api.autonomous.ai/api/health`).
- Times are UTC.

## Machines

| Machine | Owner | OS | CLI | grid | Desktop | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| MacbookPro.local | ken15 | macOS | not read | not read | not read | Shares the DeepSeek API. |
| MACs-Mac-Studio.local | ken15 | macOS | 0.4.72 | 0.3.59 | not read | Runs the Lead. Read by the Lead. |
| WIN-DELL | ken15 | Windows | not read | none (assumed) | not read | No grid is published for Windows. |
| MacBooks-MacBook-Pro-19.local | tony | macOS | 0.4.72, then 0.4.73 from 09:45:55 | 0.3.59 (installed 09:22 by flow 4) | 1.3.19 | This Engineer's machine. |
| Diego's Mac | diego | macOS | not read | not read | not read | |
| MacBookPro2021.local | phamngochuy | macOS | not read | not read | not read | Its readings carry no Local models field. |

## Result matrix

| Flow | Machine | Result | Evidence |
| --- | --- | --- | --- |
| 1. Local models on and ready | Swarm (owner's computers) | **fail** on 0.4.72 | Status flipped between ready and "Grid could not be set up on this computer. Try again." every ~60 s until 09:45:45; [F1](#f1) |
| 1. Local models on and ready, recheck | Swarm, CLI 0.4.73 | pass | 82 of 82 reads ready from 10:23:23 to 10:38:17, none failed since 09:46:02 ([Flow 1](#flow-1-local-models-on-and-ready)) |
| 1. Membership and visibility | MacBooks-MacBook-Pro-19.local | pass | `grid --remote ls` lists `swarm-626d5615ecf5`; `grid --remote models swarm-626d5615ecf5` lists the DeepSeek model on node MacbookPro.local |
| 2. Share an API: machine readings | MacbookPro.local | pass | Its reading lists the model with kind `api` (every status read 09:15–09:28) |
| 2. Share an API: Local models window preview | MacbookPro.local | not verified | Needs a screenshot from Ken |
| 3a. Route naming "deepseek 4.1 flash" | all six | pass | Pick on Diego's Mac with `gridModel`/`gridName`; same model offered on all six machines |
| 3b. Route without a model name | all six | not verified | DeepSeek printed on MacbookPro.local only; full list not read ([3b](#flow-3)) |
| 3c. Route naming a model four Builders hold | Swarm | **fail** | Explanation naming the Builders is missing; [F2](#f2) |
| 3d. Route while the sharing machine's readings are stale | Swarm | **fail** | "No candidate runs …" while the grid serves it; [F4](#f4) |
| 4. Builder on DeepSeek, sharing machine | MacbookPro.local | pass on retry | First start failed: "Cloning took too long. Check the connection and retry." ([F3](#f3)); retry done 09:35 |
| 4. Builder on DeepSeek, through the relay | MacBooks-MacBook-Pro-19.local | pass | Nico: task done; 77/77 model replies from DeepSeek, no API error |
| 4. Builder on DeepSeek, through the relay | MACs-Mac-Studio.local | pass | Arlo: task done with the expected answers |
| 4. Builder on DeepSeek, through the relay | Diego's Mac | pass | Arlo (second of that name): task done; started 6 min 22 s after it was queued |
| 4. Builder on DeepSeek, through the relay | WIN-DELL | **fail** | Dispatched 09:38:12, never runs, no error shown; [F5](#f5) |
| 4. Builder on DeepSeek after CLI 0.4.73 (post-fix recheck) | MACs-Mac-Studio.local | pass | Requested 10:22:00, running 10:22:41, expected answers, model DeepSeek through OpenRouter |
| 5. Shared with you → Offer to Swarm | MacBooks-MacBook-Pro-19.local | not in this build | The Desktop hides Shared with you and Offer to Swarm on purpose; the plan still describes them; [F6](#f6) |
| 6. Models service restart on the sharing machine | MacbookPro.local | pending | Needs Ken's ok |
| 7. Delete the saved API (#1716) | MacbookPro.local | pending | Last; needs Ken's agreement |
| 8. Unit tests | MacBooks-MacBook-Pro-19.local | pass | Backend 192/192, CLI 283/283, Desktop 64/64 at `7754ca93c` |

## Flow 1: Local models on and ready

**Observed.** Polling the Swarm state every 10 s from 09:19:12 to 09:24:33 (30 reads): 12 ready, 18 failed, in a
fixed rhythm — about 20 s ready, then about 40 s with
`{"ready": false, "error": "Grid could not be set up on this computer. Try again."}`, then ready again:

```
09:19:12 ready   09:19:33 FAIL   09:20:06 ready   09:20:28 FAIL   09:21:07 ready   09:21:29 FAIL
09:22:12 ready   09:22:33 FAIL   09:23:05 ready   09:23:27 FAIL   09:24:11 ready   09:24:33 FAIL
```

A second watcher, reading every ~17 s from 09:32, saw the same rhythm (1–3 failed reads a minute) until the last failed
read at 09:45:45; from 09:46:02 to 10:23:18 all 134 reads said ready, and MacbookPro.local's reading listed DeepSeek
(under 45 s old) and grid listed it on every one of them.

**Fixed in CLI 0.4.73.** `bf77fd7ca` (#1730, tag `v0.4.73_cli` at `f7b93bc4b`, released at about 09:46): an owner's
computer that cannot set grid up no longer reports a failure over a grid the Swarm shows ready, unless it kept the grid
ready itself, and does not ask grid again while another computer keeps it (`cli/src/superTabs/swarmGrids.ts`). The fix
acts on the failing computer, so the flapping stops once that one runs 0.4.73. MacBooks-MacBook-Pro-19.local updated
itself at 09:45:55 (`[update] applying 0.4.72 → 0.4.73`); it is not the owner's, so it never reported this status.
**Recheck on 0.4.73** (Lead's request): the Swarm state read every ~11 s from 10:23:23 to 10:38:17, 82 reads, all
`{"enabled": true, "ready": true}` with no error; the 17 s watcher over the same span read ready 52 times out of 52, and
MacbookPro.local's reading listed DeepSeek, under 45 s old, on all 53 of its reads. Before the fix the same 10 s polling
saw 18 failures in 30 reads. A Builder on DeepSeek on Mac Studio passed at 10:22 ([flow 4](#flow-4-builders-on-the-shared-api-model)).
Which of the owner's computers run 0.4.73 cannot be read from here (readings carry no CLI version); asked of the Lead.
**F1 is fixed on 0.4.73**; which computer failed is still not confirmed by its log.

**Which computer, and why.** Every computer signed in as the Swarm owner keeps the Swarm's grid: the daemon's Super Tab
host runs `SwarmGrids` on each of them (`cli/src/superTabs/host.ts` `pollMachines`), `GET /api/super-tabs/grids` answers
the owner's Swarms to each (`backend/src/superTabs/store.ts` `hostGrids`), and each posts `localModels.status`
(`cli/src/superTabs/swarmGrids.ts:59-67`). The backend keeps the last report and does not record which computer sent it
(`backend/src/superTabs/commands.ts:872-880`). A computer that is ready skips its next pass only while the Swarm still
says ready, so after a failing report it reports ready again within a minute; the failing computer is retried every
minute because its error is not final. The two alternate.

Ken has three computers in the Swarm. MacbookPro.local serves the shared API on the grid, so it is signed in to grid.
MACs-Mac-Studio.local's log (read by the Lead) shows grid signed in and no "could not be set up" line. The exact sentence
is what `notReady` answers when grid's set-up ends with no detail (`cli/src/services/models.ts:213-216`), which is the
`no-cli` outcome: no grid binary after the install attempt (`cli/src/lib/gridAttach.ts:99-102`). On Windows there is no
managed grid (`cli/src/lib/runtimeInstall.ts:321-323`: "no grid is published for it"), and the fallback installer is a
`bash` script. So the failing reporter is most likely WIN-DELL. **Not verified**: WIN-DELL's log lines are requested.

**Impact.**
- Routing and Builder starts do not read this flag. Verified: routes 3a/3b (09:21:28, 09:21:30) and the four smoke starts
  (09:22) were made while it flipped, and Nico and Arlo ran on DeepSeek.
- The Local models window reads it (`desktop/lib/super_tabs/local_models.dart:146-152`): while it says failed, the window
  shows the error to members too, about a computer that is not theirs, and the picker treats the Swarm's models as not
  set up, so a member's Share with Swarm is answered with the set-up note
  (`desktop/lib/models/swarm_models_target.dart:62-66`). Observed on MacBooks-MacBook-Pro-19.local (Tony, a member) at
  09:34: Manage models showed "The Swarm owner has not set up models yet." and, in red, "Could not set up: Grid could
  not be set up on this computer. Try again." (Tony's screenshots, posted by the Lead).
- WIN-DELL retried grid's install every minute (assumed, pending its log); on 0.4.73 it asks only once the Swarm shows
  failed.
- What 0.4.73 leaves (code reading, not tested): a computer that cannot run grid still cannot run it ([F5](#f5)), and if
  every owner computer that can goes away, the status keeps saying ready, since only a computer that kept it ready
  reports a failure over ready.

## Flow 3

**3a.** Route by the Lead at 09:21:28, small/low, model "deepseek 4.1 flash": pick "New agent · Claude on
deepseek/deepseek-v4.1-flash-1017 · OpenRouter (API) · Diego's Mac" with `gridModel deepseek/deepseek-v4.1-flash-1017`,
`gridName swarm-626d5615ecf5`; alternatives: the same model on the other five machines; no warnings.

**3b.** Route by the Lead at 09:21:30, small/low, no model: pick Claude sonnet medium on MacBooks-MacBook-Pro-19.local;
printed alternatives Haiku on five machines, then DeepSeek on MacbookPro.local (c7). The printed alternatives are only
the next two rows and each other machine's best row (`cli/src/superTabs/routeCommand.ts` `alternativesTo`), so DeepSeek
rows on machines whose best row was Haiku are not printed. MacbookPro.local's Claude was at 97% of its weekly limit, so
DeepSeek was likely its best row. The API model was offered (quality 1, the policy default) as the plan says. **Not
verified**: the logged decision's full candidate list was not read (Lead's ruling).

## Flow 4: Builders on the shared API model

The Lead started four Builders on `gridModel deepseek/deepseek-v4.1-flash-1017`, `gridName swarm-626d5615ecf5`, engine
Claude Code, each in its own group, with this task:

> Smoke test, no code changes, no commit, no push. In your worktree: 1) run git rev-parse --short HEAD and hostname.
> 2) In docs/plans/2026-10-23-swarm-local-models.md, count the numbered rows of the Flow table. 3) In
> cli/src/superTabs/route.ts, find the value of API_BUILDERS. 4) Create smoke-check.txt containing exactly: api model
> smoke ok — then run cat smoke-check.txt and git status --short, then delete the file. 5) Post one reply with:
> hostname, commit, row count, API_BUILDERS value, the git status line you saw, and the model your session runs on.
> Then mark done.

Expected: 8 rows, `4`, `?? smoke-check.txt`.

| Machine | Queued | Running | Done | Answers | Model evidence |
| --- | --- | --- | --- | --- | --- |
| MacBooks-MacBook-Pro-19.local (Nico) | 09:22:0x | 09:22:47 | 09:26:41 (assigned 09:25:37) | 8, 4, `?? smoke-check.txt`, commit `7754ca93c` | Transcript: 77 of 77 assistant messages `model: deepseek/deepseek-v4.1-flash-1017`, no API error |
| MACs-Mac-Studio.local (Arlo) | 09:22:23 | 09:22:45 | 09:25:57 (answers 09:23:55) | 8, 4, `?? smoke-check.txt`, commit `7754ca93c` | Builder's report; Swarm agent configuration model DeepSeek |
| Diego's Mac (Arlo) | 09:22:13 | 09:28:35 | about 09:30 | 8, 4, `?? smoke-check.txt`, commit `0df48fc38` | Builder's report |
| MacbookPro.local, first start | 09:22 | — | — | — | Failed 09:28:25; see [F3](#f3) |
| MacbookPro.local, retry | about 09:30 | 09:34:35 | about 09:35:30 (56 s of work) | 8, 4, `?? smoke-check.txt`, commit `018467761` | Builder's report: DeepSeek, high effort |
| MACs-Mac-Studio.local, after CLI 0.4.73 | 10:22:00 | 10:22:41 | soon after; stopped by the Lead | 8, 4, `?? smoke-check.txt`, commit `0d3485bad` | Builder's report: `deepseek/deepseek-v4.1-flash-1017` via OpenRouter |

On MacBooks-MacBook-Pro-19.local, which had never used grid, the daemon's log shows the whole launch on its own
(local time UTC+7):

```
16:22:21.053 [grid-runtime] ▸ installing the Harness grid runtime (0.3.59, darwin-arm64)…
16:22:37.382 [grid-runtime]   ✓ grid runtime ready → ~/.harness/runtime/grid-0.3.59-darwin-arm64
16:22:39.815 [grid-attach] signed grid in as this account ('tony-ac385524' not needed yet)
16:22:47.215 [grid] claude -> swarm-626d5615ecf5 (grid-2ca05f4371b1422e) · deepseek/deepseek-v4.1-flash-1017 · web search on
16:22:49.701 [launch] 88e44187 ready → none · register claude (new session)
```

The Lead kept the screens of all four (60 lines each); none shows an API error or a retry.

Observations, not failures of this add-on:
- Arlo on Mac Studio did the task from the group's brief before it was assigned (answers 09:23:55, assigned 09:25:36),
  then asked for an assignment to mark done.
- The Diego's Mac start took 6 min 22 s from queued to running, with fresh readings and free slots throughout; most
  likely the project's first clone on that machine (not verified).
- Two Builders in the Swarm were both named Arlo (Mac Studio, Diego's Mac).
- Nico first used its harness id as its Swarm agent id; the backend refused every call ("agent no longer in Super Tab")
  until it switched to its Swarm agent id.
- Diego's Mac's `harness.log` (pasted by Diego) repeats `[super-tabs] This agent is no longer in the Super Tab.` about
  every 6 s from 09:26:59 to 09:30:36, and logs `Could not close a session the Swarm ended (NOT_A_MEMBER).` at 09:29:41:
  its host keeps asking about an agent that has left. Its readings then stopped from about 09:31:50, when its Builder
  was stopped (229 s old at 09:35:42, 246 s at 09:35:59), and came back at 10:19:19 (11 s old), about 47 minutes later;
  cause not known.
- The retry's new worktree on MacbookPro.local already had `M CLAUDE.md` before the Builder touched it.
- The same `This agent is no longer in the Super Tab.` line is in MacBooks-MacBook-Pro-19.local's own `harness.log`
  27,772 times since 23 Oct 22:45 (UTC+7), still about every 6 s at 09:52 UTC: it predates this test.
- The WIN-DELL start ([F5](#f5)): WIN-DELL's readings stopped from 09:35:42 to 09:37:55 (140 s old at the end) while it
  readied the start, the same pause as [F4](#f4).

## Findings

### F1

**The Swarm's Local models status flips between ready and failed every minute while the owner has a computer that
cannot run grid.** See [Flow 1](#flow-1-local-models-on-and-ready). Reproduce: be the owner of a Swarm on two computers
signed in to the same account, one of which cannot set grid up (WIN-DELL here); turn Local models on; read the Swarm
state every 10 s for five minutes. Exact error: `Grid could not be set up on this computer. Try again.`
Status: fixed in CLI 0.4.73 (`bf77fd7ca`), rechecked 10:23–10:38 with no failed read.

### F2

**A route naming a model that four Builders hold does not say who holds it once one of those Builders is listed.**
The Lead's route right after the four smoke starts (09:22, model "deepseek 4.1 flash") answered:

```json
{"error":"NO_CANDIDATE","excluded":[{"title":"Builder · Claude deepseek/deepseek-v4.1-flash-1017 auto · MACs-Mac-Studio.local","reason":"Its terminal is not running."}]}
```

The plan (Flow table, row 4) says "When nothing is offered because a model is taken, the route names the Builders on
it." `choose` adds that explanation only when no probe at all runs the named model (`cli/src/superTabs/route.ts`
`if (named && !probes.length)`); a Builder already on the model is such a probe, even when it is refused. Reproduced
with `choose` itself (`npx tsx`, scratch script, held list of four Builders):

```
without member row:      {"error":"NO_CANDIDATE","excluded":[{"title":"Named model","reason":"\"deepseek/deepseek-v4.1-flash-1017 · OpenRouter\" is shared with the Swarm, but Builders Ada, Bo, Cy and Dee are on it: an API model takes 4 Builders at a time. Assign the work to one of them once it is free, or stop one to free the model."}]}
with refused member row: {"error":"NO_CANDIDATE","excluded":[{"title":"Builder · Claude deepseek/deepseek-v4.1-flash-1017 auto · MACs-Mac-Studio.local","reason":"Its terminal is not running."}]}
```

`route.spec.ts` covers the held reason only with no member probe.

### F3

**The smoke start on MacbookPro.local failed: `Cloning took too long. Check the connection and retry.`** Queued 09:22,
failed 09:28:25: the project's first clone on that machine was killed at its 300 s limit
(`cli/src/lib/projectFolder.ts` `cloneRepository`). Its `harness.log` (Ken's screenshot, local time UTC+7) shows the
machine losing the backend in bursts from 07:57 to 09:24:12 UTC, `[super-tabs] Could not reach the Harness backend ().
Check the connection and try again.`, with `An internal server error occurred` and `Swarm grid: An internal server error
occurred` at 08:15–08:16; the clone itself logs nothing. Its network is the likely cause (not verified). The DeepSeek
share on it answered Nico throughout. The retry, queued at about 09:30, cloned for about 4½ minutes and started at
09:34:35.

The empty `()` in that log line is a small fault of its own: the message puts the error's cause in parentheses
(`cli/src/gateway/accountHttp.ts:70`, `e.cause?.message ?? e.message`), and an empty cause text is not replaced, so the
reason is lost.

### F4

**While a start clones the project on the sharing machine, that machine sends no readings, so the Swarm stops offering
its shared API for up to five minutes.** The host readies a queued start (`prepareSwarmStart`, which clones) inside the
same pass that sends the machine's readings (`cli/src/superTabs/machines.ts` `poll`), and `tick` runs one pass at a time;
a clone may take 300 s before it is killed (`cli/src/lib/projectFolder.ts` `cloneRepository`). Routing offers a shared
model only from readings under 45 s old (`cli/src/superTabs/routeCommand.ts` `LOCAL_FRESH_MS`), and the backend admits
a start on the Swarm's grid only while a fresh reading serves the model (`backend/src/superTabs/machines.ts:389`).
Observed on MacbookPro.local, twice:

| Window | Readings | Start | Route naming "deepseek 4.1 flash" | Grid from MacBooks-MacBook-Pro-19.local |
| --- | --- | --- | --- | --- |
| 09:22–09:28 | about 5 min old before 09:28:25, 4 s old at 09:28:42 | first start, clone killed at 09:28:25 | 09:32 (Lead): no candidate, reading 178 s old | model listed on MacbookPro.local; Nico answered |
| 09:30–09:34 | 132 s at 09:32:05 … 249 s at 09:34:01, 16 s at 09:34:18 | retry cloning, started 09:34:35 | 09:33:47 (Lead), verbatim below, reading 237 s old | model listed at every 15 s read |

```json
{"error":"NO_CANDIDATE","excluded":[{"title":"Named model","reason":"No candidate runs \"deepseek 4.1 flash\". Share it with the Swarm (Manage models), or check its name."}]}
```

The second gap starts when the retry is queued and ends 17 s before it starts. Ken's log, posted at 09:33:09, shows no
backend error after 09:24:12; when the screenshot was taken is not known, so the network is not ruled out for the
second gap. The answer also tells the Lead to share a model that is shared. Desktop shows such a machine as Offline after 35 s.

### F5

**A Builder started on the shared API model on WIN-DELL is dispatched and then never runs, with no error anywhere a
person can see it.** The Lead started a fifth smoke Builder on DeepSeek on WIN-DELL at about 09:36 (same task as flow 4).
WIN-DELL took it: its readings paused from 09:35:42 to 09:37:55 while it readied the project, and at 09:38:12 the Swarm
showed the start dispatched. From then to at least 09:53:12 the start had no agent and no error, while WIN-DELL's readings
were fresh (1–15 s) with free slots.

Why, from the code: on the machine, a create with a grid model whose launch target cannot be had is saved and held with
"Waiting for the selected model. This request is saved and will continue when it is available."
(`cli/src/core/agents/launches.ts`, `modelHold`; the target is `modelTarget(selection)`), with no time limit. The Swarm
start then reads as pending, and the host writes the reason only to that machine's own log
(`cli/src/superTabs/machines.ts` `noteWaiting`: `Swarm start … is waiting: …`). WIN-DELL has no grid runtime
(`cli/src/lib/runtimeInstall.ts:321-323`), so the target never comes. **Not verified by log**: WIN-DELL's lines for that
start and for grid's set-up are asked of Ken.

Two further effects:
- Routing offered WIN-DELL for the shared model like every other machine (route 3a listed it), although it cannot run it.
  It still does on 0.4.73: the Lead's route at 10:22 named all six machines, WIN-DELL included.
- The Swarm has no way to cancel a dispatched start, and the held request would start a Builder if WIN-DELL ever got a
  grid. The Lead asked Ken to close any Builder that appears there.

Reproduce: contribute a Windows machine to a Swarm with a shared API model; start a Builder on that model there; read
the Swarm state for 20 minutes.

### F6

**Flow 5 (Shared with you → Offer to Swarm) is not in this build.** The Desktop hides the section and the action on
purpose: `desktop/lib/models/swarm_models_target.dart` sets `swarmSharedWithYouShown = false` ("Hidden for now (owner,
2026-10-23)"), checked by the Lead on `origin/main` too. The plan still describes both (Flow table row 2 and "Shared with
you", `docs/plans/2026-10-23-swarm-local-models.md`). Observed on MacBooks-MacBook-Pro-19.local at 09:34 (Tony's
screenshots): no Shared with you section, and a search for "0731" found only "APIs 0" and "Add API connection", while
this computer's daemon listed `DeepSeek-V4-Flash-0731` on the autonomous.ai grid (read 09:51 with `grid_models_list`).
The offer could be made below the Desktop, but people cannot, so it was not (Lead's ruling). To do: either turn the
switch back on before the release or mark the section hidden in the plan.

## Flow 8: automated coverage

Run on MacBooks-MacBook-Pro-19.local at `7754ca93c`, after `npm ci` (backend, cli) and `flutter pub get` (desktop),
Node 24.13.0, Flutter 3.47.2. All three exited 0 with no warnings or errors in their output.

| Component | Command | Result |
| --- | --- | --- |
| Backend | `cd backend && NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=… npx vitest run src/superTabs/commands.test.ts src/superTabs/machines.test.ts src/superTabs/routingPolicy.test.ts` | 3 files, 192 passed |
| CLI | `cd cli && npx vitest run src/superTabs/swarmGrids.spec.ts src/lib/swarmGrid.spec.ts src/superTabs/machines.spec.ts src/superTabs/routeCommand.spec.ts src/superTabs/route.spec.ts src/services/models.spec.ts src/lib/swarmHeal.spec.ts src/lib/swarmApiShares.spec.ts src/lib/swarmOffers.spec.ts src/lib/codingModel.spec.ts` | 10 files, 283 passed |
| Desktop | `cd desktop && flutter test --no-pub --concurrency=2 --timeout=60s test/swarm_local_models_picker_test.dart test/super_tab_machines_test.dart` | 64 passed |

The encryption key is the backend's `npm test` value from `backend/package.json`. `test:local-models` was not run: it
covers on-device local models (`lib/localModels.ts`), not this add-on.

Gaps these suites leave, each matching a finding above: no backend test calls `GET /api/super-tabs/grids` or
`store.hostGrids`, and none has two owner computers report `localModels.status` ([F1](#f1)); `route.spec.ts` has no
held model beside a refused Builder on it ([F2](#f2)); no CLI test reads a machine's readings while a start is being
prepared ([F4](#f4)); no routing or start test has a machine that cannot run grid (no `win32` case in the Super Tab
route, start or machines suites), and `machines.spec.ts` pins only that a waiting start is logged locally ([F5](#f5)).

## Rulings

| Ruling | By | Why | Cost if wrong |
| --- | --- | --- | --- |
| 3b is "not verified", with the printed-alternatives explanation | Lead | The logged decision's full candidate list could not be read | 3b is retested later |
| F2 is real: the route after the four starts was a rerun, not a fresh route | Lead | Confirmed from the attached route files | A false finding |
| Flow 5 is "not in this build (hidden by the owner on 23 Oct)" plus a plan mismatch; no offer made below the Desktop | Lead | People cannot reach it, so it is not a user flow in this release | It is tested when turned back on |
| WIN-DELL's DeepSeek start is a fail: dispatched 09:38:12, never runs, no error shown | Lead | Code reading plus 20+ minutes observed | Low: a rerun |
| Flow 6 is judged against the 2026-10-24 decision (a share keeps its address across a restart), and the plan's "Shares end when the models service restarts" is recorded as a plan mismatch | Engineer | The later decision and the code (`SwarmApiShares.restore`) agree | Flow 6 judged against the wrong rule |
