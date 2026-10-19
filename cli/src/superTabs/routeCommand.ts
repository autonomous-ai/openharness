/** `harness super-tab route GROUP JSON`: the Lead's routing step (docs/superpowers/specs/2026-10-19-super-tab-routing-v1-design.md).
 * Reads the tab, the effective policy and the account's machines; probes each machine once per engine with
 * the same admission `start` uses; then orders, asks Jev, and records the decision in the tab. */
import { randomUUID } from 'node:crypto'
import { openDaemon, type Daemon, type Where } from '../agentClient/daemon.js'
import { startRequirements } from './capacity.js'
import { inspectCapacity, type ScopedRequest } from './start.js'
import { object } from './wire.js'
import { choose, decide, jevQuestion, parseAssessment, quotaOf2, rateFor, recordOf, type Assessment, type Policy, type Probe } from './route.js'
import type { JevChoiceAnswer } from '../lib/jev/jevClient.js'

type Json = Record<string, unknown>
const ENGINES = ['claude', 'codex']
// Only these say the request never reached a decision; any other refusal (RATE_LIMITED, LEAD_REQUIRED,
// validation) is the answer and must reach the Lead.
const TRANSPORT = new Set(['AGENT_UNAVAILABLE', 'SUPER_TAB_UNAVAILABLE', 'BACKEND_UNAVAILABLE', 'BACKEND_TIMEOUT', 'BACKEND_UNREACHABLE'])
const MACHINES_UNREADABLE = "The account's machine list could not be read; only known machines were considered."
const OFFLINE = 'Machine is offline or unreachable.'
const UNKNOWN_QUOTA: Probe['quota'] = { known: false, leftPercent: null, resetsAt: null }
const active = (assignment: unknown) => { const a = object(assignment); return !!a.id && !['done', 'stopped'].includes(String(a.status)) }
const list = (value: unknown) => Array.isArray(value) ? value.map(object) : []

export async function routeTask(input: { tabId: string; conversationId: string; assessment: unknown }, request: ScopedRequest, where: Where,
  open: typeof openDaemon = openDaemon, newId: () => string = randomUUID): Promise<Json> {
  // A lost connection is an answer here, never a throw: the Lead must still get a decision or a reason.
  const scoped: ScopedRequest = async payload => {
    try { return await request(payload) } catch (error) {
      return { error: 'AGENT_UNAVAILABLE', detail: error instanceof Error ? error.message : 'The request to the machine failed.' }
    }
  }
  const assessment = parseAssessment(input.assessment)
  if (typeof assessment === 'string') return { error: 'INVALID_REQUEST', detail: assessment }
  const context = await scoped({ action: 'routeContext' })
  if (context.error || context.ok !== true) return context
  const value = object(context.value), state = object(object(value.tab).state), effective = object(value.policy)
  const policy = effective.policy as unknown as Policy
  const conversations = list(state.conversations), agents = list(state.agents)
  const group = conversations.find(c => c.id === input.conversationId)
  if (!group) return { error: 'NOT_FOUND', detail: 'No such group in this Super Tab.' }
  if (group.leadId !== value.agentId) return { error: 'LEAD_REQUIRED', detail: 'Only the Lead of this group routes its work.' }
  // The group's Lead and the tab Lead coordinate; neither is a worker candidate even when idle.
  const busy = new Set([String(group.leadId), String(conversations.find(c => c.id === 'lead')?.leadId),
    ...conversations.filter(c => active(c.assignment)).map(c => String(object(c.assignment).agentId))])
  const members = agents.filter(a => !busy.has(String(a.id)) && ENGINES.includes(String(object(a.configuration).engine)))
  // The account's machines can start a new agent. A member may run on a machine only its collaborator can
  // open; the Lead tries that machine too, but a member there is unknown, never offline.
  const machines = new Map<string, { name: string; status: string; account: boolean }>()
  for (const m of list(value.machines)) machines.set(String(m.machineId), { name: String(m.name), status: String(m.status ?? 'unknown'), account: true })
  // The Lead's own machine is the account's even when the list could not be read.
  if (!machines.has(where.machineId)) machines.set(where.machineId, { name: where.machineId, status: 'unknown', account: true })
  for (const m of members) if (!machines.has(String(m.machineId))) machines.set(String(m.machineId), { name: String(m.machineId), status: 'unknown', account: false })
  const enabled = policy.models.filter(m => m.enabled)

  const probes = (await Promise.all([...machines].map(([machineId, machine]) =>
    probeMachine(machineId, machine, members.filter(m => m.machineId === machineId), enabled, policy, assessment, where, open)))).flat()
  const choice = choose(probes, policy, assessment, Date.now())
  if ('error' in choice) return choice

  let answer: JevChoiceAnswer | undefined, unavailable: string | null = null
  if (choice.shown.length > 1) {
    const checks = list(group.checks).map(c => String(c.description ?? ''))
    // The group's last attempt, when it ended: a worker that stopped on this task is a worse choice.
    const last = object(group.assignment)
    const history = last.id && !active(last)
      ? [`${String(agents.find(a => a.id === last.agentId)?.name ?? 'An agent')}: ${String(last.status)}${typeof last.result === 'string' ? ` — ${last.result.slice(0, 300)}` : ''}`]
      : []
    const question = jevQuestion({ title: String(group.title ?? ''), brief: String(group.brief ?? ''), checks, history }, assessment, policy, choice)
    const reply = await scoped({ action: 'routeJev', conversationId: input.conversationId, ...question })
    if (typeof reply.error === 'string' && !TRANSPORT.has(reply.error)) return reply
    const jev = object(reply.value)
    if (reply.ok !== true || typeof jev.unavailable === 'string') unavailable = typeof jev.unavailable === 'string' ? jev.unavailable : 'UNAVAILABLE'
    else answer = object(jev.answers).who as JevChoiceAnswer | undefined
  }
  const verdict = decide(choice, answer, unavailable)
  const recorded = await scoped({ action: 'command', operationId: `route-${newId()}`,
    command: { type: 'route.record', conversationId: input.conversationId, decision: recordOf(choice, verdict, assessment, policy) } })
  if (typeof recorded.error === 'string' && !TRANSPORT.has(recorded.error)) return recorded
  const routeDecisionId = recorded.ok === true ? object(object(recorded.value).result).routeDecisionId : undefined
  const decision = typeof routeDecisionId === 'string' ? `,"routeDecisionId":"${routeDecisionId}"` : ''
  const publicOf = (s: typeof verdict.pick) => ({ id: s.id, kind: s.kind, ...(s.agentId ? { agentId: s.agentId } : {}), machineId: s.machineId,
    engine: s.engine, model: s.model, effort: s.effort, title: s.title })
  return {
    ok: true, ...(typeof routeDecisionId === 'string' ? { routeDecisionId } : { unrecorded: true }),
    pick: publicOf(verdict.pick), via: verdict.via, p: verdict.p, belowFloor: choice.belowFloor, why: verdict.why,
    alternatives: choice.shown.filter(s => s.id !== verdict.pick.id).slice(0, 2).map(publicOf),
    warnings: [...(Array.isArray(effective.warnings) ? effective.warnings : []), ...(value.machinesUnreadable === true ? [MACHINES_UNREADABLE] : [])],
    next: verdict.pick.kind === 'member'
      ? `Assign with: command OPERATION_ID {"type":"work.assign","conversationId":"${input.conversationId}","agentId":"${verdict.pick.agentId}"${decision}}`
      : `Start with: start OPERATION_ID ${JSON.stringify({ conversationId: input.conversationId, name: 'Builder', cwd: assessment.needs.cwd ?? '/absolute/repo/on/that/machine',
        worktree: true, requirements: startRequirements(assessment.needs), machineId: verdict.pick.machineId, engine: verdict.pick.engine, model: verdict.pick.model,
        effort: verdict.pick.effort, ...(typeof routeDecisionId === 'string' ? { routeDecisionId } : {}) })}, then assign the started agent${decision ? ' with the same routeDecisionId' : ''}.`,
  }
}

