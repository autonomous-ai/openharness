import { modelsAssignments } from './modelsAssignments.js'
/**
 * Models: grid, how Harness runs local AI models with Codex, Claude Code and the other engines
 * (docs/design/2026-10-03-harnessd.md, "Models"). Grid access on first use, the managed grid's pin, the
 * model pictures an agent's frame carries, starting a sleeping grid while someone types to its agent,
 * where an agent on a grid model sends its inference, and what the apps ask about models: the picker's
 * list, an agent's Model/Effort choices, the Model Manager's local models and its grid commands.
 *
 * A service on the core boundary: it reads the core only through `CoreApi`, the core reaches it only
 * through `ports.models`, and the apps through the requests it answers. It runs in a process of its own
 * (services/modelsProcess.ts, docs/design/2026-10-06-core-boundary-next.md step 7): its downloads, its
 * installs and the `grid` children it runs cost that process, never the core's.
 */
import { join } from 'node:path'
import { baseNode } from '../harnessd/baseNode.js'
import type { CoreApi, CorePorts, ModelsPort, ServiceRequest, ServiceRequests } from '../core/api.js'
import { MODEL_MANAGER_ID } from '../dsh/builtinIds.js'
import { installedDsh } from '../dsh/installed.js'
import { ApiConnections, apiConnectionsRequest } from '../lib/apiConnections.js'
import { apiModelsRequest, apiTargetAnswer, refreshApiFor, rememberSavedApis } from '../lib/apiModels.js'
import { appEngineOps, scanAppModels } from '../lib/appModels.js'
import { linkCodexProfile, listCodexProfiles } from '../lib/codexProfiles.js'
import { createGridAccess, gridNamesLocal, reconcileGridAttach } from '../lib/gridAttach.js'
import { deriveHarnessGridName, resetGridDeriveMemo, signedInGridEmail } from '../lib/gridDerive.js'
import { ensureHarnessGrid } from '../lib/gridEnsure.js'
import { gridAvailable, gridExec, managedGridPath } from '../lib/gridExec.js'
import { GridFleetRpc, parseGridFleetRequest } from '../lib/gridFleetRpc.js'
import { handOffToGrid } from '../lib/gridHandoff.js'
import { ensureGridInstalled } from '../lib/gridInstall.js'
import { answerGridLaunch, type GridLaunchOverride } from '../lib/gridLaunch.js'
import { clearGridMcpUrlCache } from '../lib/gridMcpUrl.js'
import {
  forgetGridModels, gridAnnotation, gridInventory, gridServingNodes, keystrokePrewarm, listAllGridModels, listGridModels, observeMachineList, onGridModelsChanged,
  retargetPrewarm, warmGridModels, type GridSection,
} from '../lib/gridModels.js'
import { gridModelsPayload } from '../lib/gridModelsPayload.js'
import { resolveGridTarget } from '../lib/gridTarget.js'
import { LocalModels } from '../lib/localModels.js'
import { nvidiaComputeApps } from '../lib/gpuProcesses.js'
import type { NewAgentModel } from '../lib/newAgentModel.js'
import type { RuntimeModelOption } from '../lib/runtimeProfile.js'
import { parseRuntimeProfile } from '../lib/runtimeProfileWire.js'
import { ensureManagedGrid, startGridPinRecheck } from '../lib/runtimeInstall.js'
import { syncSwarmGrid } from '../lib/swarmGrid.js'
import { SwarmApiShares } from '../lib/swarmApiShares.js'
import { liveModels, SwarmHeal } from '../lib/swarmHeal.js'
import { SwarmOffers } from '../lib/swarmOffers.js'
import { internalOnThrow } from './requestErrors.js'

/** The requests models answers for the apps, declared in core/api.ts for the core to route. */
export { MODELS_REQUESTS } from '../core/api.js'

/** What grid's set-up for an act needs of models: have grid ready, and whether it is set up at all. */
interface GridSetUp {
  ensure: ModelsPort['ensure']
  /** Offline, for every list read: is there a `grid` here holding a sign-in? What decides whether the
   *  picker offers local and shared models or a Set up row. */
  setUp(): boolean
}

