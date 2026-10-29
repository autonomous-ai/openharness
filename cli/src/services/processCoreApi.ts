import { usageTarget, usageTargetKey, usageSnapshot, validUsage, validUsageTarget } from '../lib/agentUsageWire.js'
/**
 * The core API a light service runs on in its own process (the edge host: usage, the monitor, the project
 * readers): the agents the core last said, and nothing else. Each process asks the core for what it reads
 * (`service_query live` or `advertised`, core/agentQueries.ts) as each request starts, so it answers as
 * the core's registry would at that moment, never from a copy that waited.
 *
 * What these services never ask (turns, questions, sign-in, the windows) answers as nothing, and a
 * credential is refused: a service holds none (services/AGENTS.md).
 *
 * An experiment acts on the core as well (core/experimentQueries.ts): it creates agents, stops a turn,
 * delivers turns (services/turnsLink.ts), reads and writes the account's backend, tells the windows it
 * changed and Share's observers what they are shown, and has Share's welcomes signed with this machine's key,
 * each asked of the core over its link (`ask`). The agents it reads come as the apps are shown them (`service_query shown`): each with its
 * name, whether its terminal is there and its harness's viewer.
 */
import { CONNECTOR_VAULT_OFF, CONVERSATIONS_OFF, DAEMON_UNKNOWN, DELIVERIES_OFF, LANE_OFF, OBSERVER_KEY_OFF, resolveAgent, TAB_KEY_OFF, TAB_RELAY_OFF, TERMINALS_OFF, WIFI_OFF, type CloudCore, type SuperTabsCore, type SuperTabScreen, type SuperTabTyped, type CoreApi, type DaemonAddress, type TerminalWatch } from '../core/api.js'
import type { AgentDshContext } from '../lib/agentFrame.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { turnsLink } from './turnsLink.js'
import { creationObservation } from '../lib/creationObservation.js'
import { nativeTurnPageIn } from '../lib/nativeTurnObservations.js'

type Payload = Record<string, unknown>

/** An agent as the core shows it to an experiment (core/experimentQueries.ts `shown`). */
export type ShownAgent = RegisteredSession & { displayName?: string; terminalAvailable?: boolean; selectedModel?: string | null; dshContext?: AgentDshContext | null }

/** The agents a process was last told of, and how it asks the core to act. Those it is never told of read
 *  as none, and with no way to ask, it acts on nothing. */
export interface AgentsView {
  live?: () => ShownAgent[]
  advertised?: () => RegisteredSession[]
  /** Ask the core (`CoreConnection.query`, services/process.ts), for an experiment that acts. */
  ask?: (query: string, payload: Payload) => Promise<Payload>
  /** The delivered turns it makes and hears of, through `ask` (services/turnsLink.ts). */
  deliveries?: ReturnType<typeof turnsLink>
  /** Where this daemon runs, as the core last said (`service_query daemon`). */
  daemon?: () => DaemonAddress | null
  /** The account's notices the core tells it (`service_event` kind `notice`), for whoever listens. */
  onNotice?: CoreApi['account']['onNotice']
  /** The core's read-only view of terminals, for its own viewers (services/watchLink.ts). */
  watch?: TerminalWatch
}

/** Whether what the core sent is an agent. */
export const isSession = (value: unknown): value is RegisteredSession =>
  !!value && typeof value === 'object' && typeof (value as { agentId?: unknown }).agentId === 'string'

/** The agents in a core's answer (`{ agents: [...] }`), or null when it is not one. */
export function agentsIn(answer: Record<string, unknown> | null | undefined): RegisteredSession[] | null {
  return Array.isArray(answer?.agents) ? answer.agents.filter(isSession) : null
}

/** The daemon's address in a core's answer (`service_query daemon`), or null when it is not one. */
export function daemonIn(answer: Payload | null | undefined): DaemonAddress | null {
  if (typeof answer?.command !== 'string' || typeof answer.port !== 'number' || typeof answer.machineId !== 'string') return null
  const machineId = answer.machineId
  return { command: answer.command, port: answer.port, machineId: () => machineId, autonomousEnv: typeof answer.autonomousEnv === 'string' ? answer.autonomousEnv : DAEMON_UNKNOWN.autonomousEnv }
}

/** The key the core answered with, or a refusal a caller can read. */
function keyAnswer(answer: Payload): string {
  if (typeof answer.key === 'string') return answer.key
  throw new Error(typeof answer.error === 'string' ? answer.error : 'the gateway did not answer for this machine\'s key')
}

