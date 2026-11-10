/**
 * Who an agent's post reaches (task #2963, Ken, 2026-11-04): in a day the PM got 841 deliveries, 420 of them agent posts,
 * and 402 of 437 agent posts reached it as their only recipient though only 1 named it. An agent's post reaches the agents
 * it names, the agent whose message it answers, and, in a task or step, its assignee when it names no one (River's ruling
 * in the task's thread). The PM hears the rest through status.
 */
import { describe, expect, it } from 'vitest'
import { REACHED_NO_AGENT, type Command } from './commands.js'
import { agent } from './model.js'
import { agentDisplayName } from './agentNames.js'
import { recordAgentPresence } from './machines.js'
import { agentChatId } from './agentKind.js'
import { owner, stepsFixture } from './steps.test-support.js'
import { storedAssignment, storedStatus } from './storedWork.test-support.js'

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
    storedStatus(f.state, f.task, 'done', 'Merged')
    expect(to(post(other, f.task, 'Thanks, it merged.'))).toEqual([[]])
    expect(to(post(f.dev, f.task, 'Merged.'))).toEqual([[]])
  })

  it('from a step\'s agent reaches no agent; the Engineer\'s reaches the step\'s agent', () => {
    const { f, post, to } = setup()
    const step = f.step('Review'), reviewer = f.add('reviewer', step)
    storedAssignment(f.state, step, reviewer, f.now)
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

// Swarm v4 (anh Dee 2026-11-08): only agents post in a project's channel, so its person talks to the PM in a chat of its own.
describe('a PM\'s own chat', () => {
  it('opens when the PM joins its project, and its person\'s message there reaches the PM', () => {
    const { f, to } = setup()
    const chat = f.state.conversations.find(c => c.kind === 'agent-chat' && c.agentIds.includes(f.lead))!
    expect(chat.audience?.people.map(p => p.id)).toEqual(['owner'])
    expect(agentChatId(f.state, agent(f.state, f.lead))).toBe(chat.id)
    const sent = f.run({ type: 'message.send', conversationId: chat.id, text: 'Ship login by Friday.', replyTo: null, recipientIds: [] } as Command, owner)
    expect(to(sent.messages)).toEqual([[f.lead]])
  })

  it('holds a new PM\'s first request, not the channel', () => {
    const f = stepsFixture()
    const made = f.run({ type: 'project.create', name: 'Todo', visibility: 'public', brief: '' } as Command, owner).result
    const added = f.run({ type: 'agent.add', conversationId: made.conversationId as string, machineId: 'host', harnessId: 'pm2', name: 'pm2', lead: true,
      configuration: { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null },
      initialMessage: 'Build a tiny todo app.' } as Command, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } })
    const chat = f.state.conversations.find(c => c.kind === 'agent-chat' && c.agentIds.includes(added.result.agentId as string))!
    expect(added.messages.filter(m => m.text === 'Build a tiny todo app.').map(m => m.conversationId)).toEqual([chat.id])
  })
})

// Swarm v4 (anh Dee 2026-11-08): a project's chat is its channel, where its agents talk to each other by name, as lampOS's
// did in its issues. An agent of the project is reached by @Name there before it has posted in it.
describe('an agent post in the project channel', () => {
  it('reaches an agent of the project it names, though that agent has not joined the channel', () => {
    const { f, post, to, nameOf } = setup()
    const other = f.add('other', f.task)
    expect(f.group('lead').agentIds).not.toContain(other)
    expect(to(post(f.dev, 'lead', `@${nameOf(other)} can you take the flaky login test?`))).toEqual([[other]])
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
    storedAssignment(f.state, step, reviewer, f.now)
    const verdict = post(reviewer, step, 'Ready to merge: With fixes', [f.dev])[0]!
    expect(to(post(f.dev, step, 'Fixed, please re-check.', [], { id: verdict.id, author: verdict.author as never }))).toEqual([[reviewer]])
    const asked = f.run({ type: 'message.send', conversationId: 'lead', text: 'Is the fix out?', replyTo: null, recipientIds: [] } as Command, owner).messages[0]!
    expect(to(post(f.dev, 'lead', 'Yes, since 14:00.', [], { id: asked.id, author: asked.author as never }))).toEqual([[]])
  })
})

