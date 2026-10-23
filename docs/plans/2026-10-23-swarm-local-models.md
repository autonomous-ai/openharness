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
| 4 | Lead | Routes as usual | Local candidates exist only while a model is served: free, quality from the policy (`localModels.quality`, default 1), one Builder per served model. A person asking for a local model overrides the floor. |
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

## Where the code is

- Backend: `superTabs/commands.ts` (`localModels.set`, `localModels.status`), `machines.ts` (admission, `swarmGridRow`,
  `hostLocalGrid`), `routingPolicy.ts` (`localModels` policy), `GET /api/super-tabs/grids`.
- CLI: `superTabs/swarmGrids.ts` + `lib/swarmGrid.ts` (owner's computer keeps the grid), `superTabs/machines.ts`
  (`servedOn`), `superTabs/routeCommand.ts` (`localProbes`), `superTabs/route.ts` (`local`, `LOCAL_NONE`),
  `services/models.ts` (`grid_swarm_sync`, Swarm-grid start/stop, `swarmLaunchTarget`), Lead skill line in `lib/swarmSkills.ts`.
- Desktop: `super_tabs/local_models.dart`, wired in `super_tabs/machines.dart`.

## Local models window (owner, 2026-10-23)

The ⌘I Models picker made for the Swarm (`SwarmModelsTarget` on `SwarmSearchController`), without Subscriptions:

- **Your models:** Run for Swarm / Stop for Swarm (start or stop on the Swarm's grid); Get first when not downloaded.
- **APIs:** a saved API's model can be shared with the Swarm. This computer runs a local endpoint (127.0.0.1, secret
  path) that adds the key and forwards completions to the API; grid joins it with `--at`. Every Builder in the Swarm then
  spends the sharer's key and credits, which the preview says. Shares end when the models service restarts (it takes
  stale ones off the grid at start).
- **Shared with you:** models other people share with you are usable by agents on *your* machines only (your machine's
  grid sign-in reaches them). The backend admits such a start only on a machine whose fresh reading lists the model.
- A click only selects a row; the preview's button (or Return) acts.
