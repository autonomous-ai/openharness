/** `harness super-tab plan`: the scheduler's input from the live Swarm (tools/scheduler, docs/plans/2026-10-27-swarm-scheduler.md).
 * Pure: the Lead's open groups become tasks, the machines that can take a new agent now become machines, the routing policy's
 * rows and the models served on the grid become models, and each machine's quota readings become accounts. The owner's hard
 * rules are applied per task, as each binds only its own project's groups, with the same checks the route makes
 * (routeCommand.ts), so the plan never offers what the route would refuse. Only new agents are planned, not idle members. */
import { requiredToolReason, startRequirements } from './capacity.js'
import { API_BUILDERS, breaks, floorFor, KIND_WORD, liftEffort, quotaOf2, SIZES, type Assessment, type Level, type Policy, type Size, type SwarmRule } from './route.js'
import { LOCAL_FRESH_MS, OFFLINE, servedModels, STALLED, stalled, takesBuilder, unreadyPool } from './routeCommand.js'
import { identifier, object } from './wire.js'

type Json = Record<string, unknown>
export interface GroupAssessment { difficulty: Level; risk: Level; size: Size; kind?: string; after?: string[] }
/** The Lead's assessments, by group id. */
export type PlanRequest = Record<string, GroupAssessment>
/** What starts a plan's pick: a policy row, or a model served on the grid (started with gridModel and gridName). */
export interface ModelRow { engine: 'claude' | 'codex'; model: string; effort: string; gridModel?: string; gridName?: string }
export interface PlanSetup {
  instance: { tasks: Json[]; machines: Json[]; models: Json[]; accounts: Json[] }
  rows: Record<string, ModelRow>
  titles: Record<string, string>
  machineNames: Record<string, string>
  /** Groups planned at the default assessment, which the Lead did not give. */
  estimates: string[]
  /** Groups the Lead named that are not open. */
  ignored: string[]
  leftOut: Array<{ machine: string; reason: string }>
  /** The effort the pick starts at for that group: the row's own, or its project's minimum when the row leaves it to the engine. */
  effortFor: (group: string, row: string) => string
}

const LEVELS: Level[] = ['low', 'medium', 'high']
const ENGINES = ['claude', 'codex'] as const
const ENGINE_WORD = { claude: 'Claude', codex: 'Codex' } as const
const WINDOWS = ['5-hour', 'weekly']
/** A group the Lead did not assess is planned as the route takes a Lead's task with no size: medium. */
const DEFAULT: GroupAssessment = { difficulty: 'medium', risk: 'medium', size: 'medium' }
const list = (value: unknown) => Array.isArray(value) ? value.map(object) : []
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** What the route says of a machine that cannot hold a new agent (routeCommand.ts probeMachine), in its words. */
function shortfalls(observed: Json, needs: ReturnType<typeof startRequirements>): string[] {
  const resources = object(observed.resources), tools = object(observed.tools)
  return [
    ...(!finite(resources.projectDiskFreeBytes) || resources.projectDiskFreeBytes < needs.diskBytes ? ['The project has insufficient measured free disk.'] : []),
    ...(!finite(resources.memoryTotalBytes) || !finite(resources.memoryUsedBytes) || resources.memoryTotalBytes - resources.memoryUsedBytes < needs.memoryBytes ? ['Insufficient measured free memory.'] : []),
    ...needs.tools.map(t => requiredToolReason(t, tools[t], object(observed.toolProbeErrors)[t])).filter((reason): reason is string => reason !== null),
  ]
}

export function parsePlanRequest(value: unknown): PlanRequest | string {
  if (value === undefined || value === null) return {}
  const groups = object(object(value).groups)
  if (Array.isArray(value) || typeof value !== 'object') return 'Give {"groups":{"GROUP":{"difficulty":"…","risk":"…","size":"…"}}}.'
  const out: PlanRequest = {}
  for (const [id, raw] of Object.entries(groups)) {
    const a = object(raw)
    if (!identifier(id)) return `"${id}" is not a group id.`
    if (!LEVELS.includes(a.difficulty as Level)) return `Set difficulty of ${id} to low, medium or high.`
    if (!LEVELS.includes(a.risk as Level)) return `Set risk of ${id} to low, medium or high.`
    if (!Object.hasOwn(SIZES, String(a.size))) return `Set size of ${id} to small, medium or large.`
    if (a.kind !== undefined && (typeof a.kind !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(a.kind))) return `Set kind of ${id} to one lowercase word, such as ui or docs.`
    if (a.after !== undefined && (!Array.isArray(a.after) || !a.after.every(identifier))) return `Set after of ${id} to a list of group ids.`
    out[id] = { difficulty: a.difficulty as Level, risk: a.risk as Level, size: a.size as Size, ...(a.kind ? { kind: a.kind as string } : {}),
      ...(a.after ? { after: a.after as string[] } : {}) }
  }
  return out
}

/** The model family a finished build used, so its review avoids it: a grid model is its own, any other the engine's. */
function familyOf(configuration: Json, gridModels: Set<string>): string | null {
  const engine = configuration.engine, model = String(configuration.model ?? '')
  if (gridModels.has(model)) return model
  return engine === 'claude' || engine === 'codex' ? engine : null
}

