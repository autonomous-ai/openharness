import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type CommandEffects } from './model.js'
import { SHIP_KIND } from './ship.js'
import { TASK_LINE_KIND } from './taskLine.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'dee@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const PR = 'https://github.com/example/app/pull/7'

function fixture() {
  let state = createSuperTab('tab', 'Office', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1000 + sequence, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const add = (name: string, group: string, lead = false) => run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId: name,
    name, configuration: config, lead }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const pm = add('River', 'lead', true)
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  const group = (title = 'Offline drafts', extra: Record<string, unknown> = {}) => run({ type: 'conversation.create', title, brief: 'Keep drafts.',
    checks: [], ...extra } as Command).result.conversationId as string
  const task = (id: string) => state.conversations.find(c => c.id === id)!
  const status = (id: string, worker: string, value: 'working' | 'needs_human' | 'blocked' | 'review' | 'done' | 'stopped', result: string | null = null,
    extra: Record<string, unknown> = {}) =>
    run({ type: 'work.status', conversationId: id, assignmentId: task(id).assignment!.id, status: value, result, ...extra } as Command, as(worker))
  const lines = (effects: CommandEffects) => effects.messages.filter(m => m.source?.kind === TASK_LINE_KIND)
  return { run, add, as, group, task, status, lines, pm, get state() { return state } }
}

describe('ordinary task messages and progress replies', () => {
  it('opens immediately as its requester with the brief first in its ordinary thread', () => {
    const f = fixture()
    const created = f.run({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [] })
    const id = created.result.conversationId as string
    const [root] = f.lines(created)
    expect(root).toMatchObject({ conversationId: 'lead', author: { kind: 'person', id: 'owner', name: 'dee@example.com' },
      text: "Let's build: Offline drafts", replyTo: null, recipients: [], source: { kind: TASK_LINE_KIND, taskId: id } })
    expect(created.messages.filter(m => m.thread === root!.id)).toEqual([expect.objectContaining({ text: 'Keep drafts.',
      replyTo: root!.id, conversationId: 'lead' })])
    expect(f.task(id).cards?.line?.messageId).toBe(root!.id)
  })

  it('uses the project PM when no requester is named, never the machine owner', () => {
    const f = fixture()
    const created = f.run({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [] }, f.as(f.pm))
    expect(f.lines(created)[0]).toMatchObject({ author: { kind: 'agent', id: f.pm }, text: "Let's build: Offline drafts" })
  })

  it('appends assignment, progress, pull request and merge replies without editing the root', () => {
    const f = fixture(), id = f.group(), root = f.task(id).cards!.line!.messageId
    const builder = f.add('Kai', id)
    const assigned = f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    expect(f.lines(assigned)).toEqual([])
    expect(assigned.messages.filter(m => m.thread === root)).toEqual([expect.objectContaining({ text: 'Assigned to Kai.', replyTo: root })])
    for (const status of ['working', 'review', 'done'] as const) {
      const effects = f.status(id, builder, status, status === 'done' ? `Checks passed: ${PR}` : 'An update.')
      expect(effects.edits ?? []).toEqual([])
      expect(effects.messages.filter(m => m.thread === root)).toHaveLength(1)
      expect(effects.messages.find(m => m.thread === root)!.replyTo).toBe(root)
      expect(f.lines(effects)).toEqual([])
    }
    const merged = f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: PR })
    expect(merged.messages.filter(m => m.thread === root)).toEqual([expect.objectContaining({ text: `Merged ${PR}.` })])
    expect(merged.edits ?? []).toEqual([])
    expect(f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: PR }).messages.filter(m => m.thread === root)).toEqual([])
  })

  it('does not repeat unchanged statuses and mirrors a plain task post into its linked thread without redelivery', () => {
    const f = fixture(), id = f.group(), root = f.task(id).cards!.line!.messageId
    const builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    f.status(id, builder, 'working', 'Started.')
    expect(f.status(id, builder, 'working', 'Halfway.').messages.filter(m => m.thread === root)).toEqual([])
    const posted = f.run({ type: 'message.send', conversationId: id, text: 'Please check the draft.', replyTo: null, recipientIds: [] }, f.as(builder))
    expect(posted.messages.filter(m => m.thread === root)).toEqual([expect.objectContaining({ text: 'Please check the draft.',
      conversationId: 'lead', replyTo: root, recipients: [], author: expect.objectContaining({ kind: 'agent', id: builder }) })])
    expect(posted.messages.filter(m => m.recipients.includes(f.pm))).toHaveLength(1)
  })

  it('links a proposal root instead of posting a second opening message', () => {
    const f = fixture()
    const created = f.run({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [], proposalMessageId: 'proposal' }, f.as(f.pm),
      { proposal: { id: 'proposal', conversationId: 'lead', author: { kind: 'person', id: 'owner', name: owner.email, membershipGeneration: f.state.people[0]!.generation },
        source: { kind: 'buddy-proposal', personId: 'owner', buddyId: 'former-buddy' } } })
    expect(f.lines(created)).toEqual([])
    expect(f.task(created.result.conversationId as string).cards?.line).toMatchObject({ messageId: 'proposal', conversationId: 'lead' })
    expect(created.messages.filter(m => m.conversationId === 'lead')).toEqual([expect.objectContaining({ replyTo: 'proposal', thread: 'proposal', text: 'Keep drafts.' })])
  })

  it('keeps legacy roots readable and appends updates without rewriting their stored words', () => {
    const f = fixture(), id = f.group(), builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    f.task(id).cards!.line!.messageId = 'old-root'
    const effects = f.status(id, builder, 'review', 'Review this.')
    expect(effects.edits ?? []).toEqual([])
    expect(effects.messages.filter(m => m.thread === 'old-root')).toHaveLength(1)
  })

  it('puts private project messages only in their own project chat and excludes steps', () => {
    const f = fixture()
    const project = f.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).result.projectId as string
    const chat = f.state.projects!.find(p => p.id === project)!.leadConversationId
    const created = f.run({ type: 'conversation.create', projectId: project, title: 'Hidden work', brief: 'Hidden.', checks: [] })
    expect(f.lines(created)[0]!.conversationId).toBe(chat)
    const parent = created.result.conversationId as string
    const step = f.run({ type: 'conversation.create', projectId: project, title: 'Review', step: 'Review', reviewOf: parent, brief: 'Review.', checks: [] })
    expect(f.lines(step)).toEqual([])
  })

  it('does not create a root for an unchanged legacy task on unrelated chat activity', () => {
    const f = fixture(), id = f.group(), builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    delete f.task(id).cards
    expect(f.lines(f.run({ type: 'message.send', conversationId: 'lead', text: 'Hello.', replyTo: null, recipientIds: [] }))).toEqual([])
    expect(f.lines(f.status(id, builder, 'review', 'Ready.'))[0]!.text).toBe("Let's build: Offline drafts")
  })
})
