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
import { fail, type AgentStart, type SuperTabState } from '../model.js'
import { transaction, type SuperTabStore } from '../store.js'
import * as parts from '../parts/index.js'
import type { MachineData, Part } from '../parts/index.js'
import { READ_FORMAT, type HostChanges } from './contract.js'
import { cursorFor, readCursor } from './cursor.js'
import { hostTab, type HostLookups } from './hostRows.js'

type Transaction = Prisma.TransactionClient
/** A full read covers this many of the machine's Swarms, most recently changed first (was 100 full Swarms each second). */
const FULL_TABS = 500

/** A change any host of the Swarm cares about from the part alone: names, pause, observers, its agents and starts. */
function plainlyRelevant(part: Part, machineId: string): boolean {
  switch (part.kind) {
    case 'head': case 'member': return true
    case 'agent': return (part.data as { machineId?: string } | null)?.machineId === machineId
    case 'start': return (part.data as AgentStart | null)?.request.machineId === machineId
    default: return false
  }
}
const PLAIN_KINDS = ['head', 'member', 'agent', 'start'] as const

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
      const woken = full ? null : await this.woken(tx, ids, machineId, from.since)
      const tabs = []
      for (const tabId of ids) {
        if (woken && !woken.has(tabId)) continue
        const state = await this.tabState(tx, tabId, machineId)
        tabs.push(await hostTab(tabId, state, machineId, user, newest.get(tabId) ?? null, await this.lookups(tx, state, teams)))
      }
      return { format: READ_FORMAT, full, cursor: cursorFor(t0, 0), tabs,
        removedTabIds: full ? [] : await this.removed(tx, user.autonomousEnv, machineId, from.since, new Set(ids)) }
    })
  }

  /**
   * The Swarms with a change for this machine's host since the cursor. Groups and machine parts go by the markers their
   * writes left (parts/commit.ts), since their new data alone cannot say it: a group concerns the host when its agents or
   * its work were on this machine before or after the write (an agent leaving its last group, review round 1); a machine
   * part when its settings or ledger changed, never when only its reading did (every 15 s; group 5's run, 2026-10-26).
   */
  private async woken(tx: Transaction, ids: string[], machineId: string, since: number): Promise<Set<string>> {
    const after = new Date(since)
    const [changed, groups, machines] = await Promise.all([
      parts.loadChanged(tx, ids, after, PLAIN_KINDS),
      tx.swarmGroup.findMany({ where: { tabId: { in: ids }, changedAt: { gt: after }, hostMachineIds: { has: machineId } }, select: { tabId: true } }),
      tx.swarmMachine.findMany({ where: { tabId: { in: ids }, hostChangedAt: { gt: after } }, select: { tabId: true, key: true, data: true } }),
    ])
    const woken = new Set([...ids.filter(id => changed.get(id)?.some(p => plainlyRelevant(p, machineId))), ...groups.map(g => g.tabId)])
    // This machine's own settings, a team account's pool on this Mac, or the Mac this team account follows.
    const follows = new Map((await tx.swarmMachine.findMany({ where: { tabId: { in: [...new Set(machines.map(m => m.tabId))] }, key: machineId },
      select: { tabId: true, data: true } })).map(m => [m.tabId, (m.data as MachineData | null)?.contribution?.hostMachineId]))
    for (const m of machines) {
      if (m.key === machineId || (m.data as MachineData | null)?.contribution?.hostMachineId === machineId || follows.get(m.tabId) === m.key) woken.add(m.tabId)
    }
    return woken
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
    const rows = await tx.swarmMachine.findMany({ where: { machineId, hostChangedAt: { gt: new Date(since) } }, select: { tabId: true } })
    const gone = [...new Set(rows.map(r => r.tabId))].filter(id => !listed.has(id))
    if (!gone.length) return []
    return (await tx.superTab.findMany({ where: { id: { in: gone }, autonomousEnv }, select: { id: true } })).map(r => r.id)
  }
}
