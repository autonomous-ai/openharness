/**
 * What an experiment in its own process may ask of the core (`service_query`, core/serviceLinks.ts), beside
 * the agents (core/agentQueries.ts) and its delivered turns (core/deliveries.ts): the generic hooks an
 * experiment acts on the core through, so that none of its own code runs in the core's process
 * (docs/design/2026-10-06-core-boundary-next.md, step 8).
 * - `shown`: the live agents as the apps are shown them: each with its name, whether its terminal is there,
 *   and what its frame says about its harness (its viewer);
 * - `create`: create an agent, as the window's `agent_create` does;
 * - `stop_turn`: stop an agent's turn;
 * - `windows`: a change notice for every window on this computer (`orchestrator_changed`);
 * - `daemon`: how an agent's shell reaches this daemon, for the prompts the experiment writes;
 * - `backend`: a read or write of the account's backend under `/api/`, signed in by the core, which holds the
 *   sign-in (Tab collaboration's tab channels);
 * - `observer_key`: this machine's public key, or its signature on a welcome to one observer of one share, by
 *   the gateway, which holds the identity (Share's owner);
 * - `observer_send`: a frame Share sealed for one of its observers, to the relay through the gateway.
 * The core answers them only for the experiments (core/api.ts `EXPERIMENTS`): creating an agent or
 * telling the windows something is no other process's to ask. The process's side is
 * services/processCoreApi.ts.
 */
import type { BackendSocket } from '../backendSocket.js'
import type { AgentCreateRequest, CoreApi } from './api.js'

type Payload = Record<string, unknown>
type Core = Pick<CoreApi, 'agents' | 'turns' | 'clients' | 'daemon' | 'account'>

const QUERIES: ReadonlySet<string> = new Set(['shown', 'create', 'stop_turn', 'windows', 'daemon', 'backend', 'observer_key', 'observer_send'])
const METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The answer to an experiment's query, or null when it is not one of these. */
export async function answerExperimentQuery(core: Core, experiments: ReadonlySet<string>, service: string, query: string, payload: Payload): Promise<Payload | null> {
  if (!QUERIES.has(query)) return null
  if (!experiments.has(service)) return { error: 'NOT_AN_EXPERIMENT' }
  switch (query) {
    case 'shown':
      return {
        agents: core.agents.live().map((session) => ({
          ...session,
          displayName: core.agents.displayName(session),
          terminalAvailable: core.agents.terminalAvailable(session.agentId),
          dshContext: core.agents.dsh(session),
        })),
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
    case 'observer_send': {
      const connId = text(payload.connId), type = text(payload.type)
      if (!connId.startsWith('observer:') || !type.startsWith('observer_') || !payload.payload || typeof payload.payload !== 'object') return { error: 'INVALID_FRAME' }
      return { sent: core.clients.observer(connId, type, payload.payload as Payload) }
    }
    default:
      return { command: core.daemon.command, port: core.daemon.port, machineId: core.daemon.machineId(), autonomousEnv: core.daemon.autonomousEnv }
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