describe('a lost task', () => {
  it('still reaches the PM', () => {
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
    storedAssignment(f.state, step, reviewer, f.now)
    const other = f.add('helper', f.task)
    const rows = [
      ...['Plan pushed.', 'Task 1 red.', 'Task 1 green.', 'PR is ready.', 'CI green.', 'Merged main in.'].flatMap(t => post(f.dev, f.task, t)),
      ...['Reading the diff.', 'Ready to merge: With fixes', 'Ready to merge: Yes'].flatMap(t => post(reviewer, step, t)),
      ...post(reviewer, f.task, 'Understood, re-reading the plan.'),
      ...post(other, f.task, 'On it, starting with the fixtures.'),
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
    // The Engineer's tag of the owner tags the owner: Swarm v4 routes no tag through the PM.
    expect(rows.flatMap(m => m.mentions ?? [])).toEqual(['owner'])
  })
})

// Task #3114 (Ken, 11-05): his reply under Hawthorn3's "Done" in #3022 reached Hawthorn3 alone, whose work there was over, and
// no one who could act on it. A person's reply to the agent whose assignment there is done reaches the PM too.
describe('a person\'s reply to an agent', () => {
  const reply = (f: ReturnType<typeof stepsFixture>, on: string, author: string, text: string) =>
    f.run({ type: 'message.send', conversationId: on, text, replyTo: 'm-agent', recipientIds: [] } as Command, owner,
      { reply: { id: 'm-agent', conversationId: on, author: { kind: 'agent', id: author } as never, createdAt: 0, thread: 'm-agent' } }).messages
      .filter(m => m.source?.kind !== 'system').map(m => m.recipients)
  it('reaches that agent alone while its work in the task is open', () => {
    const f = stepsFixture()
    expect(reply(f, f.task, f.dev, 'Release it now?')).toEqual([[f.dev]])
  })
  it('reaches that agent and the PM once its work in the task is done', () => {
    const f = stepsFixture()
    storedStatus(f.state, f.task, 'done', 'Done, PR #12')
    expect(reply(f, f.task, f.dev, 'Release it now?')).toEqual([[f.dev, f.lead]])
  })
  it('reaches the agent alone when the done work is another agent\'s', () => {
    const f = stepsFixture()
    const other = f.add('other', f.task)
    storedStatus(f.state, f.task, 'done', 'Done')
    expect(reply(f, f.task, other, 'Thanks, and the fixture?')).toEqual([[other]])
  })
})

// A post to an agent whose session is down stays queued for it, as it must; its sender is told, in the command's result every CLI
// prints, instead of hearing nothing (tester Q3, 2026-11-09).
describe('a post to an agent whose session is down', () => {
  const sent = (f: ReturnType<typeof stepsFixture>, by: string | null, recipientIds: string[], extra: Record<string, unknown> = {}) =>
    f.run({ type: 'message.send', conversationId: f.task, text: 'Please rebase on main.', replyTo: null, recipientIds, ...extra } as Command, by ? f.as(by) : owner)
  /** What a machine's report records (machines.ts recordAgentPresence): every session of the machine but those [running] is down now. */
  const down = (f: ReturnType<typeof stepsFixture>, running: string[]) => recordAgentPresence(f.state, 'host', running, f.now)
  /** The name its sender's app shows it by (agentNames.ts). */
  const name = (f: ReturnType<typeof stepsFixture>, id: string) => agentDisplayName(f.state.agents, id)!

  it('tells its sender the recipient is offline and will read it when it is back, and still queues the post for it', () => {
    const f = stepsFixture()
    const other = f.add('other', f.task)
    down(f, ['pm', 'dev'])
    const done = sent(f, f.dev, [other])
    expect(done.result.offline).toBe(`${name(f, other)} is offline; it will read this when it is back.`)
    expect(done.messages.filter(m => m.source?.kind !== 'system').map(m => m.recipients)).toEqual([[other]])
    // A person's post to the agent says it too.
    expect(sent(f, null, [other]).result.offline).toBe(`${name(f, other)} is offline; it will read this when it is back.`)
  })

  it('names two with "and", and three with commas, and says "they"', () => {
    const f = stepsFixture()
    const [a, b, c] = ['a', 'b', 'c'].map(id => f.add(id, f.task)) as [string, string, string]
    down(f, ['pm', 'dev'])
    expect(sent(f, f.dev, [a, b]).result.offline).toBe(`${name(f, a)} and ${name(f, b)} are offline; they will read this when they are back.`)
    expect(sent(f, f.dev, [a, b, c]).result.offline).toBe(`${name(f, a)}, ${name(f, b)} and ${name(f, c)} are offline; they will read this when they are back.`)
  })

  it('names only the recipients that are down, and says nothing when none is', () => {
    const f = stepsFixture()
    const [a, b] = ['a', 'b'].map(id => f.add(id, f.task)) as [string, string]
    down(f, ['pm', 'dev', 'a'])
    expect(sent(f, f.dev, [a, b]).result.offline).toBe(`${name(f, b)} is offline; it will read this when it is back.`)
    expect(sent(f, f.dev, [a]).result).not.toHaveProperty('offline')
    expect(sent(f, f.dev, [f.lead]).result).not.toHaveProperty('offline')
  })

  it('says nothing of an agent told to stop, a post that names no agent, or an agent-only notice', () => {
    const f = stepsFixture()
    const other = f.add('other', f.task)
    // Everything is down, the Engineer too: an agent-only notice is its own, whatever its record says.
    down(f, [])
    agent(f.state, other).workDecision = 'stop'
    expect(sent(f, f.dev, [other]).result).not.toHaveProperty('offline')
    expect(sent(f, f.dev, []).result).not.toHaveProperty('offline')
    expect(sent(f, f.dev, [f.dev], { agentOnly: true }).result).not.toHaveProperty('offline')
  })

  it('stops saying it once the session is back', () => {
    const f = stepsFixture()
    const other = f.add('other', f.task)
    down(f, ['pm', 'dev'])
    expect(sent(f, f.dev, [other]).result).toHaveProperty('offline')
    down(f, ['pm', 'dev', 'other'])
    expect(sent(f, f.dev, [other]).result).not.toHaveProperty('offline')
  })
})
