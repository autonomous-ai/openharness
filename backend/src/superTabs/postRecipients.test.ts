/**
 * Who an agent's post reaches (task #2963, Ken, 2026-11-04): in a day the PM got 841 deliveries, 420 of them agent posts,
 * and 402 of 437 agent posts reached it as their only recipient though only 1 named it. An agent's post reaches the agents
 * it names, the agent whose message it answers, and, in a task or step, its assignee when it names no one (River's ruling
 * in the task's thread). The PM hears the rest through status.
 */
import { describe, expect, it } from 'vitest'
import { REACHED_NO_AGENT, type Command } from './commands.js'
import { agent } from './model.js'
import { owner, stepsFixture } from './steps.test-support.js'

function setup() {
  const f = stepsFixture()
  const post = (by: string, on: string, text: string, recipientIds: string[] = [], reply?: { id: string; author: never }) =>
    f.run({ type: 'message.send', conversationId: on, text, replyTo: reply?.id ?? null, recipientIds } as Command, f.as(by),
      reply ? { reply: { id: reply.id, conversationId: on, author: reply.author, createdAt: 0, thread: reply.id } } : {}).messages
  const to = (messages: ReturnType<typeof post>) => messages.filter(m => m.source?.kind !== 'system').map(m => m.recipients)
  const nameOf = (id: string) => agent(f.state, id).displayName ?? agent(f.state, id).name
  return { f, post, to, nameOf }
}

describe('an agent post that names no one', () => {
  it('in its own task reaches no agent, not the PM', () => {
    const { f, post, to } = setup()
    expect(to(post(f.dev, f.task, 'PR #12 is ready for review.'))).toEqual([[]])
  })

  it('from another agent in a task reaches the task\'s assignee alone', () => {
    const { f, post, to } = setup()
    const other = f.add('other', f.task)
    expect(to(post(other, f.task, 'I pushed the fixture you asked for.'))).toEqual([[f.dev]])
    expect(to(post(f.lead, f.task, 'Rebase on main first.'))).toEqual([[f.dev]])
  })

  it('in a task with no active assignee reaches no agent', () => {
    const { f, post, to } = setup()
    const other = f.add('other', f.task)
    f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status: 'done', result: 'Merged' } as Command, f.as(f.dev))
    expect(to(post(other, f.task, 'Thanks.'))).toEqual([[]])
    expect(to(post(f.dev, f.task, 'Merged.'))).toEqual([[]])
  })

  it('from a step\'s agent reaches no agent; the Engineer\'s reaches the step\'s agent', () => {
    const { f, post, to } = setup()
    const step = f.step('Review'), reviewer = f.add('reviewer', step)
    f.run({ type: 'work.assign', conversationId: step, agentId: reviewer }, f.as(f.dev))
    expect(to(post(reviewer, step, 'Ready to merge: Yes'))).toEqual([[]])
    expect(to(post(f.dev, step, 'Fixed in abc123, please re-check.'))).toEqual([[reviewer]])
  })

  it('in the project chat reaches no agent', () => {
    const { f, post, to } = setup()
    // The Engineer has a task in the project, so it posts there without joining.
    const rows = post(f.dev, 'lead', 'Ken, the fix is out.')
    expect(to(rows)).toEqual([[]])
  })
})

// Egret6's review: a post that reaches no agent says so to the agent that sent it, in the command's result every CLI prints.
describe('an agent post that reaches no agent', () => {
  const sent = (f: ReturnType<typeof stepsFixture>, by: string | null, on: string, recipientIds: string[] = [], agentOnly = false) =>
    f.run({ type: 'message.send', conversationId: on, text: 'PR #12 is ready.', replyTo: null, recipientIds, ...agentOnly ? { agentOnly } : {} } as Command,
      by ? f.as(by) : owner).result
  it('tells its sender, and a post that reached someone or a person\'s says nothing', () => {
    const f = stepsFixture()
    expect(sent(f, f.dev, f.task).reachedNoAgent).toBe(REACHED_NO_AGENT)
    expect(sent(f, f.dev, f.task, [f.lead])).not.toHaveProperty('reachedNoAgent')
    expect(sent(f, f.lead, f.task)).not.toHaveProperty('reachedNoAgent')
    expect(sent(f, f.dev, f.task, [f.dev], true)).not.toHaveProperty('reachedNoAgent')
    expect(sent(f, null, f.task, [])).not.toHaveProperty('reachedNoAgent')
  })
})

describe('an agent post that names agents', () => {
  it('reaches the PM only when it names the PM', () => {
    const { f, post, to } = setup()
    expect(to(post(f.dev, f.task, 'Need a ruling on the schema.', [f.lead]))).toEqual([[f.lead]])
  })

  it('reaches only the agent it names', () => {
    const { f, post, to } = setup()
    const other = f.add('other', f.task)
    expect(to(post(f.dev, f.task, 'Can you check the fixture?', [other]))).toEqual([[other]])
    expect(to(post(f.lead, f.task, 'Take a look.', [other]))).toEqual([[other]])
  })

  it('names an agent of the conversation by @Name in its text', () => {
    const { f, post, to, nameOf } = setup()
    const other = f.add('other', f.task)
    expect(to(post(f.dev, f.task, `@${nameOf(other)} the CI runner is down.`))).toEqual([[other]])
    expect(to(post(f.dev, f.task, `@${nameOf(f.lead)} the CI runner is down.`))).toEqual([[f.lead]])
  })
})

