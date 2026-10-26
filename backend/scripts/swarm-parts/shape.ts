/**
 * Synthetic Swarms shaped like production (spec, PM ruling on the dry run): built through real commands, then the fields
 * only the store writes (assignments' ends, ledgers, observations, progress), and history numbered by tab revision as the
 * old store numbered it. Deterministic for a seed. Sizes from the issue: 1.16 MB with 195 groups, 422 KB with 50.
 */
import { applyCommand, type Command, type CommandContext } from '../../src/superTabs/commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type Assignment, type Author, type SuperTabState } from '../../src/superTabs/model.js'
import { setLegacyProgress, type LegacyMessage } from './legacy.js'

export interface SwarmSpec { name: string; groups: number; agents: number; machines: number; projects: number; messages: number; targetBytes?: number; withoutProjects?: true }
export const PRODUCTION_SHAPED: SwarmSpec[] = [
  { name: 'big', groups: 195, agents: 20, machines: 6, projects: 3, messages: 40_000, targetBytes: 1_160_000 },
  { name: 'medium', groups: 50, agents: 8, machines: 3, projects: 2, messages: 8_000, targetBytes: 422_000 },
  ...Array.from({ length: 10 }, (_, i): SwarmSpec => ({ name: `small-${i}`, groups: 5 + (i % 5), agents: 2, machines: 1, projects: 1, messages: 50 + 25 * i })),
  { name: 'legacy-without-projects', groups: 7, agents: 2, machines: 1, projects: 1, messages: 120, withoutProjects: true },
]
export interface SeededSwarm { state: SuperTabState; revision: number; messages: LegacyMessage[]; attempts: Array<{ id: string; conversationId: string; snapshot: unknown }> }

const DAY = 86_400_000
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
/** mulberry32: a small seeded generator, so a dry run can be repeated exactly. */
function random(seed: number) {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296 }
}
const words = 'the agent ran the suite against the local stack and recorded each check with its output before handing the work back'.split(' ')
const prose = (rng: () => number, length: number) => { let text = ''; while (text.length < length) text += `${words[Math.floor(rng() * words.length)]} `; return text.trim() }
const pr = (n: number) => `https://github.com/autonomous-ai/openharness/pull/${n}`
export const personId = (swarm: number, n: number) => (swarm * 16 + n + 1).toString(16).padStart(24, '0')

