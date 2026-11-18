import { wifiView, type WifiView } from './wifiView.js'
/**
 * The Wi-Fi device (lib/autonomous-device/, docs/autonomous-device-integration.md): a paired device that
 * speaks its own protocol over an E2EE session the gateway holds. Its service, its Store preparations and
 * its relay run here, with the dials in the devices' process (step 9, D3), on `CoreApi` alone: a fault in
 * it costs the devices, never a session (docs/design/2026-10-06-core-boundary-next.md).
 *
 * What the service reads in line while it answers (the agents, the Store's evidence on them, whether a
 * window is there) is the core's answer to `view`, asked again before each request and each move of the
 * window's focus, so what it answers is as fresh as when it ran in the core. Raw evidence is read here;
 * normalized events use the same negotiated local transport as Desktop. Relay sessions come from the
 * gateway peer, and the core keeps no component observation interests.
 *
 * What a person asks of it on this computer (`harness device receipt`, `harness autonomous-device addon`) comes as its
 * routes of the door, handed on by the core as they came (core/serviceRoutes.ts) and checked here
 * (lib/autonomous-device/localHttp.ts).
 */
import { join } from 'node:path'
import type { AgentView, CoreApi, CorePorts, ServiceRequests, WifiPort } from '../core/api.js'
import { submissionPolicy } from '../engines/submissionPolicies.js'
import { startDevicePart } from '../lib/autonomous-device/parts.js'
import { deviceRelayOverGateway } from '../lib/autonomous-device/overGateway.js'
import { devicePeerKey } from '../lib/autonomous-device/peerEndpoint.js'
import { DeviceResultJournal } from '../lib/autonomous-device/resultJournal.js'
import { AutonomousDeviceService, type AutonomousDeviceFrame } from '../lib/autonomous-device/service.js'
import { deviceRefusal, deviceRoutes } from '../lib/autonomous-device/localHttp.js'
import { createDeviceStore } from '../lib/autonomous-device/storeRuntime.js'
import { cancelTurn } from '../agentClient/cancel.js'
import { observeQuestions, type QuestionAnswerBudget, type QuestionListener, type QuestionObservation } from '../agentClient/questions.js'
import { createDeviceEvidence, DeviceEvidencePool } from '../lib/autonomous-device/evidenceReader.js'
import { observeDeviceSessions, DeviceFeedPool, type DeviceSessionFeedOptions, type DeviceSessionFeed } from '../lib/autonomous-device/sessionFeed.js'
import type { LiveEvent } from '../engines/kit/events.js'
import { sessionEventProof } from '../lib/sessionEvents.js'
import { DeviceWorkBudget } from '../lib/autonomous-device/pendingWork.js'
import { isLocalOnly, withoutUpdate } from '../lib/cardUpdate.js'

export { WIFI_FALLBACKS, WIFI_REQUESTS } from '../core/api.js'

// Inline reconstruction must not forget a previous instance's still-running view query.
const inlineFocusWork = new DeviceWorkBudget()
const inlineEvidencePool = new DeviceEvidencePool()
const inlineFeedPool = new DeviceFeedPool()
const inlineAnswerWork = new DeviceWorkBudget()

export interface WifiDeps {
  /** Same-worker desk calls carry this component's lifetime without adding a core API rule. */
  desk?: import('./deviceDesk.js').DeviceDeskClient
  /** Explicit composition: an absent service token never silently creates an unrelated peer authority. */
  peer?: { composition: 'inline' | 'services'; port: number; token?: string }
  /** Swapped in tests, to reach what the service and the Store are given. */
  service?: (options: ConstructorParameters<typeof AutonomousDeviceService>[0]) => AutonomousDeviceService
  store?: typeof createDeviceStore
  /** Process adapter: captures one core connection through capability probe, read and submit. */
  submit?: (agentId: string, text: string, deliveryId: string, context: (agent: AgentView) => void | Promise<void>, current?: () => boolean) => Promise<void>
  cancel?: (deliveryId: string) => void
  stop?: (agentId: string, current: () => boolean, signal: AbortSignal) => Promise<boolean>
  evidence?: typeof createDeviceEvidence
  evidencePool?: DeviceEvidencePool
  feedPool?: DeviceFeedPool
  focusWork?: DeviceWorkBudget
  answerWork?: DeviceWorkBudget
  observeSessions?: (options: DeviceSessionFeedOptions) => DeviceSessionFeed
  /** Same authenticated local tool transport in an external process and explicit inline mode. */
  observeQuestions?: (listener: QuestionListener, budget: QuestionAnswerBudget) => QuestionObservation
}


