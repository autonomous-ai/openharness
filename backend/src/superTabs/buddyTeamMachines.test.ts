// A Buddy on a teammate's machine (Dee, 10-29): it runs in that Mac's Harness Team account, never its owner's own, and
// reads and posts only its own chat. Teammates' agents in that account share its computer user, so they could act as any
// agent there: a chat-only Buddy gives them nothing beyond the chat (Lead's ruling, 10-29). It changes Ken's 10-28 rule
// that a Buddy runs only on its person's own machine; Dee decided.
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor } from './model.js'
import { canReadGroup } from './projects.js'
import { buddyChatId } from './buddies.js'
import type { ContributedMachine } from './machines.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const reading = (extra: Partial<NonNullable<ContributedMachine['observation']>> = {}): NonNullable<ContributedMachine['observation']> => ({
  generation: 'g1', receivedAt: 1000, sessionKind: 'computer', resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null,
    diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null, deviceType: null, chip: null, os: null, gpuPercent: null }, tools: {},
  quotas: [], runningHarnessIds: [], stoppedHarnessIds: [], ...extra })
/** What the store reads for a listed machine (store.ts contribution, pooled): its contributor's grant. */
const listedGrant = (contributorId: string) => ({ machineOwnerId: contributorId, contributorId, hostGrant: null })

/** A Swarm with the owner's Mac, its Team account private, one project with a Lead and a workgroup, and peer. */
function setup({ team = true, privacy = true }: { team?: boolean; privacy?: boolean } = {}) {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: owner.email }, 'test')
  state.people.push({ id: 'peer', email: peer.email, role: 'collaborator', generation: 'first' })
  state.people.find(p => p.id === 'owner')!.generation = 'owner-gen'
  const pool = (machineId: string, extra: Partial<ContributedMachine>): ContributedMachine => ({ machineId, name: 'Mac Studio', contributorId: 'owner',
    membershipGeneration: 'owner-gen', generation: `g-${machineId}`, cwd: `/${machineId}`, scope: 'swarm', engines: ['claude'], maxAgents: 4, paused: false,
    observation: reading(), ...extra })
  state.machines = [pool('owner-mac', {}), ...team ? [pool('owner-team', { hostMachineId: 'owner-mac', observation: reading({ sessionKind: 'team',
    privacy: privacy ? { mode: 'account', passed: true, checkedAt: 1000, seenAt: 1000 } : { mode: 'account', passed: false, item: 'home', detail: 'x',
      checkedAt: 1000, seenAt: 1000 } }) })] : []]
  let next = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000, contribution: listedGrant('owner'),
      teamMachines: ['owner-team'], ...context })
    state = effects.state
    return effects
  }
  const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const pm = run({ type: 'agent.add', conversationId: app.conversationId, harnessId: 'pm', machineId: 'owner-mac', name: 'PM', configuration, lead: true })
    .result.agentId as string
  const group = run({ type: 'conversation.create', projectId: app.projectId, title: 'Offline', brief: 'Save edits.', checks: [] }).result.conversationId as string
  return { run, app, pm, group, get state() { return state } }
}
type Swarm = ReturnType<typeof setup>
/** peer adds their Buddy on the owner's Mac, a Swarm machine. */
const addOnTeam = (f: Swarm, machineId = 'owner-mac') =>
  f.run({ type: 'buddy.create', projectId: f.app.projectId, machineId, engine: 'claude' }, peer, { contribution: listedGrant('owner') })
/** addOnTeam, launched by the Team account's host. */
function running(f: Swarm) {
  const added = addOnTeam(f)
  const host = { contribution: listedGrant('owner') }
  // Its host completes the start as the person who asked for it (store.ts poolHostActor).
  const agentId = f.run({ type: 'agent.started', startId: added.result.startId as string, harnessId: 'buddy-native', configuration }, peer, host).result.agentId as string
  return { agentId, chat: added.result.conversationId as string }
}
const group = (f: Swarm, id: string) => f.state.conversations.find(c => c.id === id)!