export function startModels(core: CoreApi, ports: CorePorts): ServiceRequests {
  // A managed grid already here follows its pin on EVERY start of this service — the daemon's, and the
  // restart a self-update ends in — not only on `--repair`: the pin is expected to move, and a machine
  // installed last month has to notice. A machine with none gets none from a start: grid is an add-on,
  // installed the first time a grid feature is used (`ensure`, below). Not awaited, and asynchronous
  // throughout (`runtimeInstall.ts`): every grid call resolves the binary afresh (`gridBinaryPath`), so
  // whatever lands is picked up as it lands. It keeps following it while this runs: a pin moved after
  // the start reaches it within ten minutes rather than at the next restart (`startGridPinRecheck`).
  const followGridPin = (): Promise<unknown> => managedGridPath()
    ? ensureManagedGrid((m) => console.log(`[grid-runtime] ${m}`))
    : Promise.resolve(null)
  void followGridPin()
  startGridPinRecheck({ ensure: followGridPin })

  // Grid is an add-on (`lib/gridAttach.ts`): nothing on this path installs `grid`, signs this machine in
  // to it or creates a grid. The first grid feature a person uses — the models picker's Set up, a local
  // model's Get or Use, an agent moved onto a grid model, the Model Manager — asks `ports.models.ensure`,
  // which does it then, with this machine's harness token (no second browser) and, only for what needs
  // one, the account's own grid. It used to run here on every start and every reconnect.
  const gridLog = (line: string): void => console.log(`[grid-attach] ${line}`)
  const gridAccess = createGridAccess({
    signedIn: () => signedInGridEmail() !== null,
    log: gridLog,
    attempt: ({ ownGrid, signedInThisRun }) => reconcileGridAttach({
      // The pinned managed runtime first; grid's own installer when there is none to follow.
      installCli: async () => {
        await ensureManagedGrid((m) => console.log(`[grid-runtime] ${m}`))
        if (gridAvailable()) return
        const installed = await ensureGridInstalled()
        if (installed.status !== 'present') gridLog(installed.message)
      },
      gridAvailable: () => gridAvailable(),
      // The backend mints and remembers the name, through the core, which holds the sign-in.
      mintName: () => core.account.mintGridName(),
      accessToken: () => core.account.accessToken(),
      signedInEmail: () => signedInGridEmail(),
      gridNames: () => gridNamesLocal(),
      handoff: (token) => handOffToGrid(token, { json: true }),
      ensure: (name) => ensureHarnessGrid(name),
      onName: (name) => {
        // Answer the picker with this account's grid at once, and drop the memos a stale or absent
        // sign-in may have filled — the model list, the derived name, and the web-tools URL.
        core.clients.gridNamed(name)
        forgetGridModels()
        resetGridDeriveMemo()
        clearGridMcpUrlCache()
      },
      log: gridLog,
    }, { ownGrid, signedInThisRun }),
  })
  const grid: GridSetUp = {
    ensure: (request) => gridAccess.ensure(request),
    setUp: () => gridAvailable() && signedInGridEmail() !== null,
  }

  /**
   * The account's private grid: the backend's word when it gave one, else what this machine can work out
   * for itself (`lib/gridDerive.ts`). A backend that predates `machine_meta.gridName` left every picker
   * empty while `grid models` listed the model fine; the derivation is the skill's own rule, so the
   * daemon and the agent it opens agree on which grid is "yours".
   */
  const privateGridName = async (): Promise<string | null> => (await core.account.privateGridName()) ?? await deriveHarnessGridName()

  // An agent's frame says what its grid's picture says (`grid.state`, and a `grid.note` when its model
  // will not answer). The picture changes on reads nobody waited for, so the frames of the agents whose
  // annotation moved are pushed again — only those, and only when it moved — and the windows are pushed
  // the list. In a process of its own the core reads the notes from what it is told
  // (services/modelsProcess.ts) and the core API there has no agents to push: the core does that itself.
  const announcedGrid = new Map<string, string>()
  onGridModelsChanged(() => {
    core.clients.gridModelsChanged()
    const onGrid = core.agents.advertised().filter((s) => s.grid)
    const present = new Set(onGrid.map((s) => s.agentId))
    for (const agentId of [...announcedGrid.keys()]) if (!present.has(agentId)) announcedGrid.delete(agentId)
    for (const s of onGrid) {
      const said = JSON.stringify(gridAnnotation(s.grid))
      if (announcedGrid.get(s.agentId) === said) continue
      announcedGrid.set(s.agentId, said)
      core.agents.sync(s)
    }
  })
  // The pictures saved before this start, back in memory with nothing read from any grid: an agent's
  // frame carries its grid's state and note, and a keystroke can start its grid, before any window asks
  // for the list (after a self-update, a phone may be the only one typing).
  void warmGridModels().catch(() => {})

  // The saved APIs, a file in the data folder (lib/apiConnections.ts), read afresh by every launch on one.
  const savedApis = new ApiConnections(core.dataDir)
  rememberSavedApis(savedApis)
  ports.models = {
    ensure: grid.ensure,
    annotation: (target) => gridAnnotation(target),
    // The keystroke prewarm (grid-reads-without-waking issue 03): typing into a pane whose agent runs on
    // a sleeping grid starts that grid while the person types.
    prewarm: (target) => { void keystrokePrewarm(target).catch(() => {}) },
    launchTarget: (selection) => SWARM_GRID.test(selection.grid) ? swarmLaunchTarget(grid, selection) : launchTarget(selection),
    moveTarget: (request) => moveTarget(grid, privateGridName, core, request),
    // The agent is on a grid model now and its pane is restarting: start that grid meanwhile if it sleeps,
    // so the first message rarely waits on a boot (issue 03). It decides for itself whether a wake is
    // worth it.
    moved: (launch) => { void retargetPrewarm(launch).catch(() => {}) },
    // The launch that points an engine at a grid or a saved API, built here for the core, which builds none
    // (docs/design/2026-10-08-launch-port.md): a relaunch's saved API with its endpoint and key as saved now.
    gridAssignments: modelsAssignments(savedApis),
    gridLaunch: async (request) => answerGridLaunch(request, refreshApiFor(savedApis)),
    apiTarget: (request) => apiTargetAnswer(savedApis, request.connectionId, request.model),
    privateGridName,
    // `grid_models_changed` to the windows: the same payload `grid_models_list` answers, built from the
    // pictures as they stand — no read is started to build it, so a push never causes one. Each window
    // gets it in the form it asked for (`gridModelsPayload`).
    lists: async () => {
      const gridName = await privateGridName()
      const grids = await listAllGridModels(gridName, { refresh: false })
      return { plain: gridModelsPayload(gridName, grids, false), rowState: gridModelsPayload(gridName, grids, true) }
    },
    // Which of the owner's other computers have been reading offline — a label on the models only they
    // serve on a sleeping grid, never a removal (grid-reads-without-waking issue 03).
    machines: (body, computerId) => observeMachineList(body, computerId),
    // The web-tools cache lives exactly as long as the sign-in.
    signedOut: () => clearGridMcpUrlCache(),
  }
  return modelsRequests(core, grid, privateGridName)
}