export function buildSwarm(spec: SwarmSpec, index: number, now: number): SeededSwarm {
  const rng = random(index + 1)
  const tabId = `seed${index.toString(16).padStart(20, '0')}`
  const people = Array.from({ length: 5 }, (_, n) => ({ kind: 'person' as const, userId: personId(index, n), email: `person${n}@swarm${index}.example` }))
  const owner = people[0]!
  let state = createSuperTab(tabId, spec.name, { id: owner.userId, email: owner.email }, 'prod')
  let op = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: now - 60 * DAY, operationId: `seed-${++op}`, ...context })
    state = effects.state
    return effects.result
  }
  const own = { contribution: { machineOwnerId: owner.userId, contributorId: owner.userId } }
  for (const person of people.slice(1)) run({ type: 'invite.accept', inviteId: run({ type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' }).inviteId as string }, person)
  for (let p = 1; p < spec.projects; p++) run({ type: 'project.create', name: `Project ${p}`, visibility: p === 1 ? 'public' : 'private', brief: '' })
  const projects = state.projects!.map(p => p.id)
  const machines = Array.from({ length: spec.machines }, (_, m) => `machine-${index}-${m}`)
  for (const machineId of machines) run({ type: 'machine.contribute', machineId, name: machineId, cwd: '/work', scope: 'swarm', engines: ['claude', 'codex'], maxAgents: 4 }, owner, own)
  const leads = state.projects!.map((p, i) => run({ type: 'agent.add', conversationId: p.leadConversationId, machineId: machines[i % machines.length]!,
    harnessId: `lead-${index}-${i}`, name: `Lead ${i}`, configuration: config, lead: true }, owner, own).agentId as string)
  // `groups` counts every conversation, as the issue's sizes do: the work groups, each project's Lead conversation, the Leads one.
  const groups = Array.from({ length: spec.groups - spec.projects - 1 }, (_, g) => run({ type: 'conversation.create', projectId: projects[g % projects.length]!, title: `Task ${g}: ${prose(rng, 30)}`,
    task: { goal: prose(rng, 300), changes: prose(rng, 500), constraints: prose(rng, 400), owns: [`backend/src/area${g}`, `cli/src/area${g}`] },
    checks: Array.from({ length: 1 + Math.floor(rng() * 3) }, () => ({ description: prose(rng, 80), independent: rng() < 0.3 })) }).conversationId as string)
  const workers = Array.from({ length: Math.max(1, spec.agents - leads.length) }, (_, w) => run({ type: 'agent.add', conversationId: groups[w % groups.length]!,
    machineId: machines[w % machines.length]!, harnessId: `worker-${index}-${w}`, name: `Builder ${w}`, configuration: config, lead: false }, owner, own).agentId as string)
  const finishedBefore = new Map<string, number>()
  edit(state, rng, groups, workers, finishedBefore, now)
  const { messages, revision } = history(state, rng, tabId, finishedBefore, spec.messages, now, owner)
  ledger(state, rng, machines, workers, groups, now)
  if (spec.targetBytes) pad(state, spec.targetBytes, rng)
  if (spec.withoutProjects) { delete state.projects; for (const a of state.agents) delete a.projectId; for (const c of state.conversations) delete c.projectId }
  const attempts = groups.filter((_, g) => g % 10 === 3).map(conversationId => ({ id: `${tabId}-attempt-${conversationId}`, conversationId,
    snapshot: { checks: [{ evidence: `Tried in ${pr(9000 + Math.floor(rng() * 999))}` }], assignment: { agentId: workers[0], status: 'stopped', result: prose(rng, 200) } } }))
  return { state, revision, messages, attempts }
}

/** Every kind of finished, running and stuck work, as the store leaves it. */
function edit(state: SuperTabState, rng: () => number, groups: string[], workers: string[], finishedBefore: Map<string, number>, now: number) {
  const free = [...workers]
  for (const id of groups) {
    const group = state.conversations.find(c => c.id === id)!
    const roll = rng()
    // A worker runs one assignment at a time; finished work may name any of them.
    const running = roll < 0.15 && free.length > 0
    const workerId = running ? free.shift()! : workers[Math.floor(rng() * workers.length)]!
    const worker = state.agents.find(a => a.id === workerId)!
    const status: Assignment['status'] | null = running ? (roll < 0.03 ? 'needs_human' : roll < 0.05 ? 'reconciling' : 'working')
      : roll < 0.65 ? 'done' : roll < 0.75 ? 'cancelled' : roll < 0.8 ? 'stopped' : null
    if (!status) continue
    if (!group.agentIds.includes(worker.id)) group.agentIds.push(worker.id)
    group.assignment = { id: `work-${id}`, agentId: worker.id, status, configuration: config,
      execution: { machineId: worker.machineId, harnessId: worker.harnessId, machineOwnerId: worker.machineOwnerId },
      result: status === 'done' ? `Done. ${rng() < 0.5 ? pr(1000 + Math.floor(rng() * 999)) : ''} ${prose(rng, 300)}` : status === 'working' ? null : prose(rng, 120) }
    if (status === 'done') for (const check of group.checks) { check.evidence = prose(rng, 250); check.passedBy = worker.id }
    if (['done', 'cancelled', 'stopped'].includes(status)) {
      finishedBefore.set(id, now - (1 + Math.floor(rng() * 40)) * DAY)
      if (rng() < 0.15) group.archived = true
    }
  }
}

/** Messages numbered by the tab revision of the command that carried them (ties when one command wrote several). */
function history(state: SuperTabState, rng: () => number, tabId: string, finishedBefore: Map<string, number>, count: number, now: number, owner: { userId: string; email: string }) {
  const author: Author = { kind: 'person', id: owner.userId, name: owner.email, membershipGeneration: tabId }
  const groups = state.conversations
  const drafts = Array.from({ length: count }, (_, n) => {
    const group = groups[Math.floor(rng() * groups.length)]!
    const end = finishedBefore.get(group.id) ?? now - 3_600_000
    return { group, at: end - Math.floor(rng() * 20 * DAY), n }
  }).sort((a, b) => a.at - b.at)
  let sequence = 1_000
  const messages = drafts.map(({ group, at, n }) => {
    if (rng() > 0.1) sequence += 1 + Math.floor(rng() * 3)
    group.lastMessageSequence = sequence
    return { id: `${tabId}-m${n}`, conversationId: group.id, sequence, author, createdAt: new Date(at),
      text: rng() < 0.03 ? `Opened ${pr(2000 + n % 999)}` : prose(rng, 40 + Math.floor(rng() * 500)) }
  })
  return { messages, revision: sequence + 7 }
}

/** What only the store writes: starts in every state, slot ledgers, observations, rules, invitations, report progress. */
function ledger(state: SuperTabState, rng: () => number, machines: string[], workers: string[], groups: string[], now: number) {
  const pool = state.machines![0]!
  const request = (conversationId: string) => ({ conversationId, machineId: pool.machineId, engine: 'claude', name: 'Builder', cwd: '/work', worktree: true,
    requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 85, tools: ['git'], devices: [], quotaRequired: false } })
  const owner = state.ownerId
  state.starts = [[null, false, null, false], [null, true, null, false], ['started-h', true, null, true], [null, false, 'Machine offline.', false], ['pooled-h', true, null, false]]
    .map(([harnessId, dispatched, error, settled], s) => ({ id: `start-${s}`, creationId: `creation-${s}`, actorKey: `person:${owner}`, contributorId: owner,
      membershipGeneration: state.people[0]!.generation, machineOwnerId: owner, hostGrant: null, harnessId: harnessId as string | null, dispatched: dispatched as boolean,
      error: error as string | null, poolGeneration: pool.generation, poolSettled: settled as boolean, request: request(groups[s % groups.length]!) }))
  for (const machine of state.machines!) machine.observation = { generation: machine.generation, receivedAt: now - Math.floor(rng() * 20_000), sessionKind: 'computer',
    resources: { cpuPercent: 12, memoryTotalBytes: 34_359_738_368, memoryUsedBytes: 17_179_869_184, diskFreeBytes: 10 ** 11, diskTotalBytes: 10 ** 12,
      projectDiskFreeBytes: 10 ** 11, deviceType: 'laptop', chip: 'Apple M2', os: 'macOS 15', gpuPercent: null }, tools: { git: true },
    quotas: [], runningHarnessIds: state.agents.filter(a => a.machineId === machine.machineId).map(a => a.harnessId), stoppedHarnessIds: [] }
  state.harnessReservations = workers.slice(0, 4).map(id => { const a = state.agents.find(x => x.id === id)!; return { machineId: a.machineId, harnessId: a.harnessId, generation: 'g1', renewed: false } })
  state.releasedHarnesses = Array.from({ length: 30 }, (_, r) => ({ machineId: machines[r % machines.length]!, harnessId: `released-${r}` }))
  state.closingSessions = [{ agentId: 'removed-agent', machineId: machines[0]!, harnessId: 'closing-h', machineOwnerId: owner }]
  state.machineCleanups = [{ machineId: 'removed-machine', removalId: 'removal-1', machineOwnerId: owner }]
  state.overlapAlerts = groups.length > 3 ? [`${groups[0]}:${groups[1]}`] : []
  state.rules = (state.projects ?? []).map((p, r) => ({ id: `rule-${r}`, projectId: p.id, rule: { kind: 'preferEngine' as const, taskKind: 'ui', engine: 'codex' as const },
    text: 'Codex for UI work.', askedBy: owner, askedIn: null, addedBy: owner, createdAt: new Date(now - 30 * DAY).toISOString() }))
  state.invitations.push({ id: 'pending-invite', email: 'later@example.com', role: 'viewer', conversationId: 'lead', expiresAt: now + 7 * DAY })
  for (const project of state.projects ?? []) {
    const reports = state.conversations.filter(c => (c.projectId ?? 'lead') === project.id && c.id !== project.leadConversationId && !c.kind).map(c => c.lastMessageSequence)
    const dirty = Math.max(0, ...reports)
    if (dirty) setLegacyProgress(project, { dirtyRevision: dirty, summarizedRevision: Math.max(0, dirty - 40), since: now - DAY, requestedRevision: Math.max(0, dirty - 20), requestedAt: now - 3_600_000 })
  }
  // One group from before link lists, and one of a kind a later release added.
  delete state.conversations.find(c => c.id === groups[groups.length - 1])!.pullRequestUrls
  state.parkedConversations = [{ id: 'later-kind', kind: 'board' as never, title: 'Board', leadId: null, agentIds: [], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 }]
}

/** Longer results and evidence until the state reaches the production size this spec copies. */
function pad(state: SuperTabState, targetBytes: number, rng: () => number) {
  const finished = state.conversations.filter(c => c.assignment?.result)
  const deficit = targetBytes - Buffer.byteLength(JSON.stringify(state))
  if (deficit <= 0 || !finished.length) return
  const each = Math.ceil(deficit / finished.length)
  for (const group of finished) group.assignment!.result += ` ${prose(rng, each)}`
}
