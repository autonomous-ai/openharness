/**
 * The Wi-Fi device (lib/autonomous-device/, docs/autonomous-device-integration.md): a paired device that
 * speaks its own protocol over an E2EE session the gateway holds. Its service, its Store preparations and
 * its relay run here, with the dials in the devices' process (step 9, D3), on `CoreApi` alone: a fault in
 * it costs the devices, never a session (docs/design/2026-10-06-core-boundary-next.md).
 *
 * What the service reads in line while it answers (the agents, the Store's evidence on them, whether a
 * window is there) is the core's answer to `view`, asked again before each request and each move of the
 * window's focus, so what it answers is as fresh as when it ran in the core. What the core reads in line
 * of it (which devices said hello, which transcripts and streams it follows, the focus revision) it is
 * told before anything that depends on it leaves here (core/wifi.ts).
 */
import { join } from 'node:path'
import type { CoreApi, CorePorts, RemoteClient, WifiPort, WifiView } from '../core/api.js'
import { startDevicePart } from '../lib/autonomous-device/parts.js'
import { deviceRelayOverGateway } from '../lib/autonomous-device/overGateway.js'
import { DeviceResultJournal } from '../lib/autonomous-device/resultJournal.js'
import { AutonomousDeviceService, type AutonomousDeviceFrame } from '../lib/autonomous-device/service.js'
import { createDeviceStore } from '../lib/autonomous-device/storeRuntime.js'

export { WIFI_FALLBACKS } from '../core/api.js'

export interface WifiDeps {
  /** Swapped in tests, to reach what the service and the Store are given. */
  service?: (options: ConstructorParameters<typeof AutonomousDeviceService>[0]) => AutonomousDeviceService
  store?: typeof createDeviceStore
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, i) => item === b[i])

