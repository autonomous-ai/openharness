/** `harness super-tab route GROUP JSON`: the Lead's routing step (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md).
 * Reads the tab, its rules, the effective policy and the account's machines; probes each machine once per engine with
 * the same admission `start` uses; then filters and orders by the rules (docs/plans/2026-10-22-swarm-rules-routing.md)
 * and records the decision in the tab. */
import { randomUUID } from 'node:crypto'
import { openDaemon, type Daemon, type Where } from '../agentClient/daemon.js'
import { requiredToolReason, startRequirements } from './capacity.js'
import { inspectCapacity, type ScopedRequest } from './start.js'
import { ENDED_WORK, object, within } from './wire.js'
import { API_BUILDERS, choose, decide, parseAssessment, quotaOf2, rateFor, recordOf, repoMatch, type Assessment, type Commitment, type HeldModel, type MemberFrame, type Policy, type Probe, type SwarmRule, type TaskFolder } from './route.js'
import { stat } from 'node:fs/promises'
import { describeScmProject } from '../scm/scmProjects.js'

type Json = Record<string, unknown>
const ENGINES = ['claude', 'codex']
// Only these say the request never reached a decision; any other refusal (RATE_LIMITED, LEAD_REQUIRED,
// validation) is the answer and must reach the Lead.
const TRANSPORT = new Set(['AGENT_UNAVAILABLE', 'SUPER_TAB_UNAVAILABLE', 'BACKEND_UNAVAILABLE', 'BACKEND_TIMEOUT', 'BACKEND_UNREACHABLE'])
const MACHINES_UNREADABLE = "The account's machine list could not be read; only known machines were considered."
const DISK_UNVERIFIED = 'Project disk space could not be verified.'
const NO_PROJECT_FOLDER = 'This machine does not have the project folder. Add it to the Swarm so it can clone the project.'
const OFFLINE = 'Machine is offline or unreachable.'
const UNKNOWN_QUOTA: Probe['quota'] = { known: false, leftPercent: null, resetsAt: null }
const UNKNOWN_LOAD: NonNullable<Probe['load']> = { agents: null, freeMemoryBytes: null, hasFolder: null }
const EXHAUSTED_WINDOW = 'The subscription has an exhausted usage window. Wait for a fresh allowance reading or choose another account.'
/** A running member keeps its engine and memory, but still needs a live terminal, account allowance and the task's tools. */
function memberRefusals(running: boolean | null, quota: Probe['quota'], tools: string[], devices: string[], reportedTools: Json, reportedDevices: Json, toolProbeErrors: Json): string[] {
  return [
    ...(running === false ? ['Its terminal is not running.'] : []),
    ...tools.map(tool => requiredToolReason(tool, reportedTools[tool], toolProbeErrors[tool])).filter((reason): reason is string => reason !== null),
    ...devices.filter(device => reportedDevices[device] !== true).map(device => `Required device unavailable: ${device}.`),
    ...(quota.leftPercent === 0 ? [EXHAUSTED_WINDOW] : []),
  ]
}
const active = (assignment: unknown) => { const a = object(assignment); return !!a.id && !ENDED_WORK.includes(String(a.status)) }
const list = (value: unknown) => Array.isArray(value) ? value.map(object) : []
/** The Lead's machine, for the task's folder; replaced in tests. */
interface FolderReader { describe: typeof describeScmProject; isDirectory: (path: string) => Promise<boolean> }
const FOLDER_READER: FolderReader = { describe: describeScmProject, isDirectory: path => stat(path).then(s => s.isDirectory(), (error: NodeJS.ErrnoException) => {
    // Only an absent folder is "not on this machine"; a refusal or a broken path says nothing, so the read fails and the folder is unknown.
    if (error.code === 'ENOENT') return false
    throw error
  }) }
async function readFolder(cwd: string, reader: FolderReader): Promise<TaskFolder> {
  const folder = { cwd, name: null, root: null, remote: null }
  // The SCM description only checks the path's form, so a folder this machine lacks must be found out first.
  if (!await reader.isDirectory(cwd)) return { ...folder, kind: 'missing' }
  const described = await reader.describe(cwd)
  if (!described) return { ...folder, kind: 'unknown' }
  return { cwd, kind: described.kind, name: described.kind === 'git' ? described.name : null, root: described.root, remote: described.remote }
}
const text = (value: unknown) => typeof value === 'string' ? value : null
/** A member started by `start` was launched with `--effort`, which Claude never reports back, so its configuration says
 * `auto` (manual run 2026-10-19). The tab's start record still holds what it was launched with; an effort the member
 * does report is kept. */
