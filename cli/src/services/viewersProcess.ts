/**
 * The DSH viewers in their own process (`harness __service viewers`, with `HARNESSD_SERVICES=viewers`).
 *
 * The same viewer servers and verdict watches as in the core's process (services/viewers.ts), on a core
 * API built here. The agents are the ones with a harness, as every service that follows agents hears them
 * (core/agentLife.ts): each time this process connects it asks to follow them (`follow_agents`, `VIEWERS_FOLLOW`)
 * and catches up from the answer, so a process started after a crash, or reconnected after the core restarted,
 * holds exactly the viewers the core's agents should have; then it hears each look at one and its end
 * (`service_event` kind `agent`).
 *
 * Agent display fields go through the shared frame publisher. The separate `viewer_target` query reports where a
 * managed viewer forwards; the core keeps that target while this process is down.
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
import type { AgentLife, CoreApi } from '../core/api.js'
import { ACCOUNT_BACKEND_OFF, CONVERSATIONS_OFF, AGENT_ACTIONS_OFF, DAEMON_UNKNOWN, DELIVERIES_OFF, emptyPorts, LANE_OFF, resolveAgent, TERMINALS_OFF, VIEWERS_FOLLOW } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { UNASKED } from './processCoreApi.js'
import { createFramePublisher } from './framePublisher.js'
import { startViewers, viewerStreamEndpoint, type ViewersRuntimeSlot } from './viewers.js'
import { CLIENT_STREAMS, type ClientStreamEndpoint } from '../lib/clientStreamContract.js'
import { createServiceClientStreams } from './clientStreams.js'

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
 * The core API the viewers run on in their own process: the agents the core told of, how the service hears of them
 * (`follow`, which this process feeds from what the core says), and `tell` for what the service would do to the core's
 * windows. Whether an agent's terminal is attached is the core's to judge when it hears; what the viewers never ask
 * (search, sign-in) answers as nothing.
 */
export function viewersCoreApi(
  dataDir: string,
  sessions: ReadonlyMap<string, RegisteredSession>,
  tell: (agentId: string) => void,
  streamFrame: CoreApi['clients']['streamFrame'],
  follow: NonNullable<CoreApi['agents']['follow']>,
): CoreApi {
  const attached = (): RegisteredSession[] => [...sessions.values()]
  return {
    dataDir,
    conversations: CONVERSATIONS_OFF,
    terminals: TERMINALS_OFF,
    machine: UNASKED.machine,
    agents: {
      all: async () => attached(),
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
      follow,
      ...AGENT_ACTIONS_OFF,
      activityText: UNASKED.activityText,
      activity: UNASKED.activity,
      summaries: UNASKED.summaries,
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
    clients: { viewerChanged: tell, gridNamed: () => {}, gridModelsChanged: () => {}, dshInstallStatus: () => {}, windows: () => {}, observer: () => false, ...UNASKED.clients, streamFrame },
    daemon: DAEMON_UNKNOWN,
    wifi: UNASKED.wifi,
  }
}

export function runViewersService(options: ViewersServiceOptions): ServiceProcess {
  /** The agents the core attached, by agent id: what this process holds viewers for. */
  const sessions = new Map<string, RegisteredSession>()
  /** What the current connection was last told of each agent, so a change is said once. */
  const told = new Map<string, string>()
  /** The service's own follower (services/viewers.ts): what this process hears of agents goes to it. */
  let follower: ((event: AgentLife) => void) | null = null
  const follow = (listener: (event: AgentLife) => void): (() => void) => {
    follower = listener
    return () => { if (follower === listener) follower = null }
  }
  /** The agents attached or detached since the core was last asked for all of them: newer than its answer. */
  const heard = new Set<string>()
  let core: CoreConnection | null = null
  const ports: ViewersRuntimeSlot = { viewers: null }

  const tell = (agentId: string): void => {
    const session = sessions.get(agentId)
    // A detached agent is the core's to forget: nothing said after its detach may bring it back.
    if (!core || !session) return
    const state = { agentId, forwardingUrl: viewers.forwardingUrl(agentId) }
    const said = JSON.stringify(state)
    if (told.get(agentId) === said) return
    told.set(agentId, said)
    // Lost only with the connection; the next connection is told everything again.
    void core.query('viewer_target', state).catch(() => {})
  }

  let endpoint: ClientStreamEndpoint | null = null
  const streamLink = createServiceClientStreams(CLIENT_STREAMS.find(spec => spec.service === 'viewers')!, () => endpoint)
  const streamFrame = streamLink.frame
  const publisher = createFramePublisher((session, fields) => ({ query: 'context', payload: { agentId: session.agentId,
    context: typeof fields.dsh === 'string' ? { id: fields.dsh, name: fields.dshName, viewerUrl: fields.viewerUrl,
      viewerName: fields.viewerName, verdict: fields.verdict } : null, forwardingUrl: ports.viewers?.forwardingUrl(session.agentId) ?? null } }))
  const api = publisher.scope(viewersCoreApi(options.dataDir, sessions, tell, streamFrame, follow))
  ;(options.start ?? startViewers)(api, ports)
  if (!ports.viewers) throw new Error('the viewers did not start')
  const viewers = ports.viewers
  endpoint = viewerStreamEndpoint(viewers)

  const attach = (session: RegisteredSession): void => {
    sessions.set(session.agentId, session)
    follower?.({ kind: 'running', session })
    // Said again on every look: a core that restarted has heard nothing yet, and keeps what it hears
    // only of an agent with a harness it follows (core/viewersLink.ts).
    told.delete(session.agentId)
    tell(session.agentId)
  }
  const detach = (agentId: string): void => {
    sessions.delete(agentId)
    told.delete(agentId)
    follower?.({ kind: 'ended', agentId })
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
      if (streamLink.event(payload)) return
      if (payload.kind === 'agent' && payload.event && typeof payload.event === 'object') {
        // A look at an agent with a harness, or the end of one: what else agents do is not the viewers' business.
        const event = payload.event as Record<string, unknown>
        if (event.kind === 'running' && isSession(event.session)) {
          heard.add(event.session.agentId)
          attach(event.session)
        } else if (event.kind === 'ended' && typeof event.agentId === 'string') {
          heard.add(event.agentId)
          detach(event.agentId)
        }
      } else if (payload.kind === 'attach' && isSession(payload.session)) {
        // A core from before agents were followed (2026-11-15) says each look and end so. Delete on or after 2026-12-18.
        heard.add(payload.session.agentId)
        attach(payload.session)
      } else if (payload.kind === 'detach' && typeof payload.agentId === 'string') {
        heard.add(payload.agentId)
        detach(payload.agentId)
      }
    },
    onConnected: (connection) => {
      core = connection
      streamLink.connected(connection)
      publisher.connected(connection)
      told.clear()
      heard.clear()
      // The catch-up attaches every agent the core lists, and each attach tells the core that agent's
      // projection: a new core hears everything, and one that only dropped the connection what changed.
      // A core from before agents were followed (2026-11-15) does not know `follow_agents`, and answers the agents with a
      // harness as it was always asked (`agents`). Delete on or after 2026-12-18.
      void connection.query('follow_agents', { ...VIEWERS_FOLLOW })
        .then((answer) => (answer.error === 'UNKNOWN_QUERY' ? connection.query('agents') : answer))
        .then((answer) => { if (core === connection) catchUp(answer.agents) }, () => {})
    },
    // Every client's connection was that core's: their streams and surfaces end with it.
    onDisconnected: () => {
      core = null
      publisher.disconnected()
      streamLink.disconnected()
    },
    onConnectionClosed: streamLink.closed,
  })
  return { stop }
}
