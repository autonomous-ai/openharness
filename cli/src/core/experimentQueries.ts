/**
 * What an experiment in its own process may ask of the core (`service_query`, core/serviceLinks.ts), beside
 * the agents (core/agentQueries.ts) and its delivered turns (core/deliveries.ts): the generic hooks an
 * experiment acts on the core through, so that none of its own code runs in the core's process
 * (docs/design/2026-10-06-core-boundary-next.md, step 8).
 * - `shown`: the live agents as the apps are shown them: each with its name, whether its terminal is there,
 *   and what its frame says about its harness (its viewer);
 * - `create`: create an agent, as the window's `agent_create` does;
 * - `creation_status`: read the exact native receipt without exposing its launch request;
 * - `keep_lead_alive`, `close_member`: for the Super Tab service alone, reopen a stopped Swarm Lead and close a member
 *   whose session its backend ended, each only as core/api.ts allows;
 * - `last_turn`: a session's last turn as its engine recorded it, for the Super Tab service alone: after a restart that cut a message
 *   off in the middle of typing, whether its agent took it (superTabs/host.ts hadBeforeRestart), and what a Swarm process of 0.5.82
 *   asks at a turn's end;
 * - `turn_answer`: what the turn of a session that ended answered, named as its end named it (its prompt's hash and its number),
 *   for the Super Tab service alone: it posts the answer of the turn that ended into its agent's person's chat;
 * - `stop_turn`: stop an agent's turn;
 * - `windows`: a change notice for every window on this computer (`orchestrator_changed`);
 * - `daemon`: how an agent's shell reaches this daemon, for the prompts the experiment writes;
 * - `backend`: a read or write of the account's backend, signed in by the core, which holds the sign-in: only on the
 *   routes its service declared (core/api.ts `EXPERIMENT_BACKEND_ROUTES`: the Swarm's own API, Share's links, Jev's decision);
 * - `observer_key`: this machine's public key, or its signature on a welcome to one observer of one share, by
 *   the gateway, which holds the identity (Share's owner);
 * - `observer_send`: a frame Share sealed for one of its observers, to the relay through the gateway;
 * - `account`: the account signed in here, its id and email, as the core reads it (`core.account.identity`), for Share
 *   alone: the observers a shared tab wants are derived for this account's harnesses;
 * - `cloud_publish`, `cloud_ask`, `cloud_unask`: the cloud agents' harnesses and their questions
 *   (`core.cloud`, core/agents/cloud.ts), for the cloud service alone;
 * - `super_tab_attention`: the Super Tab members here waiting on a person (`core.superTabs`,
 *   superTabs/inCore/attention.ts), for the Super Tab service alone;
 * - `super_tab_cards`, `super_tab_card_recap`: the Swarms' cards and a Lead's last message for the Harness Pro
 *   (`core.superTabs`, superTabs/inCore/cards.ts), for the Super Tab service alone;
 * - `super_tab_observers`: members may watch an agent here, so Share must run (`core.superTabs`), for the Super Tab
 *   service alone;
 * - `super_tab_screen`, `super_tab_input`, `super_tab_input_if_screen`: a member's terminal read as plain text and typed into for its Lead,
 *   and keys typed there only while its screen is still the one the Service read
 *   (`core.superTabs`, superTabs/inCore/terminal.ts), for the Super Tab service alone.
 * The core answers them only for the experiments (core/api.ts `EXPERIMENTS`): creating an agent or
 * telling the windows something is no other process's to ask. The process's side is
 * services/processCoreApi.ts. Agent Messages, an experiment until 2026-10-12, asks a few of the same and is
 * answered by its own link, for what it uses alone (core/messagesLink.ts).
 */
import type { BackendSocket } from '../backendSocket.js'
import { experimentBackendAllowed, type AgentCreateRequest, type CoreApi } from './api.js'
import { creationObservation } from '../lib/creationObservation.js'

