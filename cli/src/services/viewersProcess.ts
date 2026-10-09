/**
 * The DSH viewers in their own process (`harness __service viewers`, with `HARNESSD_SERVICES=viewers`).
 *
 * The same viewer servers and verdict watches as in the core's process (services/viewers.ts), on a core
 * API built here. The agents are the ones the core attaches: it says each attach and detach
 * (`service_event`), and each time this process connects it asks the core for every agent with a harness
 * (`service_query agents`) and catches up, so a process started after a crash, or reconnected after the
 * core restarted, holds exactly the viewers the core's agents should have.
 *
 * What the core used to read from the service while it builds a frame (an agent's DSH context, where the
 * windows' viewer pane forwards) is told to the core whenever it changes (`service_query context`), and
 * the core keeps it (core/viewersLink.ts). Where the service would push a frame or move the windows'
 * viewer panes in the core's process, it tells the core here, and the core does both as before.
 *
 * The viewer servers, the watches on every harness's workspace and their restarts are this process's
 * alone: a crash or a leak costs the viewers, and the master starts them again. A new process stops the
 * viewer servers a crashed one left running before it starts its own (dsh/viewerLedger.ts). A core restart
 * no longer restarts every viewer: they stay up here, and the new core hears their URLs at once.
 *
 * A client served a viewer over its connection (services/viewers.ts `serveViewers`) reaches this process
 * through the core: each frame of its stream is told here (`service_event` `stream`), and what the stream
 * answers goes back to that connection through the core (`service_notice` `viewer`). A rendered frame
 * (`viewer_surface`) is the core's question (`surface`), which only the core asks. The connections are the
 * core's: when it goes, every stream it carried goes with it.
 */
import type { CoreApi } from '../core/api.js'
import { ACCOUNT_BACKEND_OFF, CONVERSATIONS_OFF, AGENT_ACTIONS_OFF, DAEMON_UNKNOWN, DELIVERIES_OFF, emptyPorts, LANE_OFF, resolveAgent, TERMINALS_OFF } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { UNASKED } from './processCoreApi.js'
import { startViewers } from './viewers.js'

export interface ViewersServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for viewers that start no server and watch no file. */
  start?: typeof startViewers
}

/** Whether what the core sent is an agent this process can attach. */
const isSession = (value: unknown): value is RegisteredSession =>
  !!value && typeof value === 'object' && typeof (value as { agentId?: unknown }).agentId === 'string'

/**
 * The core API the viewers run on in their own process: the agents the core attached, and `tell` for
 * what the service would do to the core's windows. Whether an agent's terminal is attached is the core's
 * to judge when it hears; what the viewers never ask (search, sign-in) answers as nothing.
 */
export function viewersCoreApi(
  dataDir: string,
  sessions: ReadonlyMap<string, RegisteredSession>,
  tell: (agentId: string) => void,
  viewerFrame: CoreApi['clients']['viewerFrame'] = () => false,
): CoreApi {
  const attached = (): RegisteredSession[] => [...sessions.values()]
  return {
    dataDir,
    conversations: CONVERSATIONS_OFF,
    terminals: TERMINALS_OFF,
    machine: UNASKED.machine,
    agents: {
      all: attached,
      live: attached,
      displayName: () => '',
      byAgent: (agentId) => sessions.get(agentId),
      resolve: (id) => resolveAgent(attached(), id),
      advertised: () => [],
      terminalAvailable: () => true,
      sync: (session) => tell(session.agentId),
      runtimeModels: async () => [],
      runtimeProfile: () => null,
      setRuntime: () => {},
      fork: async () => ({ ok: false, error: 'UNSUPPORTED' }),
      ...AGENT_ACTIONS_OFF,
      activityText: UNASKED.activityText,
    },
    // The viewers drive no agent: these are never asked of them.
    turns: { send: () => {}, stop: () => {}, recent: async () => [], asks: async () => [], ...DELIVERIES_OFF },
    questions: { answer: () => {}, answerReviewed: async () => false },
    transcripts: { databaseHistory: () => undefined, lastTurn: UNASKED.lastTurn },

    account: {
      mintGridName: async () => null,
      accessToken: () => Promise.reject(new Error('the viewers hold no credential')),
      lane: LANE_OFF,
      privateGridName: async () => null,
      machineName: () => null,
      ...ACCOUNT_BACKEND_OFF,
      ...UNASKED.account,
    },
    clients: { viewerChanged: tell, gridNamed: () => {}, gridModelsChanged: () => {}, dshInstallStatus: () => {}, windows: () => {}, observer: () => false, ...UNASKED.clients, viewerFrame },
    daemon: DAEMON_UNKNOWN,
    wifi: UNASKED.wifi,
  }
}

