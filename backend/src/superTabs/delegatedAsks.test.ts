import { describe, expect, it } from 'vitest'
import { commandSchema, type Command } from './commands.js'
import { owedLines } from './inbox.js'
import type { Actor, Author } from './model.js'
import { touchesFor } from './parts/touches.js'
import { projectsOf } from './projects.js'
import { storedPulse } from './pulse.js'
import { owner, stepsFixture } from './steps.test-support.js'

function setup() {
  const f = stepsFixture()
  const guest = { kind: 'person' as const, userId: 'guest', email: 'guest@example.com' }
  const invite = f.run({ type: 'invite.create', email: guest.email, role: 'collaborator', conversationId: 'lead' })
  f.run({ type: 'invite.accept', inviteId: invite.result.inviteId as string }, guest)
  const project = () => projectsOf(f.state)[0]!
  const ask = (by: Actor = guest, replyTo: string | null = null) => f.run({ type: 'message.send', conversationId: 'lead',
    text: 'Where is the installer?', replyTo, recipientIds: [f.lead] }, by,
  replyTo ? { reply: { id: replyTo, conversationId: 'lead', author: { kind: 'person', id: 'guest' } as Author, createdAt: 0, thread: replyTo } } : {}).result.messageId as string
  const handoffCommand = (messageId: string, recipientIds = [f.dev]) => ({ type: 'message.send', conversationId: f.task,
    text: 'Please answer this support ask in its thread.', replyTo: null, recipientIds, handoff: messageId }) as Command
  const handoff = (id: string, to = f.dev) => f.run(handoffCommand(id, [to]), f.as(f.lead))
  const reply = (by: string, id: string, options: { thread?: string; answers?: true; agentOnly?: true } = {}) => f.run({ type: 'message.send',
    conversationId: 'lead', text: 'Get the installer from Downloads.', replyTo: options.answers ? null : id,
    recipientIds: options.agentOnly ? [by] : [], ...options.answers ? { answers: id } : {}, ...options.agentOnly ? { agentOnly: true } : {} },
  f.as(by), { reply: { id, conversationId: 'lead', author: { kind: 'person', id: 'guest' } as Author, createdAt: 0, thread: options.thread ?? id } })
  const owes = () => (f.group('lead').owed ?? []).map(a => a.id)
  const count = () => storedPulse(f.state, project())!.asks.count
  const lines = () => owedLines(f.state, project(), f.now).join('\n')
  return { f, guest, project, ask, handoffCommand, handoff, reply, owes, count, lines }
}

