/**
 * The agent browser in its own process (`harness __service agentBrowser`, on demand): the same service as in the core's
 * process (services/agentBrowser.ts). Podman's calls and its event stream, image builds that run for minutes and a
 * setup that waits on a password dialog all cost this process, never the core.
 *
 * The core tells it what happens to agents (`service_event` `attached`, `stopped`, `deleted`) and reads each browser's
 * state from what this process last told it (`browser_state`, core/agentBrowserLink.ts), so a frame never waits on it.
 * It asks the core for what only the core knows: its agents' ids (`agent_ids`), the agent of a pane (`agent_of_pane`),
 * and to hand on a product counter (`count`).
 */
import type { CoreApi, CorePorts } from '../core/api.js'
import type { ProductUsageMetric } from '../lib/productUsageContract.js'
import { startAgentBrowser } from './agentBrowser.js'
import type { BrowserState } from './agentBrowser/browsers.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { isSession, processCoreApi } from './processCoreApi.js'

type Payload = Record<string, unknown>
type Ask = (query: string, payload: Payload) => Promise<Payload>

// The service's start waits on this before it deletes anything; no answer in time is no answer.
const IDS_TIMEOUT_MS = 10_000

export interface AgentBrowserServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests. */
  start?: typeof startAgentBrowser
}

const strings = (value: unknown): string[] | null => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null)

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`the core did not answer within ${ms} ms`)), ms) })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/** The core API the agent browser runs on here: the light services' (processCoreApi.ts), with what it asks the core. */
export function agentBrowserCoreApi(dataDir: string, ask: Ask): CoreApi {
  const api = processCoreApi(dataDir, 'agentBrowser')
  return {
    ...api,
    agents: {
      ...api.agents,
      ids: async () => {
        const answer = await within(IDS_TIMEOUT_MS, ask('agent_ids', {}))
        const live = strings(answer.live)
        const stopped = strings(answer.stopped)
        if (!live || !stopped) throw new Error('the core gave no answer for its agents')
        return { live, stopped }
      },
      ofPane: async (pane) => {
        const answer = await ask('agent_of_pane', { pane }).catch(() => null)
        return typeof answer?.agentId === 'string' ? answer.agentId : null
      },
    },
    // A count the core cannot take now is lost: counters are measures, never state.
    count: (metric: ProductUsageMetric) => { void ask('count', { metric }).catch(() => {}) },
  }
}

export function runAgentBrowserService(options: AgentBrowserServiceOptions): ServiceProcess {
  let core: CoreConnection | null = null
  const ask: Ask = (query, payload) => (core ? core.query(query, payload) : Promise.reject(new Error('no core to ask')))
  const ports: Pick<CorePorts, 'agentBrowser'> = { agentBrowser: null }
  /** What each browser last showed: a new core, or the same one after this link dropped, hears all of it again. */
  const shown = new Map<string, BrowserState>()
  const tell = (agentId: string, state: BrowserState | undefined) => {
    // A ready browser's exec goes with its state: the core opens a viewer's stream with it, in line.
    const command = state?.state === 'ready' ? ports.agentBrowser?.streamCommand(agentId) : undefined
    void ask('browser_state', { agentId, ...(state ? { state } : {}), ...(command && 'argv' in command ? { command: command.argv } : {}) }).catch(() => {})
  }
  const requests = (options.start ?? startAgentBrowser)(agentBrowserCoreApi(options.dataDir, ask), ports, {
    told: (agentId, state) => {
      if (state) shown.set(agentId, state)
      else shown.delete(agentId)
      tell(agentId, state)
    },
  })
  const port = ports.agentBrowser!
  const service = (options.run ?? runServiceProcess)({
    name: 'agentBrowser',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests,
    onEvent: (payload) => {
      if (payload.kind === 'attached') {
        if (isSession(payload.session)) port.attached(payload.session)
        return
      }
      if (typeof payload.agentId !== 'string' || !payload.agentId) return
      if (payload.kind === 'stopped') port.stopped(payload.agentId)
      else if (payload.kind === 'deleted') port.deleted(payload.agentId)
    },
    onConnected: (connection) => {
      core = connection
      for (const [agentId, state] of shown) tell(agentId, state)
    },
    onDisconnected: () => { core = null },
  })
  return { stop: () => { port.stop(); return service.stop() } }
}
