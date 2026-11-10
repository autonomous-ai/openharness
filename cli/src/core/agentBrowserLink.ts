/**
 * The agent browser in its own process, as the core sees it (services/agentBrowserProcess.ts; on demand).
 *
 * The core tells the process what happens to agents and goes on: one with Browser is here (`service_event attached`),
 * one stopped, one was purged. A stop or a purge it missed would leave a browser running, or a login on disk, so those
 * are held until the process hears them. An attach is not: it is said on every look at an agent, and the core says
 * every one again each time the process connects, which a process that restarted needs anyway. An attach also asks
 * for the process, which runs only once a browser is wanted here, or as the core starts when its state file is there.
 *
 * An agent's frame reads its browser in line, and cannot wait on another process: the process tells the core each
 * browser's state as it changes (`browser_state`), and the port answers from the last of them. The core keeps them
 * only for the agents it attached and has not since stopped or deleted, so a late word never brings a browser back.
 *
 * The process asks the core what only the core knows: its agents' ids (`agent_ids`), the agent of a pane
 * (`agent_of_pane`), and to hand on one of its own product counters (`count`), none other.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentBrowserFrame } from '../lib/agentFrame.js'
import { PRODUCT_USAGE_AGENT_BROWSER_METRICS, type ProductUsageMetric } from '../lib/productUsageContract.js'
import type { AgentBrowserPort, CoreApi } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'

type Payload = Record<string, unknown>

const STATES: ReadonlySet<string> = new Set(['setup', 'starting', 'ready', 'failed'])
const METRICS: ReadonlySet<string> = new Set(PRODUCT_USAGE_AGENT_BROWSER_METRICS)
const INVALID = { error: 'INVALID_REQUEST' }

/** Only the shape the frame carries, so the process can put nothing else on it. */
function browserState(value: unknown): AgentBrowserFrame | null {
  if (!value || typeof value !== 'object') return null
  const { state, step, error } = value as Payload
  if (typeof state !== 'string' || !STATES.has(state)) return null
  if ((step !== undefined && typeof step !== 'string') || (error !== undefined && typeof error !== 'string')) return null
  return { state: state as AgentBrowserFrame['state'], ...(step !== undefined ? { step } : {}), ...(error !== undefined ? { error } : {}) }
}

export function createAgentBrowserLink(deps: {
  core: Pick<CoreApi, 'agents' | 'count'>
  notify: (frame: ServiceFrame, opts?: { untilDelivered?: boolean }) => boolean
  /** Ask the master for the process (`coreLink.want`). */
  want: () => void
}) {
  const { core, notify } = deps
  const attached = new Set<string>()
  const states = new Map<string, AgentBrowserFrame>()
  let up = false
  const event = (payload: Payload, opts?: { untilDelivered?: boolean }) => { notify({ type: 'service_event', payload }, opts) }
  const forget = (agentId: string) => {
    attached.delete(agentId)
    states.delete(agentId)
  }

  const port: AgentBrowserPort = {
    attached: (session) => {
      if (!session.browser) return
      attached.add(session.agentId)
      if (!up) deps.want()
      event({ kind: 'attached', session })
    },
    stopped: (agentId) => {
      forget(agentId)
      event({ kind: 'stopped', agentId }, { untilDelivered: true })
    },
    deleted: (agentId) => {
      forget(agentId)
      event({ kind: 'deleted', agentId }, { untilDelivered: true })
    },
    frameContext: agentId => states.get(agentId),
    stop: () => {},
  }

  const answer = async (query: string, payload: Payload): Promise<Payload> => {
    if (query === 'browser_state') {
      const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
      const state = payload.state === undefined ? undefined : browserState(payload.state)
      if (!agentId || state === null) return INVALID
      if (!attached.has(agentId)) return { ok: true }
      if (state) states.set(agentId, state)
      else states.delete(agentId)
      const session = core.agents.byAgent(agentId)
      if (session) core.agents.sync(session)
      return { ok: true }
    }
    if (query === 'agent_ids') return core.agents.ids ? { ...await core.agents.ids() } : { error: 'UNSUPPORTED' }
    if (query === 'agent_of_pane') {
      if (typeof payload.pane !== 'string') return INVALID
      return { agentId: (await core.agents.ofPane?.(payload.pane)) ?? null }
    }
    if (query === 'count') {
      if (typeof payload.metric !== 'string' || !METRICS.has(payload.metric)) return INVALID
      core.count?.(payload.metric as ProductUsageMetric)
      return { ok: true }
    }
    return { error: 'UNKNOWN_QUERY' }
  }

  return {
    port,
    answer,
    connected: () => {
      up = true
      for (const session of core.agents.live()) if (session.browser) event({ kind: 'attached', session })
    },
    disconnected: () => { up = false },
  }
}

/** As the core starts: the process is asked for when it runs out here and a browser was wanted before. */
export function wakeAgentBrowser(deps: { outOfProcess: ReadonlySet<string>; dataDir: string; want: (service: string) => void }): void {
  if (deps.outOfProcess.has('agentBrowser') && existsSync(join(deps.dataDir, 'agent-browser.json'))) deps.want('agentBrowser')
}