export function runViewersService(options: ViewersServiceOptions): ServiceProcess {
  /** The agents the core attached, by agent id: what this process holds viewers for. */
  const sessions = new Map<string, RegisteredSession>()
  /** What the current connection was last told of each agent, so a change is said once. */
  const told = new Map<string, string>()
  /** The agents attached or detached since the core was last asked for all of them: newer than its answer. */
  const heard = new Set<string>()
  let core: CoreConnection | null = null
  const ports = emptyPorts()

  const tell = (agentId: string): void => {
    const session = sessions.get(agentId)
    // A detached agent is the core's to forget: nothing said after its detach may bring it back.
    if (!core || !session) return
    const state = { agentId, context: viewers.frameContext(session), forwardingUrl: viewers.forwardingUrl(agentId) }
    const said = JSON.stringify(state)
    if (told.get(agentId) === said) return
    told.set(agentId, said)
    // Lost only with the connection; the next connection is told everything again.
    void core.query('context', state).catch(() => {})
  }

  /** A stream's frame for one client: through the core, which alone holds the client's connection. */
  const viewerFrame = (connId: string, type: string, payload: Record<string, unknown>): boolean => {
    if (!core?.notice) return false
    core.notice('viewer', { connId, type, payload })
    return true
  }
  ;(options.start ?? startViewers)(viewersCoreApi(options.dataDir, sessions, tell, viewerFrame), ports)
  if (!ports.viewers) throw new Error('the viewers did not start')
  const viewers = ports.viewers

  const attach = (session: RegisteredSession): void => {
    sessions.set(session.agentId, session)
    viewers.attach(session)
    // Said again on every attach: a core that restarted has heard nothing yet, and keeps what it hears
    // only of an agent it has attached (core/viewersLink.ts).
    told.delete(session.agentId)
    tell(session.agentId)
  }
  const detach = (agentId: string): void => {
    sessions.delete(agentId)
    told.delete(agentId)
    viewers.detach(agentId)
  }
  /** Every agent the core has with a harness, as it answered: attach what is missing here, detach what it
   *  no longer has, but leave an agent heard of since the question, whose news is newer than the answer. */
  const catchUp = (agents: unknown): void => {
    if (!Array.isArray(agents)) return
    const listed = new Map(agents.filter(isSession).map((session) => [session.agentId, session]))
    for (const [agentId, session] of listed) if (!heard.has(agentId)) attach(session)
    for (const agentId of [...sessions.keys()]) if (!listed.has(agentId) && !heard.has(agentId)) detach(agentId)
  }

  // Its process stops it before it exits, however it ends (services/process.ts `hostServices`): the viewer
  // servers run in process groups of their own and would otherwise outlive it, holding their ports, until
  // the next viewers process reaped them. Once, whoever asks.
  let stopping: Promise<void> | null = null
  const stop = (): Promise<void> => {
    stopping ??= Promise.resolve().then(() => {
      service.stop()
      return viewers.stop()
    })
    return stopping
  }

  const run = options.run ?? runServiceProcess
  const service = run({
    name: 'viewers',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    // The apps ask the viewers nothing directly. The core asks for a client's rendered frame (`surface`),
    // under a type no client's request is routed as, with the connection the client asked over.
    requests: {
      surface: (payload) => {
        const { connId, ...asked } = payload
        return viewers.surface(String(connId), asked)
      },
    },
    onEvent: (payload) => {
      if (payload.kind === 'stream' && typeof payload.connId === 'string' && typeof payload.type === 'string') {
        viewers.stream(payload.connId, payload.type, payload.frame && typeof payload.frame === 'object' ? payload.frame as Record<string, unknown> : {})
      } else if (payload.kind === 'closed') {
        viewers.closed(typeof payload.connId === 'string' ? payload.connId : undefined)
      } else if (payload.kind === 'attach' && isSession(payload.session)) {
        heard.add(payload.session.agentId)
        attach(payload.session)
      } else if (payload.kind === 'detach' && typeof payload.agentId === 'string') {
        heard.add(payload.agentId)
        detach(payload.agentId)
      }
    },
    onConnected: (connection) => {
      core = connection
      told.clear()
      heard.clear()
      // The catch-up attaches every agent the core lists, and each attach tells the core that agent's
      // context: a new core hears everything, and one that only dropped the connection what changed.
      void connection.query('agents').then((answer) => { if (core === connection) catchUp(answer.agents) }, () => {})
    },
    // Every client's connection was that core's: their streams and surfaces end with it.
    onDisconnected: () => {
      core = null
      viewers.closed()
    },
  })
  return { stop }
}
