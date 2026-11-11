import type { AuthUser } from '../../src/lib/ssoAuth.js'
import type { Command } from '../../src/superTabs/commands.js'
import type { BenchConfig } from './config.js'
import type { Reply, SwarmDriver } from './driver.js'
import { machineId } from './fixtures.js'
import type { Plan } from './plan.js'

export interface Agent {
  id: string
  harnessId: string
  machine: number
  /** Its 1:1 chat with its person (the owner of its machine). */
  chat: string
  /** Its project's channel, where it posts. */
  channel: string
  /** Its project's PM: itself, for a PM. */
  pmId: string
}

/** The Swarm the load runs on: who is who, and the ids the load's calls need. */
export interface Swarm {
  tabId: string
  people: AuthUser[]
  /** Every project's channel, by its index in the plan. */
  channels: string[]
  agents: Agent[]
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
  async run(user: AuthUser, command: Command) {
    return (await this.check(command.type, this.driver.execute(this.tabId, user, this.op(), command))).result
  }
}

/** Members join and list their machines. */
async function seedMembers(s: Setup): Promise<void> {
  for (const member of s.people.slice(1)) {
    const invitation = await s.run(s.owner, { type: 'invite.create', email: member.email, role: 'collaborator', conversationId: 'lead' })
    await s.run(member, { type: 'invite.accept', inviteId: String(invitation.inviteId) })
  }
  for (let n = 0; n < s.config.machines; n++) {
    await s.run(s.people[n]!, { type: 'machine.contribute', machineId: machineId(n), name: `Bench machine ${n}`, cwd: '/bench/repo',
      engines: ['codex'], maxAgents: 64 })
  }
}

/** Every project's channel in plan order: the Swarm's first project, then one each created by its PM's person. */
async function seedProjects(s: Setup, p: Plan): Promise<string[]> {
  const channels = ['lead']
  for (let project = 1; project < s.config.projects; project++) {
    const pm = p.agents[project]!
    channels.push(String((await s.run(s.people[pm.machine]!, { type: 'project.create', name: `Bench project ${project}`, visibility: 'public', brief: '' })).conversationId))
  }
  return channels
}

/** Each agent added by its person on their own machine: a PM into its project's channel (which opens its 1:1 chat), a Member
 *  into the 1:1 chat its person opens for it (+ New agent). */
async function seedAgents(s: Setup, p: Plan, channels: string[]): Promise<Array<{ id: string; harnessId: string; chat: string | null }>> {
  const agents: Array<{ id: string; harnessId: string; chat: string | null }> = []
  for (const a of p.agents) {
    const person = s.people[a.machine]!, harnessId = `bench-agent-${a.index}`, name = `Agent ${a.index}`
    const add = { type: 'agent.add', machineId: machineId(a.machine), harnessId, name, configuration: AGENT_CONFIGURATION } as const
    if (a.pm) {
      const id = String((await s.run(person, { ...add, conversationId: channels[a.project]!, lead: true })).agentId)
      agents.push({ id, harnessId, chat: null })
      continue
    }
    const chat = String((await s.run(person, { type: 'agent.new', kind: 'regular', machineId: machineId(a.machine), engine: 'codex', name, local: true }))
      .conversationId)
    agents.push({ id: String((await s.run(person, { ...add, conversationId: chat, lead: false })).agentId), harnessId, chat })
  }
  return agents
}

/**
 * Builds the Swarm through the driver's real commands, one after another, as people would: members join and list their
 * machines, projects are created, each project's PM is added to its channel and each Member to its own chat. Returns how
 * many calls it made.
 */
export async function seedSwarm(driver: SwarmDriver, config: BenchConfig, p: Plan, people: AuthUser[]): Promise<{ swarm: Swarm; calls: number }> {
  const s = new Setup(driver, config, people)
  s.tabId = (await s.check('create', driver.createSwarm(s.owner, s.op(), 'Bench Swarm'))).id
  await seedMembers(s)
  const channels = await seedProjects(s, p)
  const added = await seedAgents(s, p, channels)
  // A PM's chat is opened by its add; each person's first load names their agents' chats.
  const chats = new Map<string, string>()
  for (let n = 0; n < config.machines; n++) {
    if (!p.agents.some(a => a.pm && a.machine === n)) continue
    s.calls++
    for (const [agentId, chat] of await driver.agentChats(s.tabId, people[n]!)) chats.set(agentId, chat)
  }
  const agents = p.agents.map((a, i): Agent => {
    const { id, harnessId, chat } = added[i]!
    return { id, harnessId, machine: a.machine, chat: chat ?? chats.get(id) ?? (() => { throw new Error(`No chat of agent ${i}`) })(),
      channel: channels[a.project]!, pmId: added[a.project]!.id }
  })
  const generations: string[] = []
  for (let n = 0; n < config.machines; n++) generations.push(await driver.machineGeneration(s.tabId, people[n]!, machineId(n)))
  return { swarm: { tabId: s.tabId, people, channels, agents, generations }, calls: s.calls }
}