describe('an agent\'s thread reply', () => {
  it('reaches the agent who wrote the message it answers', () => {
    const { f, post, to } = setup()
    const other = f.add('other', f.task)
    const asked = post(other, f.task, 'Which migration does this need?', [f.dev])[0]!
    expect(to(post(f.dev, f.task, 'None: the field is optional.', [], { id: asked.id, author: asked.author as never }))).toEqual([[other]])
    const ruled = post(f.lead, f.task, 'Is the migration reversible?', [f.dev])[0]!
    expect(to(post(f.dev, f.task, 'Yes.', [], { id: ruled.id, author: ruled.author as never }))).toEqual([[f.lead]])
  })

  it('reaches a step agent that answered the Engineer, and nobody for a person\'s message', () => {
    const { f, post, to } = setup()
    const step = f.step('Review'), reviewer = f.add('reviewer', step)
    f.run({ type: 'work.assign', conversationId: step, agentId: reviewer }, f.as(f.dev))
    const verdict = post(reviewer, step, 'Ready to merge: With fixes', [f.dev])[0]!
    expect(to(post(f.dev, step, 'Fixed, please re-check.', [], { id: verdict.id, author: verdict.author as never }))).toEqual([[reviewer]])
    const asked = f.run({ type: 'message.send', conversationId: 'lead', text: 'Is the fix out?', replyTo: null, recipientIds: [] } as Command, owner).messages[0]!
    expect(to(post(f.dev, 'lead', 'Yes, since 14:00.', [], { id: asked.id, author: asked.author as never }))).toEqual([[]])
  })
})

describe('status still reaches the PM', () => {
  const status = (status: string, result: string | null) => {
    const f = stepsFixture()
    const rows = f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status, result } as Command, f.as(f.dev)).messages
    return { f, rows: rows.filter(m => m.conversationId === f.task) }
  }

  it.each([['done', 'Merged #12'], ['needs_human', 'Ship behind a flag?'], ['blocked', 'No Mac here']])('%s', (kind, result) => {
    const { f, rows } = status(kind, result)
    expect(rows.some(m => m.recipients.includes(f.lead))).toBe(true)
  })

  it('lost', () => {
    const f = stepsFixture()
    const rows = f.run({ type: 'agent.alert', agentId: f.dev, alert: 'limit', active: true, resetAt: new Date(3_600_000).toISOString() } as Command, f.as(f.dev)).messages
    expect(rows.some(m => m.source?.kind === 'work-lost' && m.recipients.includes(f.lead))).toBe(true)
  })
})

/** One hour of a working day, in the shape of Ken's 11-04 numbers: most agent posts are reports, verdicts and
 *  acknowledgements that name no one; one names the PM and one answers it. */
describe('the PM\'s deliveries in a fixture hour', () => {
  it('are only the posts that name it or answer it', () => {
    const { f, post, nameOf } = setup()
    const step = f.step('Review'), reviewer = f.add('reviewer', step)
    f.run({ type: 'work.assign', conversationId: step, agentId: reviewer }, f.as(f.dev))
    const other = f.add('helper', f.task)
    const rows = [
      ...['Plan pushed.', 'Task 1 red.', 'Task 1 green.', 'PR is ready.', 'CI green.', 'Merged main in.'].flatMap(t => post(f.dev, f.task, t)),
      ...['Reading the diff.', 'Ready to merge: With fixes', 'Ready to merge: Yes'].flatMap(t => post(reviewer, step, t)),
      ...post(reviewer, f.task, 'Understood.'),
      ...post(other, f.task, 'On it.'),
      ...post(f.dev, f.task, '@owner here is the mockup.'),
      ...['Ken, I am on it.', 'Ken, it shipped.'].flatMap(t => post(f.dev, 'lead', t)),
      ...post(f.dev, step, 'Fixed in abc123.', [reviewer]),
      ...post(f.dev, f.task, 'Which database should this use?', [f.lead]),
      ...post(f.dev, f.task, `@${nameOf(f.lead)} the runner is down.`),
    ]
    const asked = post(f.lead, f.task, 'Is the migration reversible?', [f.dev])[0]!
    rows.push(...post(f.dev, f.task, 'Yes.', [], { id: asked.id, author: asked.author as never }))
    const agentPosts = rows.filter(m => m.author.kind === 'agent' && m.source?.kind !== 'system')
    expect(agentPosts).toHaveLength(18)
    expect(agentPosts.filter(m => m.recipients.includes(f.lead))).toHaveLength(3)
  })
})