type Payload = Record<string, unknown>
type Core = Pick<CoreApi, 'agents' | 'turns' | 'clients' | 'daemon' | 'account' | 'cloud' | 'superTabs' | 'transcripts'>

const QUERIES: ReadonlySet<string> = new Set(['shown', 'activity', 'last_turn', 'turn_answer', 'close_swarm', 'keep_lead_alive', 'close_member', 'stopped', 'gone', 'creation_status', 'create', 'stop_turn', 'windows', 'daemon', 'backend', 'observer_key', 'observer_send', 'account', 'cloud_publish', 'cloud_ask', 'cloud_unask', 'super_tab_attention', 'super_tab_cards', 'super_tab_card_recap', 'super_tab_observers', 'super_tab_screen', 'super_tab_input', 'super_tab_input_if_screen'])
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The live agents as the apps are shown them (`shown`): each with its name, whether its terminal is there and
 *  what its frame says about its harness. */
export function shownAgents(core: Pick<CoreApi, 'agents'>): Payload {
  return {
    agents: core.agents.live().map((session) => ({
      ...session,
      displayName: core.agents.displayName(session),
      terminalAvailable: core.agents.terminalAvailable(session.agentId),
      selectedModel: core.agents.runtimeProfile(session),
      dshContext: core.agents.dsh(session),
    })),
  }
}

/** How an agent's shell reaches this daemon (`daemon`). */
export function daemonAddress(core: Pick<CoreApi, 'daemon'>): Payload {
  return { command: core.daemon.command, port: core.daemon.port, machineId: core.daemon.machineId(), autonomousEnv: core.daemon.autonomousEnv }
}

/** The services, not experiments, that ask how this daemon is reached: the add-ons of a device that is this machine
 *  (services/machineAddonsProcess.ts), for the account's machine id; Hachi's service (services/hachi.ts), which follows
 *  harnesses here and on the owner's other machines as a tool does; and the agent cleanup, which hands what Hachi
 *  started on another machine to the person there (services/hachiHandOver.ts). */
const DAEMON_ASKERS: ReadonlySet<string> = new Set(['machineAddons', 'hachi', 'agentCleanup'])

/** This daemon's address, to those services. Answered before the experiments' check, which would refuse it as
 *  NOT_AN_EXPERIMENT; any other query of theirs is not answered here. */
export function answerDaemonQuery(core: Pick<CoreApi, 'daemon'>, service: string, query: string): Payload | null {
  return DAEMON_ASKERS.has(service) && query === 'daemon' ? daemonAddress(core) : null
}

/** How many refused routes of one service are said: a process that asks for route after route fills no log. */
const REFUSALS_SAID = 16

/**
 * What a backend call on a route its service has not declared is answered, and where it is said (core/api.ts
 * `EXPERIMENT_BACKEND_ROUTES`, `MESSAGES_BACKEND_ROUTES`). Its process hears only that the call failed, which the Swarm
 * shows as a server it could not reach: so the core's log names the route, once for each service, method and path's
 * shape (a segment with a digit in it is an id), up to a bound for each service, and then says it stops. The path is
 * whatever that process sent: printable characters only, and never its query, which can hold what a person wrote.
 */
export function createRouteRefusals(log: (line: string) => void = (line) => console.warn(line)) {
  const said = new Map<string, Set<string>>()
  return (service: string, method: unknown, path: unknown, declared: (method: unknown, path: unknown) => boolean): Payload => {
    const [route = '', query] = String(path).split('?', 2)
    const shape = `${String(method).slice(0, 8)} ${route.slice(0, 160).split('/').map((part) => (/\d/.test(part) ? ':id' : part)).join('/')}`.replace(/[^\x21-\x7e ]/g, '?')
    const known = said.get(service) ?? new Set<string>()
    said.set(service, known)
    if (known.size < REFUSALS_SAID && !known.has(shape)) {
      known.add(shape)
      // Declared but for its query: the path is not what to look for.
      const why = query !== undefined && declared(method, route) ? 'with a query that holds a space, a # or a character that is not printable' : 'which it has not declared'
      log(`[services] ${service} asked for a backend route ${why}, and was refused: ${shape} (core/api.ts)`)
      if (known.size === REFUSALS_SAID) log(`[services] ${service}: further refused backend routes are not said`)
    }
    return { error: 'ROUTE_NOT_DECLARED' }
  }
}
/** The core's own: one bound for each service for as long as the core runs. */
export const routeRefused = createRouteRefusals()

