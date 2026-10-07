/**
 * The devices in a process of their own (services/devicesProcess.ts), as the core sees them: the port the
 * core calls (`DevicesPort`) and what the core answers when the devices ask (docs/design/2026-10-06-core-
 * boundary-next.md, step 9, D2).
 *
 * The core never waits on them. What it tells them (a card, the desk, a window's answer) is a notice on
 * their link, dropped while they are down, since the core keeps the state they need and says it again
 * when they connect. What it asks of them (⌘K, the Wi-Fi device's step along the desk) is a request on
 * the link with a deadline and an answer for when they do not give one: a hung devices process costs ⌘K
 * its answer, never a window's typing or an agent's turn.
 *
 * What they ask of the core is the core's API, as a service in the core's process would call it: this
 * computer's agents as the dial lists them (asked as the dial's tick or ⌘K needs them, and with them this
 * computer, the sign-in and whether a window is there), a turn, a stop, an answer, a pane's activity line,
 * a token for the transcriber and the fleet's lane, the lane's sealing (the gateway's), the machine list,
 * and the frames for the windows.
 * The one-way ones come as notices, the rest as queries.
 */
import type { AppSwarms } from '../cable/cableSession.js'
import type { UnreadNotification } from '../lib/notificationRead.js'
import type { ReviewedAnswer } from '../cable/questionInbox.js'
import { DEVICES_FALLBACKS, readFallback, type CoreApi, type DeviceBridgeFrame, type DevicesPort, type DeviceWindowFrame, type RouteAnswer, type SendResult, type WindowFocus } from './api.js'
import { answerAccountQuery } from './accountQueries.js'
import type { ServiceFrame } from './serviceLinks.js'

/** What the core keeps for the devices, and says again whenever they connect. */
export interface DevicesState {
  desk: string[]
  foreground: boolean
  swarms: AppSwarms | null
  unread: UnreadNotification[]
  focus: WindowFocus
  engines: string[]
  commanders: boolean
}

export interface DevicesLinkDeps {
  core: CoreApi
  /** A notice for the devices' process; false when it is not connected to hear it. */
  notify(frame: ServiceFrame): boolean
  /** A request to the devices' process, answered SERVICE_UNAVAILABLE when it is down or slow. */
  call(type: string, payload: Record<string, unknown>, waitMs: number): Promise<Record<string, unknown>>
  /** What the windows last said: the desk, the tabs, what is unread, which window has the person's
   *  attention; and the engines here and whether a device watches through the backend. */
  state(): DevicesState
  log?: (line: string) => void
}

/** How long ⌘K waits for the devices to pick an agent: the classifier has 20 s (services/fleet.ts). */
export const ROUTE_TASK_WAIT_MS = 25_000
/** How long anything else waits for them: a send, a step along the desk. */
export const DEVICES_WAIT_MS = 5_000

const fallback = <T>(member: keyof typeof DEVICES_FALLBACKS): T => readFallback(DEVICES_FALLBACKS[member]).value as T
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const isFrame = (value: unknown): value is { type: string; payload: Record<string, unknown> } =>
  !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
  && !!(value as { payload?: unknown }).payload && typeof (value as { payload?: unknown }).payload === 'object'

