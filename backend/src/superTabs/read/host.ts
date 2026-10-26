/**
 * The host form (design 4.10): for one machine, the rows of every Swarm it serves (full), or of the Swarms with a change
 * that concerns it since the cursor (incremental). Grants and billing live outside the parts, so the host asks for a full
 * read at start and at least every 60 s.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuthUser } from '../../lib/ssoAuth.js'
import { machineAlive } from '../../lib/prisma.js'
import { isTeamSession } from '../../lib/teamSession.js'
import { machineBillingAllowsDataPlane } from '../../lib/billingState.js'
import { fail, type AgentStart, type Conversation, type SuperTabState } from '../model.js'
import { transaction, type SuperTabStore } from '../store.js'
import * as parts from '../parts/index.js'
import type { MachineData, Part } from '../parts/index.js'
import { READ_FORMAT, type HostChanges } from './contract.js'
import { cursorFor, readCursor } from './cursor.js'
import { hostTab, type HostLookups } from './hostRows.js'

type Transaction = Prisma.TransactionClient
/** A full read covers this many of the machine's Swarms, most recently changed first (was 100 full Swarms each second). */
const FULL_TABS = 500

/** A change any host of the Swarm cares about without looking further (names, pause, observers, its agents and starts). */
function plainlyRelevant(part: Part, machineId: string): boolean {
  switch (part.kind) {
    case 'head': case 'member': return true
    case 'agent': return (part.data as { machineId?: string } | null)?.machineId === machineId
    case 'start': return (part.data as AgentStart | null)?.request.machineId === machineId
    case 'machine': return part.key === machineId || (part.data as MachineData | null)?.contribution?.hostMachineId === machineId
    case 'group': return (part.data as Conversation | null)?.assignment?.execution.machineId === machineId
    default: return false
  }
}
/** A change to a group one of its agents is in, or to the Mac a team account follows. */
function relevantTo(state: SuperTabState, part: Part, machineId: string): boolean {
  if (part.kind === 'group') {
    const agents = new Set(state.agents.filter(a => a.machineId === machineId).map(a => a.id))
    return ((part.data as Conversation | null)?.agentIds ?? []).some(id => agents.has(id))
  }
  return part.kind === 'machine' && state.machines?.find(m => m.machineId === machineId)?.hostMachineId === part.key
}

export class HostReads {
  private readonly db: PrismaClient
  private readonly now: () => number
  /** Reads the store's own database, on its clock unless given one (tests). */
  constructor(private readonly store: SuperTabStore, private readonly options: { now?: () => number; githubApp?: boolean; teamAccountsIdle?: boolean } = {}) {
    this.db = store.db
    this.now = options.now ?? store.now
  }

  async changes(user: AuthUser, machineId: string, request: { cursor?: string; full?: boolean }): Promise<HostChanges> {
    const t0 = this.now()
    const from = request.cursor && !request.full ? readCursor(request.cursor, 0, t0) : { reload: true as const }
    return transaction(this.db, async tx => {
      await this.store.hostFor(tx, user, machineId)
      const owned = await tx.machine.findFirst({ where: { machineId, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
      if (!owned || !machineBillingAllowsDataPlane(owned)) fail('HOST_UNAVAILABLE', 'This execution host is unavailable.', 403)
      // Swarms still in one row are migrated when first opened; the job migrates every one before the new release serves.
      const ids = (await tx.superTab.findMany({ where: { autonomousEnv: user.autonomousEnv, format: 2,
        OR: [{ machineIds: { has: machineId } }, { cleanupMachineIds: { has: machineId } }] },
        orderBy: { updatedAt: 'desc' }, take: FULL_TABS, select: { id: true } })).map(r => r.id)
      const teams = isTeamSession(user) || this.options.teamAccountsIdle ? [] : await tx.machine.findMany({ where: { userId: user.sub,
        hostMachineId: machineId, sessionKind: 'team', autonomousEnv: user.autonomousEnv, ...machineAlive }, select: { machineId: true } })
      const newest = await parts.lastChangedAt(tx, ids)
      const full = 'reload' in from
      const changed = full ? null : await parts.loadChanged(tx, ids, new Date(from.since))
      const tabs = []
      for (const tabId of ids) {
        const mine = changed?.get(tabId) ?? []
        if (changed && !mine.length) continue
        const state = await this.tabState(tx, tabId, machineId)
        if (changed && !mine.some(p => plainlyRelevant(p, machineId) || relevantTo(state, p, machineId))) continue
        tabs.push(await hostTab(tabId, state, machineId, user, newest.get(tabId) ?? null, await this.lookups(tx, state, teams)))
      }
      return { format: READ_FORMAT, full, cursor: cursorFor(t0, 0), tabs,
        removedTabIds: full ? [] : await this.removed(tx, user.autonomousEnv, machineId, from.since, new Set(ids)) }
    })
  }

  /** The Swarm's active parts plus, dormant ones included, every group its agents on this machine are in (a finished
   *  group that is not archived still keeps its agent from automatic cleanup) and every group of a start it holds (the
   *  host still settles a queued start whose group went quiet). */
  private async tabState(tx: Transaction, tabId: string, machineId: string): Promise<SuperTabState> {
    let loaded = await parts.loadActive(tx, tabId)
    const agentIds = loaded.agents.filter(a => !a.deleted && a.data?.machineId === machineId).map(a => a.key)
    const loadedGroups = new Set(loaded.groups.map(g => g.key))
    const groupIds = [...new Set(loaded.starts.map(s => s.data!.request.conversationId))].filter(id => !loadedGroups.has(id))
    if (agentIds.length || groupIds.length) loaded = await parts.loadActive(tx, tabId, { agentIds, groupIds })
    return parts.reassemble(loaded)
  }

  private async lookups(tx: Transaction, state: SuperTabState, teams: Array<{ machineId: string }>): Promise<HostLookups> {
    const people = await tx.user.findMany({ where: { id: { in: state.people.map(p => p.id) }, autonomousEnv: state.environment }, select: { id: true, email: true } })
    return { people, teams, githubApp: !!this.options.githubApp, agentGrant: target => this.store.agentGrant(tx, state, target) }
  }

  /** Swarms whose record of this machine changed since the cursor and that no longer list it. */
  private async removed(tx: Transaction, autonomousEnv: string, machineId: string, since: number, listed: Set<string>): Promise<string[]> {
    const rows = await tx.swarmMachine.findMany({ where: { machineId, changedAt: { gt: new Date(since) } }, select: { tabId: true } })
    const gone = [...new Set(rows.map(r => r.tabId))].filter(id => !listed.has(id))
    if (!gone.length) return []
    return (await tx.superTab.findMany({ where: { id: { in: gone }, autonomousEnv }, select: { id: true } })).map(r => r.id)
  }
}
