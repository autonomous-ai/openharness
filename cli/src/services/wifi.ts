/**
 * The Wi-Fi device (lib/autonomous-device/, docs/autonomous-device-integration.md): a paired device that
 * speaks its own protocol over an E2EE session the gateway holds. Its service, its Store preparations and
 * its relay run here, with the dials in the devices' process (step 9, D3), on `CoreApi` alone: a fault in
 * it costs the devices, never a session (docs/design/2026-10-06-core-boundary-next.md).
 *
 * What the service reads in line while it answers (the agents, the Store's evidence on them, whether a
 * window is there) is the core's answer to `view`, asked again before each request and each move of the
 * window's focus, so what it answers is as fresh as when it ran in the core. What the core reads in line
 * of it (transcript/stream interests) is acknowledged by the following ordered
 * view query before a dependent direct reply leaves here. Relay sessions come from the gateway peer.
 *
 * What a person asks of it on this computer (`harness device receipt`, `harness autonomous-device addon`) comes as its
 * routes of the door, handed on by the core as they came (core/serviceRoutes.ts) and checked here
 * (lib/autonomous-device/localHttp.ts).
 */
import { join } from 'node:path'
import type { AgentView, CoreApi, CorePorts, ServiceRequests, WifiPort, WifiView } from '../core/api.js'
import { submissionPolicy } from '../engines/submissionPolicies.js'
import { startDevicePart } from '../lib/autonomous-device/parts.js'
import { deviceRelayOverGateway } from '../lib/autonomous-device/overGateway.js'
import { devicePeerKey } from '../lib/autonomous-device/peerEndpoint.js'
import { DeviceResultJournal } from '../lib/autonomous-device/resultJournal.js'
import { AutonomousDeviceService, type AutonomousDeviceFrame } from '../lib/autonomous-device/service.js'
import { deviceRefusal, deviceRoutes } from '../lib/autonomous-device/localHttp.js'
import { createDeviceStore } from '../lib/autonomous-device/storeRuntime.js'
import { observeQuestions, type QuestionListener, type QuestionObservation } from '../agentClient/questions.js'

export { WIFI_FALLBACKS, WIFI_REQUESTS } from '../core/api.js'

export interface WifiDeps {
  /** Explicit composition: an absent service token never silently creates an unrelated peer authority. */
  peer?: { composition: 'inline' | 'services'; port: number; token?: string }
  /** Swapped in tests, to reach what the service and the Store are given. */
  service?: (options: ConstructorParameters<typeof AutonomousDeviceService>[0]) => AutonomousDeviceService
  store?: typeof createDeviceStore
  /** Process adapter: captures one core connection through capability probe, read and submit. */
  submit?: (agentId: string, text: string, deliveryId: string, context: (agent: AgentView) => void, current?: () => boolean) => Promise<void>
  cancel?: (deliveryId: string) => void
  /** Same authenticated local tool transport in an external process and explicit inline mode. */
  observeQuestions?: (listener: QuestionListener) => QuestionObservation
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, i) => item === b[i])

