/**
 * The agent browser in its own process (`harness __service agentBrowser`, on demand): the same service as in the core's
 * process (services/agentBrowser.ts). Podman's calls and its event stream, image builds that run for minutes and a
 * setup that waits on a password dialog all cost this process, never the core.
 *
 * The core tells it what happens to agents (`service_event` `attached`, `stopped`, `deleted`, and `moved`: a pane whose
 * agent ended has a new one, decision 19) and reads each browser's state from what this process last told it
 * (`browser_state`, core/agentBrowserLink.ts), so a frame never waits on it.
 * It asks the core for what only the core knows: its agents' ids (`agent_ids`), the agent of a pane and whether it is a
 * guest's, held to the parents of the command that names it (`agent_of_pane`), and to hand on a product counter
 * (`count`). It asks the core to turn an agent's Browser on or off, its person's Start and Stop (`set_browser`), and to
 * move the flag after a browser it moved to a pane's new agent (`move_browser`): the core tells it `attached` or
 * `stopped` before it answers. And it has the core type its two lines into an agent (`deliver`, services/turnsLink.ts),
 * and hears what became of them.
 */
import type { BrowserSwitch, CoreApi, CorePorts } from '../core/api.js'
import type { ProductUsageMetric } from '../lib/productUsageContract.js'
import { startAgentBrowser } from './agentBrowser.js'
import type { BrowserState } from './agentBrowser/browsers.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { isSession, processCoreApi } from './processCoreApi.js'
import { turnsLink } from './turnsLink.js'

type Payload = Record<string, unknown>
type Ask = (query: string, payload: Payload) => Promise<Payload>

// The service's start waits on this before it deletes anything; no answer in time is no answer.
const IDS_TIMEOUT_MS = 10_000
// The core switches in the same turn it is asked: a person's Start or Stop, or a move, it does not answer in this is a
// failed one.
const SWITCH_TIMEOUT_MS = 10_000
// The core reads the pane's process from tmux within 2 s. An agent's command waits on this answer: a core that does not
// give it in time names no agent, and the command is refused rather than left hanging.
const PANE_TIMEOUT_MS = 10_000

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

/** The core's answer to a switch, or null for anything else. */
function switchOf(answer: Payload): BrowserSwitch | null {
  if (answer.ok === true && typeof answer.changed === 'boolean') return { ok: true, changed: answer.changed }
  return answer.error === 'NOT_RUNNING' || answer.error === 'NOT_ALLOWED' ? { error: answer.error } : null
}

/** The core API the agent browser runs on here: the light services' (processCoreApi.ts), with what it asks the core
 *  and the turns it delivers through it. */
export function agentBrowserCoreApi(dataDir: string, ask: Ask, deliveries: ReturnType<typeof turnsLink>): CoreApi {
  const api = processCoreApi(dataDir, 'agentBrowser', { deliveries })
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
      ofPane: async (pane, ancestors) => {
        const answer = await within(PANE_TIMEOUT_MS, ask('agent_of_pane', { pane, ...(ancestors ? { ancestors } : {}) })).catch(() => null)
        // An answer that does not say whose the agent is names none: a command is never run for a guest's on a guess.
        return typeof answer?.agentId === 'string' && typeof answer.guest === 'boolean' ? { agentId: answer.agentId, guest: answer.guest } : null
      },
      setBrowser: async (agentId, on) => {
        const answer = switchOf(await within(SWITCH_TIMEOUT_MS, ask('set_browser', { agentId, on })))
        if (!answer) throw new Error('the core gave no answer for the switch')
        return answer
      },
      moveBrowser: async (from, to) => {
        const answer = switchOf(await within(SWITCH_TIMEOUT_MS, ask('move_browser', { from, to })))
        if (!answer) throw new Error('the core gave no answer for the move')
        return answer
      },
    },
    // A count the core cannot take now is lost: counters are measures, never state.
    count: (metric: ProductUsageMetric) => { void ask('count', { metric }).catch(() => {}) },
  }
}

export function runAgentBrowserService(options: AgentBrowserServiceOptions): ServiceProcess {
  let core: CoreConnection | null = null
  const ask: Ask = (query, payload) => (core ? core.query(query, payload) : Promise.reject(new Error('no core to ask')))
  const link = turnsLink(ask)
  // A line asked of no core never left this process: heard `rejected`, so it is tried again (agentBrowser/notices.ts),
  // not `unknown`, which counts as perhaps typed and is never typed again.
  const deliveries: ReturnType<typeof turnsLink> = { ...link, turns: { ...link.turns, deliver: (agentId, text, deliveryId, opts) => {
    if (core) return link.turns.deliver(agentId, text, deliveryId, opts)
    queueMicrotask(() => link.heard({ kind: 'delivery', event: { deliveryId, sessionId: agentId, state: 'rejected', reason: 'no_core' } }))
  } } }
  const ports: Pick<CorePorts, 'agentBrowser'> = { agentBrowser: null }
  /** What each browser last showed: a new core, or the same one after this link dropped, hears all of it again. */
  const shown = new Map<string, BrowserState>()
  const tell = (agentId: string, state: BrowserState | undefined) => {
    // A ready browser's exec goes with its state: the core opens a viewer's stream with it, in line.
    const command = state?.state === 'ready' ? ports.agentBrowser?.streamCommand(agentId) : undefined
    void ask('browser_state', { agentId, ...(state ? { state } : {}), ...(command && 'argv' in command ? { command: command.argv } : {}) }).catch(() => {})
  }
  const requests = (options.start ?? startAgentBrowser)(agentBrowserCoreApi(options.dataDir, ask, deliveries), ports, {
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
      if (deliveries.heard(payload)) return
      if (payload.kind === 'attached') {
        if (isSession(payload.session)) port.attached(payload.session)
        return
      }
      if (payload.kind === 'moved') {
        const { from, session, on } = payload
        if (typeof from === 'string' && from && isSession(session) && typeof on === 'boolean') port.moved(from, session, on)
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
