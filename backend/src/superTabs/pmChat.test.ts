import { describe, expect, it } from 'vitest'
import { giveAgentsChats } from './agentChats.js'
import { applyCommand, postable, type Command, type CommandContext } from './commands.js'
import { PERSONAL_SWARM_OPERATION } from './deletion.js'
import { PM_PICKUP_MS, sweepLiveness } from './liveness.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, stableId, SuperTabError, visibleState, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import { projectsOf } from './projects.js'

// Swarm v4 (anh Dee 2026-11-08): only agents post in a project's channel, so a person asks a new project's Product Manager for
// its work in their 1:1 chat with it. lead.start opens that chat at once, before the PM is there, and the PM that joins takes it
// with everything its person sent there meanwhile.

const NOW = 50_000_000
const MINUTE = 60_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'xhigh', contextWindow: null, engineVersion: null }
const resources = { cpuPercent: 1, memoryTotalBytes: 64e9, memoryUsedBytes: 1e9, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const REPO = 'https://github.com/example/app'
const hosted = { contribution: { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null } }
const refusal = (body: () => unknown): SuperTabError | null => {
  try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

/** The owner's Team Swarm with a teammate, the owner's Mac, and the owner's new project App with no PM yet. */
function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: mate.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, mate)
  const person = (id: string) => state.people.find(p => p.id === id)!
  const mac: ContributedMachine = { machineId: 'owner-mac', name: 'Owner Mac', contributorId: 'owner', membershipGeneration: person('owner').generation,
    generation: 'g1', cwd: '/swarm', scope: 'swarm', engines: ['claude', 'codex'], maxAgents: 4, paused: false,
    observation: { generation: 'g1', receivedAt: NOW, resources, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [], capabilities: ['leadStart'] } }
  state.machines = [mac]
  const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const project = () => projectsOf(state).find(p => p.id === app.projectId)
  const chat = (id: string) => state.conversations.find(c => c.id === id)!
  const lead = (context: Partial<CommandContext> = {}) =>
    run({ type: 'lead.start', projectId: app.projectId, machineId: 'owner-mac', engine: 'claude', repositoryUrl: REPO }, owner, context).result as
      { startId: string; machineId: string; chatId: string }
  const send = (conversationId: string, text: string, attachments: CommandContext['attachments'] = []) =>
    run({ type: 'message.send', conversationId, text, replyTo: null, recipientIds: [], ...(attachments.length ? { attachmentIds: attachments.map(a => a.id) } : {}) },
      owner, attachments.length ? { attachments } : {})
  const started = (startId: string, harnessId = 'pm') => run({ type: 'agent.started', startId, harnessId, configuration: config }, owner, hosted)
  return { run, app, project, chat, lead, send, started, person, get state() { return state } }
}