/**
 * Where a new agent on a grid model sends its inference, resolved on this machine. Refreshed at launch: a
 * model stopped after the picker opened must not silently fall back to a subscription or to the grid's
 * default router. Only the semantic choice goes into the creation receipt, never this rotating key.
 */
export async function launchTarget(selection: NewAgentModel): Promise<GridLaunchOverride | null> {
  forgetGridModels()
  const models = await listGridModels(selection.grid)
  if (!models.some((model) => model.id === selection.model)) return null
  return resolveGridTarget(selection.grid, selection.model)
}

/**
 * A Builder on a model served on a Swarm's grid (docs/plans/2026-10-23-swarm-local-models.md) may start on a machine that
 * never used grid: it signs in first (the Harness sign-in handed to `grid login --harness`), then pulls the account's grids,
 * since the Swarm's grid is new to this machine until a sync lists it.
 */
export async function swarmLaunchTarget(grid: GridSetUp, selection: NewAgentModel, sync: () => Promise<unknown> = () => gridExec(['--remote', 'sync'])): Promise<GridLaunchOverride | null> {
  if (await notReady(grid, false)) return null
  await sync()
  return launchTarget(selection)
}

/**
 * Grid set up for an act, or the sentence saying why it could not be: null when it is ready. The
 * picker's Set up, a Get, a Use and a move onto a grid model each ask it.
 */
