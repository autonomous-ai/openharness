/**
 * The orchestrator in its own process (`harness __service orchestrator`), an experiment: started only once it
 * is on (core/api.ts `EXPERIMENTS`). The same service as in the core's process (services/orchestrator.ts),
 * on the core's API as a process reaches it (services/processCoreApi.ts):
 * - the agents it reads as the apps are shown them, asked of the core as each request starts, with how this
 *   daemon is run, which its prompts name, asked before its first request builds it;
 * - its turns delivered, its agents created and stopped and the windows told, each asked of the core;
 * - what an agent is to its projects, reported to the core whenever a project changes and each time it
 *   connects (core/orchestratorLink.ts), since the core asks it in line at every turn's end;
 * - its Directors' frames, which the core sends it, and what became of its deliveries.
 */
import { emptyPorts, type DaemonAddress } from '../core/api.js'
import { startOrchestrator } from './orchestrator.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { agentsIn, daemonIn, processCoreApi, type ShownAgent } from './processCoreApi.js'
import { turnsLink } from './turnsLink.js'

type Payload = Record<string, unknown>

export interface OrchestratorServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for a service that runs no engine and reads no installed harness. */
  start?: typeof startOrchestrator
}

export function runOrchestratorService(options: OrchestratorServiceOptions): ServiceProcess {
  let core: CoreConnection | null = null
  let live: ShownAgent[] = []
  let daemon: DaemonAddress | null = null
  const ask = (query: string, payload: Payload): Promise<Payload> =>
    core ? core.query(query, payload) : Promise.reject(new Error('not connected to the core'))
  const deliveries = turnsLink(ask)
  /** How this daemon is run, asked once per connection however many ask at once (a request, a report). */
  let asking: Promise<void> | null = null
  /** The agents as the core shows them now, and how this daemon is run: what a request reads. */
  let askedOn: CoreConnection | null = null
  const ready = async (): Promise<void> => {
    live = (agentsIn(await ask('shown', {}).catch(() => null)) as ShownAgent[] | null) ?? live
    if (daemon && askedOn === core) return
    // A core that cannot say leaves what the last one said.
    await (asking ??= ask('daemon', {}).then((answer) => { daemon = daemonIn(answer) ?? daemon; askedOn = core }, () => {}).finally(() => { asking = null }))
  }

  let reporting = false
  let again = false
  /** Tell the core what each live agent is to the projects; once at a time, once more for what changed meanwhile. */
  const report = async (): Promise<void> => {
    if (reporting) { again = true; return }
    reporting = true
    try {
      do {
        again = false
        await ready()
        const roles: Payload = {}
        const { port } = current()
        for (const agent of live) {
          const role = port.roleOf(agent.agentId)
          if (role) roles[agent.agentId] = role
        }
        await ask('roles', { roles }).catch(() => {})
      } while (again)
    } catch (error) {
      console.warn(`[service orchestrator] could not report its agents' roles · ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      reporting = false
    }
  }

  const base = processCoreApi(options.dataDir, 'orchestrator', { live: () => live, ask, deliveries, daemon: () => daemon })
  // A project that changed may have changed a role: the windows are told, and the core is told the roles.
  const api = { ...base, clients: { ...base.clients, windows: (frame: { type: string; payload: Payload }) => { base.clients.windows(frame); void report() } } }
  const build = () => {
    const ports = emptyPorts()
    const requests = (options.start ?? startOrchestrator)(api, ports)
    return { requests, port: ports.orchestrator! }
  }
  let built = build()
  /** The machine the service was first read under; null until then. */
  let builtFor: string | null = null
  /**
   * The service, for the machine this daemon serves as now. One read under another machine is stopped and a
   * new one built: a sign-in starts a new core under the account's machine, and the orchestrator it ran inside
   * used to go with it, which this process outlives. Its projects are on disk, read again by the new one.
   */
  const current = () => {
    const machine = daemon?.machineId() ?? null
    if (machine !== null && builtFor !== null && builtFor !== machine) {
      built.port.stop()
      built = build()
    }
    if (machine !== null) builtFor = machine
    return built
  }
  const service = (options.run ?? runServiceProcess)({
    name: 'orchestrator',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: {
      orchestrator: async (payload, asker) => {
        await ready()
        return current().requests.orchestrator(payload, asker)
      },
    },
    onEvent: (payload) => {
      if (deliveries.heard(payload)) return
      if (payload.kind === 'frame' && payload.frame && typeof payload.frame === 'object') built.port.frame(payload.frame as Payload)
    },
    onConnected: (connection) => {
      core = connection
      void report()
    },
    onDisconnected: () => { core = null },
  })
  return {
    stop: () => {
      built.port.stop()
      return service.stop()
    },
  }
}