describe('lead.start opens its PM\'s 1:1 chat at once', () => {
  it('for the person who asked, with no agent while it starts, and answers its id', () => {
    const f = swarm()
    const answer = f.lead()
    expect(answer).toEqual({ startId: answer.startId, machineId: 'owner-mac', chatId: expect.any(String) })
    expect(f.chat(answer.chatId)).toMatchObject({ kind: 'agent-chat', agentIds: [], leadId: null, title: 'Product Manager',
      audience: { people: [{ id: 'owner', generation: f.person('owner').generation }] } })
    expect(f.project()!.pmChat).toEqual({ id: answer.chatId })
  })

  it('answers the same id for the same operation', () => {
    const f = swarm()
    const before = f.state
    const first = applyCommand(before, owner, { type: 'lead.start', projectId: f.app.projectId, machineId: 'owner-mac', engine: 'claude', repositoryUrl: REPO },
      { now: NOW, operationId: 'start-1' })
    const again = applyCommand(before, owner, { type: 'lead.start', projectId: f.app.projectId, machineId: 'owner-mac', engine: 'claude', repositoryUrl: REPO },
      { now: NOW, operationId: 'start-1' })
    expect(again.result.chatId).toBe(first.result.chatId)
  })

  it('takes its person\'s message and file before the PM is there, and nobody else reads that chat', () => {
    const f = swarm()
    const { chatId } = f.lead()
    expect(() => postable(f.state, owner, chatId, NOW)).not.toThrow()
    const file = { id: 'file-1', name: 'brief.pdf', mime: 'application/pdf', size: 10, url: 'https://files.example/brief.pdf' }
    const sent = f.send(chatId, 'Build the sign-in page.', [file])
    expect(sent.messages.at(-1)).toMatchObject({ conversationId: chatId, text: 'Build the sign-in page.', recipients: [], attachments: [file] })
    expect(f.project()!.pmChat).toEqual({ id: chatId, waiting: [sent.result.messageId] })
    // The teammate reads the project, and neither the chat nor what waits in it.
    const mates = visibleState(f.state, mate, NOW)
    expect(mates.projects!.find(p => p.id === f.app.projectId)).not.toHaveProperty('pmChat')
    expect(mates.conversations.some(c => c.id === chatId)).toBe(false)
    expect(visibleState(f.state, owner, NOW).projects!.find(p => p.id === f.app.projectId)!.pmChat).toEqual({ id: chatId, waiting: [sent.result.messageId] })
  })

  it('keeps at most 20 messages waiting, and refuses the next one with why', () => {
    const f = swarm()
    const { chatId } = f.lead()
    for (let i = 0; i < 20; i++) f.send(chatId, `ask ${i}`)
    expect(refusal(() => f.send(chatId, 'one more'))).toMatchObject({ code: 'PM_CHAT_FULL', status: 409 })
  })
})

describe('the PM that joins', () => {
  it('takes that chat as its own, and is delivered what waited there, as its person wrote it', () => {
    const f = swarm()
    const { startId, chatId } = f.lead()
    const first = f.send(chatId, 'Build the sign-in page.').result.messageId as string
    const second = f.send(chatId, 'Use the brand colours.').result.messageId as string
    const joined = f.started(startId)
    const pm = joined.result.agentId as string
    expect(f.chat(chatId)).toMatchObject({ agentIds: [pm], audience: { people: [{ id: 'owner' }] } })
    expect(f.state.agents.find(a => a.id === pm)!.chatId).toBe(chatId)
    const author = { kind: 'person', id: 'owner', generation: f.person('owner').generation }
    expect(joined.lateDeliveries).toEqual([
      { messageId: first, conversationId: chatId, agentId: pm, lead: true, author },
      { messageId: second, conversationId: chatId, agentId: pm, lead: true, author }])
    expect(f.project()!.pmChat).toBeUndefined()
    // The time checks open it no other chat.
    const chats = f.state.conversations.length
    giveAgentsChats(f.state, NOW)
    expect(f.state.conversations).toHaveLength(chats)
    // What its person sends next reaches it as in any agent's chat.
    expect(f.send(chatId, 'Thanks.').messages.at(-1)!.recipients).toEqual([pm])
  })

  it('with nothing waiting, still takes the chat and is delivered nothing', () => {
    const f = swarm()
    const { startId, chatId } = f.lead()
    const joined = f.started(startId)
    expect(f.chat(chatId).agentIds).toEqual([joined.result.agentId])
    expect(joined.lateDeliveries).toBeUndefined()
  })
})