export function startWifi(core: CoreApi, ports: CorePorts, deps: WifiDeps = {}): void {
  const machineId = core.machine.id()
  let view: WifiView = { agents: [], store: [], hasWindow: false }
  /** One ask of the core at a time: requests arriving together share it, and are answered in order. */
  let viewing: Promise<void> | null = null
  const refresh = (): Promise<void> => {
    viewing ??= core.wifi.view()
      .then((next) => { view = next })
      .catch(() => { /* the core went away: the next ask is answered by its next connection */ })
      .finally(() => { viewing = null })
    return viewing
  }

  /** The device sessions the gateway holds, as the core said. */
  const sessions = new Map<string, RemoteClient>()
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
    inputConsumed: (agentId, text) => core.wifi.started(agentId, text),
    machineId,
    requestAppFocus: (agentId, expiresAt, focusRevision) => core.wifi.focusApp(agentId, expiresAt, focusRevision),
    stepFocus: (direction, currentAgentId) => core.wifi.stepFocus(direction, currentAgentId),
    scroll: (phase, dy, velocity) => core.wifi.scroll(phase, dy, velocity),
    agents: () => view.agents,
    submit: (agentId, text, deliveryId) => core.wifi.submit(agentId, text, deliveryId),
    // Told, not asked: the one caller (an unpairing) goes on whatever the answer.
    cancelDelivery: (deliveryId) => { core.wifi.cancel(deliveryId); return true },
    stop: (agentId) => core.wifi.stop(agentId),
    answer: (agentId, requestId, answers) => core.wifi.answer(agentId, requestId, answers),
    recent: (agentId, n) => core.turns.recent(agentId, n),
    fullText: () => fullText,
    emit: (frame, deviceId) => emit(frame, deviceId),
  }))
  if (!service) throw new Error('the Wi-Fi device service could not be started')

  /** Which streams and which transcripts it follows, told to the core as they change. */
  const reportStreams = (): void => {
    const now = service.streamedAgents().sort()
    if (same(now, streamed)) return
    streamed = now
    core.wifi.streams(now)
  }
  const reportTranscript = (agentId: string): void => {
    if (!service.watchesTranscript(agentId)) core.wifi.transcripts(agentId, seen.get(agentId) ?? 0)
  }

  const relay = deviceRelayOverGateway({
    client: (connId) => sessions.get(connId),
    // Only to a session it found here (`client` above): the core checks it is still that identity's.
    send: (connId, type, payload) => {
      // A subscription's answer leaves after the core knows to send its agent's tool events.
      reportStreams()
      core.wifi.send(connId, sessions.get(connId)!.identity, type, payload)
    },
    service, machineId,
    onReady: () => core.wifi.joined(),
    onRemoteRevoke: (identity) => core.wifi.unpaired(identity),
    onClient: (connId, identity) => core.wifi.hello(connId, identity),
  })
  function emit(frame: AutonomousDeviceFrame, deviceId?: string): void {
    // The revision a window's delayed selection is checked against, before anything that carries it.
    if (frame.kind === 'focus.changed') {
      const revision = (frame.payload as { focusRevision?: unknown } | undefined)?.focusRevision
      if (typeof revision === 'string') core.wifi.focus(revision)
    }
    relay.emit(frame, deviceId)
  }

  /** The window's focus moves in the order the windows moved it, each against the agents as they are. */
  let focusing: Promise<void> = Promise.resolve()

  const port: WifiPort = {
    session: (connId, client) => {
      if (client) sessions.set(connId, client)
      else sessions.delete(connId)
    },
    // Answered against the agents as they are now; taken (the relay opens it before its first wait) before
    // anything the core says after it, as it was in the core's process.
    request: async (connId, frame, opened) => {
      await refresh()
      // Answered on its own time; one that fails is that request's, said, and the next is answered.
      relay.handle(connId, frame, opened).catch((error: unknown) => {
        console.warn(`[wifi] a device's request failed · ${error instanceof Error ? error.message : String(error)}`)
      })
    },
    dropped: (connId) => relay.drop(connId),
    revoked: (identity) => relay.revoke(identity),
    resume: async ({ sessions: held, helloed, focus }) => {
      sessions.clear()
      for (const { connId, client } of held) sessions.set(connId, client)
      // A session this run served that the core no longer holds (the core restarted, and the relay with it).
      const kept = new Set(helloed.map(({ connId }) => connId))
      for (const connId of relay.helloed()) if (!kept.has(connId)) relay.drop(connId)
      // The core starts over from what this run follows (it has forgotten, or never knew).
      seen.clear()
      core.wifi.watching(service.transcriptWatches())
      streamed = service.streamedAgents().sort()
      core.wifi.streams(streamed)
      core.wifi.focus(service.focusSnapshot().focusRevision)
      if (focus) port.appFocus(focus.machineId, focus.agentId, focus.connId).catch(() => { /* said by the move itself */ })
      await refresh()
      for (const { connId, identity } of helloed) relay.restore(connId, identity)
      if (helloed.length) core.wifi.joined()
      core.wifi.ready()
    },
    card: (frame, text) => {
      fullText = text
      try { service.commander(frame) } finally { fullText = undefined }
    },
    turnStarted: (agentId) => service.turnStarted(agentId),
    turnEnded: (agentId, aborted) => service.turnEnded(agentId, aborted),
    stream: (agentId, events) => service.stream(agentId, events),
    transcript: (agentId, sessionId, engine, line) => {
      service.observeTranscript(agentId, sessionId, engine, line)
      reportTranscript(agentId)
    },
    delivery: (event) => service.delivery(event),
    dispatched: (agentId, deliveryId, text, sessionId) => {
      seen.set(agentId, (seen.get(agentId) ?? 0) + 1)
      service.inputDispatched(agentId, deliveryId, text, sessionId)
      reportTranscript(agentId)
    },
    inputStatus: (event) => service.inputStatus(event),
    agentGone: (agentId) => {
      service.agentGone(agentId)
      reportTranscript(agentId)
    },
    appFocus: (machineId, agentId, connId) => {
      const moved = focusing.then(refresh).then(() => service.appFocus(machineId, agentId, connId))
      // A move that fails is that move's: the next waits for it, not on it.
      focusing = moved.catch(() => {})
      return moved
    },
    revealed: (operationId, agentId) => store.acknowledgeReveal(operationId, agentId),
    receipt: async (deviceId, idempotencyKey) => ({ receipt: service.receipt(deviceId, idempotencyKey) }),
    stop: async () => store.stopUiDelivery(),
  }
  store.startUiDelivery()
  ports.wifi = port
}