async function notReady(grid: GridSetUp, ownGrid: boolean): Promise<string | null> {
  const ready = await grid.ensure({ ownGrid })
  if (ready.status !== 'converged' && ready.status !== 'signed-in') {
    return ready.detail || 'Grid could not be set up on this computer. Try again.'
  }
  if (ownGrid && ready.ownGrid && !['created', 'existed', 'adopted'].includes(ready.ownGrid)) {
    return ready.detail || 'Your grid could not be created. Try again.'
  }
  return null
}

/**
 * Where a running agent moved onto a grid model sends its inference (`agent_retarget`). The app names
 * the model, and the grid it was picked from when the picker says (a shared grid's section), the
 * account's own otherwise; the endpoint and the credential are resolved here, from this machine's own
 * signed-in `grid`, so neither ever crosses the relay. A move onto a grid model is a grid feature in
 * use: grid is signed in first, if it is not yet — and the account's own grid made sure of when that is
 * where the model is.
 */
async function moveTarget(
  grid: GridSetUp, privateGridName: () => Promise<string | null>, core: CoreApi, request: { gridName: string | null; model: string },
): Promise<{ target: GridLaunchOverride } | { detail: string }> {
  const named = request.gridName
  const unready = await notReady(grid, !named || named === await core.account.privateGridName())
  if (unready) return { detail: unready }
  const target = await resolveGridTarget(named ?? await privateGridName(), request.model)
  return target ? { target } : { detail: 'Could not read this machine\'s grid endpoint.' }
}

/** Sections one `grid_models_list` may ask to wake — a person presses one "Show models" at a time. */
const MAX_WAKES_PER_ASK = 8

/** The APIs this computer shares with Swarms: one set for the process, since each holds a live endpoint. */
function swarmApiShares(dataDir: string): SwarmApiShares {
  const saved = new ApiConnections(dataDir)
  const shares = new SwarmApiShares({ access: (id) => saved.modelAccess(id), exec: (args) => gridExec(args), stateFile: join(dataDir, 'swarm-api-shares.json') })
  void shares.restore().catch(() => {})
  return shares
}

/** A Swarm's grid name as the backend mints it (backend/src/superTabs/commands.ts `swarmGridName`). */
const SWARM_GRID = /^swarm-[0-9a-f]{12}$/

type LocalModelRequest = 'grid_fleet_models_list' | 'grid_fleet_model_download' | 'grid_fleet_model_start' | 'grid_fleet_model_stop'

/**
 * What the apps ask about models, on grid as this service holds it. Each request waits on grid, the
 * network or a model's process; the host replies when it is done and never holds the asking connection's
 * next request behind it (core/serviceHost.ts `route`), which is why the socket ran them detached when it
 * answered them itself. A failure is answered as the socket answered it, sentences included: the apps
 * show them.
 */