export function planSetup(input: { state: Json; policy: Policy; leadId: string; request: PlanRequest; githubApp: boolean; now: number }): PlanSetup {
  const { state, policy, leadId, request, githubApp, now } = input
  const conversations = list(state.conversations)
  // Open work: a defined group no one has been given yet, or whose agent was lost, which the Lead hands on. Finished, cancelled
  // and stopped work is not planned again, nor work still running or in review.
  const waiting = (assignment: unknown) => { const a = object(assignment); return !a.id || a.status === 'lost' }
  const open = conversations.filter(c => c.leadId === leadId && c.id !== 'lead' && c.archived !== true && c.task && waiting(c.assignment))
  const openIds = new Set(open.map(c => String(c.id)))
  // Rules bind only their own project's groups; a Mac's Harness Team account is that Mac, so a machines rule naming the Mac
  // allows it too (routeTask).
  const macOf = new Map(list(state.machines).filter(m => typeof m.hostMachineId === 'string').map(m => [String(m.machineId), String(m.hostMachineId)]))
  const rulesOf = (projectId: string) => (list(state.rules).filter(r => r.rule && typeof r.text === 'string' && (r.projectId === undefined || r.projectId === projectId)) as unknown as SwarmRule[])
    .map(r => r.rule.kind !== 'machines' ? r : { ...r, rule: { ...r.rule,
      machineIds: [...r.rule.machineIds, ...[...macOf].filter(([, mac]) => r.rule.kind === 'machines' && r.rule.machineIds.includes(mac)).map(([team]) => team)] } })
  const projectOf = (c: Json) => String(c.projectId ?? 'lead')

  // Machines: those that can take a new agent now, for any project, with the engines that can start one.
  const leftOut: PlanSetup['leftOut'] = []
  const machines: Json[] = [], machineNames: Record<string, string> = {}, pools = new Map<string, Json>()
  const needs = startRequirements({ tools: [], devices: [] })
  for (const pool of list(state.machines)) {
    const id = String(pool.machineId), name = String(pool.name ?? id), observed = object(pool.observation)
    const quotas = list(observed.quotas)
    const unready = unreadyPool(pool, undefined, '', false, githubApp, null)
    const reasons = [
      ...(!finite(observed.receivedAt) || now - observed.receivedAt >= LOCAL_FRESH_MS ? [OFFLINE] : []),
      ...(pool.paused ? ['New work is paused on this machine.'] : []),
      ...(pool.availableSlots === 0 ? ['This machine has no available agent slots.'] : []),
      ...unready.all,
      ...shortfalls(observed, needs),
      ...(stalled(list(state.starts), id) ? [STALLED] : []),
    ]
    // An engine that is not ready, or whose account has a window used up, starts nothing (the route refuses both).
    const exhausted = (engine: string) => {
      const q = quotas.find(q => q.engine === engine)
      return !!q && quotaOf2({ known: q.known === true, windows: list(q.windows).filter(w => finite(w.usedPercent)).map(w => ({ usedPercent: w.usedPercent as number, resetsAt: w.resetsAt })) }).leftPercent === 0
    }
    const listed = Array.isArray(pool.engines) ? pool.engines : []
    const engines = ENGINES.filter(e => listed.includes(e) && !unready.engines[e] && !exhausted(e))
    if (!reasons.length && !engines.length) reasons.push('No engine on this machine can start a new agent.')
    if (reasons.length) { leftOut.push({ machine: name, reason: reasons[0]! }); continue }
    machines.push({ id, name, slots: finite(pool.availableSlots) ? pool.availableSlots : Number(pool.maxAgents), engines })
    machineNames[id] = name
    pools.set(id, pool)
  }

  // Models: the policy's enabled rows, and each model served on the grid that still takes a Builder (never for a review).
  const rows: Record<string, ModelRow> = {}, models: Json[] = []
  for (const m of policy.models) {
    if (!m.enabled || !ENGINES.includes(m.engine)) continue
    const id = `${m.engine}-${m.model}-${m.effort}`
    rows[id] = { engine: m.engine, model: m.model, effort: m.effort }
    models.push({ id, engine: m.engine, cost: m.cost, quality: { default: m.quality }, label: `${ENGINE_WORD[m.engine]} ${m.model} ${m.effort}` })
  }
  const addOn = object(state.localModels)
  const served = addOn.enabled === true && typeof addOn.grid === 'string' && policy.localModels?.enabled !== false
    ? [...servedModels(state, addOn.grid, now).values()].filter(takesBuilder) : []
  const gridRows = new Set<string>()
  for (const s of served) {
    const id = `grid:${s.model}`
    if (rows[id]) continue
    gridRows.add(id)
    rows[id] = { engine: 'claude', model: 'default', effort: 'default', gridModel: s.model, gridName: s.grid }
    // A Claude Code Builder drives it through the grid relay; an API answers four at once, a local engine one.
    models.push({ id, engine: 'claude', cost: 1, quality: { default: policy.localModels?.quality ?? 1 },
      concurrency: (s.kind === 'api' ? API_BUILDERS : 1) - s.holders.length, subscription: false, remote: s.kind === 'api' || s.kind === 'shared',
      family: s.model, label: `Claude on ${s.label} (${KIND_WORD[s.kind]})`, ...(s.machines ? { machines: [...s.machines].filter(m => pools.has(m)) } : {}) })
  }
  const gridModels = new Set(served.map(s => s.model))

  // Tasks: each open group, with its assessment, dependencies, and the machines and models its project's rules leave.
  const estimates: string[] = [], ignored: string[] = [], titles: Record<string, string> = {}
  const tasks = open.map(c => {
    const id = String(c.id), given = request[id], a = given ?? DEFAULT, projectId = projectOf(c)
    if (!given) estimates.push(id)
    titles[id] = String(c.title ?? id)
    const rules = rulesOf(projectId), project = list(state.projects).find(p => p.id === projectId)
    const review = typeof c.reviewOf === 'string'
    const build = review ? conversations.find(b => b.id === c.reviewOf) : undefined
    const buildOpen = !!build && openIds.has(String(build.id))
    // A group it waits for that has finished is already done; one that is not in the tab at all is listed back.
    const after = (a.after ?? []).filter(d => openIds.has(d))
    ignored.push(...(a.after ?? []).filter(d => !openIds.has(d) && !conversations.some(x => x.id === d)))
    const deps = [...new Set([...(buildOpen ? [String(build!.id)] : []), ...after])]
    const builtWith = build && !buildOpen ? familyOf(object(object(build.assignment).configuration), gridModels) : null
    const projectOwner = project?.ownerId ?? state.ownerId
    const allowed = [...pools].filter(([machineId, pool]) => {
      const repository = object(project?.repository)
      const teamWork = object(pool.teamWork)
      const unready = unreadyPool(pool, project, projectId, !review, githubApp, projectOwner)
      return !unready.all.length && !unready.push
        && !(teamWork.allowed === false && teamWork.code !== 'MACHINE_OFFLINE' && pool.contributorId !== projectOwner)
        && !(pool.scope !== 'swarm' && projectId !== 'lead')
        && !(pool.scope === 'swarm' && repository.machineId !== machineId && typeof repository.repositoryUrl !== 'string')
        && !breaks(rules.filter(r => r.rule.kind === 'machines'), { machineId, engine: '', model: '', effort: '' })
    }).map(([machineId]) => machineId)
    const modelRules = rules.filter(r => r.rule.kind !== 'machines')
    const allowedModels = Object.entries(rows).filter(([rowId, row]) => !(review && gridRows.has(rowId))
      && !breaks(modelRules, { machineId: '', engine: row.engine, model: row.model, effort: liftEffort(rules, row.engine, row.effort) })).map(([rowId]) => rowId)
    const { minutes, spend } = SIZES[a.size]
    return { id, title: titles[id], minutes, floor: floorFor(policy, a as unknown as Assessment), kind: review ? 'review' : a.kind ?? 'default',
      difficulty: a.difficulty, spend: { ...spend }, deps, independent_of: buildOpen ? [String(build!.id)] : [],
      avoid_families: builtWith ? [builtWith] : [], machines: allowed, models: allowedModels }
  })

  // Accounts: each machine's quota readings, shared where two machines report one account (route.ts accountOf).
  const accounts = new Map<string, Json>()
  for (const [machineId, pool] of pools) {
    for (const q of list(object(pool.observation).quotas)) {
      if (!ENGINES.includes(q.engine as 'claude') || q.known !== true) continue
      const quota = quotaOf2({ known: true, account: typeof q.account === 'string' ? q.account : null,
        windows: list(q.windows).filter(w => finite(w.usedPercent)).map(w => ({ usedPercent: w.usedPercent as number, resetsAt: w.resetsAt, name: typeof w.name === 'string' ? w.name : undefined })) })
      if (quota.metered || !quota.windows) continue
      const key = quota.account ?? `${machineId}:${String(q.engine)}`
      // A window whose reset has passed since it was read has refilled.
      const windows = quota.windows.filter(w => WINDOWS.includes(String(w.name))).map(w => w.resetsAt !== null && w.resetsAt <= now
        ? { name: w.name, left: 100, resets_in: null } : { name: w.name, left: w.leftPercent, resets_in: w.resetsAt === null ? null : Math.round((w.resetsAt - now) / 60_000) })
      const account = accounts.get(key) ?? { id: key, members: [] as string[][], reserve: policy.quotaReserve, windows }
      ;(account.members as string[][]).push([machineId, String(q.engine)])
      accounts.set(key, account)
    }
  }

  const byGroup = new Map(open.map(c => [String(c.id), rulesOf(projectOf(c))]))
  return {
    instance: { tasks, machines, models, accounts: [...accounts.values()] }, rows, titles, machineNames, estimates, ignored, leftOut,
    effortFor: (group, row) => liftEffort(byGroup.get(group) ?? [], rows[row]!.engine, rows[row]!.effort),
  }
}