export function startWifi(core: CoreApi, ports: CorePorts, deps: WifiDeps = {}): ServiceRequests {
  const machineId = core.machine.id()
  let view: WifiView = { agents: [], store: [], hasWindow: false }
  let stopped = false, coreConnected = true, coreEpoch = 0, notices = 0, applied = 0
  let cancellations = new AbortController()
  /** One ask of the core at a time: requests arriving together share it, and are answered in order. */
  let viewing: { epoch: number; promise: Promise<void> } | null = null
  const refresh = async (): Promise<void> => {
    if (stopped || !coreConnected) throw new Error('CORE_VIEW_UNAVAILABLE')
    if (viewing) {
      const pending = viewing
      try { await pending.promise } catch (error) { if (pending.epoch === coreEpoch) throw error }
      if (pending.epoch !== coreEpoch || applied < notices) return refresh()
      return
    }
    const epoch = coreEpoch, revision = notices
    const pending = { epoch, promise: Promise.resolve() }
    pending.promise = core.agents.snapshot().then(snapshot => {
      if (stopped || !coreConnected || coreEpoch !== epoch) throw new Error('CORE_VIEW_UNAVAILABLE')
      if (snapshot.machine.id !== machineId) throw new Error('CORE_VIEW_UNAVAILABLE')
      view = wifiView(snapshot); applied = revision
    }).catch(error => {
      // Preserve the existing last-view read fallback only when no unapplied notice needs a barrier.
      if (!stopped && coreConnected && coreEpoch === epoch && applied === notices) return
      throw error
    }).finally(() => { viewing = null })
    viewing = pending
    await pending.promise
    if (applied < notices) return refresh()
    relay.drain()
  }
  const changed = (): void => {
    notices++
    if (!viewing) void refresh().catch(() => { console.warn('[wifi] CORE_VIEW_UNAVAILABLE') })
  }
  /** A summary card's whole answer, while the service reads it. */
  let fullText: string | undefined

  const store = (deps.store ?? createDeviceStore)({
    dataDir: core.dataDir, machineId,
    agents: () => view.store,
    create: (packageId, engine, cwd) => core.wifi.create(packageId, engine, cwd),
    reveal: (operationId, agentId) => { core.clients.sendWindow({ target: { kind: 'first' },
      frame: { type: 'device_prepare_open', payload: { operationId, machineId, agentId } } }) },
  })

  // Built before the relay that speaks for it; a journal that does not parse leaves the Wi-Fi device off,
  // and the devices on (lib/autonomous-device/parts.ts says why).
  const build = deps.service ?? ((options) => new AutonomousDeviceService(options))
  const service = startDevicePart('Wi-Fi device service', () => build({
    store,
    resultJournal: new DeviceResultJournal(join(core.dataDir, 'device-results.json')),
    machineId,
    requestAppFocus: (agentId, expiresAt, focusRevision) => core.clients.sendWindow({ target: { kind: 'first' },
      frame: { type: 'device_focus', payload: { machineId, agentId, expiresAt, focusRevision } } }),
    stepFocus: async (direction, currentAgentId) => {
      const epoch = coreEpoch, current = () => !stopped && coreConnected && coreEpoch === epoch
      if (!current()) return 'no_agents'
      if (deps.desk) {
        const result = await deps.desk.stepFocus(direction, currentAgentId, current)
        return current() ? result : 'no_agents'
      }
      // Explicit inline mode uses the existing guarded devices port; mixed hosts keep the core route.
      if (ports.devices && !view.hasWindow) return 'no_app'
      const result = await (ports.devices?.stepFocus(direction, currentAgentId) ?? core.wifi.stepFocus(direction, currentAgentId))
      return current() ? result : 'no_agents'
    },
    scroll: (phase, dy, velocity) => {
      const current = () => !stopped && coreConnected
      if (!current()) return false
      if (deps.desk) return deps.desk.scroll(phase, dy, velocity, current)
      if (!ports.devices) return core.wifi.scroll(phase, dy, velocity)
      if (!view.hasWindow) return false
      ports.devices.scroll(phase, dy, velocity)
      return true
    },
    agents: () => view.agents,
    submit: async (agentId, text, deliveryId) => {
      const epoch = coreEpoch
      const current = (): boolean => !stopped && coreConnected && coreEpoch === epoch && service!.inputCurrent(deliveryId)
      try { await ensureFeed() } catch {
        service!.delivery({ sessionId: agentId, deliveryId, state: 'rejected', reason: 'SESSION_EVENTS_UNAVAILABLE' })
        return
      }
      if (!current()) return
      const context = async (agent: AgentView): Promise<void> => {
        try { await evidence.arm(agent, deliveryId) }
        catch {
          service!.delivery({ sessionId: agentId, deliveryId, state: 'rejected', reason: 'EVIDENCE_UNAVAILABLE' })
          return
        }
        service!.inputContext(deliveryId, agent)
      }
      if (deps.submit) { await deps.submit(agentId, text, deliveryId, context, current); return }
      const agent = await core.conversations.resolve(agentId)
      if (!current()) return
      if (!agent || agent.agentId !== agentId) {
        service!.delivery({ sessionId: agentId, deliveryId, state: 'rejected', reason: 'agent_gone' })
        return
      }
      await context(agent)
      if (!current()) return
      core.turns.deliver(agentId, text, deliveryId, { when: 'composer', current })
    },
    // Told, not asked: the one caller (an unpairing) goes on whatever the answer.
    cancelDelivery: (deliveryId) => {
      if (deps.cancel) deps.cancel(deliveryId)
      else core.turns.cancelDelivery(deliveryId)
      return true
    },
    stop: async (agentId) => {
      const epoch = coreEpoch, signal = cancellations.signal
      const current = () => !stopped && coreConnected && coreEpoch === epoch && core.machine.id() === machineId
      if (!current()) return false
      const ok = deps.stop ? await deps.stop(agentId, current, signal) : await cancelTurn({
        dataDir: core.dataDir, port: core.daemon.port, machineId,
      }, agentId, current, signal, deps.answerWork ?? inlineAnswerWork)
      return ok && current()
    },
    answer: async (agentId, requestId, answers) => {
      const original = observation, epoch = coreEpoch, generation = questionEpoch
      const current = () => !stopped && coreConnected && coreEpoch === epoch && questionEpoch === generation && observation === original
      if (!original || !current()) return false
      return await original.answer(agentId, requestId, answers, current) && current()
    },
    recent: (agentId, n) => core.turns.recent(agentId, n),
    fullText: () => fullText,
    emit: (frame, deviceId) => emit(frame, deviceId),
  }))
  if (!service) throw new Error('the Wi-Fi device service could not be started')
  const evidence = (deps.evidence ?? createDeviceEvidence)({
    pool: deps.evidencePool ?? inlineEvidencePool,
    resolve: agentId => core.conversations.resolve(agentId),
    observe: (agentId, sessionId, engine, line) => service.observeTranscript(agentId, sessionId, engine, line),
    gap: agentId => service.evidenceLost(agentId),
    needed: (agentId, sessionId, engine) => service.needsTranscript(agentId, sessionId, engine),
    failed: code => console.warn(`[wifi] ${code}`),
  })
  const feedPool = deps.feedPool ?? inlineFeedPool
  let feed: DeviceSessionFeed | null = null, feedRetries = 0
  let feedRetry: ReturnType<typeof setTimeout> | undefined
  const stopFeed = (): DeviceSessionFeed | null => {
    clearTimeout(feedRetry); feedRetry = undefined
    const previous = feed; feed = null; previous?.close()
    return previous
  }
  const applyEvents = async (agentId: string, events: readonly LiveEvent[], current: () => boolean,
    observed: Parameters<DeviceSessionFeedOptions['receive']>[1]): Promise<void> => {
    // Filesystem notifications already drive live evidence. Only a receipt boundary needs
    // an ordering drain; token/tool traffic must not turn into per-token core/file queries.
    if (events.some(event => event.type === 'turn_ended')) await evidence.flush(agentId)
    if (!current()) return
    const busyInput = submissionPolicy(view.agents.find(agent => agent.agentId === agentId)?.engine)?.typesWhileBusy === true
    for (let index = 0; index < events.length; index++) {
      const event = events[index]
      if (event.type === 'turn_started') service.turnStarted(agentId, sessionEventProof(observed[index]))
      else if (event.type === 'turn_ended' && !(busyInput && events[index + 1]?.type === 'turn_started')) service.turnEnded(agentId,
        sessionEventProof(observed[index]), event.payload.aborted === true)
    }
  }
  const ensureFeed = (): Promise<void> => {
    if (stopped || !coreConnected) return Promise.reject(new Error('SESSION_EVENTS_UNAVAILABLE'))
    if (feed) return feed.ready
    clearTimeout(feedRetry); feedRetry = undefined
    const epoch = coreEpoch
    const own = (deps.observeSessions ?? (options => observeDeviceSessions({
      dataDir: core.dataDir, port: core.daemon.port, machineId,
    }, options)))({ pool: feedPool,
      receive: async (agentId, frames, active, source) => {
        const current = () => active() && !stopped && coreConnected && coreEpoch === epoch && feed === own
        if (!current()) return
        if (frames.length === 1 && frames[0].type === 'agent_synced') { evidence.changed(agentId); changed(); return }
        if (frames.length === 1 && frames[0].type === 'agent_deleted') { service.agentGone(agentId); evidence.forget(agentId); return }
        if (frames.length === 1 && frames[0].type === 'commander_event') {
          if (source !== 'recaps' && !isLocalOnly(frames[0])) service.commander(withoutUpdate(frames[0]))
          return
        }
        const cancel = frames.length === 1 && frames[0].type === 'agent_activity' && frames[0].payload.cause === 'cancel'
        if (cancel || frames.some(frame => frame.type === 'turn_ended')) {
          // The service-link response follows earlier input notices; the adapter applies that prefix
          // before resolving. Token events make no such query. The feed retains actual handler credit.
          await core.conversations.resolve(agentId)
          if (!current()) return
        }
        if (cancel) {
          await evidence.flush(agentId)
          if (current()) service.turnEnded(agentId, sessionEventProof(frames[0]), true)
          return
        }
        if (frames.length === 1 && frames[0].type === 'agent_activity') return
        // Only consumed fields need a local interpretation contract; other normalized events retain
        // their positions so end→start adjacency cannot be invented by filtering an original batch.
        for (const frame of frames) {
          const p = frame.payload
          if (frame.type === 'text_delta' && typeof p.content !== 'string'
            || frame.type === 'turn_started' && typeof p.userMessage !== 'string'
            || frame.type === 'tool_start' && (typeof p.id !== 'string' || typeof p.tool !== 'string')
            || frame.type === 'tool_end' && (typeof p.id !== 'string' || typeof p.tool !== 'string' || typeof p.isError !== 'boolean')) throw new Error('SESSION_EVENTS_PROTOCOL')
        }
        await applyEvents(agentId, frames as unknown as readonly LiveEvent[], current, frames)
        if (current()) service.stream(agentId, frames as unknown as readonly LiveEvent[])
      },
      unavailable: code => {
        if (feed !== own || coreEpoch !== epoch || stopped || !coreConnected) return
        feed = null; own.close()
        console.warn(`[wifi] ${code}`)
        service.eventsUnavailable()
        if (feedRetries++ < 5) {
          feedRetry = setTimeout(() => { feedRetry = undefined; void ensureFeed().catch(() => {}) }, 1_000)
          feedRetry.unref?.()
        }
      },
    })
    feed = own
    void own.ready.catch(() => {})
    return own.ready
  }
  let questionEpoch = 0, retries = 0
  let observation: QuestionObservation | null = null
  let reconnect: ReturnType<typeof setTimeout> | undefined
  const stopQuestions = (): void => {
    questionEpoch++
    const previous = observation
    observation = null
    previous?.close()
    if (reconnect) clearTimeout(reconnect)
    reconnect = undefined
    retries = 0
    service.questionsUnavailable()
  }
  const unavailable = (epoch: number, code: string): void => {
    if (questionEpoch !== epoch) return
    questionEpoch++
    const previous = observation
    observation = null
    previous?.close()
    service.questionsUnavailable()
    console.warn('[wifi] QUESTION_OBSERVATION_UNAVAILABLE')
    // Reconnect a lost read connection, never a prompt effect. Contract/pressure refusal needs a new hello.
    if (relay.connected() && code === 'QUESTION_OBSERVATION_UNAVAILABLE' && retries < 5) {
      const delay = [250, 500, 1_000, 2_000, 5_000][retries++]
      reconnect = setTimeout(() => { reconnect = undefined; void ensureQuestions().catch(() => {}) }, delay)
      reconnect.unref?.()
    }
  }
  const ensureQuestions = (): Promise<void> => {
    if (observation) return observation.ready
    if (reconnect) clearTimeout(reconnect)
    reconnect = undefined
    const epoch = ++questionEpoch
    service.questionsUnavailable()
    const listener: QuestionListener = {
      begin: generation => { if (questionEpoch === epoch) service.beginQuestions(generation) },
      question: (generation, frame) => { if (questionEpoch === epoch) service.observeQuestion(generation, frame) },
      end: generation => { if (questionEpoch === epoch) service.endQuestions(generation) },
      unavailable: code => unavailable(epoch, code),
    }
    const budget = deps.answerWork ?? inlineAnswerWork
    const next = deps.observeQuestions ? deps.observeQuestions(listener, budget) : observeQuestions({
      dataDir: core.dataDir, port: core.daemon.port, machineId: core.daemon.machineId(),
    }, listener, undefined, budget)
    const ready = next.ready.then(() => {
      if (questionEpoch !== epoch) throw new Error('The original question observation ended')
      retries = 0
    })
    if (questionEpoch === epoch) observation = { ready, answer: (...args) => next.answer(...args), close: () => next.close() }
    else next.close()
    void ready.catch(() => unavailable(epoch, 'QUESTION_OBSERVATION_UNAVAILABLE'))
    return ready
  }
  // Inline composition hears the same facts directly; a process adapter feeds the port below.
  const stopInput = deps.submit ? undefined : core.turns.onInput?.(event => port.input?.(event))
  const stopDelivery = deps.submit ? undefined : core.turns.onDelivery(event => port.delivery(event))
  const stopAgents = core.agents.follow?.(event => service.agentLife(event))

  const relay = deviceRelayOverGateway({
    dataDir: core.dataDir, port: deps.peer?.port ?? core.daemon.port,
    key: devicePeerKey(deps.peer?.composition ?? 'services', deps.peer?.token === undefined ? undefined : { HARNESSD_SERVICE_TOKEN: deps.peer.token }),
    service, machineId,
    maySend: () => coreConnected && !stopped && applied === notices,
    clientChanged: () => { if (!relay.connected()) stopQuestions() },
    card: async (frame, text, peerCurrent) => {
      const origin = feed, epoch = coreEpoch
      const current = () => peerCurrent() && origin !== null && feed === origin && coreEpoch === epoch && coreConnected && !stopped
      if (!current()) return
      const payload = frame.payload as Record<string, unknown>
      if (payload.kind === 'summary') {
        try { await origin!.barrier(String(frame.agentId)) }
        catch { console.warn('[wifi] SESSION_SUMMARY_UNAVAILABLE'); throw new Error('SESSION_SUMMARY_UNAVAILABLE') }
        if (!current()) return
      }
      fullText = text
      try { service.commander(frame) } finally { fullText = undefined }
    },
    failed: code => console.warn(`[wifi] ${code}`),
    beforeReady: async () => { await ensureFeed(); await ensureQuestions() },
    beforeRequest: refresh,
  })
  function emit(frame: AutonomousDeviceFrame, deviceId?: string): void {
    relay.emit(frame, deviceId)
  }

  /** The window's focus moves in the order the windows moved it, each against the agents as they are. */
  let focusing: Promise<void> = Promise.resolve()
  const focusWork = deps.focusWork ?? inlineFocusWork

  const port: WifiPort = {
    resume: async ({ focus }) => {
      stopFeed(); feedRetries = 0
      cancellations.abort(); cancellations = new AbortController()
      coreConnected = true
      const epoch = ++coreEpoch
      notices++
      if (focus) port.appFocus(focus.machineId, focus.agentId, focus.connId).catch(() => { /* said by the move itself */ })
      await refresh()
      if (!stopped && coreConnected && coreEpoch === epoch) {
        evidence.connected(); await ensureFeed()
        if (!stopped && coreConnected && coreEpoch === epoch) relay.start()
      }
    },
    input: (event) => {
      service.inputProgress(event)
      evidence.input(event)
    },
    disconnected: () => { coreConnected = false; coreEpoch++; cancellations.abort(); stopQuestions(); stopFeed(); evidence.disconnected(); void relay.stop(); service.coreDisconnected() },
    delivery: (event) => {
      service.delivery(event)
      if (event.state === 'completed' || event.state === 'rejected') evidence.settled(event.sessionId, event.deliveryId)
    },
    appFocus: (machineId, agentId, connId) => {
      if (stopped || !coreConnected) return Promise.reject(new Error('CORE_VIEW_UNAVAILABLE'))
      const epoch = coreEpoch
      const release = focusWork.reserve({ machineId, agentId, connId })
      if (!release) {
        port.disconnected()
        console.warn('[wifi] WIFI_FOCUS_BACKPRESSURE')
        return Promise.reject(new Error('WIFI_FOCUS_BACKPRESSURE'))
      }
      const current = () => !stopped && coreConnected && coreEpoch === epoch
      let resolve!: () => void, reject!: (error: unknown) => void
      const reply = new Promise<void>((done, fail) => { resolve = done; reject = fail })
      const timer = setTimeout(() => {
        if (current()) { port.disconnected(); console.warn('[wifi] WIFI_FOCUS_TIMEOUT') }
        reject(new Error('WIFI_FOCUS_TIMEOUT'))
      }, 15_000)
      timer.unref?.()
      const actual = focusing.then(async () => {
        if (!current()) return
        await refresh()
        if (current()) service.appFocus(machineId, agentId, connId)
      })
      // Logical timeout revokes authority; only actual handler settlement releases the retained charge.
      focusing = actual.then(() => { clearTimeout(timer); release(); resolve() }, error => {
        clearTimeout(timer); release(); reject(error)
      })
      return reply
    },
    revealed: (operationId, agentId) => store.acknowledgeReveal(operationId, agentId),
    stop: async () => { stopped = true; coreEpoch++; cancellations.abort(); stopQuestions(); const feed = stopFeed(); stopInput?.(); stopDelivery?.(); stopAgents?.(); store.stopUiDelivery(); await Promise.all([relay.stop(), evidence.stop(), feed?.stop()]) },
  }
  store.startUiDelivery()
  ports.wifi = port
  // A refusal of the add-on layer is said under its own code (`DeviceAddonError`); any other failure fails the
  // request, which its route answers as for a service that is down, since what failed may have been done.
  return {
    wifi_serving: () => ({ serving: !stopped && coreConnected }),
    wifi_focus_current: async ({ revision }) => {
      if (typeof revision !== 'string' || !revision || revision.length > 128) return { current: false }
      const epoch = coreEpoch
      await focusing
      return { current: !stopped && coreConnected && coreEpoch === epoch && service.focusSnapshot().focusRevision === revision }
    },
    wifi_http: deviceRoutes({
      receipt: ({ deviceId, idempotencyKey }) => ({ receipt: service.receipt(deviceId, idempotencyKey) }),
      addonState: ({ deviceId }) => ({ devices: service.addons.state(deviceId) }),
      addonPropose: (proposal) => ({ proposal: service.addons.propose(proposal) }),
      addonProposal: ({ proposalId }) => {
        const proposal = service.addons.proposal(proposalId)
        // Never sent, or aged out: said as such, so a script can tell it from a proposal.
        if (!proposal) throw deviceRefusal('PROPOSAL_UNKNOWN', 'No such proposal: never sent, or aged out after ten minutes')
        return { proposal }
      },
    }),
  }
}
