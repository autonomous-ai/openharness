import { emptyPorts, type BackendNotice, type DaemonAddress } from '../core/api.js'
import { startSuperTabs } from './superTabs.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { agentsIn, daemonIn, processCoreApi, type ShownAgent } from './processCoreApi.js'
import { turnsLink } from './turnsLink.js'

export interface SuperTabsServiceOptions {
  dataDir: string; socketPath: string; machineId: string; token: string
  run?: typeof runServiceProcess
  start?: typeof startSuperTabs
}

/** A private process owns the host loop. Losing the core disconnects it and expires all input leases. */
export function runSuperTabsService(options: SuperTabsServiceOptions): ServiceProcess {
  let core: CoreConnection | null = null
  let live: ShownAgent[] = []
  let daemon: DaemonAddress | null = null
  const ask = (query: string, payload: Record<string, unknown>) => core
    ? core.query(query, payload) : Promise.reject(new Error('Core disconnected'))
  const turns = turnsLink(ask)
  /** The account's notices the core tells this process (`service_event` kind `notice`): the host hears from them that the
   *  server says work waits (superTabs/host.ts). */
  const notices = new Set<(notice: BackendNotice) => void>()
  let reading: Promise<void> | null = null
  const ready = (): Promise<void> => {
    const connection = core
    return reading ??= Promise.all([ask('shown', {}), ask('daemon', {})]).then(([agents, address]) => {
      if (core !== connection) throw new Error('Core changed while reading its identity')
      live = agentsIn(agents) ?? []
      daemon = daemonIn(address)
    }).finally(() => { reading = null })
  }
  const base = processCoreApi(options.dataDir, 'superTabs', { live: () => live, ask, deliveries: turns, daemon: () => daemon,
    onNotice: listener => { notices.add(listener); return () => { notices.delete(listener) } } })
  // Every authority read also refreshes the native registry. A stopped/replaced
  // harness cannot receive work through a stale process-side snapshot.
  const api = { ...base, account: { ...base.account, backend: async (method: string, path: string, body?: unknown) => {
    await ready()
    return base.account.backend(method, path, body)
  } },
  // An agent's last turn as its engine wrote it, which the core reads (core/experimentQueries.ts `last_turn`): the host asks it after a
  // restart that cut a message off in the middle of typing, to type it again only if the agent did not take it (superTabs/host.ts).
  // An answer that says no turn is null; one that says nothing it can read is a failure, which the host reads as unknown.
  transcripts: { ...base.transcripts, lastTurn: async (sessionId: string) => {
    const { turn } = await ask('last_turn', { sessionId })
    if (turn === null) return null
    const { userMessage, assistantText } = (turn ?? {}) as Record<string, unknown>
    if (typeof userMessage !== 'string' || typeof assistantText !== 'string') throw new Error('The core did not say the last turn.')
    return { userMessage, assistantText }
  } } }
  const ports = emptyPorts()
  const requests = (options.start ?? startSuperTabs)(api, ports)
  const service = (options.run ?? runServiceProcess)({
    name: 'superTabs', socketPath: options.socketPath, machineId: options.machineId, token: options.token,
    requests: { super_tabs: async (payload, asker, closed) => { await ready(); return requests.super_tabs(payload, asker, closed) } },
    onEvent: payload => {
      if (payload.kind !== 'notice') { turns.heard(payload); return }
      if (payload.notice && typeof payload.notice === 'object') for (const listener of notices) listener(payload.notice as BackendNotice)
    },
    onConnected: connection => {
      core = connection
      void ready().then(() => { if (core === connection) ports.superTabs?.connected() }).catch(() => {})
    },
    onDisconnected: () => { core = null; live = []; daemon = null; ports.superTabs?.disconnected() },
  })
  return { stop: () => { ports.superTabs?.stop(); return service.stop() } }
}
