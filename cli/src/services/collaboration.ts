/**
 * Tab collaboration and teams (`collaboration`), an experiment: agents on this machine and the owner's others asking each other
 * questions in a team or a tab's swarm (teams/service.ts), the mailbox that writes those turns into this
 * machine's agents and keeps their receipts (teams/mailbox.ts), and the tab channels read from the account
 * (teams/channels.ts). Moved out of the socket as it was (docs/design/2026-10-06-core-boundary-next.md, step
 * 8, move only): what the socket gave them, they now get from the core's API, in the core's process
 * (`HARNESSD_SERVICES=none`) or in the teams' own (services/collaborationProcess.ts), beside the prompt
 * scopes (services/teamsProcess.ts), as a service of its own there.
 * - The `team` and `team_delivery` requests, for an owner alone, as the socket answered them.
 * - A team's turns, delivered through the core (`core.turns.deliver`), what became of each, and whether one
 *   still holds its agent's pane (`canWrite`), which the core asks in line as it writes it.
 * - The prompt scopes it reads (`scopes`): the service's own in the core's process; in the teams' process,
 *   the core's word on them (core/teamsLink.ts), where a change on its way reads as no team.
 * - The tab channels, read and set through the account (`core.account.backend`), polled while it runs and
 *   read again at the account's `desk_changed`.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CoreApi, CorePorts, ServiceRequests, TurnDelivery } from '../core/api.js'
import { ChannelDirectory } from '../teams/channels.js'
import { teamRpc } from '../teams/client.js'
import { TeamMailbox } from '../teams/mailbox.js'
import { Address, Id, OperationId, Receipt, TeamError, type MemberRuntime } from '../teams/model.js'
import { SwarmPromptScopes } from '../teams/promptScope.js'
import { TeamService } from '../teams/service.js'
import { teamDeliveryRequest, teamFailure, teamRequest } from '../teams/wire.js'

/** The requests the teams answer, declared in core/api.ts for the core to route. */
export { TEAMS_REQUESTS } from '../core/api.js'

/** The prompt scopes as the teams read them: the team an agent's current prompt came from, and an answer to a
 *  team's question moving it back. */
export interface TeamScopes {
  current(agentId: string): string | null | Promise<string | null>
  replied(agentId: string, teamId: string, questionId: string): void | Promise<unknown>
}

export interface TeamsOptions {
  scopes: TeamScopes
  /** Where the teams keep their ledgers and mailboxes; an isolated fixture's own. */
  stateDir?: string
  /** The command a member on this machine runs `team` with; an isolated fixture's own. */
  command?: string | null
  /** How a request reaches another of the owner's machines: through this daemon's own local socket. */
  rpc?: typeof teamRpc
  /** The local socket's folder (`ADAPTER_DATA_DIR`) the other machines are reached through. */
  dataDir?: string
  /**
   * Before the mailbox takes a delivery back (a cancel, a hold, read through the inbox): the teams' own
   * process asks the core whether the turn could still be taken back, since the mailbox reads that answer in
   * line (`core.turns.cancelDelivery`) and the core's cannot wait. Released once the mailbox has read it.
   */
  takingBack?: (deliveryId: string) => Promise<() => void>
  /** Something that decides whether a delivery may be written changed: the teams' process tells the core. */
  changed?: () => void
}

/** The mailbox's actions that may take a delivery the core holds back. */
const TAKES_BACK: ReadonlySet<string> = new Set(['cancel', 'consume', 'hold'])

export interface Teams {
  requests: ServiceRequests
  /** Whether a team's delivery still holds its agent's pane: the mailbox's word, in line. */
  canWrite(deliveryId: string): boolean
  /** The account's tab channels changed (`desk_changed`): read them again. */
  refreshChannels(): void
  /** Resume persisted queues after input wiring is ready, even with no UI attached. */
  start(): void
  stop(): void
}

