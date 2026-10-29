/**
 * What each attempt at a Swarm task ran on, how it was paid and how many tokens it used (Dee, 2026-10-29: show "Cheaper", and
 * route each job to the cheapest harness that still gets it right). Kept on the attempt's route decision (routeDecisions.ts)
 * and read by costs/read.ts. Pure: the store hands it the states before and after a write.
 */
import { activeWork, type Assignment, type Conversation, type SuperTabState } from '../model.js'
import type { TokensByModel } from './tokens.js'

/** How an attempt's tokens were paid: an engine plan's allowance, per token through an API (an API key, or a grid model a
 *  member shares from one), the Swarm's own GPUs, or unknown. Only `api` is money actually spent per token. */
export type Billing = 'subscription' | 'api' | 'own-hardware' | 'unknown'

/** One attempt as its route decision keeps it. `start` and `end` are its session's totals by model when it began and ended
 *  (null: no reading); its tokens are the difference (attemptTokens). */
export interface RouteRun {
  machineId: string
  harnessId: string
  engine: string
  model: string
  effort: string
  /** The model on the Swarm's grid it ran, which its engine never reports (model.ts Agent.gridModel). */
  grid?: string
  billing: Billing
  startedAt: number
  start: TokensByModel | null
  endedAt?: number
  end?: TokensByModel | null
}

export interface AttemptChanges {
  started: Assignment[]
  /** `lost` and `superseded` are outcomes the decision takes from here; the others are closed by the command that ended them
   *  (routeDecisions.ts closeAssignment). */
  ended: Array<{ assignment: Assignment; outcome: 'lost' | 'superseded' | null }>
  /** Lost to a usage limit and taken back by the same session (work.resume): the same attempt goes on. */
  resumed: Assignment[]
}

/** The attempts a write started, ended or resumed, as store.ts endRuns finds ended work: an active assignment that became
 *  inactive, or that went (its group removed) or was replaced while still active. */
export function attemptChanges(before: Conversation[], after: SuperTabState): AttemptChanges {
  const earlier = new Map(before.map(c => [c.id, c.assignment])), later = new Map(after.conversations.map(c => [c.id, c]))
  const changes: AttemptChanges = { started: [], ended: [], resumed: [] }
  for (const group of after.conversations) {
    const now = group.assignment, was = earlier.get(group.id)
    if (!now) continue
    if (activeWork(group) && now.id !== was?.id) changes.started.push(now)
    else if (activeWork(group) && was?.status === 'lost') changes.resumed.push(now)
    else if (!activeWork(group) && now.id === was?.id && activeWork({ assignment: was } as Conversation)) {
      changes.ended.push({ assignment: now, outcome: now.status === 'lost' ? 'lost' : null })
    }
  }
  for (const group of before) {
    if (!activeWork(group)) continue
    const changed = later.get(group.id)
    if (!changed || changed.assignment?.id !== group.assignment!.id) changes.ended.push({ assignment: group.assignment!, outcome: 'superseded' })
  }
  return changes
}

const observationOf = (state: SuperTabState, machineId: string) => state.machines?.find(m => m.machineId === machineId)?.observation
const tokensOf = (state: SuperTabState, machineId: string, harnessId: string): TokensByModel | null =>
  observationOf(state, machineId)?.harnessTokens?.[harnessId] ?? null

/** A grid model is paid as every machine serving it says: its own GPUs (`local`) or a member's shared API (`api`). Machines
 *  that disagree, or none serving it, leave it unknown rather than guessed. An engine is paid by its plan when its machine
 *  reads plan windows for it, per token when it reads it as known with none (an API key, cli superTabs/capacity.ts). */
function billingOf(state: SuperTabState, machineId: string, engine: string, grid: string | undefined): Billing {
  if (grid) {
    const kinds = new Set((state.machines ?? []).flatMap(m => (m.observation?.localModels ?? []).filter(s => s.model === grid).map(s => s.kind)))
    if (kinds.size !== 1) return 'unknown'
    const [kind] = kinds
    return kind === 'local' ? 'own-hardware' : kind === 'api' ? 'api' : 'unknown'
  }
  const quota = observationOf(state, machineId)?.quotas.find(q => q.engine === engine)
  return !quota?.known ? 'unknown' : quota.windows.length ? 'subscription' : 'api'
}

function ranOn(state: SuperTabState, assignment: Assignment, agentId: string) {
  const agent = state.agents.find(a => a.id === agentId)
  const configuration = agent?.configuration ?? assignment.configuration
  return { engine: configuration.engine, model: configuration.model ?? 'unknown', effort: configuration.effort ?? 'unknown',
    ...(agent?.gridModel ? { grid: agent.gridModel } : {}) }
}

export function startRun(state: SuperTabState, assignment: Assignment, now: number): RouteRun {
  const { machineId, harnessId } = assignment.execution
  const ran = ranOn(state, assignment, assignment.agentId)
  return { machineId, harnessId, ...ran, billing: billingOf(state, machineId, ran.engine, ran.grid), startedAt: now, start: tokensOf(state, machineId, harnessId) }
}

/** Its end, and the model and effort its agent ran at last. An agent that finishes its own work (Done, Stopped) sends its
 *  session's totals read as it finishes (`final`); finished without them (an older host, or a Lead finishing it) its end is
 *  unknown (null), never the last report's: that can be a report old and price real work at nothing (review of #2106). Other
 *  ends (lost, cancelled, its host's stop) take the totals its machine last reported; the report that says a session
 *  stopped no longer lists it, so then those reported before this write (`before`). A session replaced during the attempt
 *  (agent.rebind) counts from zero, so only the new session's tokens are counted. */
export function endRun(run: RouteRun, state: SuperTabState, assignment: Assignment, agentId: string, now: number, before?: SuperTabState,
  final?: TokensByModel | null): RouteRun {
  const { machineId, harnessId } = assignment.execution
  const { engine: _engine, grid: _grid, ...ran } = ranOn(state, assignment, agentId)
  const end = final !== undefined ? final : tokensOf(state, machineId, harnessId) ?? (before ? tokensOf(before, machineId, harnessId) : null)
  return { ...run, ...ran, ...(harnessId !== run.harnessId ? { harnessId, start: {} } : {}), endedAt: now, end }
}

/** The tokens the attempt used, by model: its session's end totals less its start totals. A count lower at the end than at the
 *  start restarted (a new transcript), so the end is all of it. With no start reading it counts from zero only for an agent
 *  started for this attempt (`fresh`); with no end reading it is unknown. */
export function attemptTokens(run: RouteRun, fresh: boolean): TokensByModel | null {
  if (!run.end || (!run.start && !fresh)) return null
  const used: TokensByModel = {}
  for (const [model, end] of Object.entries(run.end)) {
    const start = run.start?.[model]
    const delta = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    for (const key of Object.keys(delta) as Array<keyof typeof delta>) delta[key] = start && end[key] >= start[key] ? end[key] - start[key] : end[key]
    if (Object.values(delta).some(n => n > 0)) used[model] = delta
  }
  return used
}
