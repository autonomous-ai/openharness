# Swarm local models

**Goal.** A Swarm's members can serve local models from their machines, and the Lead (Product Manager) can start
Builders on them when that fits the work. It is an add-on: nothing calls grid until the Swarm's owner turns it on.

## Flow

| # | Who | Does | Behind it |
|---|---|---|---|
| 0 | Anyone | Creates a Swarm | No grid. Routing uses subscriptions only. |
| 1 | Owner | Machines heading → Local models (chip icon) → Use local models | Backend mints `state.localModels.grid` (`swarm-<12 hex>`). The owner's host creates the grid (`grid --remote start`, `permissioned-public`), keeps its members in step with the Swarm's people (`grid members add|remove`, role `both`), and reports `localModels.status`. |
| 2 | A member | Local models window (⌘I's Models: APIs, Your models, Get for this Mac, Shared with you) → a model → Run for Swarm, or an API's model → Share with Swarm | That machine's daemon signs in to grid (Harness sign-in handed to `grid login --harness`), serves the model on the Swarm's grid, and lists it in its machine readings (`observation.localModels`). |
| 3 | Everyone | Sees it in the machine's details and the Local models dialog ("Qwen 3 on Studio") | Served models come from fresh readings only (45 s). |
| 4 | Lead | Routes as usual | Local candidates exist only while a model is served: free, quality from the policy (`localModels.quality`, default 1), one Builder per local engine and up to four per shared API model (2026-10-24). A person asking for a local model overrides the floor. When nothing is offered because a model is taken, the route names the Builders on it. |
| 5 | Lead | Starts the Builder | Any Swarm machine with a slot runs Claude Code or Codex on the model through the grid relay. The backend admits `gridModel`/`gridName` on a contributed machine only for the Swarm's grid while a fresh reading serves the model. |
| 6 | Member | Stops the model | It leaves the readings; routing stops offering it. |
| 7 | Owner | Turns Local models off | No new local starts. The grid is kept. |

## Decisions (owner, 2026-10-23)

- Off by default; grid is called only on turn-on, on starting or stopping a model, and on a Builder launch on one.
- Only the owner (the grid's admin) manages its members; a newcomer gets access when the owner's computer is next online.
- No Harness limit on grids. Members are added as `both`.
- Local models count as quality 1 unless the owner raises it; a person's explicit request overrides.
- Turning it off keeps the grid.
- Not limited to the machine serving the model: a Builder on another machine reaches it through the grid relay.
- (2026-10-24) A local model must be able to drive a coding agent: 7B parameters or more and, when measured, 10 tok/s or
  more (`lib/codingModel.ts`, mirrored in `desktop/lib/models/coding_model.dart`). A smaller one gets no Run or Get for
  the Swarm; one already served is reported as `refusedModels` with why, never offered, and a Lead asked for it is told
  why. A llama3.2:3b Builder made over a thousand requests for a one-line edit.
- (2026-10-24) A Builder whose engine keeps retrying its model for ten minutes alerts its Lead (`agent.alert` `model`).
- (2026-10-24) A machine keeps what it serves on the grid: shares keep their address across restarts, and
  `lib/swarmHeal.ts` joins again what the grid stopped listing.
- Known limit (grid): a local model answers a Claude Code turn only after reading its whole prompt (~45K tokens, over
  three minutes for Qwen3.6 35B on an M-series Mac); the relay ends the transaction first and every retry starts again.
  It still finished a one-line edit in 14 minutes. Needs a relay keepalive and prompt-cache reuse in grid.

## Where the code is

- Backend: `superTabs/commands.ts` (`localModels.set`, `localModels.status`), `machines.ts` (admission, `swarmGridRow`,
  `hostLocalGrid`), `routingPolicy.ts` (`localModels` policy), `GET /api/super-tabs/grids`.
- CLI: `superTabs/swarmGrids.ts` + `lib/swarmGrid.ts` (owner's computer keeps the grid), `superTabs/machines.ts`
  (`servedOn`, `refusedOn`, the `grid_swarm_heal` reading), `superTabs/routeCommand.ts` (`localProbes`, `heldLocalModels`), `superTabs/route.ts` (`local`, `LOCAL_NONE`),
  `services/models.ts` (`grid_swarm_sync`, Swarm-grid start/stop, `swarmLaunchTarget`), Lead skill line in `lib/swarmSkills.ts`.
- Desktop: `super_tabs/local_models.dart`, wired in `super_tabs/machines.dart`.

## Local models window (owner, 2026-10-23)

The ⌘I Models picker made for the Swarm (`SwarmModelsTarget` on `SwarmSearchController`), without Subscriptions:

- **Your models:** Run for Swarm / Stop for Swarm (start or stop on the Swarm's grid); Get first when not downloaded.
- **APIs:** a saved API's model can be shared with the Swarm. This computer runs a local endpoint (127.0.0.1, secret
  path) that adds the key and forwards completions to the API; grid joins it with `--at`. Every Builder in the Swarm then
  spends the sharer's key and credits, which the preview says. Shares end when the models service restarts (it takes
  stale ones off the grid at start).
- **Shared with you:** a model other people share with you is offered to the Swarm only when you choose Offer to Swarm
  (owner, 2026-10-23); this computer keeps the list (`swarm-offers.json`) and reports only offered ones. Agents on *your*
  machines alone may use it (your machine's grid sign-in reaches it): the backend admits such a start only on a machine
  whose fresh reading lists the model.
- A shared API is never counted as a running local model, so your models can run for the Swarm beside shared APIs.
- A click only selects a row; the preview's button (or Return) acts.

## Grid models first for simple work (2026-10-27)

Roadmap (Dec): about 30% of work runs on cheaper models without lower quality.

- **Routing** (`cli/src/superTabs/route.ts` `softOf`, `compare`): a task of low difficulty and low risk that is not a
  review ranks a model served on the Swarm's grid above every subscription candidate. Only the owner's preferred engine
  comes before it, since those are the owner's own words, and a grid model runs on Claude Code or Codex anyway. Hard
  rules and the policy floor apply first, as before. Without this, a grid model (cost 1, like Haiku) lost to an
  account whose 5-hour window was about to reset (effective cost 0) and to idle members under `preferIdle`.
- **Opt-out:** the owner's soft rule `noGridFirst` (backend `rules.ts`). It only ranks and never refuses a start.
  To stop using grid models entirely, the owner still has the policy's `localModels.enabled`.
- **Recording** (backend `leaderboard/record.ts`): every `work.assign` appends a run to its group's ledger: the
  assignment, the engine, the model (the grid model named by the agent's start, else the model its engine reports)
  and the time. The first verdict on an independent check during that attempt is its `firstReview`.
- **Report:** the leaderboard read returns `models` for this week and last week: the attempts at requests, how many
  ran on the grid, and how many of each kind passed their first review.

### Design

- **Growth:** at most 20 runs per group (`MAX_RUNS`, the oldest are dropped), about 150 bytes each. The runs live and
  go with their group's ledger. Reviews and private conversations are never counted.
- **Concurrency:** written inside the command that assigns or checks, under the group part's existing lock. There is
  no new lock.
- **Read cost:** the leaderboard already reads the project's groups. Counting their runs adds no read.
- **Scale:** at 10x (about 3,000 attempts a week) it is still one pass over at most 20 runs per group. The group part
  size (4 MB limit) would warn first, and 20 runs use under 0.1% of it.
- **Compatibility:** `models` is a new field in the leaderboard response, and Desktop's parser ignores fields it does
  not know. A CLI from before this change does not know `noGridFirst` and ranks as before. A backend from before it
  refuses the rule as invalid.
- **Migration + rollback:** none. Old groups have no `runs` and count as zero. A rollback leaves `runs` in ledgers,
  where the old code never reads them.
- **Audience:** the ledger is never sent to clients (`read/views.ts` strips it). The leaderboard read keeps its
  per-project access check.
- **Identity:** N/A because no work runs as anyone. Only the agent's own configuration and start are read.
- **Failure:** a start the backend no longer holds is recorded with the model its engine reports, never dropped.
- **Platforms:** backend and CLI only. Desktop shows nothing new yet.