describe('a PM that leads the project another way', () => {
  /** A session of the owner's shared into the channel, which joins the project alone (#2207). */
  const shared = (f: ReturnType<typeof swarm>, harnessId: string) => f.run({ type: 'agent.add', conversationId: f.app.conversationId, machineId: 'owner-mac',
    harnessId, name: 'Mine', configuration: config, lead: false }, owner, hosted).result.agentId as string
  const named = (f: ReturnType<typeof swarm>, agentId: string) =>
    f.run({ type: 'conversation.agent', conversationId: f.app.conversationId, agentId, present: true, lead: true })

  it('named by hand, its person\'s, takes the chat with what waited', () => {
    const f = swarm()
    const { chatId } = f.lead()
    const asked = f.send(chatId, 'Build the sign-in page.').result.messageId as string
    const mine = shared(f, 'by-hand')
    const effects = named(f, mine)
    expect(f.chat(chatId).agentIds).toEqual([mine])
    expect(f.state.agents.find(a => a.id === mine)!.chatId).toBe(chatId)
    expect(effects.lateDeliveries?.map(d => [d.messageId, d.conversationId])).toEqual([[asked, chatId]])
    expect(f.project()!.pmChat).toBeUndefined()
  })

  it('named by hand with a chat of its own already, leaves the chat, which says so', () => {
    const f = swarm()
    const { chatId } = f.lead()
    f.send(chatId, 'Build the sign-in page.')
    const mine = shared(f, 'by-hand')
    giveAgentsChats(f.state, NOW)
    const effects = named(f, mine)
    expect(f.chat(chatId).agentIds).toEqual([])
    expect(effects.messages.filter(m => m.conversationId === chatId).map(m => m.text)).toEqual(
      ['This project\'s Product Manager already has its own chat. Send it what you wrote here.'])
    expect(f.project()!.pmChat).toBeUndefined()
  })

  it('added by hand while the Swarm starts one, takes the chat, and the start that loses says nothing there', () => {
    const f = swarm()
    const { startId, chatId } = f.lead()
    const hand = f.run({ type: 'agent.add', conversationId: f.app.conversationId, machineId: 'owner-mac', harnessId: 'by-hand', name: 'Mine',
      configuration: config, lead: true }, owner, hosted).result.agentId as string
    expect(f.chat(chatId).agentIds).toEqual([hand])
    const overtaken = f.started(startId)
    expect(overtaken.result.refused).toMatch(/already/)
    expect(overtaken.messages.filter(m => m.conversationId === chatId)).toEqual([])
  })

  it('no other agent joins the chat while it waits', () => {
    const f = swarm()
    const { chatId } = f.lead()
    expect(refusal(() => f.run({ type: 'agent.add', conversationId: chatId, machineId: 'owner-mac', harnessId: 'regular', name: 'Ada', configuration: config,
      lead: false }, owner, hosted))).toMatchObject({ code: 'AGENT_CHAT_TAKEN' })
  })
})