function modelsRequests(core: CoreApi, grid: GridSetUp, privateGridName: () => Promise<string | null>): ServiceRequests {
  // The Model Manager reads the grid it runs on through the same credential-less reader as every picker
  // (never `grid engines`, which carries the grid credential and so wakes a sleeping grid on every tick),
  // and a start or stop it finishes makes every list read again — pushed to the window when it changes.
  const localModels = new LocalModels({
    stateDir: join(core.dataDir, 'local-models'),
    machineName: () => core.account.machineName(),
    inventory: gridInventory,
    servingNodes: gridServingNodes,
    onChanged: () => { forgetGridModels(); core.clients.gridModelsChanged() },
    // Models Ollama, LM Studio and llama.cpp downloaded here, found by the Model Manager's own scan (the
    // bundled harness), so the picker and that harness agree on what is here and what starts it.
    appModels: () => scanAppModels({ node: baseNode(process.execPath), packageDir: installedDsh(MODEL_MANAGER_ID)?.realDir ?? null, env: process.env }),
    appEngines: appEngineOps(process.env),
    gpuProcesses: nvidiaComputeApps,
  })
  // One set of shared APIs for the process, and the check that keeps them and the local models on each Swarm's grid
  // (lib/swarmHeal.ts).
  const shares = swarmApiShares(core.dataDir)
  const heal = new SwarmHeal({
    live: async (name) => {
      const answer = await gridExec(['--remote', 'models', name, '--json'])
      return answer.code === 'OK' ? liveModels(answer.stdout) : null
    },
    shares: { list: (name) => shares.list(name), rejoin: (name, connectionId, model) => shares.rejoin(name, connectionId, model) },
    apps: { served: (name) => localModels.servedApps(name), rejoin: (name) => localModels.rejoinApp(name) },
  })
  /** The grid listing currently out, shared by every `grid_models_list` for the same own grid that lands
   *  meanwhile. */
  let listing: { gridName: string | null; grids: Promise<GridSection[]> } | null = null

  // A daemon-owned operation survives panel closure and a lost reply. Its hardware, catalog and network
  // reads stay off the connection's ordered queue: the host answers when they are done.
  //
  // Grid is set up here only for an ACT: the picker's Set up (a list read carrying `setup`), a Get, a
  // Use. The list read the app polls while a picker is open never sets anything up — it says whether it
  // is needed (`gridSetupNeeded`). A Get needs a sign-in (the catalog is grid's); a Use serves on the
  // account's own grid, and so does the Set up that offers it.
  const localModel = (type: LocalModelRequest): ServiceRequest => async (payload) => {
    try {
      const list = type === 'grid_fleet_models_list'
      const setup = list ? payload.setup === true : type !== 'grid_fleet_model_stop'
      const unready = setup ? await notReady(grid, type !== 'grid_fleet_model_download') : null
      const gridName = await privateGridName()
      if (list) {
        const snapshot = await localModels.list(gridName, payload.refresh === true || setup)
        const needed = !grid.setUp()
        if (setup && !unready) core.clients.gridModelsChanged()
        return { ...snapshot, ...(needed ? { gridSetupNeeded: true } : {}), ...(unready ? { gridSetupError: unready } : {}) }
      }
      if (unready) return { error: unready }
      // A start or stop for the community grid of this computer's OS (`osGrid`): run there, for its members. Or for a
      // Swarm's own grid (docs/plans/2026-10-23-swarm-local-models.md), named by the Swarm and checked by grid itself:
      // only its members may serve there.
      const community = payload.community === true && type !== 'grid_fleet_model_download'
      const swarm = type !== 'grid_fleet_model_download' && typeof payload.grid === 'string' && SWARM_GRID.test(payload.grid) ? payload.grid : null
      const target = swarm ?? (community ? await localModels.communityGrid() : gridName)
      if (community && !target) return { error: 'This computer is in no community grid.' }
      return { ...await localModels.act(target, payload.modelId, type === 'grid_fleet_model_download' ? 'download' : type === 'grid_fleet_model_start' ? 'start' : 'stop') }
    } catch {
      return { error: 'Models are unavailable. Try again.' }
    }
  }

  return {
    grid_models_list: async (payload) => {
      // Every grid this computer is signed into, in sections, the account's own first. `gridName`
      // and `models` keep naming the own grid alone, for an app that predates `grids`.
      //
      // Never held in line: it waits on a grid reconcile (up to 6s), then a `grid ls` spawn and — for a
      // grid this daemon has never read — up to 4s of its first read (`gridModels.ts`); every other grid
      // answers from its picture. The desktop asks for it in the same breath as `terminal_capabilities`
      // and `agents_list` on every connect, and awaited in line it held both behind it — with no
      // network, past the app's 10s request timeout, on which the app forces a reconnect and asks all
      // three again. Measured 2026-09-18, wifi off, daemon restarted: every local RPC timed out for as
      // long as the backend stayed unreachable; the terminal on the SAME computer sat on "offline" until
      // the wifi came back. Request ids make the reply safe to land out of order.
      //
      // One computation at a time: a second ask that lands while the first is still out (the app re-asks
      // on every connect) would spawn another `grid ls` for the same answer. Later askers share the one
      // in flight; each grid's reads are single-flight in `gridModels.ts`.
      //
      // `rowState: true` — a window that draws row state gets offline labels as `unavailable` (and the
      // socket pushes it the list's changes in that form); `wake: [name]` — a person pressed "Show
      // models" / "Wake now", and the answer (with those sections "waking") comes back at once while the
      // wake runs behind it (grid-reads-without-waking issue 03). A wake never joins a listing already
      // out: that one was built before the wake began, and would not say "waking".
      const rowState = payload.rowState === true
      const wake = Array.isArray(payload.wake)
        ? payload.wake.filter((name): name is string => typeof name === 'string' && !!name.trim()).map((name) => name.trim()).slice(0, MAX_WAKES_PER_ASK)
        : []
      try {
        const gridName = await privateGridName()
        const inFlight = listing
        const grids = wake.length
          ? listAllGridModels(gridName, { wake })
          : inFlight && inFlight.gridName === gridName
            ? inFlight.grids
            : (listing = {
                gridName,
                grids: listAllGridModels(gridName).finally(() => {
                  if (listing?.gridName === gridName) listing = null
                }),
              }).grids
        return gridModelsPayload(gridName, await grids, rowState)
      } catch {
        return { error: 'GRID_MODELS_FAILED' }
      }
    },

    // Runtime Model/Effort: the choices an agent's engine offers, or every live agent's.
    models_list: async (payload) => {
      const sessionId = typeof payload.agentId === 'string' && payload.agentId ? payload.agentId : undefined
      try {
        const models = await core.agents.runtimeModels(sessionId)
        return {
          // The device derives labels from the opaque runtime-v1 id. Omitting the duplicate
          // displayName keeps the encrypted picker response below its 16 KiB decrypt cap.
          models: payload.compact === true
            ? compactRuntimePickerModels(models, sessionId, payload.pickerMode, payload.selectedModel)
            : models,
        }
      } catch (error) {
        // Logged and answered as the socket did while this was a case of its own.
        console.error('[backend] dispatch models_list failed:', error)
        return { error: 'INTERNAL' }
      }
    },

    grid_fleet_models_list: localModel('grid_fleet_models_list'),
    grid_fleet_model_download: localModel('grid_fleet_model_download'),
    grid_fleet_model_start: localModel('grid_fleet_model_start'),
    grid_fleet_model_stop: localModel('grid_fleet_model_stop'),
    // What this computer serves on a Swarm's grid that the grid really lists, joined again when it lost them: read by
    // every machine reading (superTabs/machines.ts).
    grid_swarm_heal: async (payload) => {
      if (typeof payload.grid !== 'string' || !SWARM_GRID.test(payload.grid)) return { error: 'INVALID_REQUEST' }
      return { ...await heal.check(payload.grid) }
    },
    ...gridCommands(grid, core.dataDir, shares),
    ...launchTargetRequests(core),
  }
}