/** The answer to an experiment's query, or null when it is not one of these. */
export async function answerExperimentQuery(core: Core, experiments: ReadonlySet<string>, service: string, query: string, payload: Payload,
  refused: ReturnType<typeof createRouteRefusals> = routeRefused): Promise<Payload | null> {
  if (!QUERIES.has(query)) return null
  // `account` is also what models asks for the account's grid name, of its own link (core/modelsLink.ts): only
  // Share's and the Swarm's are answered here. Seen 2026-10-18: since #1376 models got NOT_AN_EXPERIMENT back instead, so
  // the backend's grid name never reached it, and the picker said "Sign in to find models" to a signed-in person. The
  // Swarm's round dial cards need the reader to find their own Buddy: answered nothing, the dial said "No Buddy here
  // yet" to a person with one (Diego's dial, 2026-10-29).
  if (query === 'account' && service !== 'sharing' && service !== 'superTabs') return null
  if (!experiments.has(service)) return { error: 'NOT_AN_EXPERIMENT' }
  switch (query) {
    case 'shown':
      return shownAgents(core)
    case 'close_swarm': {
      if (service !== 'superTabs') return { error: 'NOT_SUPER_TABS' }
      const { agentId, creationId, sessionId, createdAt, expiresAt } = payload
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(text(agentId)) ||
          creationId !== undefined && (typeof creationId !== 'string' || !/^[A-Za-z0-9_-]{16,96}$/.test(creationId)) ||
          sessionId !== undefined && typeof sessionId !== 'string' ||
          createdAt !== undefined && (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) ||
          expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) return { error: 'INVALID_REQUEST' }
      return { ...await (core.agents.closeSwarm?.({ agentId: agentId as string,
        ...(typeof creationId === 'string' ? { creationId } : {}), ...(typeof sessionId === 'string' ? { sessionId } : {}),
        ...(typeof createdAt === 'string' ? { createdAt } : {}), ...(typeof expiresAt === 'number' ? { expiresAt } : {}) }) ?? { error: 'UNSUPPORTED' }) }
    }
    // The Super Tab host keeps its Leads alive and closes the sessions its backend ends; the core decides which (core/api.ts).
    case 'keep_lead_alive':
    case 'close_member': {
      if (service !== 'superTabs') return { error: 'NOT_SUPER_TABS' }
      const { agentId, creationId } = payload
      if (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(agentId)
        || creationId !== undefined && (typeof creationId !== 'string' || !/^[A-Za-z0-9_-]{16,96}$/.test(creationId))) return { error: 'INVALID_REQUEST' }
      return query === 'keep_lead_alive'
        ? { ...await (core.agents.keepLeadAlive?.(agentId) ?? { ok: false, error: 'UNSUPPORTED' }) }
        : { ...await (core.agents.closeMember?.(agentId, creationId as string | undefined) ?? { error: 'UNSUPPORTED' }) }
    }
    // Whether its agents are in a turn (superTabs/host.ts).
    case 'activity': {
      if (service !== 'superTabs') return { error: 'NOT_SUPER_TABS' }
      const ids = Array.isArray(payload.agentIds) ? payload.agentIds.filter((id): id is string => typeof id === 'string').slice(0, 64) : []
      return { activity: await core.agents.activity(ids) }
    }
    // Whether an agent took a message a restart cut off in the middle of typing (superTabs/host.ts hadBeforeRestart), and what a Swarm
    // process of 0.5.82 asks at a turn's end.
    case 'last_turn': {
      if (service !== 'superTabs') return { error: 'NOT_SUPER_TABS' }
      const sessionId = text(payload.sessionId)
      if (!sessionId || sessionId.length > 256) return { error: 'INVALID_REQUEST' }
      return { turn: await core.transcripts.lastTurn(sessionId) }
    }
    // The answer of the turn that just ended, which the Swarm host posts into its agent's person's chat (superTabs/agentReplies.ts): the
    // turn its end named by its prompt's hash and its number, as the core heard it said (core/turns/ends.ts).
    case 'turn_answer': {
      if (service !== 'superTabs') return { error: 'NOT_SUPER_TABS' }
      const sessionId = text(payload.sessionId), prompt = text(payload.prompt), { turnId } = payload
      if (!sessionId || sessionId.length > 256 || !/^[0-9a-f]{32}$/.test(prompt) || !Number.isSafeInteger(turnId) || (turnId as number) < 1) return { error: 'INVALID_REQUEST' }
      return { answer: await core.turns.answerOf({ sessionId, prompt, turnId: turnId as number }) }
    }
    case 'stopped':
      return { stopped: !!text(payload.agentId) && await core.agents.stopped?.(text(payload.agentId)) === true }
    case 'gone':
      return { gone: !!text(payload.agentId) && await core.agents.gone?.(text(payload.agentId)) === true }
    case 'creation_status':
      return { observation: await core.agents.creationStatus?.(text(payload.creationId)) ?? null }
    case 'create': {
      if (!text(payload.engine) || !text(payload.cwd) || typeof payload.prompt !== 'string' || typeof payload.name !== 'string') return { ok: false, error: 'INVALID_REQUEST' }
      const request: AgentCreateRequest = {
        engine: payload.engine as AgentCreateRequest['engine'],
        cwd: text(payload.cwd),
        dsh: text(payload.dsh) || null,
        prompt: payload.prompt,
        name: payload.name,
        bypassPermission: payload.bypassPermission === true,
      }
      return { ...await core.agents.create(request) }
    }
    case 'stop_turn':
      if (text(payload.agentId)) core.turns.stop(text(payload.agentId))
      return {}
    case 'windows': {
      const frame = payload.frame as Payload | undefined
      // A change notice and nothing else: what the windows hear from the core itself is the core's to say.
      if (!frame || !/^[a-z]+_changed$/.test(text(frame.type)) || !frame.payload || typeof frame.payload !== 'object') return { error: 'INVALID_FRAME' }
      core.clients.windows({ type: text(frame.type), payload: frame.payload as Payload })
      return {}
    }
    // Only the routes its service declared, by method and whole path (core/api.ts `EXPERIMENT_BACKEND_ROUTES`): the core
    // signs the call, so any other would be this account's to whatever code runs in that process.
    case 'backend': {
      const { method, path } = payload
      if (!experimentBackendAllowed(service, method, path)) return refused(service, method, path, (m, p) => experimentBackendAllowed(service, m, p))
      return { ...await core.account.backend(method as string, path as string, payload.body) }
    }
    case 'observer_key':
      try {
        if (payload.op === 'public') return { key: await core.account.observerKey.publicKey() }
        return { key: await core.account.observerKey.signWelcome(text(payload.machineId), text(payload.shareId), text(payload.peer), text(payload.ephemeral)) }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    case 'cloud_publish':
    case 'cloud_ask':
    case 'cloud_unask': {
      if (service !== 'cloud' || !core.cloud) return { error: 'NOT_CLOUD' }
      if (query === 'cloud_publish') core.cloud.publish(Array.isArray(payload.harnesses) ? payload.harnesses : [])
      else if (query === 'cloud_ask') core.cloud.ask(text(payload.agentId), text(payload.questionId), (payload.question ?? {}) as { text: string; choices: string[] })
      else core.cloud.unask(text(payload.agentId), text(payload.questionId))
      return {}
    }
    case 'super_tab_attention': {
      // The core checks each item (superTabs/inCore/attention.ts): what reaches the devices is decided there, not here.
      if (service !== 'superTabs' || !core.superTabs) return { error: 'NOT_SUPER_TABS' }
      core.superTabs.attention(Array.isArray(payload.items) ? payload.items : [])
      return {}
    }
    case 'super_tab_cards':
    case 'super_tab_card_recap': {
      // Checked by the core (superTabs/inCore/cards.ts), which drops what is not sound; here only the list's shape.
      if (service !== 'superTabs' || !core.superTabs) return { error: 'NOT_SUPER_TABS' }
      if (query === 'super_tab_cards') core.superTabs.cards(Array.isArray(payload.items) ? payload.items : [])
      else core.superTabs.cardRecap(payload.recap as never)
      return {}
    }
    case 'super_tab_observers':
      if (service !== 'superTabs' || !core.superTabs) return { error: 'NOT_SUPER_TABS' }
      core.superTabs.shareObservers()
      return {}
    case 'super_tab_screen':
    case 'super_tab_input':
    case 'super_tab_input_if_screen': {
      if (service !== 'superTabs' || !core.superTabs) return { error: 'NOT_SUPER_TABS' }
      const { agentId, scrollback = 0, text: typed = '', keys = [], screen } = payload
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(text(agentId)) || typeof scrollback !== 'number' || typeof typed !== 'string'
        || !Array.isArray(keys) || !keys.every(key => typeof key === 'string')
        || (query === 'super_tab_input_if_screen' && (typeof screen !== 'string' || !keys.length))) return { ok: false, error: 'INVALID_REQUEST' }
      return { ...query === 'super_tab_screen' ? await core.superTabs.screen(agentId as string, scrollback)
        : query === 'super_tab_input_if_screen' ? await core.superTabs.inputIfScreen(agentId as string, keys as string[], screen as string)
        : await core.superTabs.input(agentId as string, typed, keys as string[]) }
    }
    case 'account': {
      const known = await core.account.identity()
      return known ? { ...known } : { error: 'ACCOUNT_UNAVAILABLE' }
    }
    case 'observer_send': {
      const connId = text(payload.connId), type = text(payload.type)
      if (!connId.startsWith('observer:') || !type.startsWith('observer_') || !payload.payload || typeof payload.payload !== 'object') return { error: 'INVALID_FRAME' }
      return { sent: core.clients.observer(connId, type, payload.payload as Payload) }
    }
    default:
      return daemonAddress(core)
  }
}