export function createDevicesLink(deps: DevicesLinkDeps) {
  const { core } = deps
  const log = deps.log ?? ((line: string) => console.warn(line))
  const event = (kind: string, payload: Record<string, unknown> = {}): void => { deps.notify({ type: 'service_event', payload: { ...payload, kind } }) }
  /** An answer from the devices, or the port's fallback when there was none (down, slow, or failed). */
  const answered = <T>(answer: Record<string, unknown>, member: keyof typeof DEVICES_FALLBACKS, read: (answer: Record<string, unknown>) => T): T =>
    typeof answer.error === 'string' ? fallback<T>(member) : read(answer)
  let dialWatching = false

  const port: DevicesPort = {
    card: (frame) => event('card', { frame }),
    desk: (agentIds, foreground) => event('desk', { agentIds, foreground }),
    swarms: (swarms) => event('swarms', { swarms }),
    unread: (items) => event('unread', { items }),
    appFocus: (machineId, agentId) => event('appFocus', { machineId, agentId }),
    seen: (agentId, readToken) => event('seen', { agentId, ...(readToken === undefined ? {} : { readToken }) }),
    settings: (id, patch) => event('settings', { id, patch }),
    windowFocus: (focus) => event('windowFocus', { focus }),
    windowReply: (which, connId, machineId, reply) => event('windowReply', { which, connId, machineId, reply }),
    voiceReply: (voiceId, reply) => event('voiceReply', { voiceId, reply }),
    windowGone: (connId) => event('windowGone', { connId }),
    routeTask: async (task) => answered(await deps.call('routeTask', { text: task }, ROUTE_TASK_WAIT_MS), 'routeTask', (answer) => answer as unknown as RouteAnswer),
    routeSend: async (agentId, task) => answered(await deps.call('routeSend', { agentId, text: task }, DEVICES_WAIT_MS), 'routeSend',
      (answer) => answer as unknown as SendResult),
    stepFocus: async (direction, currentAgentId) => answered(await deps.call('stepFocus', { direction, ...(currentAgentId ? { currentAgentId } : {}) }, DEVICES_WAIT_MS),
      'stepFocus', (answer) => (answer.step === 'no_agents' ? 'no_agents' : { machineId: text(answer.machineId), agentId: text(answer.agentId) })),
    scroll: (phase, dy, velocity) => event('scroll', { phase, dy, velocity }),
    engines: (engines) => event('engines', { engines }),
    commanders: (connected) => event('commanders', { connected }),
    // Their own process: the master stops it, and a core that restarts leaves it running with the dial.
    stop: async () => {},
  }

  /** A dial on the wire, or none any more, as the devices said last: the core makes the cards for it. */
  const watching = (on: boolean): void => {
    dialWatching = on
    core.clients.dialWatching(on)
  }

  /** What the devices may ask of the core (`service_query`), by name. */
  const queries: Record<string, (payload: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>> = {
    // This computer's agents as the dial lists them, and what else the dial reads in line: asked as its
    // tick or ⌘K builds a list, so the devices read the registry as it is then.
    view: () => ({
      agents: core.agents.advertised().map((session) => ({ ...session, displayName: core.agents.displayName(session), runtimeProfile: core.agents.runtimeProfile(session) })),
      machine: { id: core.machine.id(), computerId: core.machine.computerId(), name: core.machine.name() },
      signedIn: core.account.signedIn(),
      environment: core.account.environment(),
      hasWindow: core.clients.hasWindow(),
    }),
    activityText: async ({ agentId }) => ({ text: await core.agents.activityText(text(agentId)) }),
    recent: async ({ agentId, n }) => ({ turns: await core.turns.recent(text(agentId), typeof n === 'number' ? n : 3) }),
    asks: async ({ agentId }) => ({ asks: await core.turns.asks(text(agentId)) }),
    answerReviewed: async ({ answer }) => ({ ok: await core.questions.answerReviewed(answer as ReviewedAnswer) }),
    models: async ({ agentId }) => ({ models: await core.agents.runtimeModels(text(agentId)) }),
    fork: async ({ agentId }) => ({ ...await core.agents.fork(text(agentId)) }),
    machines: () => core.account.machines(),
    // The transcriber's and the fleet's lane's sign-in, and the lane's sealing, asked of the core at every
    // use as every service in its own process asks them (core/accountQueries.ts): the devices hold no
    // credential and no E2EE identity.
    access_token: async (payload) => (await answerAccountQuery(core.account, 'access_token', payload))!,
    lane: async (payload) => (await answerAccountQuery(core.account, 'lane', payload))!,
  }

  /** What the devices tell the core without asking (`service_notice`), by kind. */
  const notices: Record<string, (payload: Record<string, unknown>) => void> = {
    turn: ({ agentId, text: said }) => core.turns.send(text(agentId), text(said)),
    stop: ({ agentId }) => core.turns.stop(text(agentId)),
    answer: ({ agentId, requestId, answers }) => core.questions.answer(text(agentId), text(requestId), (answers && typeof answers === 'object' ? answers : {}) as Record<string, string>),
    setRuntime: ({ agentId, model, effort }) => core.agents.setRuntime(text(agentId), typeof model === 'string' ? model : undefined, typeof effort === 'string' ? effort : undefined),
    sendLocal: ({ frame }) => { if (isFrame(frame)) core.clients.sendLocal(frame as DeviceWindowFrame) },
    // A bridge's ask for one window: told, not asked, since the bridge answers a window that has gone by its
    // own deadline either way.
    sendToWindow: ({ connId, frame }) => { if (isFrame(frame)) core.clients.sendToWindow(text(connId), frame as DeviceBridgeFrame) },
    devicesChanged: ({ status, revision }) => core.clients.devicesChanged({ status, revision }),
    dialWatching: ({ watching: on }) => watching(on === true),
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
      if (!tell) { log(`[services] devices said ${kind.slice(0, 40) || 'nothing'}, which the core does not hear`); return }
      tell(payload)
    },
    /** The devices connected (again): told everything the windows said meanwhile, and what the machine runs. */
    connected(): void {
      const state = deps.state()
      event('state', { ...state })
    },
    /** Their process is gone, and every dial with it: no cards are made for a dial that is not there. */
    disconnected(): void {
      if (dialWatching) watching(false)
    },
    /** The devices started in the core's process instead: told the same, as calls on their port. */
    started(started: DevicesPort): void {
      const state = deps.state()
      started.desk(state.desk, state.foreground)
      started.swarms(state.swarms)
      started.unread(state.unread)
      started.windowFocus(state.focus)
      started.engines(state.engines)
      started.commanders(state.commanders)
    },
  }
}

export type DevicesLink = ReturnType<typeof createDevicesLink>
