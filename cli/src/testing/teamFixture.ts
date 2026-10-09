/**
 * The teams on a socket, for the teams' own specs written against it (teams/remote.spec.ts,
 * teams/transport.spec.ts) when the team features were the socket's: its state folder and command
 * (`teamStateDir`, `teamCommand`), its prompt scopes (`swarmPromptScopes`), what became of a delivery
 * (`teamDelivery`), the account's tab channels (`readChannelDesk`) and their start (`startTeams`).
 *
 * Tab collaboration is now a service (services/collaboration.ts), routed by the socket like any other. This
 * starts it on the socket in its own process, as `HARNESSD_SERVICES=none` does, from the core's API as those
 * specs knew it: the real registry's agents, the turns the socket's `onMessage` writes, and the frames the
 * socket sends its windows. So the specs run as they were written, and say the same of the moved service.
 */
import type { BackendSocket } from '../backendSocket.js'
import { env } from '../config/env.js'
import { ACCOUNT_BACKEND_OFF, AGENT_ACTIONS_OFF, CONVERSATIONS_OFF, DELIVERIES_OFF, LANE_OFF, TERMINALS_OFF, type CoreApi, type TurnDelivery } from '../core/api.js'
import { projectDisplayName, registry } from '../lib/registry.js'
import type { SessionInputDelivery } from '../lib/sessionInput.js'
import { startCollaboration, type Teams } from '../services/collaboration.js'
import { UNASKED } from '../services/processCoreApi.js'
import { SwarmPromptScopes } from '../teams/promptScope.js'

export interface TeamFixture {
  /** Where the teams keep their ledgers and mailboxes. */
  teamStateDir: string
  /** The command a member on this machine runs `team` with. */
  teamCommand: string | null
  /** The prompt scopes the teams read. */
  swarmPromptScopes: SwarmPromptScopes
  /** The account's tab channels, as the backend would answer them; none: no channels. */
  readChannelDesk: (() => Promise<unknown>) | null
  /** What became of a delivery, as the core's input says it. */
  teamDelivery(event: SessionInputDelivery): void
  /** Resume persisted queues and poll the channels, as the daemon does once its input is wired. */
  startTeams(): void
}

export function attachTeams<T extends BackendSocket>(socket: T): T & TeamFixture {
  const listeners = new Set<(event: TurnDelivery) => void>()
  let teams: Teams | null = null
  const fixture = socket as T & TeamFixture
  const core = (): CoreApi => ({
    dataDir: env.ADAPTER_DATA_DIR,
    terminals: TERMINALS_OFF,
    machine: UNASKED.machine,
    conversations: CONVERSATIONS_OFF,
    agents: {
      all: () => registry.list(), live: () => registry.list(), displayName: projectDisplayName,
      byAgent: (agentId) => registry.byAgent(agentId), resolve: (id) => registry.resolve(id), advertised: () => registry.advertised(),
      terminalAvailable: (agentId) => registry.terminalAvailable(agentId), sync: () => {},
      runtimeModels: async () => [], runtimeProfile: () => null, setRuntime: () => {}, fork: async () => ({ ok: false, error: 'UNSUPPORTED' }),
      ...AGENT_ACTIONS_OFF,
      activityText: UNASKED.activityText,
    },
    turns: {
      send: () => {}, stop: () => {}, recent: async () => [], asks: async () => [],
      ...DELIVERIES_OFF,
      deliver: (agentId, text, deliveryId) => socket.onMessage?.(agentId, text, deliveryId),
      cancelDelivery: (deliveryId) => socket.onCancelOrchestratorMessage?.(deliveryId) ?? false,
      onDelivery: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    questions: { answer: () => {}, answerReviewed: async () => false },
    transcripts: { databaseHistory: () => undefined, lastTurn: async () => null },
    account: {
      mintGridName: async () => null, accessToken: () => Promise.reject(new Error('no credential')), lane: LANE_OFF,
      privateGridName: async () => null, machineName: () => null,
      ...ACCOUNT_BACKEND_OFF,
      ...UNASKED.account,
      // The tab channels as the spec says the account has them; a backend without them answers 404.
      backend: async (method, path) => {
        if (method !== 'GET' || path !== '/api/tab-channels' || !fixture.readChannelDesk) return { status: 404, body: {} }
        return { status: 200, body: { success: true, data: await fixture.readChannelDesk() } }
      },
    },
    clients: {
      viewerChanged: () => {}, viewerFrame: () => false, gridNamed: () => {}, gridModelsChanged: () => {}, dshInstallStatus: () => {},
      windows: (frame) => socket.sendLocal(frame),
      observer: () => false,
      ...UNASKED.clients,
    },
    daemon: { command: 'harness', port: env.PORT, machineId: () => socket.machineId, autonomousEnv: 'prod' },
    wifi: UNASKED.wifi,
  })
  /** Built at its first use, from what the spec set by then. */
  const collaboration = (): Teams => teams ??= startCollaboration(core(), {
    scopes: fixture.swarmPromptScopes, stateDir: fixture.teamStateDir, command: fixture.teamCommand, dataDir: env.ADAPTER_DATA_DIR,
  })
  Object.assign(fixture, {
    teamStateDir: `${env.ADAPTER_DATA_DIR}/teams`,
    teamCommand: null,
    swarmPromptScopes: new SwarmPromptScopes(),
    readChannelDesk: null,
    teamDelivery: (event: SessionInputDelivery) => { for (const listener of listeners) listener(event) },
    startTeams: () => collaboration().start(),
  })
  socket.serviceRouter = (type, payload, asker, reply) => {
    if (type !== 'team' && type !== 'team_delivery') return false
    void Promise.resolve(collaboration().requests[type](payload, asker)).then(reply)
    return true
  }
  const stop = socket.stop.bind(socket)
  socket.stop = async () => {
    teams?.stop()
    await stop()
  }
  return fixture
}
