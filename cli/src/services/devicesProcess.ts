/**
 * The devices in a process of their own (`harness __service devices`, harnessd/services.ts): the dials on
 * this computer's USB ports, the window bridges they speak through, the fleet's router and its lane to the
 * owner's other machines, the voice router and the Devices tab (services/devices.ts), on a link to the core
 * (docs/design/2026-10-06-core-boundary-next.md, step 9, D2).
 *
 * A device is hardware speaking whatever its firmware says, a lane to the backend and a voice router's
 * engine worker: here a device that hangs the event loop, leaks or crashes costs the devices, and the
 * master starts them again, while every agent and window goes on. The serial ports are this process's,
 * one owner each (`O_EXLOCK`, cable/serial.ts).
 *
 * It runs on a core API of its own, over its link (core/devicesLink.ts): what the dial reads in line while
 * it builds a frame (this computer's agents, their names and models, this computer, the sign-in, whether a
 * window is there) is the core's answer to `view`, asked again as the dial's tick or ⌘K builds a list;
 * everything else is asked of the core when it is needed, or told to it. The core keeps what the windows
 * said and tells it again each time this process connects.
 */
import { env } from '../config/env.js'
import type { AppSwarms } from '../cable/cableSession.js'
import type { RecentTurn } from '../cable/cableHost.js'
import type { UnreadNotification } from '../lib/notificationRead.js'
import { AGENT_ACTIONS_OFF, DAEMON_UNKNOWN, DELIVERIES_OFF, emptyPorts, resolveAgent, TERMINALS_OFF, type CoreApi, type CorePorts, type DevicesPort, type ForkResult, type ServiceRequests, type VoiceRouteReply, type WindowFocus } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { RuntimeModelOption } from '../lib/runtimeProfile.js'
import { accountLink } from './accountLink.js'
import { startDevices, type DevicesDeps } from './devices.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess, type ServiceProcessOptions } from './process.js'
import { processCoreApi } from './processCoreApi.js'

/** An agent as the core lists it for the dial: with the name the apps show and the model it runs. */
type Viewed = RegisteredSession & { displayName?: string; runtimeProfile?: string | null }

/** What the core last said of this computer: what the dial reads in line. */
interface View {
  agents: Viewed[]
  machine: { id: string; computerId: string; name: string }
  signedIn: boolean
  environment: string
  hasWindow: boolean
}

export interface DevicesServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** For this service's tests: its start and its link. */
  start?: typeof startDevices
  run?: (options: ServiceProcessOptions) => ServiceProcess
  processEnv?: NodeJS.ProcessEnv
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** The window that has the person's attention, as the core sent it; nothing for anything else. */
function focusOf(value: unknown): WindowFocus {
  const focus = object(value)
  const voice = object(focus.voice)
  const form = object(focus.form)
  return {
    voice: voice.connId ? { machineId: text(voice.machineId), agentId: text(voice.agentId), connId: text(voice.connId) } : null,
    form: form.connId ? { machineId: text(form.machineId), connId: text(form.connId) } : null,
  }
}

/** `HARNESSD_TEST_FAULTS`, as the devices read it for their own parts (services/devicesGuard.ts). */
function faultsOf(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean))
}

