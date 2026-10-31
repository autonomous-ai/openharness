/** `harness super-tab plan`: the scheduler's input from the live Swarm (tools/scheduler, docs/plans/2026-10-27-swarm-scheduler.md).
 * Pure: the agent's open groups become tasks, the machines that can take a new agent now become machines, the catalog's
 * offered rows and the models served on the grid become models, and each machine's quota readings become accounts. Like the
 * route (routeCommand.ts), it leaves out only what cannot run: no owner rule or reserve (project instructions, phase 4), and
 * a used-up account is quota, not a refusal. Each task asks the strength its difficulty does, as advice the plan follows
 * as far as a model can (final review). Only new agents are planned, not idle members. */
import { requiredToolReason, startRequirements } from './capacity.js'
import { API_BUILDERS, gridStrength, KIND_WORD, SIZES, quotaOf2, type Catalog, type Level, type Size } from './route.js'
import { LOCAL_FRESH_MS, OFFLINE, servedModels, takesBuilder, taskRequirement, unreadyPool } from './routeCommand.js'
import { identifier, object } from './wire.js'

type Json = Record<string, unknown>
export interface GroupAssessment { difficulty: Level; risk: Level; size: Size; kind?: string; after?: string[] }
/** The Lead's assessments, by group id. */
export type PlanRequest = Record<string, GroupAssessment>
/** What starts a plan's pick: a catalog row, or a model served on the grid (started with gridModel and gridName). */
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
  /** Groups no model that can run them is as strong as their difficulty asks: planned on the strongest that can. */
  understrength: string[]
  leftOut: Array<{ machine: string; reason: string }>
}

const LEVELS: Level[] = ['low', 'medium', 'high']
const ENGINES = ['claude', 'codex'] as const
const ENGINE_WORD = { claude: 'Claude', codex: 'Codex' } as const
const WINDOWS = ['5-hour', 'weekly']
/** A group the Lead did not assess is planned as the route takes a Lead's task with no size: medium. */
const DEFAULT: GroupAssessment = { difficulty: 'medium', risk: 'medium', size: 'medium' }
/** The catalog strength each difficulty asks (catalog.ts: 3 is Opus or Codex's default, 2 Sonnet or Kimi K3, 1 a small grid
 *  model). The solver minimizes finish time then cost, so with floor 1 everywhere the plan took the cheapest models, small
 *  grid models among them, where the route ranks by strength first (final review). */
const FLOORS: Record<Level, number> = { low: 1, medium: 2, high: 3 }
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