describe('a PM start that ends without its PM', () => {
  const rowsIn = (effects: { messages: Array<{ conversationId: string; text: string; source?: Record<string, unknown>; recipients: string[] }> }, id: string) =>
    effects.messages.filter(m => m.conversationId === id)

  it('failed, leaves the chat with its person and says so there; their next start takes it with what still waits', () => {
    const f = swarm()
    const { startId, chatId } = f.lead()
    const asked = f.send(chatId, 'Build the sign-in page.').result.messageId as string
    const failed = f.run({ type: 'agent.startFailed', startId, error: 'Could not clone the repository.' }, owner, hosted)
    const rows = rowsIn(failed, chatId)
    expect(rows.map(m => m.text)).toEqual(['Could not start Product Manager: its machine could not prepare or launch it. What you sent here waits for its next start.'])
    expect(rows[0]).toMatchObject({ recipients: [], source: { kind: 'system' }, id: stableId('pm-chat', startId) })
    expect(f.chat(chatId)).toMatchObject({ agentIds: [], archived: false, audience: { people: [{ id: 'owner' }] } })
    const again = f.lead()
    expect(again.chatId).toBe(chatId)
    expect(f.started(again.startId).lateDeliveries?.map(d => d.messageId)).toEqual([asked])
  })

  it('never taken by its machine, says so in the chat from the time checks too', () => {
    const f = swarm()
    const { chatId } = f.lead()
    const later = NOW + PM_PICKUP_MS + MINUTE
    f.state.machines![0]!.observation!.receivedAt = later
    const said = sweepLiveness(f.state, later)
    expect(said.filter(m => m.conversationId === chatId).map(m => m.text)).toEqual(
      ['Could not start Product Manager: its machine did not start it. Harness there may need an update. What you sent here waits for its next start.'])
  })

  it('removed with its machine, says so in the chat', () => {
    const f = swarm()
    const { chatId } = f.lead()
    const removed = f.run({ type: 'machine.remove', machineId: 'owner-mac' })
    expect(rowsIn(removed, chatId).map(m => m.text)).toEqual([expect.stringMatching(/^Could not start Product Manager: .* What you sent here waits for its next start\.$/)])
  })

  it('with its project deleted, the chat stays its person\'s and says no PM joins it', () => {
    const f = swarm()
    const { startId, chatId } = f.lead()
    f.run({ type: 'agent.startFailed', startId, error: 'Could not clone the repository.' }, owner, hosted)
    const deleted = f.run({ type: 'project.delete', projectId: f.app.projectId })
    expect(rowsIn(deleted, chatId).map(m => m.text)).toEqual(['This project was deleted, so no Product Manager joins this chat.'])
    expect(f.chat(chatId)).toMatchObject({ agentIds: [], audience: { people: [{ id: 'owner' }] } })
  })

  it('a later start still running is the one the chat waits for: an older start\'s failure says nothing there', () => {
    const f = swarm()
    const { startId, chatId } = f.lead()
    // A start recorded before this one that only now reports its failure.
    f.state.starts!.unshift({ ...f.state.starts![0]!, id: 'older', creationId: 'super-older' })
    expect(rowsIn(f.run({ type: 'agent.startFailed', startId: 'older', error: 'Could not clone the repository.' }, owner, hosted), chatId)).toEqual([])
    expect(f.state.starts!.find(s => s.id === startId)!.error).toBeNull()
  })
})

describe('a Personal Swarm\'s Lead (lead.claim)', () => {
  function personal() {
    let state = createSuperTab(stableId('super-tab', 'prod', 'owner', PERSONAL_SWARM_OPERATION), 'Personal', { id: 'owner', email: owner.email }, 'prod')
    let sequence = 0
    const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
      const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
      state = effects.state
      return effects
    }
    const app = run({ type: 'project.create', name: 'Games', visibility: 'private', brief: '' }).result as { projectId: string; conversationId: string }
    const claim = (machineId: string) => run({ type: 'lead.claim', projectId: app.projectId, machineId }).result as { leadStart: string; chatId: string }
    const join = () => run({ type: 'agent.add', conversationId: app.conversationId, machineId: 'mac', harnessId: 'h1', name: 'Lead', configuration: config, lead: true },
      owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
    return { run, app, claim, join, get state() { return state } }
  }

  it('answers the chat its Lead takes, the same to every claim, and the Lead that joins is delivered what waited there', () => {
    const f = personal()
    const first = f.claim('mac')
    expect(first).toEqual({ leadStart: 'start', chatId: expect.any(String) })
    expect(f.claim('mini')).toEqual({ leadStart: 'waiting', chatId: first.chatId })
    const asked = f.run({ type: 'message.send', conversationId: first.chatId, text: 'make the landing page dark', replyTo: null, recipientIds: [] }).result.messageId
    const joined = f.join()
    const lead = joined.result.agentId as string
    expect(f.state.conversations.find(c => c.id === first.chatId)!.agentIds).toEqual([lead])
    expect(f.state.agents.find(a => a.id === lead)!.chatId).toBe(first.chatId)
    expect(f.state.conversations.filter(c => c.kind === 'agent-chat')).toHaveLength(1)
    expect(joined.lateDeliveries).toEqual([{ messageId: asked, conversationId: first.chatId, agentId: lead, lead: true,
      author: { kind: 'person', id: 'owner', generation: f.state.people[0]!.generation } }])
  })
})