export function runDevicesService(options: DevicesServiceOptions): ServiceProcess {
  const processEnv = options.processEnv ?? process.env
  let core: CoreConnection | null = null
  /** Whether a dial watches, as the cable last said: told again to every core this process connects to.
   *  A dial says hello as soon as its port opens, which is often before a core that just started has
   *  this process connected (2026-10-09, a user's log: hello 14:22:54.141, connected 14:22:54.525). Told
   *  only then, the notice was lost: the core made no cards for the dial, which showed Working for turns
   *  that had ended, and no recaps, until the next restart. */
  let dialWatching = false
  let view: View = { agents: [], machine: { id: '', computerId: options.machineId, name: 'This machine' }, signedIn: false, environment: '', hasWindow: false }
  /** One ask of the core's view at a time: the dial's tick and ⌘K asking together share it. */
  let viewing: Promise<void> | null = null
  const refresh = (): Promise<void> => {
    if (viewing) return viewing
    if (!core) return Promise.resolve()
    const asking = core.query('view').then((answer) => {
      if (!Array.isArray(answer.agents)) return
      const machine = object(answer.machine)
      view = {
        agents: answer.agents as Viewed[],
        machine: { id: text(machine.id), computerId: text(machine.computerId) || options.machineId, name: text(machine.name) || 'This machine' },
        signedIn: answer.signedIn === true,
        environment: text(answer.environment),
        hasWindow: answer.hasWindow === true,
      }
    }).catch(() => { /* the core went away; its next connection is asked again */ }).finally(() => { viewing = null })
    viewing = asking
    return asking
  }
  const ask = async (query: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    if (!core) throw new Error('the devices are not connected to the core')
    return core.query(query, payload)
  }
  const tell = (kind: string, payload: Record<string, unknown> = {}): void => { core?.notice?.(kind, payload) }

  // What the devices never ask of the core, answered as every service in its own process answers it.
  const unasked = processCoreApi(options.dataDir, 'devices')
  const account = accountLink((query, payload) => ask(query, payload))
  const api: CoreApi = {
    dataDir: options.dataDir,
    conversations: unasked.conversations,
    // Terminals are launched by the core alone (#893).
    terminals: TERMINALS_OFF,
    machine: { id: () => view.machine.id, computerId: () => view.machine.computerId, name: () => view.machine.name },
    agents: {
      all: () => view.agents,
      live: () => view.agents,
      advertised: () => view.agents,
      displayName: (session) => (session as Viewed).displayName ?? '',
      byAgent: (agentId) => view.agents.find((agent) => agent.agentId === agentId),
      resolve: (id) => resolveAgent(view.agents, id),
      terminalAvailable: () => true,
      sync: () => {},
      runtimeModels: async (agentId) => ((await ask('models', { agentId })).models ?? []) as RuntimeModelOption[],
      runtimeProfile: (session) => (session as Viewed).runtimeProfile ?? null,
      setRuntime: (agentId, model, effort) => tell('setRuntime', { agentId, model, effort }),
      fork: async (agentId) => {
        const { requestId: _id, ...result } = await ask('fork', { agentId })
        return result as unknown as ForkResult
      },
      activityText: async (agentId) => {
        const said = (await ask('activityText', { agentId })).text
        return typeof said === 'string' ? said : null
      },
      // The devices make no agent of their own and show no harness's viewer.
      ...AGENT_ACTIONS_OFF,
    },
    turns: {
      send: (agentId, said) => tell('turn', { agentId, text: said }),
      stop: (agentId) => tell('stop', { agentId }),
      recent: async (agentId, n) => ((await ask('recent', { agentId, n })).turns ?? []) as RecentTurn[],
      asks: async (agentId) => strings((await ask('asks', { agentId })).asks),
      // The devices deliver no turns of their own under an id: a dial's turn is `send`.
      ...DELIVERIES_OFF,
    },
    questions: {
      answer: (agentId, requestId, answers) => tell('answer', { agentId, requestId, answers }),
      answerReviewed: async (answer) => (await ask('answerReviewed', { answer })).ok === true,
    },
    transcripts: unasked.transcripts,
    account: {
      ...unasked.account,
      // The core's sign-in and the gateway's seal, asked at every use: this process holds no credential and
      // no E2EE identity (services/accountLink.ts).
      ...account,
      signedIn: () => view.signedIn,
      environment: () => view.environment,
      machines: async () => {
        const answer = await ask('machines')
        return { status: typeof answer.status === 'number' ? answer.status : 502, body: object(answer.body) }
      },
    },
    clients: {
      ...unasked.clients,
      sendLocal: (frame) => tell('sendLocal', { frame }),
      // Told, not asked: a bridge answers a window that has gone by its own deadline either way.
      sendToWindow: (connId, frame) => { tell('sendToWindow', { connId, frame }); return core !== null },
      hasWindow: () => view.hasWindow,
      devicesChanged: (payload) => tell('devicesChanged', payload),
      dialWatching: (watching) => {
        dialWatching = watching
        tell('dialWatching', { watching })
      },
      windows: () => {},
    },
    daemon: DAEMON_UNKNOWN,
    // The Wi-Fi device beside the dials has a link of its own (services/wifiProcess.ts).
    wifi: unasked.wifi,
  }

  const ports: CorePorts = emptyPorts()
  const deps: DevicesDeps = {
    logsDir: env.HARNESS_LOGS_DIR,
    dialSerials: processEnv.HARNESS_DIAL_SERIALS?.split(',').map((serial) => serial.trim()).filter(Boolean),
    testDialPort: processEnv.HARNESSD_TEST_DIAL_PORT,
    cableDisabled: env.CABLE_DISABLE,
    faults: faultsOf(processEnv.HARNESSD_TEST_FAULTS),
    refresh,
  }
  const requests = (options.start ?? startDevices)(api, ports, deps)
  const port = ports.devices as DevicesPort

  /** What the core tells the devices (`service_event`), by kind: the port's own calls, across the link. */
  const heard: Record<string, (payload: Record<string, unknown>) => void> = {
    card: ({ frame }) => port.card(object(frame)),
    desk: ({ agentIds, foreground }) => port.desk(strings(agentIds), foreground !== false),
    swarms: ({ swarms }) => port.swarms(swarms && typeof swarms === 'object' ? swarms as AppSwarms : null),
    unread: ({ items }) => port.unread(Array.isArray(items) ? items as UnreadNotification[] : []),
    appFocus: ({ machineId, agentId }) => port.appFocus(text(machineId), text(agentId)),
    seen: ({ agentId, readToken }) => port.seen(text(agentId), typeof readToken === 'string' ? readToken : undefined),
    settings: ({ id, patch }) => port.settings(text(id), object(patch)),
    windowFocus: ({ focus }) => port.windowFocus(focusOf(focus)),
    windowReply: ({ which, connId, machineId, reply }) =>
      port.windowReply(which === 'form' ? 'form' : which === 'visit' ? 'visit' : 'selection', text(connId), text(machineId), object(reply)),
    voiceReply: ({ voiceId, reply }) => port.voiceReply(text(voiceId), object(reply) as unknown as VoiceRouteReply),
    windowGone: ({ connId }) => port.windowGone(text(connId)),
    scroll: ({ phase, dy, velocity }) => { if (phase === 'down' || phase === 'move' || phase === 'up') port.scroll(phase, number(dy), number(velocity)) },
    engines: ({ engines }) => port.engines(strings(engines)),
    commanders: ({ connected }) => port.commanders(connected === true),
    // Everything at once, as the core keeps it: this process (re)connected, and starts where the windows are.
    // What a window has not said is not said to the dial: a fresh process holds nothing yet, and a dial still
    // attached through a core's restart keeps its tab until the windows, reconnecting, say theirs again.
    // Pushed regardless, an empty tab reached a dial still opening its port, before its greeting, which no
    // build before this one sent (e2e/deviceCompat.e2e.ts).
    state: (state) => {
      const desk = strings(state.desk)
      if (desk.length) port.desk(desk, state.foreground !== false)
      if (state.swarms && typeof state.swarms === 'object') port.swarms(state.swarms as AppSwarms)
      if (Array.isArray(state.unread) && state.unread.length) port.unread(state.unread as UnreadNotification[])
      port.windowFocus(focusOf(state.focus))
      port.engines(strings(state.engines))
      port.commanders(state.commanders === true)
    },
  }

  const devices: ServiceRequests = {
    ...requests,
    // What the core asks of the devices (core/devicesLink.ts), under types only the core sends: no client's
    // request is routed here under these names (core/serviceLinks.ts routes the Devices tab's alone).
    routeTask: async ({ text: task }) => ({ ...await port.routeTask(text(task)) }),
    routeSend: async ({ agentId, text: task }) => ({ ...await port.routeSend(text(agentId), text(task)) }),
    stepFocus: async ({ direction, currentAgentId }) => {
      const step = await port.stepFocus(direction === 'previous' ? 'previous' : 'next', typeof currentAgentId === 'string' ? currentAgentId : undefined)
      return step === 'no_agents' ? { step } : { ...step }
    },
  }

  const service = (options.run ?? runServiceProcess)({
    name: 'devices',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    requests: devices,
    onEvent: (payload) => {
      const kind = text(payload.kind)
      if (Object.hasOwn(heard, kind)) heard[kind](payload)
    },
    onConnected: (connection) => {
      core = connection
      if (dialWatching) tell('dialWatching', { watching: true })
      void refresh()
    },
    onDisconnected: () => { core = null },
  })
  return {
    stop: async () => {
      service.stop()
      // The serial ports first and on the way out: a port this process still held would make the next
      // devices process, and esptool, fail as if the hardware had died.
      await port.stop()
    },
  }
}