/**
 * `core.agents.create`: the window's `agent_create` (the socket's `onCreateAgent`) with no grid, Codex profile,
 * named agent or permission mode of the agent's own, as the socket created the orchestrator's agents for it.
 */
export async function createForExperiment(create: BackendSocket['onCreateAgent'], request: AgentCreateRequest): ReturnType<CoreApi['agents']['create']> {
  if (!create) return { ok: false, error: 'UNSUPPORTED', detail: 'This daemon cannot create agents.' }
  const result = await create({ ...request, grid: null, codexHome: null, agent: null, permissionMode: null })
  return result.ok ? { ok: true, agentId: result.session.agentId } : { ok: false, error: result.error, ...(result.detail ? { detail: result.detail } : {}) }
}

/** Read the window's receipt through its existing provider; never infer a
 * cancelled launch from a missing callback, an old core or a failed read. */
export async function creationForExperiment(read: BackendSocket['createStatusProvider'], creationId: string) {
  if (!read || !/^[A-Za-z0-9_-]{16,96}$/.test(creationId)) return null
  let reply: Record<string, unknown> | null = null
  try { await read({ creationId }, { local: true }, value => { reply = value }) } catch { return null }
  const frame = reply as Record<string, unknown> | null
  const agent = frame?.agent as { id?: unknown } | undefined
  // A closed terminal is unavailable to a window, but its durable creation
  // receipt still identifies what launched. A service can check its stop.
  return creationObservation(creationId, frame?.state === 'unavailable'
    ? { ...frame, state: 'created', agentId: frame.createdAgentId }
    : { ...frame, agentId: agent?.id })
}
