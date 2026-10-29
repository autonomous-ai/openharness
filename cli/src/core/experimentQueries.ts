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
 * - `stop_turn`: stop an agent's turn;
 * - `windows`: a change notice for every window on this computer (`orchestrator_changed`);
 * - `daemon`: how an agent's shell reaches this daemon, for the prompts the experiment writes;
 * - `backend`: a read or write of the account's backend under `/api/`, signed in by the core, which holds the
 *   sign-in (Share's links);
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
import type { AgentCreateRequest, CoreApi } from './api.js'
import { creationObservation } from '../lib/creationObservation.js'
import { nativeTurnCursorIn } from '../lib/nativeTurnObservations.js'

type Payload = Record<string, unknown>
type Core = Pick<CoreApi, 'agents' | 'turns' | 'clients' | 'daemon' | 'account' | 'cloud' | 'superTabs' | 'transcripts'>

const QUERIES: ReadonlySet<string> = new Set(['shown', 'close_swarm', 'keep_lead_alive', 'close_member', 'stopped', 'gone', 'creation_status', 'native_turns', 'create', 'stop_turn', 'windows', 'daemon', 'backend', 'observer_key', 'observer_send', 'account', 'cloud_publish', 'cloud_ask', 'cloud_unask', 'super_tab_attention', 'super_tab_cards', 'super_tab_card_recap', 'super_tab_observers', 'super_tab_screen', 'super_tab_input', 'super_tab_input_if_screen'])
const METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
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

/** What the add-ons of a device that is this machine ask in their own process (services/machineAddonsProcess.ts):
 *  this daemon's address, for the account's machine id. Answered before the experiments' check, which would refuse
 *  it as NOT_AN_EXPERIMENT; any other query of theirs is not answered here. */
export function answerMachineAddonsQuery(core: Pick<CoreApi, 'daemon'>, service: string, query: string): Payload | null {
  return service === 'machineAddons' && query === 'daemon' ? daemonAddress(core) : null
}

/** The answer to an experiment's query, or null when it is not one of these. */
export async function answerExperimentQuery(core: Core, experiments: ReadonlySet<string>, service: string, query: string, payload: Payload): Promise<Payload | null> {
  if (!QUERIES.has(query)) return null
  // `account` is also what models asks for the account's grid name, of its own link (core/modelsLink.ts): only
  // Share's is answered here. Seen 2026-10-18: since #1376 models got NOT_AN_EXPERIMENT back instead, so the
  // backend's grid name never reached it, and the picker said "Sign in to find models" to a signed-in person.
  if (query === 'account' && service !== 'sharing') return null
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
    case 'stopped':
      return { stopped: !!text(payload.agentId) && await core.agents.stopped?.(text(payload.agentId)) === true }
    case 'gone':
      return { gone: !!text(payload.agentId) && await core.agents.gone?.(text(payload.agentId)) === true }
    case 'creation_status':
      return { observation: await core.agents.creationStatus?.(text(payload.creationId)) ?? null }
    case 'native_turns': {
      const cursor = payload.cursor === undefined ? undefined : nativeTurnCursorIn(payload.cursor)
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(text(payload.agentId)) || cursor === null) return { error: 'INVALID_REQUEST' }
      return { page: await core.transcripts.nativeTurns?.(text(payload.agentId), cursor) ?? null }
    }
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
    case 'backend': {
      const method = text(payload.method), path = text(payload.path)
      if (!METHODS.has(method) || !path.startsWith('/api/')) return { error: 'INVALID_REQUEST' }
      return { ...await core.account.backend(method, path, payload.body) }
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