async function probeMachine(machineId: string, { name: machineName, status, account }: { name: string; status: string; account: boolean },
  members: Json[], allModels: Policy['models'], policy: Policy, a: Assessment, where: Where, open: typeof openDaemon): Promise<Probe[]> {
  const models = account ? allModels : []
  const engines = [...new Set([...models.map(m => m.engine), ...members.map(m => String(object(m.configuration).engine) as 'claude' | 'codex')])]
  const memberProbe = (m: Json, refusals: string[] = [], quota = UNKNOWN_QUOTA): Probe => {
    const c = object(m.configuration), engine = String(c.engine) as 'claude' | 'codex'
    const model = typeof c.model === 'string' ? c.model : null, effort = typeof c.effort === 'string' ? c.effort : null
    return { kind: 'member', agentId: String(m.id), name: String(m.name ?? 'Member'), machineId, machineName, engine,
      model: model ?? 'default', effort: effort ?? 'default', ...rateFor(policy, engine, model, effort),
      quota, activity: 'idle', known: quota.known, refusals }
  }
  const newProbe = (m: Policy['models'][number], refusals: string[], quota: Probe['quota'], known: boolean): Probe => ({
    kind: 'new', machineId, machineName, engine: m.engine, model: m.model, effort: m.effort, quality: m.quality, cost: m.cost,
    quota, activity: 'new agent', known, refusals })
  const offline = () => models.map(m => newProbe(m, [OFFLINE], UNKNOWN_QUOTA, false))
  // The account says this machine is off, so nothing there can run or be asked.
  if (account && status === 'offline') return [...members.map(m => memberProbe(m, [OFFLINE])), ...offline()]
  let target: Daemon
  try { target = await open(where, machineId) } catch {
    // Not being able to open a machine says nothing about the agents already on it; only a new start needs it.
    return [...members.map(m => memberProbe(m)), ...offline()]
  }
  try {
    const listed = object(await target.request('agents_list', {}, 10_000).catch(() => ({})))
    const live = new Set(list(listed.agents).filter(f => object(f.terminal).available !== false).map(f => String(f.id)))
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
      const refusals = [
        ...(live.has(String(m.harnessId)) ? [] : ['Its terminal is not running.']),
        // A running member already has its engine, memory and sign-in; only these three can still rule it out.
        ...inspected.reasons.filter(r => /usage window|Required tool|Required device/.test(r)),
      ]
      probes.push(memberProbe(m, refusals, quotaOf2(inspected.quota)))
    }
    for (const m of models) {
      const inspected = byEngine.get(m.engine)!
      probes.push(newProbe(m, inspected.allowed ? [] : inspected.reasons, quotaOf2(inspected.quota), inspected.unknown.length === 0 && inspected.quota.known))
    }
    return probes
  } finally { target.close() }
}
