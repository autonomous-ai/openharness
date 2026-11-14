/**
 * Share in its own process (`harness __service sharing`), an experiment: started only once it is on (core/api.ts
 * `EXPERIMENTS`): its invitations or links are saved here, or the app or an observer asks. The same service as
 * in the core's process (services/sharing.ts), on the core's API as a process reaches it
 * (services/processCoreApi.ts), and holding no credential: each welcome it gives an observer is signed by the
 * gateway (`observer_key`).
 * - An observer's frames come as the relay handed them over (`observer`, the core's call), taken one at a time
 *   for each observer, in the order they came: a close that follows an open waits for the open's welcome.
 * - What an observer is shown of a terminal is the core's read-only stream manager's (`watch_frame`, and the
 *   core's `watch` events back, services/watchLink.ts); sealed here, it goes to the relay through the core.
 * - The agents it reads as the apps are shown them: asked as each request starts, and whenever its timers read
 *   them and they are a second old, since an observer's access is checked every second.
 * - A new core under another machine (a sign-in since) starts Share again: its saved shares are that machine's.
 */
import { emptyPorts, SHARE_REQUESTS, type DaemonAddress, type ServiceRequests, type SharingPort } from '../core/api.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { agentsIn, daemonIn, processCoreApi, type ShownAgent } from './processCoreApi.js'
import { startSharing } from './sharing.js'
import { watchLink } from './watchLink.js'

type Payload = Record<string, unknown>

/** How old the agents it read may be before a timer's next look asks again. */
export const AGENTS_FRESH_MS = 1_000

export interface SharingServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for a Share that keeps nothing on disk and starts no browser. */
  start?: typeof startSharing
  now?: () => number
}

export function runSharingService(options: SharingServiceOptions): ServiceProcess {
  const now = options.now ?? Date.now
  let core: CoreConnection | null = null
  let live: ShownAgent[] = []
  let readAt = -Infinity
  let daemon: DaemonAddress | null = null
  let askedOn: CoreConnection | null = null
  let reading: Promise<void> | null = null
  const ask = (query: string, payload: Payload): Promise<Payload> =>
    core ? core.query(query, payload) : Promise.reject(new Error('not connected to the core'))
  const readAgents = (): Promise<void> => reading ??= ask('shown', {}).then((answer) => {
    live = (agentsIn(answer) as ShownAgent[] | null) ?? live
    readAt = now()
  }, () => {}).finally(() => { reading = null })
  /** The agents now, and how this daemon is run, asked once per connection; a core that cannot say leaves the last. */
  const ready = async (): Promise<void> => {
    await readAgents()
    if (daemon && askedOn === core) return
    const on = core
    daemon = daemonIn(await ask('daemon', {}).catch(() => null)) ?? daemon
    askedOn = on
  }
  const watch = watchLink(ask)
  const api = processCoreApi(options.dataDir, 'sharing', {
    live: () => { if (now() - readAt > AGENTS_FRESH_MS) void readAgents(); return live },
    ask, daemon: () => daemon, watch: watch.watch,
  })

  const build = () => {
    const ports = emptyPorts()
    const requests = (options.start ?? startSharing)(api, ports)
    return { requests, port: ports.sharing! }
  }
  let built: { requests: ServiceRequests; port: SharingPort } = build()
  let builtFor: string | null = null
  /** Share, for the machine this daemon serves as now; the one under another machine stops. */
  const current = () => {
    const machine = daemon?.machineId() ?? null
    if (machine !== null && builtFor !== null && builtFor !== machine) {
      void built.port.stop()
      built = build()
    }
    if (machine !== null) builtFor = machine
    return built
  }
  /** Each observer's frames, one at a time, in the order the relay handed them over. */
  const inLine = new Map<string, Promise<void>>()
  const observer = (connId: string, type: string, payload: Payload): Promise<void> => {
    const turn = (inLine.get(connId) ?? Promise.resolve())
      .then(() => ready())
      .then(() => current().port.observer(connId, type, payload))
      .catch((error: unknown) => console.warn(`[service sharing] an observer's frame failed · ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { if (inLine.get(connId) === turn) inLine.delete(connId) })
    inLine.set(connId, turn)
    return turn
  }

  const requests: ServiceRequests = Object.fromEntries(SHARE_REQUESTS.map((type) => [type, async (payload: Payload, asker: { local: boolean; owner: boolean }) => {
    await ready()
    return current().requests[type](payload, asker)
  }]))
  const service = (options.run ?? runServiceProcess)({
    name: 'sharing',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: {
      ...requests,
      // The core's own call, for an observer's frame as the relay handed it over.
      observer: async (payload) => {
        if (typeof payload.connId !== 'string' || typeof payload.type !== 'string') return { error: 'INVALID_FRAME' }
        await observer(payload.connId, payload.type, payload.payload && typeof payload.payload === 'object' ? payload.payload as Payload : {})
        return {}
      },
    },
    onEvent: (payload) => {
      if (watch.heard(payload)) return
      if (payload.kind === 'linkDown') built.port.linkDown()
    },
    onConnected: (connection) => {
      core = connection
      void ready().then(() => { current() })
    },
    onDisconnected: () => { core = null },
  })
  return {
    stop: async () => {
      await built.port.stop()
      await service.stop()
    },
  }
}