export function planSetup(input: { state: Json; catalog: Catalog; leadId: string; request: PlanRequest; githubApp: boolean; now: number }): PlanSetup {
  const { state, catalog, leadId, request, githubApp, now } = input
  const conversations = list(state.conversations)
  // Open work: a defined group no one has been given yet, or whose agent was lost, which the agent hands on. Finished,
  // cancelled and stopped work is not planned again, nor work still running or in review.
  const waiting = (assignment: unknown) => { const a = object(assignment); return !a.id || a.status === 'lost' }
  const open = conversations.filter(c => c.leadId === leadId && c.id !== 'lead' && c.archived !== true && c.task && waiting(c.assignment))
  const openIds = new Set(open.map(c => String(c.id)))
  // A Mac's Harness Team account is that Mac (routeTask).
  const macOf = new Map(list(state.machines).filter(m => typeof m.hostMachineId === 'string').map(m => [String(m.machineId), String(m.hostMachineId)]))
  const projectOf = (c: Json) => String(c.projectId ?? 'lead')

  // Machines: those that can take a new agent now, for any project, with the engines that can start one. A machine whose last
  // starts failed is noted by the route, not left out (routeCommand.ts STALLED), so it is planned too.
  const leftOut: PlanSetup['leftOut'] = []
  const machines: Json[] = [], machineNames: Record<string, string> = {}, pools = new Map<string, Json>()
  const needs = startRequirements({ tools: [], devices: [] })
  for (const pool of list(state.machines)) {
    const id = String(pool.machineId), name = String(pool.name ?? id), observed = object(pool.observation)
    const unready = unreadyPool(pool, undefined, '', githubApp, null)
    const reasons = [
      ...(!finite(observed.receivedAt) || now - observed.receivedAt >= LOCAL_FRESH_MS ? [OFFLINE] : []),
      ...(pool.paused ? ['New work is paused on this machine.'] : []),
      ...(pool.availableSlots === 0 ? ['This machine has no available agent slots.'] : []),
      ...unready.all,
      ...shortfalls(observed, needs),
    ]
    // An engine that is not ready starts nothing (the route refuses it too); one on a used-up account still starts, and its
    // account's windows say how much it has left.
    const listed = Array.isArray(pool.engines) ? pool.engines : []
    const engines = ENGINES.filter(e => listed.includes(e) && !unready.engines[e])
    if (!reasons.length && !engines.length) reasons.push('No engine on this machine can start a new agent.')
    if (reasons.length) { leftOut.push({ machine: name, reason: reasons[0]! }); continue }
    machines.push({ id, name, slots: finite(pool.availableSlots) ? pool.availableSlots : Number(pool.maxAgents), engines })
    machineNames[id] = name
    pools.set(id, pool)
  }

  // A Mac's Harness Team account runs on the Mac, so the two share the Mac's slots (backend machines.ts machineSlots).
  for (const m of machines) if (macOf.has(String(m.id)) && pools.has(macOf.get(String(m.id))!)) m.pool = macOf.get(String(m.id))

  // Models: the catalog's offered rows, and each model served on the grid that still takes an agent. A row not offered by
  // default is the route's to offer when a person names it; the plan names none.
  const rows: Record<string, ModelRow> = {}, models: Json[] = []
  for (const m of catalog.models) {
    if (!m.offered || !ENGINES.includes(m.engine)) continue
    const id = `${m.engine}-${m.model}-${m.effort}`
    rows[id] = { engine: m.engine, model: m.model, effort: m.effort }
    models.push({ id, engine: m.engine, cost: m.cost, quality: { default: m.strength }, label: `${ENGINE_WORD[m.engine]} ${m.model} ${m.effort}` })
  }
  const addOn = object(state.localModels)
  // A model a machine reports too small or slow to drive a coding agent (the route's note, servedModels) is left out: the route
  // still offers it with that note, for the agent choosing to decide.
  const served = addOn.enabled === true && typeof addOn.grid === 'string' ? [...servedModels(state, addOn.grid, now).values()].filter(m => takesBuilder(m) && !m.note) : []
  for (const s of served) {
    const id = `grid:${s.model}`
    if (rows[id]) continue
    rows[id] = { engine: 'claude', model: 'default', effort: 'default', gridModel: s.model, gridName: s.grid }
    // A Claude Code agent drives it through the grid relay; an API answers four at once, a local engine one.
    models.push({ id, engine: 'claude', cost: 1, quality: { default: gridStrength(catalog, s.model, s.label) },
      concurrency: (s.kind === 'api' ? API_BUILDERS : 1) - s.holders.length, subscription: false, remote: s.kind === 'api' || s.kind === 'shared',
      family: s.model, label: `Claude on ${s.label} (${KIND_WORD[s.kind]})`, ...(s.machines ? { machines: [...s.machines].filter(m => pools.has(m)) } : {}) })
  }

  // The strongest model each machine can run: one of its engines, and a grid model only where it reaches.
  const engines = new Map(machines.map(m => [String(m.id), m.engines as string[]]))
  const strongest = (machineIds: string[]) => Math.max(0, ...models.filter(m => machineIds.some(id => engines.get(id)?.includes(String(m.engine))
    && (!Array.isArray(m.machines) || m.machines.includes(id)))).map(m => Number(object(m.quality).default)))

  // Tasks: each open group, with its assessment, dependencies, and the machines that can run its project's work. Its floor is
  // what its difficulty asks, or the strongest model that can run it when none is that strong (listed back). No task has
  // `independent_of`, and each takes every model: the scheduler keeps those for bench instances (tools/scheduler).
  const estimates: string[] = [], ignored: string[] = [], titles: Record<string, string> = {}, understrength: string[] = []
  const tasks = open.map(c => {
    const id = String(c.id), given = request[id], a = given ?? DEFAULT, projectId = projectOf(c)
    if (!given) estimates.push(id)
    titles[id] = String(c.title ?? id)
    const project = list(state.projects).find(p => p.id === projectId)
    const linked = typeof c.reviewOf === 'string' ? conversations.find(b => b.id === c.reviewOf) : undefined
    const linkedOpen = !!linked && openIds.has(String(linked.id))
    // A group it waits for that has finished is already done; one that is not in the tab at all is listed back.
    const after = (a.after ?? []).filter(d => openIds.has(d))
    ignored.push(...(a.after ?? []).filter(d => !openIds.has(d) && !conversations.some(x => x.id === d)))
    // A linked task (a review of open work) waits for the work it links to.
    const deps = [...new Set([...(linkedOpen ? [String(linked!.id)] : []), ...after])]
    const projectOwner = project?.ownerId ?? state.ownerId
    // One machine (routeTask): a Mac's owner's own projects start on the Mac, a teammate's in its team account, so only one of
    // the two is offered for this group.
    const folded = new Set([...macOf].flatMap(([team, mac]) => {
      const teamPool = list(state.machines).find(m => m.machineId === team)
      return teamPool && list(state.machines).some(m => m.machineId === mac) ? [projectOwner === teamPool.contributorId ? team : mac] : []
    }))
    // The group's own requirement, as the route reads it. A required device rules out every machine here: a machine reports
    // its devices only to a capacity probe the route makes, never in the reading the plan has.
    const required = taskRequirement(c)
    const allowed = [...pools].filter(([machineId, pool]) => {
      const repository = object(project?.repository)
      const teamWork = object(pool.teamWork)
      const unready = unreadyPool(pool, project, projectId, githubApp, projectOwner)
      return !folded.has(machineId) && !unready.all.length
        && !(teamWork.allowed === false && teamWork.code !== 'MACHINE_OFFLINE' && pool.contributorId !== projectOwner)
        && !(pool.scope !== 'swarm' && projectId !== 'lead')
        && !(pool.scope === 'swarm' && repository.machineId !== machineId && typeof repository.repositoryUrl !== 'string')
        && (!required.machines || required.machines.has(machineId) || required.machines.has(macOf.get(machineId) ?? '')) && !required.devices.length
    }).map(([machineId]) => machineId)
    const { minutes, spend } = SIZES[a.size]
    // A task no machine may run keeps its difficulty's floor: the scheduler then says it has no machine.
    const best = strongest(allowed), floor = allowed.length && best ? Math.min(FLOORS[a.difficulty], best) : FLOORS[a.difficulty]
    if (floor < FLOORS[a.difficulty]) understrength.push(id)
    return { id, title: titles[id], minutes, floor, kind: a.kind ?? 'default',
      difficulty: a.difficulty, spend: { ...spend }, deps, independent_of: [], avoid_families: [], machines: allowed, models: Object.keys(rows) }
  })

  // Accounts: each machine's quota readings, shared where two machines report one account (route.ts accountOf). Nothing is
  // held in reserve: quota is information.
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
      const account = accounts.get(key) ?? { id: key, members: [] as string[][], reserve: 0, windows }
      ;(account.members as string[][]).push([machineId, String(q.engine)])
      accounts.set(key, account)
    }
  }

  // Diego's issue, 2026-10-27: an assessed group that is not open (a typo, a finished group) was dropped without a word, and
  // a group two others wait for was listed twice.
  ignored.push(...Object.keys(request).filter(id => !openIds.has(id)))
  return {
    instance: { tasks, machines, models, accounts: [...accounts.values()] }, rows, titles, machineNames, estimates,
    ignored: [...new Set(ignored)], leftOut, understrength,
  }
}
