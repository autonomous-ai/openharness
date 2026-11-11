import { describe, expect, it } from 'vitest'
import { freeze } from './cache.js'
import { applyCommand, postable, type Command, type CommandContext } from './commands.js'
import { createSuperTab, SuperTabError, type Actor, type SuperTabState } from './model.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const config = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const own = (userId: string) => ({ contribution: { machineOwnerId: userId, contributorId: userId } })

function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1_000 + sequence, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: mate.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, mate)
  /** A v4 agent: + New agent, its 1:1 chat, the session joined into it; in no project and with no task. */
  const newAgent = (person: Extract<Actor, { kind: 'person' }>, name: string) => {
    const chat = run({ type: 'agent.new', kind: 'regular', name, machineId: `${person.userId}-mac`, engine: 'claude', local: true } as Command,
      person, own(person.userId)).result.conversationId as string
    const agentId = run({ type: 'agent.add', conversationId: chat, machineId: `${person.userId}-mac`, harnessId: `h-${name.replace(/\W/g, '-')}`, name, lead: false,
      configuration: config } as Command, person, own(person.userId)).result.agentId as string
    return { kind: 'agent', agentId, machineOwnerId: person.userId } as Extract<Actor, { kind: 'agent' }>
  }
  return { run, newAgent, edit: (change: (state: SuperTabState) => void) => change(state), get state() { return state } }
}
const post = (conversationId: string, text: string, recipientIds: string[] = []) =>
  ({ type: 'message.send', conversationId, text, replyTo: null, recipientIds }) as Command

// Swarm v4 (anh Dee, 2026-11-08): agents talk to agents in a project's channel. A v4 agent belongs to no project and holds
// no server task (tasks are GitHub issues), so the channel's old rule (an agent of the project, or one with work there)
// left every new agent out of every channel (found in the swarm-sandbox run, 2026-11-09).
describe('a v4 agent in a project\'s channel', () => {
  it('posts there and reaches another person\'s agent by name, when its person reads the project', () => {
    const f = swarm()
    const pip = f.newAgent(owner, 'Pip'), juno = f.newAgent(mate, 'Juno')
    const sent = f.run(post('lead', 'free: pip'), pip)
    expect(sent.messages.map(m => m.text)).toContain('free: pip')
    const asked = f.run(post('lead', 'Can you review #4?', [juno.agentId]), pip)
    expect(asked.messages.at(-1)!.recipients).toEqual([juno.agentId])
  })

  // An upload asks whether an agent may post, on the Swarm as the read cache holds it, which nothing may change (store.ts poster).
  it('answers whether it may post in the channel on a state nobody may change, and that it would join', () => {
    const f = swarm()
    const pip = f.newAgent(owner, 'Pip')
    const held = structuredClone(f.state)
    freeze(held)
    expect(postable(held, pip, 'lead', 1_000).joining).toBe(pip.agentId)
    expect(held.conversations.find(c => c.id === 'lead')!.agentIds).not.toContain(pip.agentId)
  })

  it('wakes another person\'s agent named by @Name though it never posted in the channel', () => {
    const f = swarm()
    const pip = f.newAgent(owner, 'Pip'), juno = f.newAgent(mate, 'Juno')
    expect(f.run(post('lead', '@Juno can you review #4?'), pip).messages.at(-1)!.recipients).toEqual([juno.agentId])
    expect(f.state.conversations.find(c => c.id === 'lead')!.agentIds).toContain(juno.agentId)
  })

  // lampOS's PM is "first builder" and the sandbox has "a2a swarm": a tag was read one word at a time, so "@first builder"
  // named nobody and woke nobody (2026-11-11).
  it('wakes an agent whose name is several words when it is tagged whole, in any case, and no other agent for its first word', () => {
    const f = swarm()
    const pip = f.newAgent(owner, 'Pip'), first = f.newAgent(mate, 'first builder'), second = f.newAgent(mate, 'first')
    expect(f.run(post('lead', '@First Builder #12 is ready for you.'), pip).messages.at(-1)!.recipients).toEqual([first.agentId])
    expect(f.run(post('lead', 'Over to @first builder.'), pip).messages.at(-1)!.recipients).toEqual([first.agentId])
    // Its first word alone is the other agent, and a longer word is neither.
    expect(f.run(post('lead', '@first can you look?'), pip).messages.at(-1)!.recipients).toEqual([second.agentId])
    expect(f.run(post('lead', '@first builders, all of you'), pip).messages.at(-1)!.recipients).toEqual([second.agentId])
    // In code it is no tag.
    expect(f.run(post('lead', 'Run `@first builder` as written.'), pip).messages.at(-1)!.recipients).toEqual([])
  })

  // Review of #3904.
  it('reads a several-word name on one line only, leaves a person\'s tag theirs, and wakes nobody for a name two agents share', () => {
    const f = swarm()
    const pip = f.newAgent(owner, 'Pip'), first = f.newAgent(mate, 'first'), whole = f.newAgent(mate, 'first builder')
    // A name does not run on over a line break: the next paragraph's first word is not part of the tag.
    expect(f.run(post('lead', 'Thanks @first\n\nBuilder agents should rebase.'), pip).messages.at(-1)!.recipients).toEqual([first.agentId])
    expect(f.run(post('lead', 'Thanks @first\tbuilder'), pip).messages.at(-1)!.recipients).toEqual([whole.agentId])
    // "mate" is a person here: a tag of them stays theirs, though an agent is called "mate builder".
    f.newAgent(owner, 'mate builder')
    expect(f.run(post('lead', '@mate builder #12 is ready'), pip).messages.at(-1)!.recipients).toEqual([])
    // Two agents of one several-word name: neither is woken, and not the agent of its first word either.
    f.newAgent(owner, 'First Builder')
    expect(f.run(post('lead', '@first builder ping'), pip).messages.at(-1)!.recipients).toEqual([])
    // A name with marks that mean something to a pattern is read as written.
    const plus = f.newAgent(mate, 'c++ dev (x)')
    expect(f.run(post('lead', 'Over to @c++ dev (x).'), pip).messages.at(-1)!.recipients).toEqual([plus.agentId])
  })

  it('stays out of a private project its person does not read', () => {
    const f = swarm()
    const secret = f.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).result as { conversationId: string }
    const pip = f.newAgent(mate, 'Pip')
    expect(() => f.run(post(secret.conversationId, 'hello'), pip)).toThrow(SuperTabError)
  })

  // Its one terminal would carry a private project's channel into every other channel (security review 2 of #4116).
  it('stays out of a private project its person reads, and once given work in one, out of every other channel', () => {
    const f = swarm()
    const secret = f.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).result as { projectId: string, conversationId: string }
    const pip = f.newAgent(owner, 'Pip')
    expect(() => f.run(post(secret.conversationId, 'hello'), pip)).toThrow(SuperTabError)
    f.edit(state => { state.agents.find(a => a.id === pip.agentId)!.privateProjectId = secret.projectId })
    expect(f.run(post(secret.conversationId, 'free: pip'), pip).messages.map(m => m.text)).toContain('free: pip')
    expect(() => f.run(post('lead', 'hello'), pip)).toThrow(SuperTabError)
  })
})
