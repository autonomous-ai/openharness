/**
 * The Wi-Fi device's service in the devices' process (`harness __service devices,wifi`, harnessd/services.ts),
 * on a link of its own to the core (core/wifiLink.ts; step 9, D3). Its sessions are the gateway's, its
 * requests and answers use its authenticated peer with the gateway, which checks the final E2EE session.
 *
 * It is built on its first connection, once the core has said which machine this is (the account's id,
 * which every frame it sends a device carries), and built again if a later core says another: a sign-in
 * restarts the core, not this process. A core that restarts keeps the same service, which then serves
 * whichever devices the new core's gateway brings.
 */
import type { RecentTurn } from '../cable/cableHost.js'
import { emptyPorts, type AgentView, type CoreApi, type CorePorts, type ForkResult, type ServiceRequests, type WifiPort, type WifiResume, type WifiView } from '../core/api.js'
import type { AutonomousDeviceDelivery } from '../lib/autonomous-device/service.js'
import type { LiveEvent } from '../lib/normalize.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess, type ServiceProcessOptions } from './process.js'
import { processCoreApi } from './processCoreApi.js'
import { startWifi } from './wifi.js'
import { inputIn } from './turnsLink.js'
import { followLink } from './followLink.js'
import { observeQuestions } from '../agentClient/questions.js'
import { env } from '../config/env.js'

export interface WifiServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** For this service's tests: its start and its link. */
  start?: typeof startWifi
  run?: (options: ServiceProcessOptions) => ServiceProcess
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : [])

