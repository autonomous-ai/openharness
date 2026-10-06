/**
 * Models in its own process, as the core reaches it (`HARNESSD_SERVICES=models`; the process's side is
 * services/modelsProcess.ts).
 *
 * The core asks models two kinds of thing. What an agent's frame and a keystroke to it read — the note on
 * the agent's grid (`annotation`), and whether typing should start that grid (`prewarm`) — cannot wait on
 * another process: a frame is built in line, and a keystroke is the hottest path there is. So models tells
 * the core a glance at every grid it tracks whenever a picker would be told something new (a
 * `service_query` of kind `glances`), the core keeps the last, and the port answers from it, with what
 * models last said while it is down (lib/gridAnnotation.ts reads a glance as the service reads its own
 * pictures). Each new glance does here what the service does in the core's process: the frames of the
 * agents whose note moved go out again. A keystroke crosses to the process only when the agent's grid is
 * asleep, which is the only time the service would act on it.
 *
 * Everything else is asked when it is needed (core/serviceLinks.ts `call`): grid's set-up, where an agent
 * on a grid model sends its inference, the private grid's name, the lists the windows are pushed. An
 * answer that does not come (the process is down, or slower than its wait, core/api.ts `LONG_ANSWERS`) is
 * what the fallbacks give in the core's process (`MODELS_FALLBACKS`): an error for the one request that
 * asked, so a create on a grid model answers GRID_UNAVAILABLE, never a hang. What models is only told (a
 * move onto a grid model, the machine list, the end of the sign-in) is not held for it while it is down:
 * a restarted process asks for the machine list as it connects, starts with no sign-in cache to drop, and
 * a missed prewarm is one boot the first message waits for.
 *
 * Models asks the core what only the core holds (`answer`): the account's grid name and this machine's
 * name, a minted grid name, the access token grid's sign-in is handed (a service holds no credential: it
 * asks for it each time), each agent's Model/Effort choices, and the two pushes to the windows.
 */
import { annotate, glanceFor, type GridGlance } from '../lib/gridAnnotation.js'
import type { GridAttachResult } from '../lib/gridAttach.js'
import { parseGridLaunchOverride, type GridLaunchOverride } from '../lib/gridLaunch.js'
import type { CoreApi, ModelsPort } from './api.js'
import { ServiceUnavailableError } from './serviceHost.js'
import type { ServiceFrame } from './serviceLinks.js'

/** Ask models' process (core/serviceLinks.ts `call`, for `models`): never rejects. */
export type CallModels = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>
/** Tell models' process something (core/serviceLinks.ts `notify`, for `models`). */
export type NotifyModels = (frame: ServiceFrame) => boolean

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** The glances in what the process said, each checked as far as an agent's note reads it; null when it
 *  said none. */
export function glancesIn(value: unknown): GridGlance[] | null {
  if (!Array.isArray(value)) return null
  return value.filter(isRecord).filter((glance) => typeof glance.id === 'string' && glance.id).map((glance) => {
    const view = isRecord(glance.view) && typeof glance.view.state === 'string' && Array.isArray(glance.view.models) ? glance.view : null
    const models = (view?.models as unknown[] | undefined ?? []).filter(isRecord).filter((model) => typeof model.id === 'string').map((model) =>
      isRecord(model.unavailable) && typeof model.unavailable.machine === 'string'
        ? { id: model.id as string, unavailable: { machine: model.unavailable.machine } }
        : { id: model.id as string })
    return {
      id: glance.id as string,
      view: view ? { state: view.state as NonNullable<GridGlance['view']>['state'], models } : null,
      listed: glance.listed === true,
      asleep: glance.asleep === true,
    }
  })
}

/** A launch the process resolved, checked as any grid launch is before it is used; null when there is none. */
const launchIn = (value: unknown): GridLaunchOverride | null => {
  const parsed = parseGridLaunchOverride(value)
  return parsed.state === 'ok' ? parsed.override : null
}