export function startCollaboration(core: CoreApi, options: TeamsOptions): Teams {
  const stateDir = options.stateDir ?? join(core.dataDir, 'teams')
  const rpc = options.rpc ?? teamRpc
  // Read as each is used: in the teams' own process the core says them once it is connected, after this starts.
  const machineId = (): string => core.daemon.machineId()
  const at = (to: string) => ({ port: core.daemon.port, machineId: to, dataDir: options.dataDir ?? core.dataDir })
  const scopes = options.scopes
  let channelsEnabled = false
  let channelDirectory: ChannelDirectory | null = null
  let teamService: TeamService | null = null
  let teamMailboxService: TeamMailbox | null = null

  const readDesk = async (): Promise<unknown> => {
    const response = await core.account.backend('GET', '/api/tab-channels')
    if (response.status === 404) throw new TeamError('CHANNELS_UNSUPPORTED', 'Tab channels are not enabled on this Harness server.')
    if (response.status !== 200 || response.body.success !== true) throw new Error('The saved channel directory is unavailable.')
    return response.body.data
  }
  const writeSettings = async (enabled: boolean): Promise<unknown> => {
    const response = await core.account.backend('PATCH', '/api/tab-channels/settings', { enabled })
    if (response.status === 404) throw new TeamError('CHANNELS_UNSUPPORTED', 'Update the Harness server to configure swarm collaboration.')
    if (response.status !== 200 || response.body.success !== true) throw new TeamError('CHANNEL_SETTINGS_FAILED', 'The swarm setting could not be saved. Refresh Settings to check its state.')
    return response.body.data
  }
  const channels = (): ChannelDirectory => channelDirectory ??= new ChannelDirectory({
    machineId: machineId(), service: teams(), readDesk,
    writeSettings,
    enabledChanged: enabled => { channelsEnabled = enabled; teamMailboxService?.pump(); options.changed?.() },
    forward: (to, payload) => rpc(at(to), 'team', payload),
  })
  const localTeamRuntime = (agentId: string): MemberRuntime | null => {
    const agent = core.agents.byAgent(agentId)
    return agent ? { name: core.agents.displayName(agent), engine: agent.engine, cwd: agent.cwd ?? undefined,
      available: agent.active && core.agents.terminalAvailable(agentId),
      ...(!agent.active ? { reason: 'Session is paused or offline.' } : {}) } : null
  }
  const teamMailbox = (): TeamMailbox => teamMailboxService ??= new TeamMailbox({
    stateDir: join(stateDir, 'mailboxes'),
    channelsEnabled: () => channelsEnabled,
    runtime: id => localTeamRuntime(id),
    send: (id, text, deliveryId) => core.turns.deliver(id, text, deliveryId),
    cancel: id => core.turns.cancelDelivery(id),
  })
  const teams = (): TeamService => teamService ??= new TeamService({
    stateDir: join(stateDir, 'ledgers'), machineId: machineId(),
    taskScope: async address => {
      if (address.machineId === machineId()) return scopes.current(address.agentId)
      const result = await rpc(at(address.machineId),
        'team_delivery', { action: 'prompt_scope', agentId: address.agentId })
      return typeof result.teamId === 'string' ? result.teamId : null
    },
    questionReplied: async (address, teamId, questionId) => {
      if (address.machineId === machineId()) await scopes.replied(address.agentId, teamId, questionId)
      else await rpc(at(address.machineId),
        'team_delivery', { action: 'prompt_replied', agentId: address.agentId, teamId, questionId })
    },
    command: address => address.machineId === machineId()
      ? options.command ?? `${core.daemon.command} team --port ${core.daemon.port}`
      : 'harness team',
    runtime: async address => {
      Address.parse(address)
      if (address.machineId === machineId()) return localTeamRuntime(address.agentId)
      const result = await rpc(at(address.machineId), 'team_delivery', { action: 'runtime', agentId: address.agentId })
      return result.runtime as MemberRuntime | null
    },
    delivery: async (address, action, delivery) => {
      if (address.machineId === machineId()) {
        const mailbox = teamMailbox()
        return takeBack(TAKES_BACK.has(action) ? delivery.id : null, () => action === 'send' ? mailbox.accept(delivery) : action === 'status' ? mailbox.status(delivery.id)
          : action === 'hold' || action === 'release' ? mailbox.hold(delivery.id, action === 'hold') : mailbox.cancel(delivery.id, action === 'consume'))
      }
      const result = await rpc(at(address.machineId), 'team_delivery', { action, delivery })
      return result.receipt == null ? null : Receipt.parse(result.receipt)
    },
    changed: (id, revision) => core.clients.windows({ type: 'team_changed', payload: { id, revision } }),
  })
  const stopHearing = core.turns.onDelivery((event: TurnDelivery) => teamMailboxService?.observe(event))
  const stopNotices = core.account.onNotice((notice) => { if (notice.type === 'desk_changed') void channels().refresh(true).catch(() => {}) })

  return {
    requests: {
      team: (payload, asker) => answer('team', payload, asker),
      team_delivery: (payload, asker) => answer('team_delivery', payload, asker),
    },
    canWrite: (deliveryId) => teamMailboxService?.canWrite(deliveryId) ?? false,
    refreshChannels: () => { void channels().refresh(true).catch(() => {}) },
    start: () => {
      channels().start()
      if (!existsSync(stateDir)) return
      try { teamMailbox().start(); teams().start() }
      catch { console.warn('[teams] preserved unreadable team state; inspect Team for recovery') }
    },
    stop: () => {
      stopHearing()
      stopNotices()
      teamService?.stop()
      teamMailboxService?.stop()
      channelDirectory?.stop()
    },
  }

  function answer(type: 'team' | 'team_delivery', payload: Record<string, unknown>, asker: { owner: boolean }): Promise<Record<string, unknown>> | Record<string, unknown> {
    // Observers never reach a service's request; only the owner or a paired owner client does.
    if (!asker.owner) return { error: 'OWNER_REQUIRED', detail: 'Team communication requires an owner connection.' }
    return Promise.resolve().then(async () => {
      if (type === 'team') {
        if (payload.action === 'context') {
          const agentId = Id.parse(payload.agentId)
          return channels().taskContext(agentId, await scopes.current(agentId))
        }
        if (String(payload.action).startsWith('channel_')) return channels().request(payload)
        if (typeof payload.teamId === 'string' && teams().isChannel(payload.teamId)
            && ['ask', 'get', 'members'].includes(String(payload.action))) await channels().refresh(payload.action === 'ask')
        return teamRequest(teams(), payload)
      }
      if (payload.action === 'runtime') return { runtime: localTeamRuntime(Id.parse(payload.agentId)) }
      if (payload.action === 'prompt_scope') return { teamId: await scopes.current(Id.parse(payload.agentId)) }
      if (payload.action === 'prompt_replied') {
        await scopes.replied(Id.parse(payload.agentId), OperationId.parse(payload.teamId), OperationId.parse(payload.questionId))
        return { ok: true }
      }
      const delivery = payload.delivery as { id?: unknown } | undefined
      return takeBack(TAKES_BACK.has(String(payload.action)) && typeof delivery?.id === 'string' ? delivery.id : null,
        () => teamDeliveryRequest(teamMailbox(), payload))
    }).catch(error => teamFailure(error))
  }

  /** Run a mailbox action, taking a delivery back as the teams' process must (`takingBack`), and say that
   *  what may be written may have changed. */
  async function takeBack<T>(deliveryId: string | null, act: () => T): Promise<T> {
    const release = deliveryId && options.takingBack ? await options.takingBack(deliveryId) : null
    try { return act() } finally {
      release?.()
      options.changed?.()
    }
  }
}

/**
 * The teams in the core's process (`HARNESSD_SERVICES=none`), as the socket ran them: the prompt scopes the
 * core records into are the service's own, read in line, and the service starts at once.
 */
export function startTeamsInCore(core: CoreApi, ports: CorePorts, options: Omit<TeamsOptions, 'scopes'> = {}): ServiceRequests {
  const scopes = new SwarmPromptScopes()
  const teams = startCollaboration(core, { ...options, scopes })
  ports.teams = Object.assign({
    prepare: scopes.prepare.bind(scopes), started: scopes.started.bind(scopes), raw: scopes.raw.bind(scopes), forget: scopes.forget.bind(scopes),
    canWrite: (deliveryId: string) => teams.canWrite(deliveryId),
  }, { stop: () => teams.stop() })
  teams.start()
  return teams.requests
}