export function runWifiService(options: WifiServiceOptions): ServiceProcess {
  const following = followLink({})
  let core: CoreConnection | null = null
  /** The core says `resume` as it takes the link, a moment before it says the link is open: what answers it
   *  asks the core, and so waits for that (found end to end: the ask failed, and the service never built). */
  let linked!: () => void
  let link = new Promise<void>((resolve) => { linked = resolve })
  let built: { machineId: string; port: WifiPort; requests: ServiceRequests } | null = null
  /** What the core last listed: whether a window is there to show the device's choice. */
  let lastView: WifiView = { agents: [], store: [], hasWindow: false }
  const contracts = new WeakMap<CoreConnection, Promise<void>>()
  let sharedCore: CoreConnection | null = null
  const inputContract = (origin: CoreConnection): Promise<void> => {
    let pending = contracts.get(origin)
    if (!pending) {
      pending = origin.query('input_contract', {}).then(answer => {
        if (core !== origin) throw new Error('the original core connection ended')
        if (answer.version === 1) { sharedCore = origin; return }
        throw new Error('the core did not confirm its input contract')
      })
      contracts.set(origin, pending)
    }
    return pending
  }
  const submit = async (agentId: string, text: string, deliveryId: string, context: (agent: AgentView) => void, current: () => boolean = () => true): Promise<void> => {
    const origin = core
    if (!origin) throw new Error('the Wi-Fi device is not connected to the core')
    await inputContract(origin)
    if (core !== origin) throw new Error('the original core connection ended')
    if (!current()) return
    const resolved = await origin.query('resolve', { id: agentId })
    if (core !== origin) throw new Error('the original core connection ended')
    if (!current()) return
    const agent = object(resolved.value)
    if (agent.agentId !== agentId || typeof agent.sessionId !== 'string' || typeof agent.engine !== 'string') {
      built?.port.delivery({ sessionId: agentId, deliveryId, state: 'rejected', reason: 'agent_gone' })
      return
    }
    context(agent as unknown as AgentView)
    if (core !== origin) throw new Error('the original core connection ended')
    if (!current()) return
    const answer = await origin.query('input', { version: 1, agentId, text, deliveryId, when: 'composer' })
    if (core !== origin) throw new Error('the original core connection ended')
    if (typeof answer.error === 'string') {
      const refused = ['INVALID_INPUT', 'INVALID_DELIVERY', 'NOT_A_DELIVERER', 'NOT_DELIVERY_OWNER', 'UNKNOWN_QUERY'].includes(answer.error)
      built?.port.delivery({ sessionId: agentId, deliveryId, state: refused ? 'rejected' : 'unknown', reason: refused ? answer.error : 'NOT_CONFIRMED' })
    }
  }
  const cancel = (deliveryId: string): void => {
    const origin = core
    if (!origin) return
    void inputContract(origin).then(async () => {
      if (core !== origin) return
      await origin.query('cancel_delivery', { deliveryId })
    }).catch(() => {})
  }

  const ask = async (query: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    if (!core) throw new Error('the Wi-Fi device is not connected to the core')
    return core.query(query, payload)
  }
  const tell = (kind: string, payload: Record<string, unknown> = {}): void => { core?.notice?.(kind, payload) }

  const api = (machineId: string): CoreApi => {
    const unasked = processCoreApi(options.dataDir, 'wifi')
    return {
      ...unasked,
      agents: { ...unasked.agents, follow: following.follow },
      machine: { id: () => machineId, computerId: () => options.machineId, name: () => '' },
      turns: { ...unasked.turns, recent: async (agentId, n) => list<RecentTurn>((await ask('recent', { agentId, n })).turns) },
      wifi: {
        view: async () => {
          const origin = core
          if (!origin) throw new Error('CORE_VIEW_UNAVAILABLE')
          const answer = await origin.query('view', {})
          if (core !== origin) throw new Error('CORE_VIEW_UNAVAILABLE')
          lastView = { agents: list(answer.agents), store: list(answer.store), hasWindow: answer.hasWindow === true }
          return lastView
        },
        stop: async (agentId) => (await ask('stop', { agentId })).ok === true,
        // Not `requestId`: the link's query carries its own under that name.
        answer: async (agentId, questionRequestId, answers) => (await ask('answer', { agentId, questionRequestId, answers })).ok === true,
        create: async (packageId, engine, cwd) => {
          const { requestId: _id, ...result } = await ask('create', { packageId, engine, cwd })
          return result as unknown as ForkResult
        },
        stepFocus: async (direction, currentAgentId) => {
          const answer = await ask('stepFocus', { direction, ...(currentAgentId ? { currentAgentId } : {}) })
          if (answer.step === 'no_agents' || answer.step === 'no_app') return answer.step
          return { machineId: text(answer.machineId), agentId: text(answer.agentId) }
        },
        // Read against the view the request being answered just asked for, as the core read its own sockets.
        scroll: (phase, dy, velocity) => {
          if (!lastView.hasWindow) return false
          tell('scroll', { phase, dy, velocity })
          return true
        },
        focusApp: (agentId, expiresAt, focusRevision) => {
          if (!lastView.hasWindow) return false
          tell('focusApp', { agentId, expiresAt, focusRevision })
          return true
        },
        reveal: (operationId, agentId) => tell('reveal', { operationId, agentId }),
        focus: (revision) => tell('focus', { revision }),
        transcripts: (agentId, seen) => tell('transcripts', { agentId, seen }),
        watching: (agentIds) => tell('watching', { agentIds }),
        streams: (agentIds) => tell('streams', { agentIds }),
      },
    }
  }

  /** The service for this machine, built (again) when the core names another. */
  const build = (machineId: string): WifiPort | null => {
    if (built?.machineId === machineId) return built.port
    if (built) void built.port.stop()
    built = null
    const ports: CorePorts = emptyPorts()
    let requests: ServiceRequests
    try {
      requests = (options.start ?? startWifi)(api(machineId), ports, { submit, cancel,
        peer: { composition: 'services', port: env.PORT, token: options.token },
        observeQuestions: listener => observeQuestions({ dataDir: options.dataDir, port: env.PORT, machineId }, listener),
      })
    } catch (error) {
      console.warn(`[wifi] did not start · ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
    built = ports.wifi ? { machineId, port: ports.wifi, requests } : null
    return built?.port ?? null
  }

  /** What the core tells the service (`service_event`), by kind: the port's own calls, across the link. */
  const heard: Record<string, (port: WifiPort, payload: Record<string, unknown>) => unknown> = {
    card: (port, { frame, fullText }) => port.card(object(frame), typeof fullText === 'string' ? fullText : undefined),
    turnEnded: (port, { agentId, aborted }) => port.turnEnded(text(agentId), aborted === true),
    stream: (port, { agentId, events }) => port.stream(text(agentId), list<LiveEvent>(events)),
    transcript: (port, { agentId, sessionId, engine, line }) => port.transcript(text(agentId), text(sessionId), text(engine), text(line)),
    delivery: (port, { event }) => port.delivery(object(event) as unknown as AutonomousDeviceDelivery),
    agentGone: (port, { agentId }) => port.agentGone(text(agentId)),
    disconnected: port => port.disconnected(),
    appFocus: (port, { machineId, agentId, connId }) => port.appFocus(text(machineId), typeof agentId === 'string' ? agentId : null, text(connId)),
    revealed: (port, { operationId, agentId }) => port.revealed(text(operationId), text(agentId)),
  }

  /** Everything the core says, in the order it said it: a request is taken, the window's focus applied
   *  and the service resumed (each against the agents as the core lists them then) before what came after. */
  let heardSoFar: Promise<unknown> = Promise.resolve()
  const inOrder = (run: () => unknown): void => {
    heardSoFar = heardSoFar.then(run).catch((error: unknown) => console.warn(`[wifi] ${error instanceof Error ? error.message : String(error)}`))
  }
  /** The core's first word on each connection: which machine this is, then what it holds for the service. */
  const connected = async (state: Record<string, unknown>): Promise<void> => {
    await link
    const origin = core
    if (!origin) return
    await inputContract(origin).catch(() => { /* Only input is unavailable; the other device operations still work. */ })
    if (core !== origin) return
    const machine = await origin.query('machine', {})
    if (core !== origin) return
    const port = build(text(machine.id))
    if (core === sharedCore) await following.connected((query, payload) => origin.query(query, payload))
    if (core !== origin) return
    await port?.resume({
      focus: state.focus && typeof state.focus === 'object' ? state.focus as WifiResume['focus'] : null,
    })
  }

  const service = (options.run ?? runServiceProcess)({
    name: 'wifi',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: {
      wifi_serving: async (payload, asker, closed) => {
        await heardSoFar
        return built?.requests.wifi_serving?.(payload, asker, closed) ?? { serving: false }
      },
      // Its routes of the door (`harness device receipt`, the add-ons), handed on by the core as they came: answered
      // once what the core said before is heard, and, while the service could not be built, as one that is down.
      wifi_http: async (payload, asker, closed) => {
        await heardSoFar
        if (!built) return { error: 'SERVICE_UNAVAILABLE' }
        return built.requests.wifi_http!(payload, asker, closed)
      },
    },
    onEvent: (payload) => {
      const kind = text(payload.kind)
      if (kind === 'resume') { inOrder(() => connected(payload)); return }
      const origin = core
      const whenCurrent = (run: () => unknown): void => inOrder(() => { if (origin && core === origin) return run() })
      if (kind === 'agent') { whenCurrent(() => following.heard(payload)); return }
      if (kind === 'input') {
        const event = inputIn(payload)
        if (event) whenCurrent(() => built?.port.input?.(event))
        return
      }
      if (kind === 'input_events') { whenCurrent(() => { if (core === sharedCore) built?.port.events?.(text(payload.agentId), list<LiveEvent>(payload.events)) }); return }
      if (!Object.hasOwn(heard, kind)) return
      whenCurrent(() => {
        if (built) return heard[kind](built.port, payload)
      })
    },
    // runServiceProcess reuses its query facade across sockets. This callback, not that facade's
    // object identity, establishes the connection captured by an input operation.
    onConnected: (connection) => { core = { ...connection }; linked() },
    onDisconnected: () => {
      following.disconnected()
      built?.port.disconnected?.()
      core = null
      sharedCore = null
      link = new Promise<void>((resolve) => { linked = resolve })
    },
  })
  return {
    stop: async () => {
      service.stop()
      await built?.port.stop()
    },
  }
}