export function createModelsLink(core: Pick<CoreApi, 'agents' | 'account' | 'clients'>, call: CallModels, notify: NotifyModels) {
  let glances: GridGlance[] = []
  /** What each agent's frame last said of its grid, so only a change sends the frame again. */
  const announced = new Map<string, string>()
  /** The machine list the core last read, for a process that connects after it. */
  let machines: { body: Record<string, unknown> | null; computerId: string } | null = null

  /** An answer, or models' being unavailable as a rejection: what a FAIL fallback gives in the core's process. */
  const ask = async (type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const answer = await call(type, payload)
    if (answer.error === 'SERVICE_UNAVAILABLE' || answer.error === 'SERVICE_FAILED') throw new ServiceUnavailableError('models')
    return answer
  }
  const tell = (payload: Record<string, unknown>): void => { notify({ type: 'service_event', payload }) }

  const port: ModelsPort = {
    ensure: async (request) => {
      const answer = await ask('ensure', { ...request })
      if (typeof answer.status !== 'string') throw new ServiceUnavailableError('models')
      return answer as unknown as GridAttachResult
    },
    annotation: (grid) => annotate(glanceFor(glances, grid.baseUrl), grid),
    prewarm: (grid) => { if (glanceFor(glances, grid.baseUrl)?.asleep) tell({ kind: 'prewarm', grid }) },
    launchTarget: async (selection) => launchIn((await ask('launchTarget', { ...selection })).target),
    moveTarget: async (request) => {
      const answer = await ask('moveTarget', { ...request })
      const target = launchIn(answer.target)
      if (target) return { target }
      return { detail: typeof answer.detail === 'string' && answer.detail ? answer.detail : 'Could not read this machine\'s grid endpoint.' }
    },
    moved: (launch) => tell({ kind: 'moved', launch }),
    // Its fallback is no name, not an error: the backend's, which the caller reads first, is all there is.
    privateGridName: async () => {
      const answer = await call('privateGridName', {})
      return typeof answer.name === 'string' && answer.name ? answer.name : null
    },
    lists: async () => {
      const answer = await ask('lists', {})
      if (!isRecord(answer.plain) || !isRecord(answer.rowState)) throw new ServiceUnavailableError('models')
      return { plain: answer.plain, rowState: answer.rowState }
    },
    machines: (body, computerId) => {
      machines = { body, computerId }
      tell({ kind: 'machines', body, computerId })
    },
    signedOut: () => tell({ kind: 'signedOut' }),
  }

  /** Models says what it now sees of every grid: kept, and the frames of the agents whose note moved sent
   *  again — every one on a grid the first time, as in the service's own process. */
  const heard = (payload: Record<string, unknown>): Record<string, unknown> => {
    const next = glancesIn(payload.glances)
    if (!next) return { kept: false }
    glances = next
    const onGrid = core.agents.advertised().filter((session) => session.grid)
    const present = new Set(onGrid.map((session) => session.agentId))
    for (const agentId of [...announced.keys()]) if (!present.has(agentId)) announced.delete(agentId)
    for (const session of onGrid) {
      const said = JSON.stringify(port.annotation(session.grid!))
      if (announced.get(session.agentId) === said) continue
      announced.set(session.agentId, said)
      core.agents.sync(session)
    }
    return { kept: true }
  }

  return {
    port,
    /** The core's answers to models' questions (core/serviceLinks.ts `answer`, for `models`). */
    async answer(query: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (query === 'glances') return heard(payload)
      if (query === 'account') return { gridName: await core.account.privateGridName(), machineName: core.account.machineName() }
      if (query === 'mintGridName') return { name: await core.account.mintGridName() }
      if (query === 'accessToken') return { token: await core.account.accessToken() }
      if (query === 'runtimeModels') {
        return { models: await core.agents.runtimeModels(typeof payload.agentId === 'string' && payload.agentId ? payload.agentId : undefined) }
      }
      if (query === 'machines') return machines ? { ...machines } : {}
      if (query === 'gridNamed') {
        if (typeof payload.name === 'string' && payload.name) core.clients.gridNamed(payload.name)
        return {}
      }
      if (query === 'gridModelsChanged') {
        core.clients.gridModelsChanged()
        return {}
      }
      return { error: 'UNKNOWN_QUERY' }
    },
  }
}

export type ModelsLink = ReturnType<typeof createModelsLink>