describe('an ask entrusted to a project agent', () => {
  it('settles a restored handoff when its named project agent answers', () => {
    const { f, ask, reply, count, lines } = setup()
    const id = ask()
    Object.assign(f.group('lead').owed![0]!, { delegatedTo: f.dev })
    reply(f.dev, id)
    expect(count()).toBe(0)
    expect(lines()).not.toContain(`message ${id} `)
  })

  it('leaves the owed list and Board only when the named agent answers in its thread', () => {
    const { f, ask, handoff, reply, owes, count, lines } = setup()
    const first = ask()
    f.tick(60_000)
    const other = ask()
    const routed = handoff(first)
    expect(routed.messages.find(m => m.id === routed.result.messageId)?.recipients).toEqual([f.dev])
    expect(routed.messages.find(m => m.id === routed.result.messageId)?.text).toContain(`Answer message ${first} in lead in its thread.`)
    expect(owes()).toEqual([first, other])
    expect(count()).toBe(2)
    expect(f.group('lead').answered).toBeUndefined()
    const answer = reply(f.dev, first).result.messageId
    expect(owes()).toEqual([other])
    expect(count()).toBe(1)
    expect(lines()).not.toContain(`message ${first} `)
    expect(lines()).toContain(`message ${other} `)
    expect(f.group('lead').pulse!.asks.oldestAt).toBe(f.now)
    expect(f.group('lead').answered).toContainEqual({ id: first, answerId: answer, thread: first, at: f.now })
  })

  it('keeps a member ask answered only by a Guide owed until the PM answers', () => {
    const { f, guest, project, ask, reply, owes, count, lines } = setup()
    f.run({ type: 'project.sharing', projectId: project().id, visibility: 'public', memberIds: [guest.userId] })
    const memberAsk = ask(guest)
    const ownerAsk = ask(owner)
    reply(f.dev, memberAsk)
    reply(f.dev, ownerAsk)
    expect(owes()).toEqual([memberAsk, ownerAsk])
    expect(count()).toBe(2)
    expect(lines()).toContain(`message ${memberAsk} `)
    reply(f.lead, memberAsk)
    expect(owes()).toEqual([ownerAsk])
  })

  it('keeps even a non-member ask owed after an unsolicited Guide reply', () => {
    const { f, ask, reply, owes, count } = setup()
    const id = ask()
    reply(f.dev, id)
    expect(owes()).toEqual([id])
    expect(count()).toBe(1)
  })

  it('does not infer handoffs from the words of a PM post', () => {
    const { f, ask, reply, owes } = setup()
    const id = ask()
    f.run({ type: 'message.send', conversationId: f.task, text: `Discuss whether to answer ${id}.`, replyTo: null, recipientIds: [f.dev] }, f.as(f.lead))
    reply(f.dev, id)
    expect(owes()).toEqual([id])
  })

  it('requires the entrusted agent, the ask thread, and a public thread reply', () => {
    const { f, ask, handoff, reply, owes } = setup()
    const otherAgent = f.add('other', f.task)
    const id = ask(), otherAsk = ask()
    handoff(id)
    reply(otherAgent, id)
    reply(f.dev, otherAsk)
    reply(f.dev, id, { answers: true })
    reply(f.dev, id, { agentOnly: true })
    expect(owes()).toEqual([id, otherAsk])
    reply(f.dev, id)
    expect(owes()).toEqual([otherAsk])
  })

  it('leaves a member follow-up in the same thread owed until the PM answers', () => {
    const { f, ask, handoff, reply, owes, count } = setup()
    const id = ask()
    handoff(id)
    const memberFollowup = ask(owner, id)
    reply(f.dev, id)
    expect(owes()).toEqual([memberFollowup])
    expect(count()).toBe(1)
    reply(f.lead, memberFollowup, { thread: id })
    expect(count()).toBe(0)
  })

  it('uses the latest explicit handoff and still allows the PM to answer', () => {
    const { f, ask, handoff, reply, owes } = setup()
    const otherAgent = f.add('next-guide', f.task)
    const id = ask()
    handoff(id)
    handoff(id, otherAgent)
    reply(f.dev, id)
    expect(owes()).toEqual([id])
    reply(otherAgent, id)
    expect(owes()).toEqual([])
    const next = ask()
    handoff(next)
    reply(f.lead, next)
    expect(owes()).toEqual([])
  })

  it('accepts the optional handoff in the public message command', () => {
    const { ask, handoffCommand } = setup()
    expect(commandSchema.safeParse(handoffCommand(ask())).success).toBe(true)
  })

  it('allows only the PM to hand off an ask', () => {
    const { f, ask, handoffCommand } = setup()
    const command = handoffCommand(ask())
    expect(() => f.run(command, owner)).toThrow('Only the project PM can hand off an owed ask.')
    expect(() => f.run(command, f.as(f.dev))).toThrow('Only the project PM can hand off an owed ask.')
  })

  it('requires a still-owed ask and exactly one named project agent', () => {
    const { f, ask, handoffCommand, handoff, reply } = setup()
    const id = ask(), other = f.add('other-guide', f.task)
    expect(() => f.run(handoffCommand(id, []), f.as(f.lead))).toThrow('Name exactly one project agent for the handoff.')
    expect(() => f.run(handoffCommand(id, [f.dev, other]), f.as(f.lead))).toThrow('Name exactly one project agent for the handoff.')
    expect(() => handoff('missing-ask')).toThrow('This ask is no longer owed in the project chat.')
    reply(f.lead, id)
    expect(() => handoff(id)).toThrow('This ask is no longer owed in the project chat.')
  })

  it('does not accept an agent-only handoff', () => {
    const { f, ask, handoffCommand } = setup()
    const command = { ...handoffCommand(ask(), [f.lead]), agentOnly: true } as Command
    expect(() => f.run(command, f.as(f.lead))).toThrow('Hand off an ask in a public post to its project agent.')
  })

  it('guards a handoff against a concurrent PM replacement', () => {
    const { f, ask, handoffCommand } = setup()
    const command = handoffCommand(ask()), actor = f.as(f.lead), before = f.state
    const effects = f.run(command, actor)
    expect(touchesFor(command, actor, before, effects)).toContainEqual({ kind: 'group', key: 'lead' })
  })

  it('lets the PM close a plain greeting with a verdict and no answer', () => {
    const { f, guest, owes, count, lines } = setup()
    const id = f.run({ type: 'message.send', conversationId: 'lead', text: 'hảo hn1', replyTo: null, recipientIds: [] }, guest).result.messageId as string
    const react = (by: string, emoji: 'eyes' | 'check') => f.run({ type: 'message.react', conversationId: 'lead', messageId: id, emoji, on: true },
      f.as(by), { reaction: { messageId: id, reacted: false } })
    react(f.lead, 'eyes')
    react(f.dev, 'check')
    expect(owes()).toEqual([id])
    expect(react(f.lead, 'check').messages).toEqual([])
    expect(count()).toBe(0)
    expect(lines()).not.toContain('Owed asks')
    expect(f.group('lead').answered).toBeUndefined()
  })
})
