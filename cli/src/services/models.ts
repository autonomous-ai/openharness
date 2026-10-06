/**
 * Models: grid, how Harness runs local AI models with Codex, Claude Code and the other engines
 * (docs/design/2026-10-03-harnessd.md, "Models"). Grid access on first use, the model pictures an
 * agent's frame carries, starting a sleeping grid while someone types to its agent, and what the apps
 * ask about models: the picker's list, an agent's Model/Effort choices and the Model Manager's local
 * models.
 *
 * A service on the core boundary (step 13): it reads the core only through `CoreApi`, the core
 * reaches it only through `ports.models`, and the apps through the requests it answers.
 */
import { join } from 'node:path'
import type { CoreApi, CorePorts, ModelsPort, ServiceRequest, ServiceRequests } from '../core/api.js'
import { MODEL_MANAGER_ID } from '../dsh/builtins.js'
import { installedDsh } from '../dsh/installed.js'
import { ApiConnections, apiConnectionsRequest } from '../lib/apiConnections.js'
import { apiModelsRequest, rememberSavedApis } from '../lib/apiModels.js'
import { appEngineOps, scanAppModels } from '../lib/appModels.js'
import { linkCodexProfile, listCodexProfiles } from '../lib/codexProfiles.js'
import { createGridAccess, gridNamesLocal, reconcileGridAttach } from '../lib/gridAttach.js'
import { resetGridDeriveMemo, signedInGridEmail } from '../lib/gridDerive.js'
import { ensureHarnessGrid } from '../lib/gridEnsure.js'
import { gridAvailable } from '../lib/gridExec.js'
import { handOffToGrid } from '../lib/gridHandoff.js'
import { ensureGridInstalled } from '../lib/gridInstall.js'
import { clearGridMcpUrlCache } from '../lib/gridMcpUrl.js'
import {
  forgetGridModels, gridAnnotation, gridInventory, keystrokePrewarm, listAllGridModels, onGridModelsChanged, warmGridModels, type GridSection,
} from '../lib/gridModels.js'
import { gridModelsPayload } from '../lib/gridModelsPayload.js'
import { LocalModels } from '../lib/localModels.js'
import { parseRuntimeProfile, type RuntimeModelOption } from '../lib/runtimeProfile.js'
import { ensureManagedGrid } from '../lib/runtimeInstall.js'
import { internalOnThrow } from './requestErrors.js'

/**
 * The requests models answers for the apps.
 *
 * The Model Manager's grid commands, `grid_fleet_run` and `grid_fleet_cancel`, are still the socket's:
 * a command is a job of the connection that started it, and a cancel stops only that connection's job
 * (`lib/gridFleetRpc.ts`), while a request answered here knows who asked but not over which connection.
 * Their handshake, `grid_fleet_capabilities`, stays beside them: the Grid harness runs a command only
 * after it, and reads an answer without its protocol as "update Harness".
 * The saved APIs and the Codex profiles came out of the socket's switch (launchTargetRequests).
 */
export const MODELS_REQUESTS = [
  'grid_models_list', 'models_list',
  'grid_fleet_models_list', 'grid_fleet_model_download', 'grid_fleet_model_start', 'grid_fleet_model_stop',
  'api_connections', 'codex_profiles_list', 'codex_profile_link',
] as const