function withLaunchEffort(member: Json, starts: Json[]): Json {
  const configuration = object(member.configuration)
  if (configuration.effort && configuration.effort !== 'auto') return member
  const launched = object(starts.find(s => s.harnessId === member.harnessId)?.request).effort
  return typeof launched === 'string' && launched !== 'default' ? { ...member, configuration: { ...configuration, effort: launched } } : member
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Work that ended in this Super Tab, oldest first, for each member's earlier work: the log's decisions, the group's
 * attempts and each group's last assignment, joined by assignment id. The log knows which agent a decision started; the
 * attempts are every earlier assignment of this group, also those `work.define` took out of the state (a person's
 * assignment has no decision); the state knows the agent of each group's last one. */
interface Ended { assignmentId: string; group: string; agentId: string | null; outcome: string }
function endedWork(conversations: Json[], decisions: Json[] | null, attempts: Json[] | null, attemptsGroup: string): Ended[] {
  const titleOf = (id: unknown) => String(conversations.find(c => c.id === id)?.title ?? 'another group')
  const ended: Ended[] = [...(decisions ?? [])].reverse().flatMap(d => {
    const final = object(d.final)
    return typeof d.assignmentId === 'string' && ENDED_WORK.includes(String(d.outcome)) && final.kind
      ? [{ assignmentId: d.assignmentId, group: titleOf(d.conversationId), outcome: String(d.outcome), agentId: final.kind === 'member' ? String(final.agentId) : null }]
      : []
  })
  // The assignment's own record wins on the agent: a started agent is a member by then.
  const join = (assignment: Json, groupId: string) => {
    const known = ended.find(e => e.assignmentId === assignment.id)
    if (known) return Object.assign(known, { agentId: String(assignment.agentId) })
    const added: Ended = { assignmentId: String(assignment.id), group: titleOf(groupId), agentId: String(assignment.agentId), outcome: String(assignment.status) }
    ended.push(added)
    return added
  }
  // With the attempts read the group's own work is ordered by it: oldest first, then the current assignment. The log's
  // order alone puts a routed attempt before an earlier one a person assigned (it has no decision). Without the read
  // the log's order stays.
  const last = (e: Ended) => { if (attempts) ended.push(...ended.splice(ended.indexOf(e), 1)) }
  const time = (a: Json) => Date.parse(String(a.createdAt)) || 0
  for (const attempt of [...(attempts ?? [])].reverse().sort((x, y) => time(x) - time(y))) if (attempt.id) last(join(attempt, attemptsGroup))
  for (const c of conversations) {
    const current = object(c.assignment)
    if (current.id && !active(current)) last(join(current, String(c.id)))
  }
  return ended
}
/** The fields of a frame that say what the agent works on; an absent or malformed one says nothing. */
function frameOf(frame: Json): MemberFrame {
  const project = object(frame.project), updatedAt = Date.parse(String(frame.updatedAt))
  return { title: text(frame.title), project: text(project.name), cwd: text(project.cwd), root: text(project.root), remote: text(project.remote),
    branch: text(object(object(frame.gitContext).current).branch) ?? text(project.branch), updatedAt: Number.isFinite(updatedAt) ? updatedAt : null }
}

export async function routeTask(input: { tabId: string; conversationId: string; assessment: unknown }, request: ScopedRequest, where: Where,
  open: typeof openDaemon = openDaemon, newId: () => string = randomUUID, reader: FolderReader = FOLDER_READER): Promise<Json> {
  // A lost connection is an answer here, never a throw: the Lead must still get a decision or a reason.
  const scoped: ScopedRequest = async payload => {
    try { return await request(payload) } catch (error) {
      return { error: 'AGENT_UNAVAILABLE', detail: error instanceof Error ? error.message : 'The request to the machine failed.' }
    }
  }
  const parsed = parseAssessment(input.assessment)
  if (typeof parsed === 'string') return { error: 'INVALID_REQUEST', detail: parsed }
  let assessment = parsed
  const cwd = assessment.needs.cwd
  const context = await scoped({ action: 'routeContext' })
  if (context.error || context.ok !== true) return context
  const value = object(context.value), state = object(object(value.tab).state), effective = object(value.policy)
  const policy = effective.policy as unknown as Policy
  const conversations = list(state.conversations), agents = list(state.agents)
  const group = conversations.find(c => c.id === input.conversationId)
  if (!group) return { error: 'NOT_FOUND', detail: 'No such group in this Super Tab.' }
  if (group.leadId !== value.agentId) return { error: 'LEAD_REQUIRED', detail: 'Only the Lead of this group routes its work.' }
  const projectId = String(group.projectId ?? 'lead')
  const project = list(state.projects).find(p => p.id === projectId)
  // The group's Lead and the tab Lead coordinate; neither is a worker candidate even when idle.
  const busy = new Set([String(group.leadId), String(conversations.find(c => c.id === 'lead')?.leadId),
    ...conversations.filter(c => active(c.assignment)).map(c => String(object(c.assignment).agentId))])
  // A review group is assigned only to a Reviewer, and a Reviewer nothing else.
  const review = typeof group.reviewOf === 'string'
  if (review) assessment = { ...assessment, kind: 'review' }
  // A backend from before rules keeps none, so routing there is the policy order alone. Rules bind only their own project's
  // groups; a backend from before per-project rules gives none a project, and its rules bind every group.
  // A Mac's Harness Team account is that Mac (One machine, below): a machines rule naming the Mac allows it too.
  const macOf = new Map(list(state.machines).filter(m => typeof m.hostMachineId === 'string').map(m => [String(m.machineId), String(m.hostMachineId)]))
  const rules = (list(state.rules).filter(r => r.rule && typeof r.text === 'string' && (r.projectId === undefined || r.projectId === projectId)) as unknown as SwarmRule[])
    .map(r => r.rule.kind !== 'machines' ? r : { ...r, rule: { ...r.rule,
      machineIds: [...r.rule.machineIds, ...[...macOf].filter(([, mac]) => r.rule.kind === 'machines' && r.rule.machineIds.includes(mac)).map(([team]) => team)] } })
  const members = agents.filter(a => !busy.has(String(a.id)) && (a.role === 'reviewer') === review && ENGINES.includes(String(object(a.configuration).engine))).map(a => withLaunchEffort(a, list(state.starts)))
  // A new agent starts only on a machine in the Swarm's Machines list (the backend refuses any other): a contributed machine, or
  // one an agent of the Swarm runs on. The Lead runs here, so its own machine is always listed. Of the account's machines
  // only those count; the rest were never prepared with the project and would only be excluded for a missing folder
  // (production, 2026-10-21). A member may run on a machine only its collaborator can open; the Lead tries that machine
  // too, but a member there is unknown, never offline.
  const swarmMachines = new Set([where.machineId, ...list(state.machines).map(m => String(m.machineId)), ...agents.map(a => String(a.machineId))])
  const machines = new Map<string, { name: string; status: string; account: boolean; pool?: Json; folded?: boolean }>()
  for (const m of list(value.machines)) if (swarmMachines.has(String(m.machineId))) machines.set(String(m.machineId), { name: String(m.name), status: String(m.status ?? 'unknown'), account: true })
  // The Lead's own machine is the account's even when the list could not be read.
  if (!machines.has(where.machineId)) machines.set(where.machineId, { name: where.machineId, status: 'unknown', account: true })
  for (const m of members) if (!machines.has(String(m.machineId))) machines.set(String(m.machineId), { name: String(m.machineId), status: 'unknown', account: false })
  // A teammate's project runs only on Team machines: the backend says per machine whether it takes one now, and why not
  // (backend superTabs/machines.ts teamWorkRefusal). Its project owner's own machines take its work as before.
  const projectOwner = project?.ownerId ?? state.ownerId
  for (const original of list(state.machines)) {
    const repository = object(project?.repository)
    const teamWork = object(original.teamWork)
    const pool: Json = { ...original,
      // Offline is said once, by the reading's own age below.
      ...(teamWork.allowed === false && teamWork.code !== 'MACHINE_OFFLINE' && typeof teamWork.reason === 'string'
        ? { teammatesRefused: teamWork.reason, projectOwnerId: projectOwner } : {}),
      ...(original.scope === 'swarm' ? { cwd: repository.machineId === original.machineId
        ? repository.cwd : `${String(original.cwd).replace(/\/+$/, '')}/${projectId}` } : {}),
      ...(original.scope !== 'swarm' && projectId !== 'lead' ? { projectUnavailable: true } : {}),
      ...(original.scope === 'swarm' && repository.machineId !== original.machineId && typeof repository.repositoryUrl !== 'string'
        ? { repositoryUnavailable: true } : {}),
    }
    machines.set(String(pool.machineId), { name: String(pool.name), status: 'contributed', account: false, pool })
  }
  // One machine (docs/plans/2026-10-24-swarm-team-account.md): a Mac's Harness Team account is that Mac, under its name. A
  // teammate's project starts only in the team account and the Mac's owner's own projects only with the owner, so only one
  // of the two offers new agents here, and the other is not listed as unfit; agents already on either stay members.
  for (const [team, mac] of macOf) {
    const pool = machines.get(team)?.pool
    if (!pool || !machines.has(mac)) continue
    machines.get(projectOwner === pool.contributorId ? team : mac)!.folded = true
  }
  const enabled = policy.models.filter(m => m.enabled && ENGINES.includes(m.engine))

  // The probes do not wait for the context reads: the machines, the task's folder and the group's talk and log are read
  // together, and each read that is only context gives up after three seconds. What needs several of them (whether a
  // member is in the task's repository, what it did before) is joined afterwards.
  const [probed, read, history] = await Promise.all([
    Promise.all([...machines].map(([machineId, machine]) =>
      probeMachine(machineId, machine, members.filter(m => m.machineId === machineId), enabled, policy, assessment, where, open))),
    cwd ? within(readFolder(cwd, reader)) : null,
    within(scoped({ action: 'routeHistory', conversationId: input.conversationId })),
  ])
  const folder: TaskFolder | null = !cwd ? null : read ?? { cwd, kind: 'unknown', name: null, root: null, remote: null }
  const past = object(history?.ok === true ? history.value : {})
  const decisions = Array.isArray(past.decisions) ? list(past.decisions) : null
  const attempts = Array.isArray(past.attempts) ? list(past.attempts) : null
  const ended = endedWork(conversations, decisions, attempts, input.conversationId)
  // The member's machine saw a usage-limit screen (superTabs/terminal.ts): it sits out until the reset, which the backend
  // sets to an hour when the screen named none (spec/2026-10-23-lead-sees-agent-terminal.md).
  const limited = (agentId: string | undefined) => {
    const until = Date.parse(String(members.find(m => m.id === agentId)?.limitedUntil))
    return until > Date.now() ? [`Its screen showed a usage limit until ${new Date(until).toISOString()}.`] : []
  }
  const probes = probed.flat().map(p => p.kind === 'member' ? { ...p, repo: repoMatch(folder, p.frame ?? null, p.machineId === where.machineId),
    refusals: [...p.refusals, ...limited(p.agentId)],
    earlier: ended.filter(e => e.agentId === p.agentId).reverse().slice(0, 3).map(e => ({ group: e.group, outcome: e.outcome })) } : p)
  probes.push(...localProbes(state, policy, probes, assessment, review))
  // Picks started or assigned and still at work hold part of their account's quota; the log, and so this, is per Swarm.
  const working = (decisions ?? []).filter(d => d.final && d.outcome === null && typeof d.account === 'string')
    .map(d => ({ account: d.account, spend: object(d.spend), size: d.size, createdAt: Date.parse(String(d.createdAt)) }) as Commitment)
  const choice = choose(probes, policy, assessment, Date.now(), working, rules, heldLocalModels(state))
  if ('error' in choice) return choice
  const verdict = decide(choice)
  const operationId = `route-${newId()}`
  const record = (v1: boolean) => scoped({ action: 'command', operationId,
    command: { type: 'route.record', conversationId: input.conversationId, decision: recordOf(choice, verdict, assessment, policy, v1) } })
  let recorded = await record(false)
  // A backend from before phase 1 refuses the new fields as invalid; the decision is still worth keeping in the shape it knows.
  if (recorded.error === 'VALIDATION_ERROR') recorded = await record(true)
  if (typeof recorded.error === 'string' && !TRANSPORT.has(recorded.error)) return recorded
  const routeDecisionId = recorded.ok === true ? object(object(recorded.value).result).routeDecisionId : undefined
  const decision = typeof routeDecisionId === 'string' ? `,"routeDecisionId":"${routeDecisionId}"` : ''
  const publicOf = (s: typeof verdict.pick) => ({ id: s.id, kind: s.kind, ...(s.agentId ? { agentId: s.agentId } : {}), machineId: s.machineId,
    engine: s.engine, model: s.model, effort: s.effort, title: s.title, ...(s.gridModel ? { gridModel: s.gridModel, gridName: s.gridName } : {}) })
  return {
    ok: true, ...(typeof routeDecisionId === 'string' ? { routeDecisionId } : { unrecorded: true }),
    pick: publicOf(verdict.pick), via: verdict.via, p: verdict.p, belowFloor: choice.belowFloor, why: verdict.why,
    alternatives: alternativesTo(verdict.pick, choice.shown).map(publicOf),
    warnings: [...(Array.isArray(effective.warnings) ? effective.warnings : []), ...(value.machinesUnreadable === true ? [MACHINES_UNREADABLE] : []),
      ...(choice.shown.some(p => p.kind === 'member' && p.terminalUnverified) ? ["A member's terminal could not be verified from its machine's snapshot. Check it before assignment."] : []),
      ...(choice.short ? [choice.short] : [])],
    next: verdict.pick.kind === 'member'
      ? `Assign with: command OPERATION_ID {"type":"work.assign","conversationId":"${input.conversationId}","agentId":"${verdict.pick.agentId}"${decision}}`
      : `Start with: start OPERATION_ID ${JSON.stringify({ conversationId: input.conversationId, name: review ? 'Reviewer' : 'Builder', ...(review ? { role: 'reviewer' } : {}), cwd: text(machines.get(verdict.pick.machineId)?.pool?.cwd) ?? assessment.needs.cwd ?? '/absolute/repo/on/that/machine',
        worktree: true, requirements: startRequirements(assessment.needs), machineId: verdict.pick.machineId, engine: verdict.pick.engine,
        // A local model is named by the grid alone: no subscription model or effort goes with it.
        ...(verdict.pick.gridModel ? { gridModel: verdict.pick.gridModel, gridName: verdict.pick.gridName } : { model: verdict.pick.model, effort: verdict.pick.effort }),
        ...(typeof routeDecisionId === 'string' ? { routeDecisionId } : {}) })}, then assign the started agent${decision ? ' with the same routeDecisionId' : ''}. It starts from the repository's default branch, fetched first; add "branchRef":"refs/remotes/origin/BRANCH" to start from another branch.`,
  }
}

/** The next two rows, and the best row of every other machine, so the Lead can choose another machine with an overrideReason. */
function alternativesTo<T extends { id: string; machineId: string }>(pick: T, shown: T[]): T[] {
  const seen = new Set([pick.machineId])
  return shown.filter(s => s.id !== pick.id).filter((s, i) => { const best = !seen.has(s.machineId); seen.add(s.machineId); return i < 2 || best })
}

/** A reading this old says nothing is served (backend `MACHINE_FRESH_MS`). */
const LOCAL_FRESH_MS = 45_000
/** Refusals about a subscription's allowance, which a local model does not spend. */
const SUBSCRIPTION = /subscription/i

interface Served { grid: string; model: string; label: string; kind: 'local' | 'api' | 'shared'; machines: Set<string> | null; holders: string[] }

/** The models served for the Swarm while the owner has the add-on on and a fresh reading lists them, by grid and model, each
 * with the Builders on it: one started on a model, or starting on it, holds it until it leaves the Swarm. */
function servedModels(state: Json, swarm: string, now: number): Map<string, Served> {
  // By grid and model: its label, and the machines that may run it (null: any).
  const served = new Map<string, Served>()
  for (const machine of list(state.machines)) {
    const observed = object(machine.observation)
    if (!finite(observed.receivedAt) || now - observed.receivedAt > LOCAL_FRESH_MS) continue
    for (const l of list(observed.localModels)) {
      if (typeof l.grid !== 'string' || typeof l.model !== 'string') continue
      const key = `${l.grid}\0${l.model}`, anywhere = l.grid === swarm
      const kind = l.kind === 'api' || l.kind === 'shared' ? l.kind : anywhere ? 'local' : 'shared'
      const known = served.get(key) ?? { grid: l.grid, model: l.model, label: text(l.name) ?? l.model, kind, machines: anywhere ? null : new Set<string>(), holders: [] }
      known.machines?.add(String(machine.machineId))
      served.set(key, known)
    }
  }
  const agents = new Map(list(state.agents).map(agent => [String(agent.harnessId), text(agent.displayName) ?? text(agent.name) ?? 'a Builder']))
  for (const start of list(state.starts)) {
    const request = object(start.request)
    if (typeof request.gridModel !== 'string' || start.error || (start.harnessId && !agents.has(String(start.harnessId)))) continue
    served.get(`${typeof request.gridName === 'string' ? request.gridName : swarm}\0${request.gridModel}`)?.holders
      .push(start.harnessId ? agents.get(String(start.harnessId))! : 'a Builder that is starting')
  }
  return served
}

/** Whether [m] can take another Builder: a local engine or a model shared with a member takes one, an API model up to [API_BUILDERS]. */
const takesBuilder = (m: Served) => m.holders.length < (m.kind === 'api' ? API_BUILDERS : 1)

/** The Swarm's served models that take no more Builders, and who is on them, then those a fresh reading says Builders are
 *  never offered, and why (superTabs/machines.ts refusedOn): what the route says when it offers none. */
export function heldLocalModels(state: Json, now: number = Date.now()): HeldModel[] {
  const addOn = object(state.localModels)
  if (addOn.enabled !== true || typeof addOn.grid !== 'string') return []
  const held: HeldModel[] = [...servedModels(state, addOn.grid, now).values()].filter(m => !takesBuilder(m))
    .map(({ model, label, kind, holders }) => ({ model, label, kind, holders }))
  for (const machine of list(state.machines)) {
    const observed = object(machine.observation)
    if (!finite(observed.receivedAt) || now - observed.receivedAt > LOCAL_FRESH_MS) continue
    for (const r of list(observed.refusedModels)) {
      if (r.grid !== addOn.grid || typeof r.model !== 'string' || typeof r.why !== 'string' || held.some(m => m.model === r.model)) continue
      held.push({ model: r.model, label: text(r.name) ?? r.model, kind: 'local', holders: [], refused: r.why })
    }
  }
  return held
}

/** New agents on local models (docs/plans/2026-10-23-swarm-local-models.md), only while the owner has the add-on on and a
 * fresh reading lists the model. One served on the Swarm's grid, an engine of a member's or an API one shares, is reached
 * through the grid relay from any Swarm machine that can start Claude Code or Codex. One on another grid, shared with a
 * machine's owner, only from that machine (owner, 2026-10-23). One Builder per local engine, since it answers one
 * conversation at a time; up to [API_BUILDERS] per API model (owner, 2026-10-24). Never for a review. */
export function localProbes(state: Json, policy: Policy, probes: Probe[], a: Assessment, review: boolean, now: number = Date.now()): Probe[] {
  const addOn = object(state.localModels)
  const swarm = addOn.enabled === true && typeof addOn.grid === 'string' ? addOn.grid : null
  if (!swarm || review || (policy.localModels?.enabled === false && !a.local)) return []
  const served = new Map([...servedModels(state, swarm, now)].filter(([, m]) => takesBuilder(m)))
  if (!served.size) return []
  // One base per machine and engine: the first new-agent row the policy offers there, which carries the machine's refusals.
  const bases = new Map<string, Probe>()
  for (const p of probes) if (p.kind === 'new' && !p.gridModel && !bases.has(`${p.machineId}\0${p.engine}`)) bases.set(`${p.machineId}\0${p.engine}`, p)
  const quality = policy.localModels?.quality ?? 1
  return [...bases.values()].flatMap(base => [...served.values()].filter(m => !m.machines || m.machines.has(base.machineId))
    .map((m): Probe => ({ ...base, model: 'default', effort: 'default', quality, cost: 1, quota: UNKNOWN_QUOTA, known: true,
      refusals: base.refusals.filter(r => !SUBSCRIPTION.test(r)), gridModel: m.model, gridName: m.grid, gridLabel: m.label, gridKind: m.kind })))
}

async function probeMachine(machineId: string, { name: machineName, status, account, pool, folded }: { name: string; status: string; account: boolean; pool?: Json; folded?: boolean },
  members: Json[], allModels: Policy['models'], policy: Policy, a: Assessment, where: Where, open: typeof openDaemon): Promise<Probe[]> {
  const listedEngines = Array.isArray(pool?.engines) ? pool.engines.filter((engine): engine is string => typeof engine === 'string') : []
  const legacy = listedEngines.some(engine => !ENGINES.includes(engine))
  const installed = legacy ? list(object(pool?.observation).quotas).map(quota => quota.engine) : listedEngines
  // A Mac folded into its Harness Team account, or the other way round, offers no new agent of its own (routeTask).
  const models = folded ? [] : pool ? allModels.filter(m => installed.includes(m.engine)) : account ? allModels : []
  const engines = [...new Set([...models.map(m => m.engine), ...members.map(m => String(object(m.configuration).engine) as 'claude' | 'codex')])]
  const memberProbe = (m: Json, refusals: string[] = [], quota = UNKNOWN_QUOTA, frame: MemberFrame | null = null, terminalUnverified = false): Probe => {
    const c = object(m.configuration), engine = String(c.engine) as 'claude' | 'codex'
    const model = typeof c.model === 'string' ? c.model : null, effort = typeof c.effort === 'string' ? c.effort : null
    return { kind: 'member', agentId: String(m.id), name: String(m.name ?? 'Member'), machineId, machineName, engine,
      model: model ?? 'default', effort: effort ?? 'default', ...rateFor(policy, engine, model, effort),
      quota, activity: 'idle', known: quota.known, refusals, frame, terminalUnverified }
  }
  const newProbe = (m: Policy['models'][number], refusals: string[], quota: Probe['quota'], known: boolean, load: Probe['load'] = UNKNOWN_LOAD): Probe => ({
    kind: 'new', machineId, machineName, engine: m.engine, model: m.model, effort: m.effort, quality: m.quality, cost: m.cost,
    quota, activity: 'new agent', known, refusals, load })
  const offline = () => models.map(m => newProbe(m, [OFFLINE], UNKNOWN_QUOTA, false))
  const needs = startRequirements(a.needs)
  if (pool) {
    const observed = object(pool.observation), resources = object(observed.resources)
    const fresh = finite(observed.receivedAt) && Date.now() - observed.receivedAt < 45_000
    const quotas = list(observed.quotas)
    const quota = (engine: string) => { const q = quotas.find(q => q.engine === engine); return fresh && q ? quotaOf2({ known: q.known === true, windows: list(q.windows).filter(w => finite(w.usedPercent)).map(w => ({ usedPercent: w.usedPercent as number, resetsAt: w.resetsAt, name: text(w.name) ?? undefined })) }) : UNKNOWN_QUOTA }
    const blocked = [...(!fresh ? [OFFLINE] : []), ...(pool.paused ? ['New work is paused on this machine.'] : [])]
    const tools = object(observed.tools)
    /** Work for a project its owner does not run here: a new agent runs under the contribution, a member under its own grant. */
    const teammates = (contributorId: unknown) => typeof pool.teammatesRefused === 'string' && contributorId !== pool.projectOwnerId ? [pool.teammatesRefused] : []
    const newReasons = [...blocked, ...teammates(pool.contributorId),
      ...(pool.projectUnavailable === true ? ['Its owner must add this machine to the swarm again to support other projects.'] : []),
      ...(pool.repositoryUnavailable === true ? ['Share a repository for this project before starting agents on this machine.'] : []),
      ...(pool.availableSlots === 0 ? ['This machine has no available agent slots.'] : []),
      ...(!finite(resources.projectDiskFreeBytes) || resources.projectDiskFreeBytes < needs.diskBytes ? ['The project has insufficient measured free disk.'] : []),
      ...(!finite(resources.memoryTotalBytes) || !finite(resources.memoryUsedBytes) || resources.memoryTotalBytes - resources.memoryUsedBytes < needs.memoryBytes ? ['Insufficient measured free memory.'] : []),
      ...needs.tools.map(t => requiredToolReason(t, tools[t], object(observed.toolProbeErrors)[t])).filter((reason): reason is string => reason !== null),
      ...(needs.devices.length ? ['Required devices have not been reported.'] : [])]
    return [...members.map(m => {
      const allowance = quota(String(object(m.configuration).engine))
      const running = Array.isArray(observed.runningHarnessIds) ? observed.runningHarnessIds.includes(m.harnessId) : null
      return memberProbe(m, fresh ? [...memberRefusals(running, allowance, needs.tools, needs.devices, tools, object(observed.devices), object(observed.toolProbeErrors)),
        ...teammates(m.contributorId)] : [OFFLINE],
        allowance, null, fresh && running === null)
    }),
      ...models.map(m => newProbe(m, [...newReasons, ...(quota(m.engine).leftPercent === 0 ? ['Subscription exhausted.'] : [])], quota(m.engine), fresh && quota(m.engine).known,
        { agents: Array.isArray(observed.runningHarnessIds) ? observed.runningHarnessIds.length : null,
          freeMemoryBytes: finite(resources.memoryTotalBytes) && finite(resources.memoryUsedBytes) ? resources.memoryTotalBytes - resources.memoryUsedBytes : null,
          hasFolder: finite(resources.projectDiskFreeBytes) }))]
  }
  // The account says this machine is off, so nothing there can run or be asked.
  if (account && status === 'offline') return [...members.map(m => memberProbe(m, [OFFLINE])), ...offline()]
  let target: Daemon
  try { target = await open(where, machineId) } catch {
    // Not being able to open a machine says nothing about the agents already on it; only a new start needs it.
    return [...members.map(m => memberProbe(m)), ...offline()]
  }
  try {
    const listed = object(await target.request('agents_list', {}, 10_000).catch(() => ({})))
    const frames = list(listed.agents)
    const live = new Set(frames.filter(f => object(f.terminal).available !== false).map(f => String(f.id)))
    // Quota is not required to route: an unknown allowance only ranks a candidate lower. The start's own
    // requirements are (the hint suggests exactly these), and so is an exhausted usage window.
    const byEngine = new Map<string, Awaited<ReturnType<typeof inspectCapacity>>>()
    for (const engine of engines) {
      byEngine.set(engine, await inspectCapacity(target, { engine, cwd: a.needs.cwd ?? '/', worktree: false,
        requirements: startRequirements(a.needs) }))
    }
    const probes: Probe[] = []
    for (const m of members) {
      const inspected = byEngine.get(String(object(m.configuration).engine))!
      const allowance = quotaOf2(inspected.quota)
      const capacity = object(inspected.capacity)
      const refusals = memberRefusals(live.has(String(m.harnessId)), allowance, needs.tools, needs.devices,
        object(capacity.tools), object(capacity.devices), object(capacity.toolProbeErrors))
      const frame = frames.find(f => f.id === m.harnessId)
      probes.push(memberProbe(m, refusals, allowance, frame ? frameOf(frame) : null))
    }
    for (const m of models) {
      const inspected = byEngine.get(m.engine)!
      const resources = object(inspected.capacity.resources)
      // The capacity probe already measured the task's folder (its disk), so the answer is reused, not asked again.
      const load = { agents: Array.isArray(listed.agents) ? frames.length : null,
        freeMemoryBytes: finite(resources.memoryTotalBytes) && finite(resources.memoryUsedBytes) ? resources.memoryTotalBytes - resources.memoryUsedBytes : null,
        hasFolder: a.needs.cwd ? finite(resources.projectDiskFreeBytes) : null }
      // A machine listed only because an agent runs there may never have cloned the project. When its capacity read succeeded but
      // could not measure the named folder's disk, a missing folder is the likely cause; a failed or unsupported read says nothing.
      const noFolder = !!a.needs.cwd && machineId !== where.machineId && object(inspected.capacity).ok === true && !finite(resources.projectDiskFreeBytes)
      const reasons = noFolder ? inspected.reasons.map(r => r === DISK_UNVERIFIED ? NO_PROJECT_FOLDER : r) : inspected.reasons
      probes.push(newProbe(m, inspected.allowed ? [] : reasons, quotaOf2(inspected.quota), inspected.unknown.length === 0 && inspected.quota.known, load))
    }
    return probes
  } finally { target.close() }
}
