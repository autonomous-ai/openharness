import { readCoreSessionRecords } from './sessionSnapshot.js'
import { readWifiView } from './wifiView.js'
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
import { emptyPorts, type AgentView, type CoreApi, type CorePorts, type ForkResult, type ServiceRequests, type WifiPort, type WifiResume } from '../core/api.js'
import type { AutonomousDeviceDelivery } from '../lib/autonomous-device/service.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess, type ServiceProcessOptions } from './process.js'
import { processCoreApi } from './processCoreApi.js'
import { startWifi } from './wifi.js'
import { inputIn } from './turnsLink.js'
import { followLink } from './followLink.js'
import { cancelTurn } from '../agentClient/cancel.js'
import { observeQuestions } from '../agentClient/questions.js'
import { env } from '../config/env.js'
import { DeviceEvidencePool } from '../lib/autonomous-device/evidenceReader.js'
import { DeviceFeedPool, observeDeviceSessions } from '../lib/autonomous-device/sessionFeed.js'
import { DeviceWorkBudget } from '../lib/autonomous-device/pendingWork.js'
import { deviceDeskFor, type DeskStep } from './deviceDesk.js'

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
type Component = { machineId: string; following: ReturnType<typeof followLink> }
type Binding = { owner: Component; origin: CoreConnection }
type Identity = { origin: CoreConnection; promise: Promise<Binding | null>; settled: boolean; settle(binding: Binding | null): void }