export function startModels(core: CoreApi, ports: CorePorts): ServiceRequests {
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

  // An agent's frame says what its grid's picture says (`grid.state`, and a `grid.note` when its model
  // will not answer). The picture changes on reads nobody waited for, so the frames of the agents whose
  // annotation moved are pushed again — only those, and only when it moved.
  const announcedGrid = new Map<string, string>()
  onGridModelsChanged(() => {
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
  const grid: Pick<ModelsPort, 'ensure' | 'setUp'> = {
    ensure: (request) => gridAccess.ensure(request),
    // Offline, for every list read: is there a `grid` here holding a sign-in? What decides whether the
    // picker offers local and shared models or a Set up row.
    setUp: () => gridAvailable() && signedInGridEmail() !== null,
  }
  ports.models = {
    ...grid,
    // The keystroke prewarm (grid-reads-without-waking issue 03): typing into a pane whose agent runs on
    // a sleeping grid starts that grid while the person types.
    prewarm: (target) => { void keystrokePrewarm(target).catch(() => {}) },
    // The web-tools cache lives exactly as long as the sign-in.
    signedOut: () => clearGridMcpUrlCache(),
  }
  return modelsRequests(core, grid)
}

/** Sections one `grid_models_list` may ask to wake — a person presses one "Show models" at a time. */
const MAX_WAKES_PER_ASK = 8

type LocalModelRequest = 'grid_fleet_models_list' | 'grid_fleet_model_download' | 'grid_fleet_model_start' | 'grid_fleet_model_stop'

/**
 * What the apps ask about models, on grid as this service holds it. Each request waits on grid, the
 * network or a model's process; the host replies when it is done and never holds the asking connection's
 * next request behind it (core/serviceHost.ts `route`), which is why the socket ran them detached when it
 * answered them itself. A failure is answered as the socket answered it, sentences included: the apps
 * show them.
 */
function modelsRequests(core: CoreApi, grid: Pick<ModelsPort, 'ensure' | 'setUp'>): ServiceRequests {
  // The Model Manager reads the grid it runs on through the same credential-less reader as every picker
  // (never `grid engines`, which carries the grid credential and so wakes a sleeping grid on every tick),
  // and a start or stop it finishes makes every list read again — pushed to the window when it changes.
  const localModels = new LocalModels({
    stateDir: join(core.dataDir, 'local-models'),
    machineName: () => core.account.machineName(),
    inventory: gridInventory,
    onChanged: () => { forgetGridModels(); core.clients.gridModelsChanged() },
    // Models Ollama, LM Studio and llama.cpp downloaded here, found by the Model Manager's own scan (the
    // bundled harness), so the picker and that harness agree on what is here and what starts it.
    appModels: () => scanAppModels({ node: process.execPath, packageDir: installedDsh(MODEL_MANAGER_ID)?.realDir ?? null, env: process.env }),
    appEngines: appEngineOps(process.env),
  })
  /** The grid listing currently out, shared by every `grid_models_list` for the same own grid that lands
   *  meanwhile. */
  let listing: { gridName: string | null; grids: Promise<GridSection[]> } | null = null

  /**
   * Grid set up for an act, or the sentence saying why it could not be: null when it is ready. The
   * socket says the same for a move onto a grid model (`agent_retarget`), which it still answers.
   */
  const notReady = async (ownGrid: boolean): Promise<string | null> => {
    const ready = await grid.ensure({ ownGrid })
    if (ready.status !== 'converged' && ready.status !== 'signed-in') {
      return ready.detail || 'Grid could not be set up on this computer. Try again.'
    }
    if (ownGrid && ready.ownGrid && !['created', 'existed', 'adopted'].includes(ready.ownGrid)) {
      return ready.detail || 'Your grid could not be created. Try again.'
    }
    return null
  }

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
      const unready = setup ? await notReady(type !== 'grid_fleet_model_download') : null
      const gridName = await core.account.privateGridName()
      if (list) {
        const snapshot = await localModels.list(gridName, payload.refresh === true || setup)
        const needed = !grid.setUp()
        if (setup && !unready) core.clients.gridModelsChanged()
        return { ...snapshot, ...(needed ? { gridSetupNeeded: true } : {}), ...(unready ? { gridSetupError: unready } : {}) }
      }
      if (unready) return { error: unready }
      return { ...await localModels.act(gridName, payload.modelId, type === 'grid_fleet_model_download' ? 'download' : type === 'grid_fleet_model_start' ? 'start' : 'stop') }
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
        const gridName = await core.account.privateGridName()
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
    ...launchTargetRequests(core),
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
