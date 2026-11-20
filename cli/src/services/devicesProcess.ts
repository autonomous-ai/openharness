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
import type { BackendNotice } from '../core/api.js'
import { env } from '../config/env.js'
import type { AppSwarms } from '../cable/cableSession.js'
import type { RecentTurn } from '../cable/cableHost.js'
import type { UnreadNotification } from '../lib/notificationRead.js'
import { validUsage } from '../lib/agentUsageWire.js'
import { DAEMON_UNKNOWN, DELIVERIES_OFF, emptyPorts, TERMINALS_OFF, type CorePorts, type DevicesPort, type ForkResult, type ServiceRequests, type WindowFocus } from '../core/api.js'
import type { RuntimeModelOption } from '../lib/runtimeProfile.js'
import { accountLink } from './accountLink.js'
import { startDevices, type DevicesDeps, type DevicesCore, type DeviceSession } from './devices.js'
import { listenForDevices, openDevicesListener } from './devicesListener.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess, type ServiceProcessOptions } from './process.js'
import { readCoreSessionRecords, readSessionView } from './sessionSnapshot.js'
import { boundedJsonBytes } from '../lib/boundedJsonBytes.js'
import { processCoreApi, UNASKED } from './processCoreApi.js'
import { harnessdEnv } from '../lib/harnessdEnv.js'
import { publishDeviceDesk, type DeviceDesk } from './deviceDesk.js'

