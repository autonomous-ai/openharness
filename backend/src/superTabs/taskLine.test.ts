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

describe('a task\'s one line in its project chat', () => {
  it('posts one line in the project chat when a task is assigned', () => {
    const f = fixture()
    const id = f.group()
    const builder = f.add('Kai', id)
    const effects = f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    const [line, ...more] = f.lines(effects)
    expect(more).toEqual([])
    expect(line).toMatchObject({ conversationId: 'lead', recipients: [], replyTo: null, text: 'Offline drafts · planned',
      author: { kind: 'agent', id: f.pm },
      source: { kind: TASK_LINE_KIND, taskId: id, number: f.task(id).number, title: 'Offline drafts', state: 'planned', builderId: builder, requesterId: 'owner' } })
    expect(line!.source).not.toHaveProperty('answerFor')
    expect(f.task(id).cards?.line).toMatchObject({ messageId: line!.id, state: 'planned' })
  })

  it('edits the same line through working, waiting, review, ready and shipped', () => {
    const f = fixture()
    const id = f.group()
    const builder = f.add('Kai', id)
    const lineId = f.lines(f.run({ type: 'work.assign', conversationId: id, agentId: builder }))[0]!.id
    const seq = () => f.state.conversations.find(c => c.id === 'lead')!.reactionSeq ?? 0
    const steps: Array<[Parameters<typeof f.status>[2], string, Record<string, unknown>, Record<string, unknown>]> = [
      ['working', 'Offline drafts · working', { state: 'working' }, {}],
      ['needs_human', 'Offline drafts · waiting on dee', { state: 'waiting', answerFor: 'owner' },
        { ask: { personId: 'owner', options: ['Keep', 'Drop'], recommended: 0, unblocks: 'The release' } }],
      ['review', 'Offline drafts · in review', { state: 'review' }, {}],
      // Done with its pull request, not merged yet: ready, never shipped (PM, review of #2633).
      ['done', 'Offline drafts · ready', { state: 'ready' }, {}],
    ]
    for (const [value, text, source, extra] of steps) {
      const before = seq()
      const effects = f.status(id, builder, value, value === 'needs_human' ? 'Keep drafts after a restart?' : value === 'done' ? `Review passed: ${PR}` : null, extra)
      expect(f.lines(effects)).toEqual([])
      expect(effects.edits).toEqual([expect.objectContaining({ id: lineId, conversationId: 'lead', text,
        source: expect.objectContaining({ kind: TASK_LINE_KIND, taskId: id, ...source }) })])
      if (!('answerFor' in source)) expect(effects.edits![0]!.source).not.toHaveProperty('answerFor')
      expect(seq()).toBe(before + 1)
    }
    // Shipped once its merge is recorded, and only then.
    const merged = f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: PR })
    expect(merged.edits).toEqual([expect.objectContaining({ id: lineId, text: 'Offline drafts · shipped', source: expect.objectContaining({ state: 'shipped' }) })])
    expect(f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: PR }).edits ?? []).toEqual([])
  })

  it('says who it waits on by the name they set', () => {
    const f = fixture()
    f.run({ type: 'member.name', name: 'Dee Tran' })
    const id = f.group()
    const builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    const effects = f.status(id, builder, 'needs_human', 'Keep drafts after a restart?', {
      ask: { personId: 'owner', options: ['Keep', 'Drop'], recommended: 0, unblocks: 'The release' } })
    expect(effects.edits).toEqual([expect.objectContaining({ text: 'Offline drafts · waiting on Dee Tran' })])
  })

  it('reads done, never shipped, for work Done with no pull request', () => {
    const f = fixture()
    const id = f.group('Review: PR #2632')
    const builder = f.add('Kai', id)
    const lineId = f.lines(f.run({ type: 'work.assign', conversationId: id, agentId: builder }))[0]!.id
    const done = f.status(id, builder, 'done', 'Ready to merge: Yes.')
    expect(done.edits).toEqual([expect.objectContaining({ id: lineId, text: 'Review: PR #2632 · done', source: expect.objectContaining({ state: 'done' }) })])
  })

  it('writes no Shipped line for a task with a line', () => {
    const f = fixture()
    const id = f.group()
    const builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    const effects = f.status(id, builder, 'done', `Merged ${PR}`)
    expect(effects.messages.filter(m => m.source?.kind === SHIP_KIND)).toEqual([])
  })

  it('does not edit for a repeated status or a plain message', () => {
    const f = fixture()
    const id = f.group()
    const builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    f.status(id, builder, 'working', 'Started.')
    const seq = f.state.conversations.find(c => c.id === 'lead')!.reactionSeq
    expect(f.status(id, builder, 'working', 'Halfway.').edits ?? []).toEqual([])
    expect(f.status(id, builder, 'blocked', 'Waiting on CI.').edits ?? []).toEqual([])
    expect(f.run({ type: 'message.send', conversationId: id, text: 'Pushed.', replyTo: null, recipientIds: [] }, f.as(builder)).edits ?? []).toEqual([])
    expect(f.state.conversations.find(c => c.id === 'lead')!.reactionSeq).toBe(seq)
  })

  it('gives a step no line and leaves its task\'s line alone', () => {
    const f = fixture()
    const id = f.group()
    const builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    f.status(id, builder, 'review', 'Ready.')
    const step = f.run({ type: 'conversation.create', title: 'Review', step: 'Review', reviewOf: id, brief: 'Review it.', checks: [] }, f.as(builder))
      .result.conversationId as string
    const reviewer = f.add('Ivy', step)
    const assigned = f.run({ type: 'work.assign', conversationId: step, agentId: reviewer }, f.as(builder))
    const finished = f.status(step, reviewer, 'done', 'Ready to merge: Yes.')
    for (const effects of [assigned, finished]) {
      expect(f.lines(effects)).toEqual([])
      expect(effects.edits ?? []).toEqual([])
    }
    expect(f.task(step).cards?.line).toBeUndefined()
    expect(f.task(id).cards?.line?.state).toBe('review')
  })

  it('keeps one line through a task stopped and reassigned', () => {
    const f = fixture()
    const id = f.group()
    const first = f.add('Kai', id), second = f.add('Max', id)
    const lineId = f.lines(f.run({ type: 'work.assign', conversationId: id, agentId: first }))[0]!.id
    f.status(id, first, 'working', 'Started.')
    const stopped = f.run({ type: 'work.cancel', conversationId: id, assignmentId: f.task(id).assignment!.id, reason: 'Moving it on.' }, f.as(f.pm))
    expect(stopped.edits).toEqual([expect.objectContaining({ id: lineId, text: 'Offline drafts · stopped', source: expect.objectContaining({ state: 'stopped' }) })])
    const again = f.run({ type: 'work.assign', conversationId: id, agentId: second }, f.as(f.pm))
    expect(f.lines(again)).toEqual([])
    expect(again.edits).toEqual([expect.objectContaining({ id: lineId, source: expect.objectContaining({ state: 'planned', builderId: second }) })])
  })

  it('follows a rename of the task', () => {
    const f = fixture()
    const id = f.group()
    const builder = f.add('Kai', id)
    const lineId = f.lines(f.run({ type: 'work.assign', conversationId: id, agentId: builder }))[0]!.id
    const renamed = f.run({ type: 'conversation.rename', conversationId: id, title: 'Drafts survive a restart' })
    expect(renamed.edits).toEqual([expect.objectContaining({ id: lineId, text: 'Drafts survive a restart · planned',
      source: expect.objectContaining({ title: 'Drafts survive a restart' }) })])
  })

  it('posts a private project\'s task line in that project\'s own chat', () => {
    const f = fixture()
    const project = f.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).result.projectId as string
    const chat = f.state.projects!.find(p => p.id === project)!.leadConversationId
    const id = f.group('Hidden work', { projectId: project })
    const builder = f.add('Kai', id)
    const [line] = f.lines(f.run({ type: 'work.assign', conversationId: id, agentId: builder }))
    expect(line!.conversationId).toBe(chat)
    expect(line!.conversationId).not.toBe('lead')
  })

  it('posts nothing for a task that existed before lines until it changes, and nothing for a finished one', () => {
    const f = fixture()
    const id = f.group()
    const builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    // As stored before this release: assigned, with no line.
    delete f.task(id).cards
    expect(f.lines(f.run({ type: 'message.send', conversationId: 'lead', text: 'Hello.', replyTo: null, recipientIds: [] }))).toEqual([])
    const [line] = f.lines(f.status(id, builder, 'review', 'Ready.'))
    expect(line).toMatchObject({ text: 'Offline drafts · in review', source: { state: 'review' } })
  })
})