export function startWifi(core: CoreApi, ports: CorePorts, deps: WifiDeps = {}): ServiceRequests {
  const machineId = core.machine.id()
  let view: WifiView = { agents: [], store: [], hasWindow: false }
  let stopped = false, coreConnected = true, coreEpoch = 0, notices = 0, applied = 0
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
    pending.promise = core.wifi.view().then(next => {
      if (stopped || !coreConnected || coreEpoch !== epoch) throw new Error('CORE_VIEW_UNAVAILABLE')
      view = next; applied = revision
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
  /** How many of an agent's prompts the core told of: the core stops sending its lines as of the count. */
  const seen = new Map<string, number>()
  let streamed: string[] = []

  const store = (deps.store ?? createDeviceStore)({
    dataDir: core.dataDir, machineId,
    agents: () => view.store,
    create: (packageId, engine, cwd) => core.wifi.create(packageId, engine, cwd),
    reveal: (operationId, agentId) => core.wifi.reveal(operationId, agentId),
  })

  // Built before the relay that speaks for it; a journal that does not parse leaves the Wi-Fi device off,
  // and the devices on (lib/autonomous-device/parts.ts says why).
  const build = deps.service ?? ((options) => new AutonomousDeviceService(options))
  const service = startDevicePart('Wi-Fi device service', () => build({
    store,
    resultJournal: new DeviceResultJournal(join(core.dataDir, 'device-results.json')),
    machineId,
    requestAppFocus: (agentId, expiresAt, focusRevision) => core.wifi.focusApp(agentId, expiresAt, focusRevision),
    stepFocus: (direction, currentAgentId) => core.wifi.stepFocus(direction, currentAgentId),
    scroll: (phase, dy, velocity) => core.wifi.scroll(phase, dy, velocity),
    agents: () => view.agents,
    submit: async (agentId, text, deliveryId) => {
      const context = (agent: AgentView): void => service!.inputContext(deliveryId, agent)
      const current = (): boolean => service!.inputCurrent(deliveryId)
      if (deps.submit) { await deps.submit(agentId, text, deliveryId, context, current); return }
      const agent = await core.conversations.resolve(agentId)
      if (!current()) return
      if (!agent || agent.agentId !== agentId) {
        service!.delivery({ sessionId: agentId, deliveryId, state: 'rejected', reason: 'agent_gone' })
        return
      }
      context(agent)
      core.turns.deliver(agentId, text, deliveryId, { when: 'composer', current })
    },
    // Told, not asked: the one caller (an unpairing) goes on whatever the answer.
    cancelDelivery: (deliveryId) => {
      if (deps.cancel) deps.cancel(deliveryId)
      else core.turns.cancelDelivery(deliveryId)
      return true
    },
    stop: (agentId) => core.wifi.stop(agentId),
    answer: (agentId, requestId, answers) => core.wifi.answer(agentId, requestId, answers),
    recent: (agentId, n) => core.turns.recent(agentId, n),
    fullText: () => fullText,
    emit: (frame, deviceId) => emit(frame, deviceId),
  }))
  if (!service) throw new Error('the Wi-Fi device service could not be started')
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
    const next = deps.observeQuestions ? deps.observeQuestions(listener) : observeQuestions({
      dataDir: core.dataDir, port: core.daemon.port, machineId: core.daemon.machineId(),
    }, listener)
    const ready = next.ready.then(() => {
      if (questionEpoch !== epoch) throw new Error('The original question observation ended')
      retries = 0
    })
    if (questionEpoch === epoch) observation = { ready, close: () => next.close() }
    else next.close()
    void ready.catch(() => unavailable(epoch, 'QUESTION_OBSERVATION_UNAVAILABLE'))
    return ready
  }
  // Inline composition hears the same facts directly; a process adapter feeds the port below.
  const stopInput = deps.submit ? undefined : core.turns.onInput?.(event => port.input?.(event))
  const stopDelivery = deps.submit ? undefined : core.turns.onDelivery(event => service.delivery(event))
  const stopAgents = core.agents.follow?.(event => service.agentLife(event))

  /** Which streams and which transcripts it follows, told to the core as they change. */
  const reportStreams = (): void => {
    const now = service.streamedAgents().sort()
    if (same(now, streamed)) return
    streamed = now
    core.wifi.streams(now)
    changed()
  }
  const reportTranscript = (agentId: string): void => {
    if (!service.watchesTranscript(agentId)) core.wifi.transcripts(agentId, seen.get(agentId) ?? 0)
  }

  const relay = deviceRelayOverGateway({
    dataDir: core.dataDir, port: deps.peer?.port ?? core.daemon.port,
    key: devicePeerKey(deps.peer?.composition ?? 'services', deps.peer?.token === undefined ? undefined : { HARNESSD_SERVICE_TOKEN: deps.peer.token }),
    service, machineId,
    beforeSend: reportStreams,
    maySend: () => coreConnected && !stopped && applied === notices,
    clientChanged: () => { if (!relay.connected()) stopQuestions() },
    failed: code => console.warn(`[wifi] ${code}`),
    beforeReady: ensureQuestions,
    beforeRequest: refresh,
  })
  function emit(frame: AutonomousDeviceFrame, deviceId?: string): void {
    relay.emit(frame, deviceId)
  }

  /** The window's focus moves in the order the windows moved it, each against the agents as they are. */
  let focusing: Promise<void> = Promise.resolve()

  const port: WifiPort = {
    resume: async ({ focus }) => {
      coreConnected = true
      const epoch = ++coreEpoch
      // The core starts over from what this run follows (it has forgotten, or never knew).
      seen.clear()
      core.wifi.watching(service.transcriptWatches())
      streamed = service.streamedAgents().sort()
      core.wifi.streams(streamed)
      notices++
      if (focus) port.appFocus(focus.machineId, focus.agentId, focus.connId).catch(() => { /* said by the move itself */ })
      await refresh()
      if (!stopped && coreConnected && coreEpoch === epoch) relay.start()
    },
    card: (frame, text) => {
      if (frame.type === 'commander_question' || frame.type === 'commander_question_close') return
      fullText = text
      try { service.commander(frame) } finally { fullText = undefined }
    },
    turnEnded: (agentId, aborted) => service.turnEnded(agentId, aborted),
    events: (agentId, events) => {
      const busyInput = submissionPolicy(view.agents.find(agent => agent.agentId === agentId)?.engine)?.typesWhileBusy === true
      for (let index = 0; index < events.length; index++) {
        const event = events[index]
        if (event.type === 'turn_started') service.turnStarted(agentId)
        else if (event.type === 'turn_ended' && !(busyInput && events[index + 1]?.type === 'turn_started')) service.turnEnded(agentId, event.payload.aborted === true)
      }
    },
    input: (event) => {
      const watching = service.watchesTranscript(event.agentId)
      if (event.phase === 'dispatching' && event.deliveryId && event.content !== undefined) seen.set(event.agentId, (seen.get(event.agentId) ?? 0) + 1)
      service.inputProgress(event)
      // In the inline composition there is no process maker to arm the existing transcript feed.
      if (!deps.submit && !watching && service.watchesTranscript(event.agentId)) core.wifi.watching(service.transcriptWatches())
      reportTranscript(event.agentId)
    },
    disconnected: () => { coreConnected = false; coreEpoch++; stopQuestions(); void relay.stop(); service.coreDisconnected() },
    stream: (agentId, events) => service.stream(agentId, events),
    transcript: (agentId, sessionId, engine, line) => {
      service.observeTranscript(agentId, sessionId, engine, line)
      reportTranscript(agentId)
    },
    delivery: (event) => service.delivery(event),
    agentGone: (agentId) => {
      service.agentGone(agentId)
      reportTranscript(agentId)
    },
    appFocus: (machineId, agentId, connId) => {
      const epoch = coreEpoch
      const moved = focusing.then(refresh).then(() => {
        // Stop, disconnect and resume all revoke this captured epoch, including after refresh settled.
        if (coreEpoch !== epoch) return
        service.appFocus(machineId, agentId, connId)
      })
      // A move that fails is that move's: the next waits for it, not on it.
      focusing = moved.catch(() => {})
      return moved
    },
    revealed: (operationId, agentId) => store.acknowledgeReveal(operationId, agentId),
    stop: async () => { stopped = true; coreEpoch++; stopQuestions(); stopInput?.(); stopDelivery?.(); stopAgents?.(); store.stopUiDelivery(); await relay.stop() },
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
