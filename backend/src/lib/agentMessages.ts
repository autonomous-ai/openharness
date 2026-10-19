import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { parseTabs } from './desk.js'

/**
 * Agent Messages, per tab (docs/design/2026-10-10-agent-messages.md): which desk tabs let their harnesses
 * message each other, and who is in each. The daemons read this to decide whether a message may go; the
 * windows read and set the flag. Off unless a person turned it on: a missing record is off.
 */

/** A tab's record address: the same for every pod and every write, so a concurrent first write converges. */
export const agentMessageTabId = (userId: string, tabId: string): string =>
  createHash('sha256').update(JSON.stringify(['agent-messages', userId, tabId])).digest('hex').slice(0, 24)

export interface AgentMessagesDirectory {
  /** The desk's revision this was read at. */
  revision: number
  /** The owner's machines by id, with the name a person gave each: what a message's header says it came from. */
  machines: { machineId: string; name: string | null }[]
  /** `named`: the person named the tab. The windows label any other tab themselves (`code`, a project), so its stored
   *  name (`New Tab`, a folder) is not what the person sees, and an agent's note calls it "this tab". */
  tabs: { id: string; name: string; named: boolean; enabled: boolean;
    /** The tab's leader; null when none is set or it may lead no more (`mayLead`: derived, never cleared). */
    leader: { machineId: string; agentId: string } | null; panes: { machineId: string; agentId: string }[] }[]
}

type Harness = { machineId: string; agentId: string }
/** A harness as one string, unambiguous whatever its ids hold: joined with '/', `m` + `a/b` and `m/a` + `b` were the
 *  same key, so a leader matching no pane could be stored (final review M1). */
const key = (h: Harness): string => JSON.stringify([h.machineId, h.agentId])

/** The harnesses a stored roster ({ body, signature }; the body is the owner's signed JSON) lists, by `key`.
 *  Read without verifying: it is this account's own share, and only names who may be chosen to lead its tab. */
function rosterHarnesses(roster: unknown): Set<string> {
  const body = (roster as { body?: unknown } | null)?.body
  if (typeof body !== 'string') return new Set()
  try {
    const harnesses = (JSON.parse(body) as { harnesses?: unknown } | null)?.harnesses
    return new Set((Array.isArray(harnesses) ? harnesses : []).flatMap((h: Partial<Harness> | null) =>
      typeof h?.machineId === 'string' && typeof h.agentId === 'string' ? [key(h as Harness)] : []))
  } catch { return new Set() }
}

/**
 * Who may lead a desk tab: a pane of that tab, on a machine of the account, or, in a tab the account shares (a share not
 * stopped), a harness its roster lists. A member's harness in a shared tab led it in 1c, and the owner's tab setting, the
 * leader's one source since, keeps that (the spec's "A leader in every tab"; ruling of the A2 review). Applied when it is
 * set and again at every read, so a leader that no longer qualifies (its pane closed or moved, its member gone from the
 * roster, the share stopped) reads as none without anything clearing it.
 */
function mayLead(leader: Harness, tabPanes: readonly Harness[], owned: ReadonlySet<string>, listed: ReadonlySet<string> | undefined): boolean {
  return tabPanes.some(p => key(p) === key(leader)) && (owned.has(leader.machineId) || !!listed?.has(key(leader)))
}

