import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { agentOnly, createSuperTab, SuperTabError, type Actor, type SuperTabState } from './model.js'

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
  /** A v4 agent and its 1:1 chat with its person, as + New agent makes them. */
  const newAgent = (person: Extract<Actor, { kind: 'person' }>, name: string) => {
    const chat = run({ type: 'agent.new', kind: 'regular', name, machineId: `${person.userId}-mac`, engine: 'claude', local: true } as Command,
      person, own(person.userId)).result.conversationId as string
    const agentId = run({ type: 'agent.add', conversationId: chat, machineId: `${person.userId}-mac`, harnessId: `h-${name}`, name, lead: false,
      configuration: config } as Command, person, own(person.userId)).result.agentId as string
    return { chat, agentId }
  }
  return { run, newAgent }
}
const relay = (chat: string, agentId: string, extra: Record<string, unknown> = {}) => ({ type: 'github.relay', conversationId: chat, agentId,
  event: 'comment', on: 'pull', repository: 'acme/app', number: 4, url: 'https://github.com/acme/app/pull/4#issuecomment-1', login: 'deehw',
  association: 'MEMBER', text: 'Juno, 14:20, to **Pip**: READ-OK f6edb44', ...extra }) as Command

describe('GitHub relayed into an agent\'s chat (githubRelay.ts)', () => {
  // anh Dee, 2026-11-11, of their chat with an agent full of these: "so terrible. it should be like a human conversation", and
  // "why? what for?". The row is how GitHub's words reach the agent's session; it is its agent's alone to read.
  it('writes a member\'s comment as the person\'s row from GitHub, to their agent alone, which only the agent reads', () => {
    const f = swarm()
    const pip = f.newAgent(owner, 'Pip')
    const row = f.run(relay(pip.chat, pip.agentId)).messages.at(-1)!
    expect(row).toMatchObject({ conversationId: pip.chat, author: { kind: 'person', id: 'owner' }, recipients: [pip.agentId],
      source: { kind: 'github', event: 'comment', on: 'pull', repository: 'acme/app', number: 4, login: 'deehw', association: 'MEMBER' } })
    expect(row.text).toBe('On GitHub, deehw wrote on pull request acme/app#4:\nJuno, 14:20, to **Pip**: READ-OK f6edb44\nhttps://github.com/acme/app/pull/4#issuecomment-1')
    expect(agentOnly(row.source, row.recipients)).toBe(true)
  })

  // #4223 (anh Dee, 2026-11-12): an agent heard "On GitHub, deehw wrote on #4212: Devon: Lennox, …", and deehw is only the login
  // Devon posts with. Each comment is credited to the agent who wrote it.
  it('names the Swarm\'s agent that signed a comment, in the new form and the old, and leaves its signature out of the text', () => {
    const f = swarm()
    const pip = f.newAgent(owner, 'Pip')
    f.newAgent(mate, 'Devon')
    f.newAgent(owner, 'Mobile-Builder')
    const text = (extra: Record<string, unknown>) => f.run(relay(pip.chat, pip.agentId, extra)).messages.at(-1)!.text.split('\n').slice(0, 2)
    const wrote = (who: string) => `On GitHub, ${who} wrote on pull request acme/app#4:`
    // The new form, a role in brackets, and bold.
    expect(text({ text: 'Devon: Pip, the design is settled.' })).toEqual([wrote('Devon'), 'Pip, the design is settled.'])
    expect(text({ text: '**devon** (PM): Pip, read #12.' })).toEqual([wrote('Devon'), 'Pip, read #12.'])
    // The old forms, which stay on GitHub: an agent's with its clock, and Harness's to someone.
    expect(text({ text: 'Mobile Builder, 16:52: taken by Mobile Builder' })).toEqual([wrote('Mobile-Builder'), 'taken by Mobile Builder'])
    expect(text({ text: 'Harness, 17:15, to **Pip**: please read this pull request.' })).toEqual([wrote('Harness'), 'please read this pull request.'])
    expect(text({ text: 'Harness: Pip, this is yours. You can start now.' })).toEqual([wrote('Harness'), 'Pip, this is yours. You can start now.'])
    // A review and a line comment, the same way.
    expect(text({ event: 'review', verdict: 'APPROVED', url: 'https://github.com/acme/app/pull/4#pullrequestreview-7', text: 'Devon: READ-OK f6edb44' }))
      .toEqual(['On GitHub, Devon reviewed pull request acme/app#4: Approved', 'READ-OK f6edb44'])
    expect(text({ event: 'review-comment', path: 'a.py', line: 2, url: 'https://github.com/acme/app/pull/4#discussion_r5', text: 'Devon: Pip, off by one.' }))
      .toEqual(['On GitHub, Devon commented on a.py line 2 in pull request acme/app#4:', 'Pip, off by one.'])
    // No agent's name, a person addressing an agent, and a signature with nothing after it: the login, and the whole text.
    // Nor its own name first, which is someone addressing it: its own posts are never relayed to it.
    for (const whole of ['Note: Pip, both rows are in the sheet.', 'Juno: Pip, I am no agent of this Swarm.', 'Devon, can you ask Pip?', 'Devon (see above) Pip disagrees.', 'Devon:', 'Pip: add a test for day 0.']) {
      expect(text({ text: whole })).toEqual([wrote('deehw'), whole])
    }
  })

  it('says a newly labelled issue is a task for the agent, and names a review\'s verdict and a line comment\'s file', () => {
    const f = swarm()
    const pip = f.newAgent(owner, 'Pip')
    const text = (extra: Record<string, unknown>) => f.run(relay(pip.chat, pip.agentId, extra)).messages.at(-1)!.text
    expect(text({ event: 'task', on: 'issue', number: 13, url: 'https://github.com/acme/app/issues/13', text: 'Show the next few days\' quotes' }))
      .toBe('New task for you on GitHub: issue acme/app#13 Show the next few days\' quotes\nhttps://github.com/acme/app/issues/13')
    expect(text({ event: 'comment', on: 'issue', number: 12, url: 'https://github.com/acme/app/issues/12#issuecomment-9', text: 'Pip, which day?' }))
      .toBe('On GitHub, deehw wrote on issue acme/app#12:\nPip, which day?\nhttps://github.com/acme/app/issues/12#issuecomment-9')
    expect(text({ event: 'review', verdict: 'CHANGES_REQUESTED', url: 'https://github.com/acme/app/pull/4#pullrequestreview-7', text: 'Pip: add a test for day 0.' }))
      .toBe('On GitHub, deehw reviewed pull request acme/app#4: Changes requested\nPip: add a test for day 0.\nhttps://github.com/acme/app/pull/4#pullrequestreview-7')
    expect(text({ event: 'review-comment', path: 'sandbox/quotes.py', line: 12, url: 'https://github.com/acme/app/pull/4#discussion_r5', text: 'Pip, off by one here.' }))
      .toBe('On GitHub, deehw commented on sandbox/quotes.py line 12 in pull request acme/app#4:\nPip, off by one here.\nhttps://github.com/acme/app/pull/4#discussion_r5')
  })

  it('refuses a kind that does not hold together: a pull request\'s task, a review with no verdict, a line comment with no file', () => {
    const f = swarm()
    const pip = f.newAgent(owner, 'Pip')
    expect(() => f.run(relay(pip.chat, pip.agentId, { event: 'task', on: 'pull' }))).toThrow(SuperTabError)
    expect(() => f.run(relay(pip.chat, pip.agentId, { event: 'review' }))).toThrow(SuperTabError)
    expect(() => f.run(relay(pip.chat, pip.agentId, { event: 'review-comment' }))).toThrow(SuperTabError)
    expect(() => f.run(relay(pip.chat, pip.agentId, { verdict: 'APPROVED' }))).toThrow(SuperTabError)
  })

  it('writes the same row once when the relay arrives twice', () => {
    const f = swarm()
    const pip = f.newAgent(owner, 'Pip')
    const first = f.run(relay(pip.chat, pip.agentId), owner, { operationId: 'github-acme-app-1' }).messages.at(-1)!
    const again = f.run(relay(pip.chat, pip.agentId), owner, { operationId: 'github-acme-app-1' }).messages.at(-1)!
    expect(again.id).toBe(first.id)
  })

  it('refuses another person\'s chat or agent, an agent, a chat that is not a 1:1 chat and a link outside the repository', () => {
    const f = swarm()
    const pip = f.newAgent(owner, 'Pip'), juno = f.newAgent(mate, 'Juno')
    expect(() => f.run(relay(juno.chat, juno.agentId))).toThrow(SuperTabError)
    expect(() => f.run(relay(pip.chat, juno.agentId))).toThrow(SuperTabError)
    expect(() => f.run(relay('lead', pip.agentId))).toThrow(SuperTabError)
    expect(() => f.run(relay(pip.chat, pip.agentId), { kind: 'agent', agentId: pip.agentId, machineOwnerId: 'owner' })).toThrow(SuperTabError)
    expect(() => f.run(relay(pip.chat, pip.agentId, { url: 'https://evil.example/acme/app/pull/4' }))).toThrow(SuperTabError)
    expect(() => f.run(relay(pip.chat, pip.agentId, { url: 'https://github.com/acme/other/pull/4' }))).toThrow(SuperTabError)
  })

  it('takes only the repository\'s own people: a stranger\'s comment is no relay at all', () => {
    expect(commandSchema.safeParse(relay('chat', 'agent', { association: 'NONE' })).success).toBe(false)
    expect(commandSchema.safeParse(relay('chat', 'agent', { association: 'CONTRIBUTOR' })).success).toBe(false)
    expect(commandSchema.safeParse(relay('chat', 'agent', { text: 'x'.repeat(4_001) })).success).toBe(false)
    expect(commandSchema.safeParse(relay('chat', 'agent')).success).toBe(true)
  })
})
