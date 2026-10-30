import type { AuthUser } from '../../src/lib/ssoAuth.js'
import type { Command } from '../../src/superTabs/commands.js'
import type { BenchConfig } from './config.js'
import type { Reply, SwarmDriver } from './driver.js'
import { machineId } from './fixtures.js'
import type { Plan } from './plan.js'
import { random, words, type Random } from './random.js'

export interface Worker {
  id: string
  harnessId: string
  machine: number
  /** The group whose task it holds; its terminal is open there. */
  group: string
  assignmentId: string
  checkIds: string[]
  /** Its terminal, opened by its machine's owner. */
  contextId: string
}

/** The Swarm the load runs on: who is who, and the ids the load's calls need. */
export interface Swarm {
  tabId: string
  people: AuthUser[]
  leadId: string
  /** Every work group's id, by its index in the plan. */
  groups: string[]
  workers: Worker[]
  /** Each machine's contribution generation, which its reports name. */
  generations: string[]
}

export const AGENT_CONFIGURATION = { engine: 'codex', model: 'bench-model', effort: 'high', contextWindow: 200000, engineVersion: 'bench' }

function must<T>(reply: Reply<T>, what: string): T {
  if (reply.code || reply.data === null) throw new Error(`Setup failed at ${what}: ${reply.code} (HTTP ${reply.status})`)
  return reply.data
}

/** Setup's calls: each must succeed, and each is counted. */
class Setup {
  calls = 0
  private operation = 0
  tabId = ''
  constructor(readonly driver: SwarmDriver, readonly config: BenchConfig, readonly people: AuthUser[]) {}
  get owner() { return this.people[0]! }
  op() { return `bench-${this.config.seed}-setup-${this.operation++}` }
  async check<T>(what: string, call: Promise<Reply<T>>): Promise<T> {
    this.calls++
    return must(await call, what)
  }
  async run(user: AuthUser, command: Command, asAgentId?: string) {
    return (await this.check(command.type, this.driver.execute(this.tabId, user, this.op(), command, asAgentId))).result
  }
}

/** Members join and contribute their machines; the owner's machine 0 runs the Lead. */
async function seedMembers(s: Setup): Promise<string> {
  for (const member of s.people.slice(1)) {
    const invitation = await s.run(s.owner, { type: 'invite.create', email: member.email, role: 'collaborator', conversationId: 'lead' })
    await s.run(member, { type: 'invite.accept', inviteId: String(invitation.inviteId) })
  }
  for (let n = 0; n < s.config.machines; n++) {
    await s.run(s.people[n]!, { type: 'machine.contribute', machineId: machineId(n), name: `Bench machine ${n}`, cwd: '/bench/repo',
      engines: ['codex'], maxAgents: 16 })
  }
  return String((await s.run(s.owner, { type: 'agent.add', conversationId: 'lead', machineId: machineId(0), harnessId: 'bench-lead',
    name: 'Lead', configuration: AGENT_CONFIGURATION, lead: true })).agentId)
}

/** Every group with a brief and two checks; returns their ids in plan order. */
async function seedGroups(s: Setup, rng: Random): Promise<string[]> {
  const groups: string[] = []
  for (let g = 0; g < s.config.groups; g++) {
    groups.push(String((await s.run(s.owner, { type: 'conversation.create', title: `Bench group ${g}`, brief: words(rng, s.config.text.briefChars),
      checks: [0, 1].map(() => ({ description: words(rng, 120), independent: false })) })).conversationId))
  }
  return groups
}

/** Each worker added by its machine's owner into its first active group, then joined to its other active groups. */
async function seedWorkers(s: Setup, p: Plan, groups: string[]): Promise<Array<{ id: string; harnessId: string }>> {
  const agents: Array<{ id: string; harnessId: string }> = []
  for (const w of p.workers) {
    const harnessId = `bench-worker-${w.index}`
    const id = String((await s.run(s.people[w.machine]!, { type: 'agent.add', conversationId: groups[w.groups[0]!]!,
      machineId: machineId(w.machine), harnessId, name: `Engineer ${w.index}`, configuration: AGENT_CONFIGURATION, lead: false })).agentId)
    for (const g of w.groups.slice(1)) await s.run(s.owner, { type: 'conversation.agent', conversationId: groups[g]!, agentId: id, present: true, lead: false })
    agents.push({ harnessId, id })
  }
  return agents
}

/** A done group's whole task: its worker joins, is assigned, passes both checks and reports done. */
async function finishGroup(s: Setup, rng: Random, group: string, agentId: string, host: AuthUser, checkIds: string[]) {
  await s.run(s.owner, { type: 'conversation.agent', conversationId: group, agentId, present: true, lead: false })
  const assignmentId = String((await s.run(s.owner, { type: 'work.assign', conversationId: group, agentId })).assignmentId)
  for (const checkId of checkIds) {
    await s.run(host, { type: 'work.check', conversationId: group, assignmentId, checkId, passed: true, evidence: words(rng, 200) }, agentId)
  }
  await s.run(host, { type: 'work.status', conversationId: group, assignmentId, status: 'done', result: words(rng, s.config.text.resultChars) }, agentId)
}

/**
 * Builds the Swarm through the driver's real commands, one after another, as people and agents would: members join,
 * machines are contributed, the Lead and the workers are added, every group gets a brief and checks, the done groups run
 * a whole task, and each worker is given its active group's task with its terminal open. Returns how many calls it made.
 */
export async function seedSwarm(driver: SwarmDriver, config: BenchConfig, p: Plan, people: AuthUser[]): Promise<{ swarm: Swarm; calls: number }> {
  const s = new Setup(driver, config, people), rng = random(config.seed, 'setup')
  s.tabId = (await s.check('create', driver.createSwarm(s.owner, s.op(), 'Bench Swarm'))).id
  const leadId = await seedMembers(s)
  const groups = await seedGroups(s, rng)
  const agents = await seedWorkers(s, p, groups)
  // Check ids are fixed when a group is created; one read gives them all.
  const snapshot = await driver.snapshot(s.tabId, s.owner)
  const checksOf = (group: string) => snapshot.conversations.find(c => c.id === group)!.checks.map(c => c.id)
  for (const w of p.workers) {
    for (const g of w.doneGroups) await finishGroup(s, rng, groups[g]!, agents[w.index]!.id, people[w.machine]!, checksOf(groups[g]!))
  }
  const workers: Worker[] = []
  for (const w of p.workers) {
    const group = groups[w.groups[0]!]!, agent = agents[w.index]!, host = people[w.machine]!
    const assignmentId = String((await s.run(s.owner, { type: 'work.assign', conversationId: group, agentId: agent.id })).assignmentId)
    const { contextId } = await s.check('native.open', driver.openNative(s.tabId, host, { operationId: s.op(), conversationId: group, agentId: agent.id }))
    workers.push({ ...agent, machine: w.machine, group, assignmentId, checkIds: checksOf(group), contextId })
  }
  const generations: string[] = []
  for (let n = 0; n < config.machines; n++) generations.push(await driver.machineGeneration(s.tabId, people[n]!, machineId(n)))
  return { swarm: { tabId: s.tabId, people, leadId, groups, workers, generations }, calls: s.calls }
}
