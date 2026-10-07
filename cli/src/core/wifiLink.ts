/**
 * The Wi-Fi device's service in the devices' process (services/wifiProcess.ts), as the core sees it: the
 * port the core calls (`WifiPort`) and what the core answers when the service asks (step 9, D3).
 *
 * Everything the core tells it is a notice on its link, in the order the core said it, so a request, the
 * prompt it sends and the transcript lines that prove it reach the service as they happened here; dropped
 * while it is down, as a frame lost on the way is, which its devices retry by the same key. What the
 * service needs to start over (the sessions, which of them said hello, the window's focus) the core keeps
 * and says again each time it connects (core/wifi.ts `started`). The one question the core asks it is a
 * person's (`harness device receipt`), with a deadline.
 *
 * What it asks of the core is `CoreApi`'s Wi-Fi doors, as it would call them in the core's process:
 * the agents as it lists them, a stop, an answer, an agent made for a Store harness, a step along the desk
 * and a recent turn, as queries; the rest as notices.
 */
import type { AutonomousDeviceReceipt } from '../lib/autonomous-device/service.js'
import { WIFI_FALLBACKS, readFallback, type CoreApi, type WifiPort, type WifiReceipt } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'

export interface WifiLinkDeps {
  core: CoreApi
  /** A notice for the service's process; false when it is not connected to hear it. */
  notify(frame: ServiceFrame): boolean
  /** A request to the service's process, answered SERVICE_UNAVAILABLE when it is down or slow. */
  call(type: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>
  log?: (line: string) => void
}

/** How long `harness device receipt` waits for the service. */
export const WIFI_WAIT_MS = 5_000

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

export function createWifiLink(deps: WifiLinkDeps) {
  const { core } = deps
  const log = deps.log ?? ((line: string) => console.warn(line))
  const event = (kind: string, payload: Record<string, unknown> = {}): void => { deps.notify({ type: 'service_event', payload: { ...payload, kind } }) }

  const port: WifiPort = {
    session: (connId, client) => event('session', { connId, client }),
    request: async (connId, frame, opened) => event('request', { connId, frame, opened }),
    dropped: (connId) => event('dropped', { connId }),
    revoked: (identity) => event('revoked', { identity }),
    resume: async (state) => event('resume', { ...state }),
    card: (frame, fullText) => event('card', { frame, ...(fullText === undefined ? {} : { fullText }) }),
    turnStarted: (agentId) => event('turnStarted', { agentId }),
    turnEnded: (agentId, aborted) => event('turnEnded', { agentId, aborted }),
    stream: (agentId, events) => event('stream', { agentId, events }),
    transcript: (agentId, sessionId, engine, line) => event('transcript', { agentId, sessionId, engine, line }),
    delivery: (delivery) => event('delivery', { event: delivery }),
    dispatched: (agentId, deliveryId, said, sessionId) => event('dispatched', { agentId, deliveryId, text: said, ...(sessionId === undefined ? {} : { sessionId }) }),
    inputStatus: (status) => event('inputStatus', { event: status }),
    agentGone: (agentId) => event('agentGone', { agentId }),
    appFocus: async (machineId, agentId, connId) => event('appFocus', { machineId, agentId, connId }),
    revealed: (operationId, agentId) => event('revealed', { operationId, agentId }),
    receipt: async (deviceId, idempotencyKey) => {
      const answer = await deps.call('receipt', { deviceId, idempotencyKey }, WIFI_WAIT_MS)
      if (typeof answer.error === 'string') return readFallback(WIFI_FALLBACKS.receipt).value as WifiReceipt
      return { receipt: (answer.receipt ?? null) as AutonomousDeviceReceipt | null }
    },
    // Its own process: the master stops it.
    stop: async () => {},
  }

  /** What the service may ask of the core (`service_query`), by name. */
  const queries: Record<string, (payload: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>> = {
    // Which machine this is (the account's id, which every frame to a device carries), asked as it connects.
    machine: () => ({ id: core.machine.id() }),
    view: async () => ({ ...await core.wifi.view() }),
    // Asked, not told: the pane's lock says what became of the prompt as it takes it, and the device's reply
    // carries that, as it did when the service ran in the core's process.
    submit: async ({ agentId, text: said, deliveryId }) => {
      await core.wifi.submit(text(agentId), text(said), text(deliveryId))
      return {}
    },
    recent: async ({ agentId, n }) => ({ turns: await core.turns.recent(text(agentId), typeof n === 'number' ? n : 3) }),
    stop: async ({ agentId }) => ({ ok: await core.wifi.stop(text(agentId)) }),
    // The question's id travels as `questionRequestId`: a query's own `requestId` is the link's.
    answer: async ({ agentId, questionRequestId, answers }) =>
      ({ ok: await core.wifi.answer(text(agentId), text(questionRequestId), object(answers) as Record<string, string>) }),
    create: async ({ packageId, engine, cwd }) => ({ ...await core.wifi.create(text(packageId), text(engine), text(cwd)) }),
    stepFocus: async ({ direction, currentAgentId }) => {
      const step = await core.wifi.stepFocus(direction === 'previous' ? 'previous' : 'next', typeof currentAgentId === 'string' ? currentAgentId : undefined)
      return typeof step === 'string' ? { step } : { ...step }
    },
  }

  /** What the service tells the core without asking (`service_notice`), by kind. */
  const notices: Record<string, (payload: Record<string, unknown>) => void> = {
    cancel: ({ deliveryId }) => core.wifi.cancel(text(deliveryId)),
    started: ({ agentId, text: said }) => core.wifi.started(text(agentId), text(said)),
    scroll: ({ phase, dy, velocity }) => { if (phase === 'down' || phase === 'move' || phase === 'up') core.wifi.scroll(phase, number(dy), number(velocity)) },
    focusApp: ({ agentId, expiresAt, focusRevision }) => { core.wifi.focusApp(text(agentId), number(expiresAt), text(focusRevision)) },
    reveal: ({ operationId, agentId }) => core.wifi.reveal(text(operationId), text(agentId)),
    send: ({ connId, identity, type, payload }) => core.wifi.send(text(connId), text(identity), text(type), object(payload)),
    hello: ({ connId, identity }) => core.wifi.hello(text(connId), typeof identity === 'string' ? identity : null),
    joined: () => core.wifi.joined(),
    ready: () => core.wifi.ready(),
    unpaired: ({ identity }) => core.wifi.unpaired(text(identity)),
    focus: ({ revision }) => core.wifi.focus(text(revision)),
    transcripts: ({ agentId, seen }) => core.wifi.transcripts(text(agentId), number(seen)),
    watching: ({ agentIds }) => core.wifi.watching(strings(agentIds)),
    streams: ({ agentIds }) => core.wifi.streams(strings(agentIds)),
  }

  return {
    port,
    answer(query: string, payload: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>> {
      const ask = Object.hasOwn(queries, query) ? queries[query] : undefined
      return ask ? ask(payload) : { error: 'UNKNOWN_QUERY' }
    },
    notice(payload: Record<string, unknown>): void {
      const kind = text(payload.kind)
      const tell = Object.hasOwn(notices, kind) ? notices[kind] : undefined
      if (!tell) { log(`[services] wifi said ${kind.slice(0, 40) || 'nothing'}, which the core does not hear`); return }
      tell(payload)
    },
  }
}

export type WifiLink = ReturnType<typeof createWifiLink>