/** An agent as the core lists it for the dial: with the name the apps show and the model it runs. */
type Viewed = DeviceSession

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
  /** For this service's tests: its start, its link and its listener. */
  start?: typeof startDevices
  run?: (options: ServiceProcessOptions) => ServiceProcess
  openListener?: typeof openDevicesListener
  processEnv?: NodeJS.ProcessEnv
  /** For this service's tests: the platform the listener is opened for. */
  platform?: NodeJS.Platform
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
const object = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

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
  const processEnv = options.processEnv ?? harnessdEnv()
  const faults = faultsOf(processEnv.HARNESSD_TEST_FAULTS)
  let core: CoreConnection | null = null
  let generation = 0, stopped = false
  let desk: DeviceDesk | undefined
  let deskOwner: { generation: number; machineId: string; revoke(): void } | null = null
  /** Whether a dial watches, as the cable last said: told again to every core this process connects to.
   *  A dial says hello as soon as its port opens, which is often before a core that just started has
   *  this process connected (2026-10-09, a user's log: hello 14:22:54.141, connected 14:22:54.525). Told
   *  only then, the notice was lost: the core made no cards for the dial, which showed Working for turns
   *  that had ended, and no recaps, until the next restart. */
  let dialWatching = false
  const emptyView = (): View => ({ agents: [], machine: { id: '', computerId: options.machineId, name: 'This machine' }, signedIn: false, environment: '', hasWindow: false })
  let view = emptyView()
  const publishDesk = (): void => {
    if (!core || !desk || !view.machine.id || view.machine.computerId !== options.machineId) {
      deskOwner?.revoke(); deskOwner = null
      return
    }
    if (deskOwner?.generation === generation && deskOwner.machineId === view.machine.id) return
    deskOwner?.revoke()
    const origin = core, epoch = generation, machineId = view.machine.id, direct = desk
    deskOwner = { generation: epoch, machineId, revoke: publishDeviceDesk({ dataDir: options.dataDir, machineId, desk: {
      // Wi-Fi can call this desk before a dial has ever read its startup view.
      stepFocus: async (...args) => await refresh() ? direct.stepFocus(...args) : 'no_agents',
      scroll: (...args) => direct.scroll(...args),
    }, faults,
      current: () => !stopped && generation === epoch && core === origin && view.machine.id === machineId,
      hasWindow: () => view.hasWindow,
    }) }
  }
  /** One ask of the core's view at a time: the dial's tick and ⌘K asking together share it. */
  let viewing: { generation: number; promise: Promise<boolean>; closed: AbortController } | null = null
  const refresh = (): Promise<boolean> => {
    if (viewing?.generation === generation) return viewing.promise
    if (!core) return Promise.resolve(false)
    const origin = core, epoch = generation
    const pending = { generation: epoch, promise: Promise.resolve(false), closed: new AbortController() }
    pending.promise = readSessionView((scope, receive, signal) => readCoreSessionRecords(origin, scope, receive, signal), 'advertised', header => {
      const agents: Viewed[] = []
      return { row: (member, budget) => {
        if (stopped || generation !== epoch || core !== origin) throw new Error('SESSION_READ_UNAVAILABLE')
        if (member[0] === 'gone') return
        const [, agentId, sessionId, engine, registeredAt, transcriptPath, lastHookAt] = member
        let row: Viewed
        if (member[0] === 'registered') {
          const [, , , , , , , active, cwd, storedDsh, launch, displayName, terminalAvailable, selectedModel] = member
          if (!terminalAvailable) return
          const [state, first, detail] = launch ?? []
          const launching = state === undefined ? undefined : state === 'failed'
            ? { state, error: first, ...(detail === false ? {} : { detail }) }
            : state === 'held' ? { state, service: first, detail } : { state }
          const session = { agentId, sessionId, engine, registeredAt, transcriptPath, lastHookAt,
            active, cwd, ...(storedDsh === false ? {} : { dsh: storedDsh }), ...(launching ? { launch: launching } : {}),
            displayName, runtimeProfile: selectedModel }
          row = session
        } else {
          const [, , , , , , , displayName, selectedModel] = member
          const session = { agentId, sessionId, engine, registeredAt, transcriptPath, lastHookAt, displayName, selectedModel, runtimeProfile: selectedModel }
          row = session
        }
        budget.retain(boundedJsonBytes(row, budget.remaining)); agents.push(row)
      }, value: (): View => ({ agents,
        machine: { ...header.machine, computerId: header.machine.computerId || options.machineId, name: header.machine.name || 'This machine' },
        signedIn: header.signedIn, environment: header.environment, hasWindow: header.hasWindow,
      }) }
    }, pending.closed.signal).then(next => {
      if (stopped || generation !== epoch || core !== origin) return false
      view = next
      publishDesk()
      return true
    }).catch(() => false).finally(() => { if (viewing === pending) viewing = null })
    viewing = pending
    return pending.promise
  }
  /** What the devices end for a core that goes (services/devices.ts `onCoreGone`). */
  let coreGone: (() => void) | undefined
  const disconnect = (): void => {
    deskOwner?.revoke(); deskOwner = null
    viewing?.closed.abort()
    generation++; core = null; viewing = null; view = emptyView()
    coreGone?.()
  }
  const ask = async (query: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    if (!core) throw new Error('the devices are not connected to the core')
    return core.query(query, payload)
  }
  const tell = (kind: string, payload: Record<string, unknown> = {}): void => { core?.notice?.(kind, payload) }

  // What the devices never ask of the core, answered as every service in its own process answers it.
  /** Who hears the account's notices in this process (the fleet), told them as the core forwards each. */
  const noticeListeners = new Set<(notice: BackendNotice) => void>()
  const unasked = processCoreApi(options.dataDir, 'devices')
  const account = accountLink((query, payload) => ask(query, payload))
  const api: DevicesCore = {
    dataDir: options.dataDir,
    conversations: unasked.conversations,
    // Terminals are launched by the core alone (#893).
    terminals: TERMINALS_OFF,
    machine: { id: () => view.machine.id, computerId: () => view.machine.computerId, name: () => view.machine.name },
    agents: {
      advertised: () => view.agents,
      displayName: (session) => (session as Viewed).displayName ?? '',
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
      activitySnapshot: async (agentId) => {
        // A core that predates the query (or has no timer to give) still has the footer.
        const said = (await ask('activitySnapshot', { agentId }).catch((): Record<string, unknown> => ({}))).activity
        if (said && typeof said === 'object' && typeof (said as { text?: unknown }).text === 'string') return said as { text: string; elapsedSeconds?: number }
        const text = (await ask('activityText', { agentId })).text
        return typeof text === 'string' && text ? { text } : null
      },
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
      // The account's notices the core forwards (core/main.ts `onAccountNotice`): the fleet reads the machine list on
      // `machines_changed`, and only every 5 minutes otherwise (spec 2026-11-02 poll cost, Part 4.4).
      onNotice: (listener) => { noticeListeners.add(listener); return () => { noticeListeners.delete(listener) } },
      signedIn: () => view.signedIn,
      environment: () => view.environment,
      machines: async () => {
        const answer = await ask('machines')
        return { status: typeof answer.status === 'number' ? answer.status : 502, body: object(answer.body) }
      },
    },
    clients: {
      ...unasked.clients,
      sendWindow: delivery => { tell('window', { ...delivery }); return core !== null },
      hasWindow: () => view.hasWindow,
      devicesChanged: (payload) => tell('devicesChanged', payload),
      dialWatching: (watching) => {
        dialWatching = watching
        tell('dialWatching', { watching })
      },
      windows: () => {},
    },
    usageFresh: async (agentId) => {
      const usage = (await ask('usageFresh', { agentId }).catch((): Record<string, unknown> => ({}))).usage
      return validUsage(usage) ? usage : null
    },
    daemon: DAEMON_UNKNOWN,
    // The Wi-Fi device beside the dials has a link of its own (services/wifiProcess.ts).
  }

  const ports: CorePorts = emptyPorts()
  let legacyCommands: ServiceRequests = {}
  const deps: DevicesDeps = {
    logsDir: env.HARNESS_LOGS_DIR,
    dialSerials: processEnv.HARNESS_DIAL_SERIALS?.split(',').map((serial) => serial.trim()).filter(Boolean),
    testDialPort: processEnv.HARNESSD_TEST_DIAL_PORT,
    cableDisabled: env.CABLE_DISABLE,
    faults,
    refresh,
    onDesk: direct => { deskOwner?.revoke(); deskOwner = null; desk = direct; publishDesk() },
    onCoreGone: (run) => { coreGone = run },
    onLegacyCommands: handlers => { legacyCommands = handlers },
    // The service owns this authenticated listener; explicit inline Windows starts open the same door.
    listen: listenForDevices(options.dataDir, options.platform ?? process.platform, options.openListener ?? openDevicesListener),
  }
  const requests = (options.start ?? startDevices)(api, ports, deps)
  const port = ports.devices as DevicesPort

  /** What the core tells the devices (`service_event`), by kind: the port's own calls, across the link. */
  const heard: Record<string, (payload: Record<string, unknown>) => void> = {
    notice: ({ notice }) => { if (notice && typeof notice === 'object') for (const listener of noticeListeners) listener(notice as BackendNotice) },
    card: ({ frame }) => port.card(object(frame)),
    // Checked and bounded by the core before it was sent (core/observedHook.ts), and kept nowhere there.
    observed: ({ kind: _kind, ...event }) => port.observed(event as unknown as Parameters<DevicesPort['observed']>[0]),
    desk: ({ agentIds, foreground }) => port.desk(strings(agentIds), foreground !== false),
    swarms: ({ swarms }) => port.swarms(swarms && typeof swarms === 'object' ? swarms as AppSwarms : null),
    unread: ({ items }) => port.unread(Array.isArray(items) ? items as UnreadNotification[] : []),
    appFocus: ({ machineId, agentId }) => port.appFocus(text(machineId), text(agentId)),
    seen: ({ agentId, readToken }) => port.seen(text(agentId), typeof readToken === 'string' ? readToken : undefined),
    settings: ({ id, patch }) => port.settings(text(id), object(patch)),
    windowFocus: ({ focus }) => port.windowFocus(focusOf(focus)),
    windowReply: ({ which, connId, machineId, reply }) =>
      port.windowReply(which === 'form' ? 'form' : which === 'visit' ? 'visit' : 'selection', text(connId), text(machineId), object(reply)),
    windowGone: ({ connId }) => port.windowGone(text(connId)),
    engines: ({ engines }) => port.engines(strings(engines)),
    commanders: ({ connected }) => port.commanders(connected === true),
    // The mod's poll whose client went before its answer (core/deviceHookCalls.ts): it ends.
    'inbox.gone': ({ pollId }) => port.inboxGone(text(pollId)),
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
    // Direct service-owned closures preserve old private port replies until 2026-12-16.
    ...legacyCommands,
    // The mod's poll, checked and bounded by the core (core/deviceHookCalls.ts), and held here until a transcript takes it
    // or the hold runs out.
    inboxPoll: async ({ pollId, sessionId }) => ({ ...await port.inboxPoll({ pollId: text(pollId), sessionId: text(sessionId) }) }),
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
      if (stopped) return
      if (core) disconnect()
      generation++; core = { ...connection }
      if (dialWatching) tell('dialWatching', { watching: true })
      void refresh()
    },
    onDisconnected: disconnect,
  })
  return {
    stop: async () => {
      stopped = true; disconnect()
      service.stop()
      // The serial ports first and on the way out: a port this process still held would make the next
      // devices process, and esptool, fail as if the hardware had died.
      await port.stop()
    },
  }
}