/**
 * What only the devices ask of the core (services/devices.ts, services/wifi.ts), as every other service in
 * its own process answers it: nothing. Shared, so that a member added for the devices is added once for the others.
 */
export const UNASKED = {
  machine: { id: () => '', computerId: () => '', name: () => '' },
  activityText: async (): Promise<string | null> => null,
  /** What only Agent Messages asks: whether harnesses work (its own process asks the core). */
  activity: async (): Promise<Record<string, 'working' | 'idle' | 'unknown'>> => ({}),
  /** What only Agent Messages asks: one line on what each harness does. */
  summaries: async (): Promise<Record<string, string>> => ({}),
  account: { signedIn: () => false, environment: () => '', machines: async () => ({ status: 503, body: {} }) },
  clients: { sendLocal: () => {}, sendToWindow: () => false, hasWindow: () => false, devicesChanged: () => {}, dialWatching: () => {}, turnCard: () => {}, turnSummary: () => {} },
  wifi: WIFI_OFF,
  /** What only the recaps ask (services/recapsProcess.ts): a turn's final answer. */
  lastTurn: async () => null,
} satisfies {
  machine: CoreApi['machine']
  activityText: CoreApi['agents']['activityText']
  activity: CoreApi['agents']['activity']
  summaries: CoreApi['agents']['summaries']
  account: Pick<CoreApi['account'], 'signedIn' | 'environment' | 'machines'>
  clients: Pick<CoreApi['clients'], 'sendLocal' | 'sendToWindow' | 'hasWindow' | 'devicesChanged' | 'dialWatching' | 'turnCard' | 'turnSummary'>
  wifi: CoreApi['wifi']
  lastTurn: CoreApi['transcripts']['lastTurn']
}

/** The core's answer to a terminal read or write, or why there is none, in words the Lead reads. */
const terminalAnswer = (asked: Promise<Record<string, unknown>>): Promise<SuperTabTyped | SuperTabScreen> => asked.then(
  answer => answer.ok === true ? answer as SuperTabScreen : { ok: false, error: String(answer.error ?? 'The terminal could not be reached.') },
  () => ({ ok: false, error: 'This machine\'s daemon could not be asked. Try again in a moment.' }))