/**
 * The Model Manager's grid commands: grid's own argv, run here (`lib/gridFleetRpc.ts`). A command is a job
 * of the connection that started it, keyed by that connection and the id it was asked under (`Asker`),
 * and a cancel stops only that connection's own. Run against grid AS IT STANDS — never set up first: a
 * Grid harness session issues these on its own the moment its viewer comes up (every open one, on every
 * daemon start), so setting grid up here signed a machine in to grid right after a Harness-only sign-in,
 * with nobody asking. Grid is set up by the picker's Set up, by making or opening a Model Manager, and by
 * that harness's own `harness grid setup`; until then grid answers these in its own words. Their
 * handshake, `grid_fleet_capabilities`, is the socket's (core/api.ts `MODELS_REQUESTS`).
 */
function gridCommands(grid: GridSetUp, dataDir: string, shares: SwarmApiShares = swarmApiShares(dataDir),
  offers: SwarmOffers = new SwarmOffers(join(dataDir, 'swarm-offers.json'))): ServiceRequests {
  const fleet = new GridFleetRpc()
  return {
    // Pulls and builds can take minutes; the host answers when it is done and holds nothing else for it.
    grid_fleet_run: async (payload, asker) => {
      const request = parseGridFleetRequest(payload)
      if (!request || !asker.connection || !asker.requestId) return { error: 'INVALID_GRID_COMMAND' }
      try {
        return { ...await fleet.run(asker.connection, asker.requestId, request) }
      } catch {
        return { ok: false, code: 1, error: 'Grid command failed unexpectedly.' }
      }
    },
    // A Swarm's own grid, created and kept in step with its people by the owner's computer (lib/swarmGrid.ts).
    grid_swarm_sync: async (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      const members = Array.isArray(payload.members) ? payload.members.filter((m): m is string => typeof m === 'string' && /^[^\s@]+@[^\s@]+$/.test(m)) : null
      if (typeof payload.grid !== 'string' || !SWARM_GRID.test(payload.grid) || !members || members.length > 200) return { error: 'INVALID_REQUEST' }
      // Signed in first: the owner may never have used grid on this computer before turning the add-on on.
      const unready = await notReady(grid, false)
      if (unready) return { ready: false, error: unready, added: [], removed: [] }
      return { ...await syncSwarmGrid(payload.grid, members) }
    },
    // A saved API shared with a Swarm's grid, on this computer's key (lib/swarmApiShares.ts). This computer's own person
    // alone: the key is theirs, and so are the credits every Builder in the Swarm then spends.
    grid_swarm_api_share: async (payload, asker) => {
      if (!asker.local || !asker.owner) return { error: 'OWNER_REQUIRED' }
      const { grid: name, connectionId, model, action } = payload
      if (typeof name !== 'string' || !SWARM_GRID.test(name) || typeof connectionId !== 'string' || typeof model !== 'string'
        || !model || model.length > 200 || (action !== 'start' && action !== 'stop')) return { error: 'INVALID_REQUEST' }
      if (action === 'stop') return { ...await shares.stop(name, connectionId, model) }
      const unready = await notReady(grid, false)
      if (unready) return { error: unready }
      return { ...await shares.share(name, connectionId, model) }
    },
    grid_swarm_api_shares: (payload) => ({
      shares: shares.list(typeof payload.grid === 'string' ? payload.grid : undefined),
    }),
    // A model shared with this computer's person, offered to a Swarm or no longer (lib/swarmOffers.ts). Their choice
    // alone: Builders the Swarm starts here then run on someone else's model through their access.
    grid_swarm_offer: (payload, asker) => {
      if (!asker.local || !asker.owner) return { error: 'OWNER_REQUIRED' }
      const { grid: name, sharedGrid, model, action } = payload
      const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200
      if (typeof name !== 'string' || !SWARM_GRID.test(name) || !text(sharedGrid) || !text(model) || (action !== 'start' && action !== 'stop')) {
        return { error: 'INVALID_REQUEST' }
      }
      try {
        return { offers: offers.set({ grid: name, sharedGrid: sharedGrid as string, model: model as string }, action === 'start') }
      } catch {
        return { error: 'The offer could not be saved on this computer.' }
      }
    },
    grid_swarm_offers: (payload) => ({
      offers: offers.list(typeof payload.grid === 'string' ? payload.grid : undefined),
    }),
    grid_fleet_cancel: (payload, asker) => ({
      cancelled: !!asker.connection && typeof payload.commandId === 'string' && fleet.cancel(asker.connection, payload.commandId),
    }),
  }
}