/** Every tab on the desk, with its owned panes and whether Agent Messages is on in it. */
export async function readAgentMessages(userId: string): Promise<AgentMessagesDirectory> {
  const [desk, machines, records] = await Promise.all([
    prisma.desk.findUnique({ where: { userId } }),
    prisma.machine.findMany({ where: { userId }, select: { machineId: true, name: true } }),
    prisma.agentMessageTab.findMany({ where: { userId }, select: { userId: true, tabId: true, enabled: true, leaderMachineId: true, leaderAgentId: true } }),
  ])
  const owned = new Set(machines.map(m => m.machineId))
  const on = new Set(records.filter(r => r.userId === userId && r.enabled).map(r => r.tabId))
  const leaders = new Map(records.filter(r => r.userId === userId && r.leaderMachineId && r.leaderAgentId)
    .map(r => [r.tabId, { machineId: r.leaderMachineId!, agentId: r.leaderAgentId! }]))
  // The rosters are read only when a leader is on a machine that is not the account's: a member's harness, which only
  // a share's roster lets lead. Every daemon reads this every 15 seconds.
  const rosters = [...leaders.values()].some(l => !owned.has(l.machineId))
    ? new Map((await prisma.agentMessageShare.findMany({ where: { ownerUserId: userId, stoppedAt: null }, select: { tabId: true, roster: true } }))
      .map(s => [s.tabId, rosterHarnesses(s.roster)]))
    : new Map<string, Set<string>>()
  return {
    revision: desk?.revision ?? 0,
    machines: machines.map(m => ({ machineId: m.machineId, name: m.name ?? null })),
    // A shared harness someone else owns is shown on the desk but never takes part: only the owner's machines.
    tabs: parseTabs(desk?.tabs).map(tab => {
      const panes = tab.panes.filter(p => owned.has(p.machineId)).map(p => ({ machineId: p.machineId, agentId: p.agentId }))
      const stored = leaders.get(tab.id)
      const leader = stored && mayLead(stored, tab.panes, owned, rosters.get(tab.id)) ? stored : null
      return { id: tab.id, name: tab.name, named: tab.nameIsCustom === true, enabled: on.has(tab.id), leader, panes }
    }),
  }
}

export interface AgentMessagesPatch { enabled?: boolean; leader?: { machineId: string; agentId: string } | null }

/** Turn Agent Messages on or off for one tab and/or set its leader; only the keys present are written. A new leader
 *  must be one that may lead the tab (`mayLead`; `INVALID_LEADER` otherwise). */
export async function setAgentMessages(userId: string, tabId: string, patch: AgentMessagesPatch):
  Promise<{ tabId: string; enabled: boolean; leader: { machineId: string; agentId: string } | null; revision: number } | { error: 'INVALID_LEADER' }> {
  if (patch.leader) {
    const { machineId } = patch.leader
    const [desk, machine] = await Promise.all([
      prisma.desk.findUnique({ where: { userId } }),
      prisma.machine.findFirst({ where: { machineId, userId } }),
    ])
    // A machine not the account's: only a harness the roster of this account's live share of the tab lists.
    const share = machine ? null : await prisma.agentMessageShare.findFirst({ where: { ownerUserId: userId, tabId, stoppedAt: null }, select: { roster: true } })
    const tabPanes = parseTabs(desk?.tabs).find(t => t.id === tabId)?.panes ?? []
    if (!mayLead(patch.leader, tabPanes, new Set(machine ? [machineId] : []), share ? rosterHarnesses(share.roster) : undefined)) return { error: 'INVALID_LEADER' }
  }
  const id = agentMessageTabId(userId, tabId)
  const data = {
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.leader !== undefined ? { leaderMachineId: patch.leader?.machineId ?? null, leaderAgentId: patch.leader?.agentId ?? null } : {}),
    revision: { increment: 1 },
  }
  // Explicit nulls at create: on MongoDB a `field: null` filter misses an absent field.
  const create = { id, userId, tabId, enabled: patch.enabled ?? false, leaderMachineId: patch.leader?.machineId ?? null, leaderAgentId: patch.leader?.agentId ?? null, revision: 1 }
  let row
  try {
    row = await prisma.agentMessageTab.upsert({ where: { id }, create, update: data })
  } catch (error) {
    // Two first writes at once: the loser updates the record the winner made.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    row = await prisma.agentMessageTab.update({ where: { id }, data })
  }
  if (row.userId !== userId || row.tabId !== tabId) throw new Error('Agent Messages record identity mismatch')
  const leader = row.leaderMachineId && row.leaderAgentId ? { machineId: row.leaderMachineId, agentId: row.leaderAgentId } : null
  return { tabId, enabled: row.enabled, leader, revision: row.revision }
}
