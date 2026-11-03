/**
 * Brought: what a person's machines did for the Swarm (contributor view, #2444; PRODUCT.md Contribution, Seen). Each machine
 * they brought that the reader may see, a Mac's Harness Team account folded into its Mac, with the verified requests that
 * shipped on it, its busy time on other people's tasks (lent.ts), and each contributed engine's weekly window. And the
 * period's contributors: people whose machine ran an attempt. Pure, from what the board already holds.
 */
import type { ContributedMachine } from '../machines.js'
import type { Conversation, SuperTabState } from '../model.js'
import type { Run } from './record.js'
import { within, type Span } from './rolling.js'
import type { BroughtMachine } from './contract.js'

/** The machine an attempt ran on: recorded with it, else (an attempt from before that) its agent's while the agent exists. */
export function runMachine(state: SuperTabState, run: Pick<Run, 'machineId' | 'agentId'>): string | undefined {
  return run.machineId ?? (run.agentId ? state.agents.find(a => a.id === run.agentId)?.machineId : undefined)
}

/** The machine the attempt a request shipped on ran on: the one kept when it shipped, else its last attempt by then. */
export function shippedOnMachine(state: SuperTabState, group: Conversation): string | undefined {
  const ledger = group.ledger!
  const shipping = ledger.shippedBy ?? (ledger.runs ?? []).filter(r => r.at <= ledger.shippedAt!).at(-1)
  if (!shipping) return undefined
  // A ship recorded before machines were names its attempt; that attempt's run may still say where it ran.
  return shipping.machineId ?? runMachine(state, ledger.runs?.find(r => r.assignmentId === shipping.assignmentId) ?? {})
}

/** Verified, as far as the server knows (PRODUCT.md north star): shipped with a pull request, and no fix merged after it. */
export const verified = (group: Conversation): boolean =>
  group.ledger?.shippedAt != null && (group.pullRequestUrls?.length ?? 0) > 0 && group.ledger.fixedAfterMergeAt == null

/** The machine a pool stands for among [machines]: a Harness Team account's Mac when the reader sees it, else itself. */
export function homeOf(machines: readonly ContributedMachine[], machineId: string): ContributedMachine | undefined {
  const pool = machines.find(m => m.machineId === machineId)
  return pool?.hostMachineId ? machines.find(m => m.machineId === pool.hostMachineId) ?? pool : pool
}

/** A window's reset as epoch milliseconds: vendors give a date, epoch seconds or milliseconds. */
function resetMs(value: string | number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/** Each contributed engine's weekly window from the machine's last reading; unknown as nulls. */
function subscriptions(pool: ContributedMachine): BroughtMachine['subscriptions'] {
  return pool.engines.map(engine => {
    const quota = pool.observation?.quotas?.find(q => q.engine === engine)
    const weekly = quota?.known ? quota.windows.find(w => w.name === 'weekly') : undefined
    return { engine, usedPercent: weekly ? weekly.usedPercent : null, resetsAt: weekly ? resetMs(weekly.resetsAt) : null }
  })
}

/**
 * The machines [mine] (one person's, the reader's visible ones) as Brought rows: [shipped] the verified requests whose
 * shipping attempt ran on each, [busyMs] each pool's lent time. Most shipped first, then busiest, then by name.
 */
export function broughtMachines(state: SuperTabState, mine: readonly ContributedMachine[], visible: readonly ContributedMachine[],
  shippedRequests: readonly Conversation[], span: Span, busyMs: (pool: ContributedMachine) => number): BroughtMachine[] {
  const rows = new Map<string, BroughtMachine & { busy: number }>()
  for (const pool of mine) {
    const home = homeOf(visible, pool.machineId) ?? pool
    let row = rows.get(home.machineId)
    if (!row) rows.set(home.machineId, row = { machineId: home.machineId, machineName: home.name, shipped: 0, busyHours: 0, subscriptions: subscriptions(home), busy: 0 })
    row.busy += busyMs(pool)
  }
  for (const group of shippedRequests) {
    if (!verified(group) || !within(group.ledger!.shippedAt!, span)) continue
    const machineId = shippedOnMachine(state, group)
    const home = machineId ? homeOf(visible, machineId) : undefined
    const row = home && rows.get(home.machineId)
    if (row) row.shipped++
  }
  return [...rows.values()].map(({ busy, ...row }) => ({ ...row, busyHours: Math.round(busy / 3_600_000 * 10) / 10 }))
    .sort((a, b) => b.shipped - a.shipped || b.busyHours - a.busyHours || a.machineName.localeCompare(b.machineName))
}

/** The people whose machine, among [visible], ran an attempt in [span] on one of [groups]. */
export function contributorsIn(state: SuperTabState, groups: readonly Conversation[], visible: readonly ContributedMachine[], span: Span): Set<string> {
  const people = new Set<string>()
  for (const run of groups.flatMap(g => g.ledger?.runs ?? [])) {
    if (!within(run.at, span)) continue
    const machineId = runMachine(state, run)
    const pool = machineId ? visible.find(m => m.machineId === machineId) : undefined
    if (pool) people.add(pool.contributorId)
  }
  return people
}