/**
 * What an agent can be launched on besides a model: the saved APIs and the Codex profiles, moved out of the
 * socket's switch (docs/design/2026-10-06-core-boundary-next.md, step 4). Its own function so the socket's
 * specs can serve it alone behind the gates.
 */
export function launchTargetRequests(core: CoreApi): ServiceRequests {
  // The saved APIs, a file in the data folder (lib/apiConnections.ts): read afresh on every request.
  const apiConnections = new ApiConnections(core.dataDir)
  return {
    // The APIs saved on this machine (lib/apiConnections.ts): list, save and remove one, and one API's
    // models. Their keys stay here, so only the owner manages them: this machine's app, or its paired one.
    api_connections: internalOnThrow('api_connections', (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      if (payload.action === 'models') return apiModelsRequest(apiConnections, payload)
      const reply = apiConnectionsRequest(apiConnections, payload)
      if (payload.action === 'save') rememberSavedApis(apiConnections)
      return reply
    }),

    // Which CODEX_HOME folders THIS machine can offer — answered here, on the machine in question, for
    // the same reason `engines_probe` is: a Codex profile is a folder on disk, and a folder on a Mac means
    // nothing on the Docker rig it was asked about instead.
    codex_profiles_list: internalOnThrow('codex_profiles_list', (payload) => {
      const observed = Array.isArray(payload.observedPaths)
        ? payload.observedPaths.filter((p): p is string => typeof p === 'string')
        : []
      try {
        return { profiles: listCodexProfiles(observed) }
      } catch {
        return { error: 'CODEX_PROFILES_FAILED' }
      }
    }),

    codex_profile_link: internalOnThrow('codex_profile_link', (payload) => {
      const path = typeof payload.path === 'string' ? payload.path : ''
      const result = linkCodexProfile(path)
      if ('error' in result) return { error: result.error }
      return { profile: result }
    }),
  }
}