export function runWifiService(options: WifiServiceOptions): ServiceProcess {
  let core: CoreConnection | null = null
  let component: Component | null = null, verified: Binding | null = null, identity: Identity | null = null
  let noticeEpoch = 0, noticesAvailable = true, stopped = false
  let lost!: () => void
  let noticeLost = new Promise<void>(resolve => { lost = resolve })
  /** The core says `resume` as it takes the link, a moment before it says the link is open: what answers it
   *  asks the core, and so waits for that (found end to end: the ask failed, and the service never built). */
  let linked!: () => void
  let link = new Promise<void>((resolve) => { linked = resolve })
  let built: { machineId: string; port: WifiPort; requests: ServiceRequests } | null = null
  /** A window in a previous core's view cannot authorize a notice to its replacement. */
  let lastView: { binding: Binding; hasWindow: boolean } | null = null
  const currentBinding = (owner: Component, binding: Binding | null): binding is Binding =>
    !stopped && component === owner && binding !== null && verified === binding && binding.owner === owner && core === binding.origin
  const bindingFor = (owner: Component, error: string): Binding => {
    if (!currentBinding(owner, verified)) throw new Error(error)
    return verified
  }
  const requireBinding = (owner: Component, binding: Binding): void => {
    if (!currentBinding(owner, binding)) throw new Error('the original core connection ended')
  }
  /** A connected socket says nothing about its account until its machine answer arrives. */
  const identify = (origin: CoreConnection): Identity => {
    identity?.settle(null)
    verified = null; lastView = null
    let resolve!: (binding: Binding | null) => void
    const promise = new Promise<Binding | null>(done => { resolve = done })
    const next: Identity = { origin, promise, settled: false, settle: binding => {
      if (next.settled) return
      next.settled = true; clearTimeout(timer); resolve(binding)
    } }
    const timer = setTimeout(() => {
      if (identity === next) { disconnect(); console.warn('[wifi] WIFI_IDENTITY_TIMEOUT') }
    }, 15_000)
    timer.unref?.()
    identity = next
    return next
  }
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
  const submit = async (owner: Component, agentId: string, text: string, deliveryId: string, context: (agent: AgentView) => void | Promise<void>, current: () => boolean = () => true): Promise<void> => {
    const binding = bindingFor(owner, 'the Wi-Fi device is not connected to the core'), origin = binding.origin
    await inputContract(origin)
    requireBinding(owner, binding)
    if (!current()) return
    const resolved = await origin.query('resolve', { id: agentId })
    requireBinding(owner, binding)
    if (!current()) return
    const agent = object(resolved.value)
    if (agent.agentId !== agentId || typeof agent.sessionId !== 'string' || typeof agent.engine !== 'string') {
      built?.port.delivery({ sessionId: agentId, deliveryId, state: 'rejected', reason: 'agent_gone' })
      return
    }
    await context(agent as unknown as AgentView)
    requireBinding(owner, binding)
    if (!current()) return
    const answer = await origin.query('input', { version: 1, agentId, text, deliveryId, when: 'composer' })
    requireBinding(owner, binding)
    if (typeof answer.error === 'string') {
      const refused = ['INVALID_INPUT', 'INVALID_DELIVERY', 'NOT_A_DELIVERER', 'NOT_DELIVERY_OWNER', 'UNKNOWN_QUERY'].includes(answer.error)
      built?.port.delivery({ sessionId: agentId, deliveryId, state: refused ? 'rejected' : 'unknown', reason: refused ? answer.error : 'NOT_CONFIRMED' })
    }
  }
  const cancel = (owner: Component, deliveryId: string): void => {
    const binding = verified
    if (!currentBinding(owner, binding)) return
    const origin = binding.origin
    void inputContract(origin).then(async () => {
      if (!currentBinding(owner, binding)) return
      await origin.query('cancel_delivery', { deliveryId })
    }).catch(() => {})
  }

  const ask = async (owner: Component, query: string, payload: Record<string, unknown>, binding = bindingFor(owner, 'the Wi-Fi device is not connected to the core')): Promise<Record<string, unknown>> => {
    requireBinding(owner, binding)
    const answer = await binding.origin.query(query, payload)
    requireBinding(owner, binding)
    return answer
  }
  const stepFocus = async (owner: Component, direction: 'next' | 'previous', currentAgentId?: string, callerCurrent: () => boolean = () => true): Promise<DeskStep> => {
    const binding = bindingFor(owner, 'the Wi-Fi device is not connected to the core')
    const current = () => currentBinding(owner, binding) && callerCurrent()
    if (!current()) return 'no_agents'
    const desk = deviceDeskFor(options.dataDir, owner.machineId)
    if (desk) {
      if (!lastView?.hasWindow) return 'no_app'
      return desk.stepFocus(direction, currentAgentId, current)
    }
    const answer = await ask(owner, 'stepFocus', { direction, ...(currentAgentId ? { currentAgentId } : {}) })
    if (!current()) return 'no_agents'
    if (answer.step === 'no_agents' || answer.step === 'no_app') return answer.step
    return { machineId: text(answer.machineId), agentId: text(answer.agentId) }
  }
  const scroll = (owner: Component, phase: 'down' | 'move' | 'up', dy: number, velocity: number, callerCurrent: () => boolean = () => true): boolean => {
    if (!lastView?.hasWindow || !currentBinding(owner, lastView.binding) || !callerCurrent()) return false
    const binding = lastView.binding, desk = deviceDeskFor(options.dataDir, owner.machineId)
    if (desk) return desk.scroll(phase, dy, velocity, () => currentBinding(owner, binding) && callerCurrent())
    binding.origin.notice?.('scroll', { phase, dy, velocity })
    return true
  }

  const api = (owner: Component): CoreApi => {
    const unasked = processCoreApi(options.dataDir, 'wifi')
    return {
      ...unasked,
      conversations: { ...unasked.conversations, resolve: async id => {
        const binding = bindingFor(owner, 'CORE_EVIDENCE_UNAVAILABLE')
        const answer = await binding.origin.query('resolve', { id })
        // onEvent has enqueued every notice preceding this response. Normalized observation is
        // outside this owner, so waiting this prefix cannot wait on its own event handler.
        if (!await heardPrefix() || !currentBinding(owner, binding)) throw new Error('CORE_EVIDENCE_UNAVAILABLE')
        const value = object(answer.value)
        return value.agentId === id && typeof value.sessionId === 'string' && typeof value.engine === 'string' ? value as unknown as AgentView : null
      } },
      agents: { ...unasked.agents,
        create: async request => {
          if (stopped || component !== owner || !identity) throw new Error('WIFI_IDENTITY_UNAVAILABLE')
          // Durable preparation may finish while the same machine is reconnecting. Wait only for
          // identity, not the resume handler that may itself be recovering this preparation.
          const binding = await identity.promise
          if (!binding) throw new Error('WIFI_IDENTITY_UNAVAILABLE')
          const { requestId: _id, ...result } = await ask(owner, 'create', { ...request }, binding)
          return result as unknown as ForkResult
        },
        follow: listener => {
        if (component !== owner || stopped) return () => {}
        return owner.following.follow(event => { if (currentBinding(owner, verified)) listener(event) })
      } },
      clients: { ...unasked.clients, sendWindow: delivery => {
        if (!currentBinding(owner, verified)) return false
        // Focus needs the view this request read. Durable Store reveal can precede a view.
        if (delivery.frame.type === 'device_focus' && (!lastView?.hasWindow || !currentBinding(owner, lastView.binding))) return false
        verified.origin.notice?.('window', { ...delivery })
        return true
      } },
      machine: { id: () => owner.machineId, computerId: () => options.machineId, name: () => '' },
      turns: { ...unasked.turns, recent: async (agentId, n) => list<RecentTurn>((await ask(owner, 'recent', { agentId, n })).turns) },
      wifi: {
        stepFocus: (direction, currentAgentId) => stepFocus(owner, direction, currentAgentId),
        // Read against the view the request being answered just asked for, as the core read its own sockets.
        scroll: (phase, dy, velocity) => scroll(owner, phase, dy, velocity),
      },
    }
  }

  const evidencePool = new DeviceEvidencePool()
  const feedPool = new DeviceFeedPool()
  const focusWork = new DeviceWorkBudget(), noticeWork = new DeviceWorkBudget()
  const answerWork = new DeviceWorkBudget()
  /** The service for this machine, built (again) when the core names another. */
  const build = (machineId: string, origin: CoreConnection): WifiPort | null => {
    if (built?.machineId === machineId && component) {
      verified = { owner: component, origin }
      return built.port
    }
    component?.following.reset()
    component = null; verified = null; lastView = null
    if (built) void built.port.stop()
    built = null
    const owner: Component = { machineId, following: followLink({}) }
    component = owner; verified = { owner, origin }
    const ports: CorePorts = emptyPorts()
    let requests: ServiceRequests
    try {
      requests = (options.start ?? startWifi)(api(owner), ports, {
        readView: async signal => {
          const binding = bindingFor(owner, 'the Wi-Fi device is not connected to the core')
          try {
            let hasWindow = false
            const view = await readWifiView((scope, receive, signal) => readCoreSessionRecords(binding.origin, scope, receive, signal),
              machineId, signal, record => {
                requireBinding(owner, binding)
                if (record.type === 'begin') {
                  if (record.payload.header.machine.id !== owner.machineId) throw new Error('WIFI_IDENTITY_UNAVAILABLE')
                  hasWindow = record.payload.header.hasWindow
                }
              })
            requireBinding(owner, binding)
            lastView = { binding, hasWindow }
            return view
          } catch (error) {
            // An old owner cannot revoke the replacement's view or carry its window permission forward.
            requireBinding(owner, binding)
            lastView = null
            throw error
          }
        },
        submit: (...args) => submit(owner, ...args), cancel: deliveryId => cancel(owner, deliveryId), evidencePool, feedPool, focusWork,
        desk: { stepFocus: (direction, agentId, current) => stepFocus(owner, direction, agentId, current),
          scroll: (phase, dy, velocity, current) => scroll(owner, phase, dy, velocity, current) },
        peer: { composition: 'services', port: env.PORT, token: options.token },
        answerWork,
        stop: async (agentId, callerCurrent, signal) => {
          const binding = verified
          if (!currentBinding(owner, binding)) return false
          const current = () => currentBinding(owner, binding) && callerCurrent()
          if (!current()) return false
          return await cancelTurn({ dataDir: options.dataDir, port: env.PORT, machineId }, agentId, current, signal, answerWork) && current()
        },
        observeQuestions: (listener, budget) => observeQuestions({ dataDir: options.dataDir, port: env.PORT, machineId }, listener, undefined, budget),
        observeSessions: observer => observeDeviceSessions({ dataDir: options.dataDir, port: env.PORT, machineId }, observer),
      })
    } catch (error) {
      owner.following.reset(); component = null; verified = null
      console.warn(`[wifi] did not start · ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
    built = ports.wifi ? { machineId, port: ports.wifi, requests } : null
    if (!built) { owner.following.reset(); component = null; verified = null }
    return built?.port ?? null
  }

  /** What the core tells the service (`service_event`), by kind: the port's own calls, across the link. */
  const heard: Record<string, (port: WifiPort, payload: Record<string, unknown>) => unknown> = {
    delivery: (port, { event }) => port.delivery(object(event) as unknown as AutonomousDeviceDelivery),
    disconnected: port => port.disconnected(),
    appFocus: (port, { machineId, agentId, connId }) => port.appFocus(text(machineId), typeof agentId === 'string' ? agentId : null, text(connId)),
    revealed: (port, { operationId, agentId }) => port.revealed(text(operationId), text(agentId)),
  }

  /** Everything the core says, in the order it said it: a request is taken, the window's focus applied
   *  and the service resumed (each against the agents as the core lists them then) before what came after. */
  let heardSoFar: Promise<unknown> = Promise.resolve()
  const disconnect = (): void => {
    // Revoke before waking a pre-connect resume or invoking a component callback.
    noticeEpoch++; noticesAvailable = false; core = null; sharedCore = null; lastView = null; verified = null
    identity?.settle(null); identity = null
    lost(); linked()
    link = new Promise<void>(resolve => { linked = resolve })
    component?.following.disconnected()
    built?.port.disconnected()
  }
  const heardPrefix = async (): Promise<boolean> => {
    const epoch = noticeEpoch
    await Promise.race([heardSoFar, noticeLost])
    return noticesAvailable && noticeEpoch === epoch
  }
  const inOrder = (payload: Record<string, unknown>, run: (current: () => boolean) => unknown, beforeConnected = false): void => {
    if (stopped || !noticesAvailable && !(beforeConnected && !core)) return
    const epoch = noticeEpoch
    const current = () => !stopped && noticeEpoch === epoch && (noticesAvailable || beforeConnected && !core)
    const release = noticeWork.reserve(payload)
    if (!release) { disconnect(); console.warn('[wifi] WIFI_NOTICE_BACKPRESSURE'); return }
    const timer = setTimeout(() => {
      if (current()) { disconnect(); console.warn('[wifi] WIFI_NOTICE_TIMEOUT') }
    }, 15_000)
    timer.unref?.()
    heardSoFar = heardSoFar.then(() => { if (current()) return run(current) }).catch(() => {
      if (current()) { disconnect(); console.warn('[wifi] WIFI_NOTICE_FAILED') }
    }).finally(() => { clearTimeout(timer); release() })
  }
  /** The core's first word on each connection: which machine this is, then what it holds for the service. */
  const connected = async (state: Record<string, unknown>, originalLink: Promise<void>, current: () => boolean): Promise<void> => {
    await originalLink
    const origin = core
    if (!current() || !origin) return
    const ready = identity?.origin === origin && !identity.settled ? identity : identify(origin)
    await inputContract(origin).catch(() => { /* Only input is unavailable; the other device operations still work. */ })
    if (!current() || core !== origin) return
    const machine = await origin.query('machine', {})
    if (!current() || core !== origin) return
    const machineId = text(machine.id)
    if (!machineId) throw new Error('WIFI_IDENTITY_UNAVAILABLE')
    const port = build(machineId, origin)
    ready.settle(verified)
    if (core === sharedCore) await component?.following.connected(async (query, payload) => {
      const answer = await origin.query(query, payload)
      if (!current() || core !== origin) throw new Error('WIFI_NOTICE_UNAVAILABLE')
      return answer
    })
    if (!current() || core !== origin) return
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
      wifi_focus_current: async (payload, asker, closed) => {
        const origin = core, service = built
        if (!await heardPrefix() || !origin || core !== origin || !service || built !== service) return { current: false }
        const answer = await service.requests.wifi_focus_current!(payload, asker, closed)
        return core === origin && built === service ? answer : { current: false }
      },
      wifi_serving: async (payload, asker, closed) => {
        if (!await heardPrefix()) return { serving: false }
        return built?.requests.wifi_serving?.(payload, asker, closed) ?? { serving: false }
      },
      // Its routes of the door (`harness device receipt`, the add-ons), handed on by the core as they came: answered
      // once what the core said before is heard, and, while the service could not be built, as one that is down.
      wifi_http: async (payload, asker, closed) => {
        if (!await heardPrefix() || !built) return { error: 'SERVICE_UNAVAILABLE' }
        return built.requests.wifi_http!(payload, asker, closed)
      },
    },
    onEvent: (payload) => {
      const kind = text(payload.kind)
      if (kind === 'resume') { const originalLink = link; inOrder(payload, current => connected(payload, originalLink, current), true); return }
      const origin = core
      const whenCurrent = (run: () => unknown): void => inOrder(payload, () => { if (origin && core === origin) return run() })
      if (kind === 'agent') { whenCurrent(() => component?.following.heard(payload)); return }
      if (kind === 'input') {
        const event = inputIn(payload)
        if (event) whenCurrent(() => built?.port.input?.(event))
        return
      }
      if (!Object.hasOwn(heard, kind)) return
      whenCurrent(() => {
        if (built) return heard[kind](built.port, payload)
      })
    },
    // runServiceProcess reuses its query facade across sockets. This callback, not that facade's
    // object identity, establishes the connection captured by an input operation.
    onConnected: (connection) => {
      if (stopped) return
      if (core) disconnect()
      if (!noticesAvailable) { noticeLost = new Promise<void>(resolve => { lost = resolve }); noticesAvailable = true }
      core = { ...connection }; identify(core); linked()
    },
    onDisconnected: disconnect,
  })
  return {
    stop: async () => {
      stopped = true; disconnect()
      component?.following.reset()
      service.stop()
      await built?.port.stop()
    },
  }
}