export function processCoreApi(dataDir: string, service: string, view: AgentsView = {}): CoreApi {
  const live = (): ShownAgent[] => view.live?.() ?? []
  const ask = view.ask
  const daemon = (): DaemonAddress => view.daemon?.() ?? DAEMON_UNKNOWN
  const backend: CoreApi['account']['backend'] = async (method, path, body) => {
    const answer = await (ask?.('backend', { method, path, ...(body === undefined ? {} : { body }) }) ?? Promise.reject(new Error('no core to ask')))
      .catch((): Payload => ({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } }))
    return typeof answer.status === 'number' && answer.body && typeof answer.body === 'object'
      ? { status: answer.status, body: answer.body as Payload }
      : { status: 502, body: { error: typeof answer.error === 'string' ? answer.error : 'BACKEND_UNREACHABLE' } }
  }
  return {
    dataDir,
    usage: async target => {
      const answer = await ask?.('agentUsage', { target: usageTarget(target) }).catch(() => null)
      return validUsageTarget(answer?.target) && usageTargetKey(answer.target) === usageTargetKey(target) && validUsage(answer?.value) ? usageSnapshot(answer.value) : null
    },
    usageFresh: async agentId => {
      const answer = await ask?.('agentUsageFresh', { agentId }).catch(() => null)
      return answer && 'value' in answer && validUsage(answer.value) ? usageSnapshot(answer.value) : null
    },
    conversations: CONVERSATIONS_OFF,
    // Terminals are launched by the core alone (the shell service, #893): a service in its own process
    // is refused, never handed a way to start a process outside the core.
    terminals: { ...TERMINALS_OFF, watch: view.watch ?? TERMINALS_OFF.watch },
    machine: UNASKED.machine,
    agents: {
      // The stopped agents are never sent to these services: none of them reads one.
      all: live,
      live,
      displayName: (session) => (session as ShownAgent).displayName ?? '',
      byAgent: (agentId) => live().find((session) => session.agentId === agentId),
      closeSwarm: async request => await (ask?.('close_swarm', { ...request }) ?? Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }))
        .catch(() => ({ error: 'SERVICE_UNAVAILABLE' })),
      keepLeadAlive: async agentId => {
        const answer = await ask?.('keep_lead_alive', { agentId }).catch(() => null)
        if (answer?.ok === true) return { ok: true }
        return answer?.ok === false && typeof answer.error === 'string'
          ? { ok: false, error: answer.error, ...(typeof answer.detail === 'string' ? { detail: answer.detail } : {}) }
          : { ok: false, error: 'SERVICE_UNAVAILABLE' }
      },
      closeMember: async (agentId, creationId) => await (ask?.('close_member', { agentId, ...(creationId ? { creationId } : {}) }) ?? Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }))
        .catch(() => ({ error: 'SERVICE_UNAVAILABLE' })),
      stopped: async agentId => (await ask?.('stopped', { agentId }).catch(() => null))?.stopped === true,
      gone: async agentId => (await ask?.('gone', { agentId }).catch(() => null))?.gone === true,
      creationStatus: async creationId => creationObservation(creationId,
        (await ask?.('creation_status', { creationId }).catch(() => null))?.observation),
      resolve: (id) => resolveAgent(live(), id),
      advertised: () => view.advertised?.() ?? [],
      terminalAvailable: (agentId) => live().find((session) => session.agentId === agentId)?.terminalAvailable === true,
      sync: () => {},
      runtimeModels: async () => [],
      runtimeProfile: session => {
        const profile = (session as ShownAgent).selectedModel
        return typeof profile === 'string' ? profile : null
      },
      setRuntime: () => {},
      fork: async () => ({ ok: false, error: 'UNSUPPORTED' }),
      create: async (request) => {
        if (!ask) return { ok: false, error: 'SERVICE_UNAVAILABLE' }
        const answer = await ask('create', { ...request }).catch((): Payload => ({ error: 'SERVICE_UNAVAILABLE' }))
        if (answer.ok === true && typeof answer.agentId === 'string') return { ok: true, agentId: answer.agentId }
        return { ok: false, error: typeof answer.error === 'string' ? answer.error : 'CREATE_FAILED', ...(typeof answer.detail === 'string' ? { detail: answer.detail } : {}) }
      },
      dsh: (session) => (session as ShownAgent).dshContext ?? null,
      activityText: UNASKED.activityText,
      // The core's answer, as the core gives it: the working state of each agent asked about (core/messagesLink.ts `activity`).
      activity: async (agentIds) => {
        const answer = await ask?.('activity', { agentIds }).catch(() => null)
        const states = answer?.activity
        if (!states || typeof states !== 'object') return {}
        return Object.fromEntries(Object.entries(states).filter((e): e is [string, 'working' | 'idle' | 'unknown'] => e[1] === 'working' || e[1] === 'idle' || e[1] === 'unknown'))
      },
      // The same query, asked for the one-line summaries too. A core from before them answers without `summaries`: none.
      summaries: async (agentIds) => {
        const answer = await ask?.('activity', { agentIds, summaries: true }).catch(() => null)
        const lines = answer?.summaries
        if (!lines || typeof lines !== 'object') return {}
        return Object.fromEntries(Object.entries(lines).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''))
      },
    },
    turns: {
      send: () => {},
      stop: (agentId) => { void ask?.('stop_turn', { agentId }).catch(() => {}) },
      recent: async () => [],
      asks: async () => [],
      ...(view.deliveries?.turns ?? DELIVERIES_OFF),
      // The connected service identity decides the namespace; the payload cannot
      // grant another process permission to write a queued instruction.
      leaseDeliveries: async (maker, leases) => maker === service &&
        (await ask?.('lease_deliveries', { leases }).catch(() => null))?.leased === true,
    },
    questions: { answer: () => {}, answerReviewed: async () => false },
    transcripts: { databaseHistory: () => undefined, lastTurn: UNASKED.lastTurn,
      nativeTurns: async (agentId, cursor) => nativeTurnPageIn(
        (await ask?.('native_turns', { agentId, ...(cursor ? { cursor } : {}) }).catch(() => null))?.page),
    },

    account: {
      mintGridName: async () => null,
      accessToken: () => Promise.reject(new Error(`${service} holds no credential`)),
      lane: LANE_OFF,
      // Share's owner signs a welcome with this machine's identity, which the gateway holds: asked each time.
      observerKey: ask ? {
        publicKey: async () => keyAnswer(await ask('observer_key', { op: 'public' })),
        signWelcome: async (machineId, shareId, peer, ephemeral) => keyAnswer(await ask('observer_key', { op: 'sign', machineId, shareId, peer, ephemeral })),
      } : OBSERVER_KEY_OFF,
      // Shared tabs' keys and relay: Agent Messages asks the core for them (services/messagesProcess.ts); no other holds one.
      tabKey: TAB_KEY_OFF,
      tabRelay: TAB_RELAY_OFF,
      // The connectors service asks the core for these itself (core/connectorsQueries.ts); no other seals.
      connectorVault: CONNECTOR_VAULT_OFF,
      privateGridName: async () => null,
      machineName: () => null,
      backend,
      // The account signed in here, asked of the core: Share derives its tabs' observers for it (core/experimentQueries.ts
      // `account`), and Agent Messages asks its own link (services/messagesProcess.ts). A core that cannot say: none.
      identity: async () => {
        const answer = await (ask?.('account', {}) ?? Promise.reject(new Error('no core to ask'))).catch(() => null)
        return typeof answer?.accountId === 'string' && answer.accountId && typeof answer.email === 'string' && answer.email
          ? { accountId: answer.accountId, email: answer.email } : null
      },
      onNotice: (listener) => view.onNotice?.(listener) ?? (() => {}),
      ...UNASKED.account,
      // The account's machine list is the one read of `/api/machines` the core's `backend` answer gives an experiment
      // already, so a service that is not asked for it gets the same refusal for it as for any other path. The Super
      // Tab service's route context needs it: in its own process it saw none (the 2026-10-19 manual run).
      machines: () => backend('GET', '/api/machines'),
    },
    clients: {
      viewerChanged: () => {}, viewerFrame: () => false, gridNamed: () => {}, gridModelsChanged: () => {}, dshInstallStatus: () => {},
      windows: (frame) => { void ask?.('windows', { frame }).catch(() => {}) },
      // Handed to the core in order; whether the relay took it is the core's to know, and a lost observer's
      // close follows.
      observer: (connId, type, payload) => {
        if (!ask) return false
        void ask('observer_send', { connId, type, payload }).catch(() => {})
        return true
      },
      ...UNASKED.clients,
    },
    daemon: {
      get command() { return daemon().command },
      get port() { return daemon().port },
      machineId: () => daemon().machineId(),
      get autonomousEnv() { return daemon().autonomousEnv },
    },
    wifi: UNASKED.wifi,
    // The cloud agents' doors (core/experimentQueries.ts): told to the core in order, never waited on. A core
    // that is not connected hears it all again when it is (services/cloudProcess.ts `republish`). A question's
    // id travels as `questionId`: `requestId` is the query's own, which the link writes over.
    ...(ask ? {
      cloud: {
        publish: (harnesses) => { void ask('cloud_publish', { harnesses }).catch(() => {}) },
        ask: (agentId, requestId, question) => { void ask('cloud_ask', { agentId, questionId: requestId, question }).catch(() => {}) },
        unask: (agentId, requestId) => { void ask('cloud_unask', { agentId, questionId: requestId }).catch(() => {}) },
      } satisfies CloudCore,
      // The Super Tab service's waits (superTabs/inCore/attention.ts), the whole set each time: a core that missed one
      // hears the next, and a new core the host's first roster (superTabs/host.ts).
      superTabs: {
        attention: (items) => { void ask('super_tab_attention', { items }).catch(() => {}) },
        // The Swarm cards, whole each time they change, and one Lead's recap (superTabs/inCore/cards.ts).
        cards: (items) => { void ask('super_tab_cards', { items }).catch(() => {}) },
        cardRecap: (recap) => { void ask('super_tab_card_recap', { recap }).catch(() => {}) },
        shareObservers: () => { void ask('super_tab_observers', {}).catch(() => {}) },
        // A Lead's read of a member's terminal and its typing (superTabs/inCore/terminal.ts), answered by the core.
        screen: (agentId, scrollback) => terminalAnswer(ask('super_tab_screen', { agentId, scrollback })) as Promise<SuperTabScreen>,
        input: (agentId, text, keys) => terminalAnswer(ask('super_tab_input', { agentId, text, keys })),
        dismissUpdate: (agentId) => terminalAnswer(ask('super_tab_dismiss_update', { agentId })),
      } satisfies SuperTabsCore,
    } : {}),
  }
}