describe('a Buddy on a teammate\'s machine', () => {
  it('starts in that Mac\'s Team account, never the owner\'s own, as a chat-only Buddy', () => {
    const f = setup()
    const added = addOnTeam(f)
    const start = f.state.starts!.find(s => s.id === added.result.startId)!
    expect(start.request).toMatchObject({ machineId: 'owner-team', cwd: `/owner-team/${f.app.projectId}`,
      buddyOf: { personId: 'peer', generation: 'first', chatOnly: true }, conversationId: buddyChatId(f.app.projectId, { id: 'peer', generation: 'first' }) })
    expect(start).toMatchObject({ contributorId: 'owner', machineOwnerId: 'owner', poolGeneration: 'g-owner-team' })
  })

  it('is refused, in the words any other machine gets, on a Mac with no Team account', () => {
    const f = setup({ team: false })
    expect(() => addOnTeam(f)).toThrow('A Buddy runs only on your own machine. Pick one of yours.')
    expect(f.state.starts ?? []).toEqual([])
  })

  it('is refused while that Team account has not shown it is private', () => {
    const f = setup({ privacy: false })
    expect(() => addOnTeam(f)).toThrow('is not private')
    expect(f.state.starts ?? []).toEqual([])
  })

  it('is refused on the Team account itself, named directly', () => {
    const f = setup()
    expect(() => addOnTeam(f, 'owner-team')).toThrow('A Buddy runs only on your own machine. Pick one of yours.')
  })

  it('reads only its own chat: not the project chat, its workgroups, nor any other row of the Swarm', () => {
    const f = setup()
    const { agentId, chat } = running(f)
    const buddy: Actor = { kind: 'agent', agentId, machineOwnerId: 'owner' }
    expect(canReadGroup(f.state, buddy, group(f, chat))).toBe(true)
    expect(canReadGroup(f.state, buddy, group(f, f.app.conversationId))).toBe(false)
    expect(canReadGroup(f.state, buddy, group(f, f.group))).toBe(false)
    const read = visibleState(f.state, buddy, 1000)
    expect(read.conversations.map(c => c.id)).toEqual([chat])
    expect(read.agents.map(a => a.id)).toEqual([agentId])
  })

  it('posts only in its own chat and sends no proposal: its person sends those to the PM', () => {
    const f = setup()
    const { agentId, chat } = running(f)
    const buddy: Actor = { kind: 'agent', agentId, machineOwnerId: 'owner' }
    const asked = f.run({ type: 'message.send', conversationId: chat, text: 'Send it to the PM.', replyTo: null, recipientIds: [] }, peer)
    expect(f.run({ type: 'message.send', conversationId: chat, text: 'Here is a draft.', replyTo: null, recipientIds: [] }, buddy).messages).toHaveLength(1)
    expect(() => f.run({ type: 'message.send', conversationId: f.app.conversationId, text: 'Hello PM.', replyTo: null, recipientIds: [] }, buddy)).toThrow()
    expect(() => f.run({ type: 'buddy.propose', conversationId: chat, ownerMessageId: asked.messages[0]!.id, goal: 'Save edits.', scope: 'App.',
      priority: 'normal' }, buddy)).toThrow('A Buddy on a teammate\'s machine reads and posts only in its chat')
  })

  it('on its person\'s own machine still reads its project as before', () => {
    const f = setup()
    f.state.machines!.push({ machineId: 'peer-mac', name: 'Peer Mac', contributorId: 'peer', membershipGeneration: 'first', generation: 'g-peer',
      cwd: '/peer', scope: 'swarm', engines: ['claude'], maxAgents: 2, paused: false, observation: reading() })
    const added = f.run({ type: 'buddy.create', projectId: f.app.projectId, machineId: 'peer-mac', engine: 'claude' }, peer, { contribution: listedGrant('peer') })
    expect(f.state.starts!.find(s => s.id === added.result.startId)!.request.buddyOf).toEqual({ personId: 'peer', generation: 'first' })
  })
})