/**
 * How many models the DEVICE picker may receive. It has room for 48 (`models[48]` in ui_habitat.c) and
 * is handed half of that, so the list it draws is never one it was not built for; the web picker is
 * unbounded and still gets everything.
 */
const DEVICE_PICKER_MAX_MODELS = 24

export function compactRuntimePickerModels(
  models: RuntimeModelOption[],
  sessionId: string | undefined,
  pickerMode: unknown,
  selectedModel: unknown,
): Array<{ id: string }> {
  const compact = models.map(({ id }) => ({ id }))
  if ((pickerMode !== 'model' && pickerMode !== 'effort') || !sessionId) return compact

  const profiles = models.flatMap((item) => {
    const profile = parseRuntimeProfile(item.id)
    return profile?.sessionId === sessionId ? [{ item, profile }] : []
  })
  const selected = parseRuntimeProfile(selectedModel)
  const current = selected?.sessionId === sessionId ? selected : null

  if (pickerMode === 'effort') {
    if (!current) return []
    const seen = new Set<string>()
    return profiles.flatMap(({ item, profile }) => {
      if (profile.model !== current.model || profile.effort === 'auto' || seen.has(profile.effort)) return []
      seen.add(profile.effort)
      return [{ id: item.id }]
    })
  }

  const byModel = new Map<string, typeof profiles>()
  for (const entry of profiles) {
    const group = byModel.get(entry.profile.model) ?? []
    group.push(entry)
    byModel.set(entry.profile.model, group)
  }
  const rows = [...byModel.values()].map((group) => {
    const target = group.find(({ profile }) => current && profile.effort === current.effort)
      ?? group.find(({ profile }) => profile.effort === 'auto')
      ?? group[0]
    return { id: target.item.id, model: target.profile.model }
  })
  // Top N only. The picker is a scroll wheel on a 1.9" round screen, and a 49-row one was enough to stall
  // the device's the device UI task into a task-watchdog reset; devin alone publishes 72
  // models. The catalog arrives in the engine's own order — its curated/most-used first — so "top" is that
  // order, with the model the agent is RUNNING pinned in front so the list can never hide it.
  const ordered = current
    ? [...rows].sort((a, b) => Number(b.model === current.model) - Number(a.model === current.model))
    : rows
  return ordered.slice(0, DEVICE_PICKER_MAX_MODELS).map(({ id }) => ({ id }))
}
