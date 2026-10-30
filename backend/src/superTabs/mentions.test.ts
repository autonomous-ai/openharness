import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { MAX_MENTIONS, tagTokens } from './mentions.js'
import { createSuperTab, type Actor } from './model.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const third: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'third', email: 'third@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let next = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: { machineOwnerId: 'owner', contributorId: actor.kind === 'person' ? actor.userId : 'owner' }, ...context })
    state = effects.state
    return effects
  }
  for (const who of [peer, third]) {
    const invited = run({ type: 'invite.create', email: who.email, role: 'collaborator', conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, who)
  }
  const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const lead = run({ type: 'agent.add', conversationId: app.conversationId, harnessId: 'lead', machineId: 'machine', name: 'Lead', lead: true,
    configuration }).result.agentId as string
  const worker = run({ type: 'agent.add', conversationId: app.conversationId, harnessId: 'worker', machineId: 'machine', name: 'Worker', lead: false,
    configuration }).result.agentId as string
  const group = run({ type: 'conversation.create', projectId: app.projectId, title: 'Copy', brief: '', checks: [] }).result.conversationId as string
  // A conversation only `peer` reads: their chat with their Buddy.
  const pmChat = run({ type: 'buddy.chat', projectId: app.projectId }, peer).result.conversationId as string
  const send = (conversationId: string, mentions: string[], actor: Actor = owner) => run({ type: 'message.send', conversationId,
    text: 'Please look.', replyTo: null, recipientIds: [], mentions }, actor).messages.at(-1)!
  /** A post that tags only by what its text says, as people type in chat. */
  const say = (conversationId: string, text: string, actor: Actor = owner, mentions?: string[]) => run({ type: 'message.send', conversationId,
    text, replyTo: null, recipientIds: [], ...(mentions ? { mentions } : {}) }, actor).messages.at(-1)!
  return { run, send, say, app, lead, worker, group, pmChat, get state() { return state } }
}

describe('people tagging people', () => {
  it('tags a person who can read the conversation', () => {
    const f = fixture()
    expect(f.send(f.group, ['peer', 'third']).mentions).toEqual(['peer', 'third'])
    expect(f.send(f.group, ['owner'], peer).mentions).toEqual(['owner'])
  })

  it('drops the author’s own tag', () => {
    const f = fixture()
    expect(f.send(f.group, ['owner', 'peer']).mentions).toEqual(['peer'])
  })

  it('refuses a tag of someone who cannot read the conversation, or is not in the Swarm', () => {
    const f = fixture()
    expect(() => f.send(f.pmChat, ['third'], peer)).toThrow(expect.objectContaining({ code: 'INVALID_MENTION' }))
    expect(() => f.send(f.group, ['stranger'])).toThrow(expect.objectContaining({ code: 'INVALID_MENTION' }))
  })

  it('refuses tags in the Leads conversation', () => {
    const f = fixture()
    const leads = f.state.leadsConversationId!
    expect(() => f.send(leads, ['peer'])).toThrow(expect.objectContaining({ code: 'MENTION_FORBIDDEN' }))
  })

  it('still lets only a project’s Lead among agents tag people', () => {
    const f = fixture()
    expect(() => f.send(f.app.conversationId, ['peer'], { kind: 'agent', agentId: f.worker, machineOwnerId: 'owner' }))
      .toThrow(expect.objectContaining({ code: 'MENTION_FORBIDDEN' }))
  })
})

const shared = JSON.parse(readFileSync(new URL('./tagFixture.json', import.meta.url), 'utf8')) as { cases: Array<{ text: string; tags: string[] }> }

describe('tags in the text', () => {
  it.each(shared.cases)('finds the tags in $text', ({ text, tags }) => {
    expect(tagTokens(text)).toEqual(tags)
  })

  it('reads a 32,000-character text of unclosed link brackets in linear time', () => {
    // Each `](` without a `)` once scanned to the end: about 200 ms per send at the limit.
    const started = performance.now()
    expect(tagTokens(`${']('.repeat(15_995)}@dee.`)).toEqual(['dee'])
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('tags each person the text names, by username in any case or by full address', () => {
    const f = fixture()
    const said = f.say(f.group, '@peer can you free some memory? @Third.')
    expect(said.mentions).toEqual(['peer', 'third'])
    expect(said.text).toBe('@peer can you free some memory? @Third.')
    expect(f.say(f.group, 'Ask @peer@example.com today').mentions).toEqual(['peer'])
  })

  it('never tags a name in code, a link or an email address', () => {
    const f = fixture()
    for (const text of ['run `@peer` here', '```\n@peer\n```', 'mail peer@example.com', 'see https://example.com/@peer']) {
      expect(f.say(f.group, text).mentions ?? [], text).toEqual([])
    }
  })

  it('leaves an unknown name, or a person who cannot read the chat, as plain text without an error', () => {
    const f = fixture()
    const outsider = f.say(f.pmChat, '@third and @nobody, look', peer)
    expect(outsider.mentions ?? []).toEqual([])
    expect(outsider.text).toBe('@third and @nobody, look')
  })

  it('drops the author naming themselves', () => {
    const f = fixture()
    expect(f.say(f.group, '@owner and @peer').mentions).toEqual(['peer'])
  })

  it('tags from a Lead’s text in its own project, and from no other agent', () => {
    const f = fixture()
    const lead = { kind: 'agent' as const, agentId: f.lead, machineOwnerId: 'owner' }
    expect(f.say(f.app.conversationId, '@peer please confirm', lead).mentions).toEqual(['peer'])
    const worker = f.say(f.app.conversationId, '@peer please confirm', { kind: 'agent', agentId: f.worker, machineOwnerId: 'owner' })
    expect(worker.mentions ?? []).toEqual([])
    expect(worker.text).toBe('@peer please confirm')
  })

  it('tags nobody from the text of a Leads conversation post or an agent-only notice', () => {
    const f = fixture()
    expect(f.say(f.state.leadsConversationId!, '@peer look').mentions ?? []).toEqual([])
    const notice = f.run({ type: 'message.send', conversationId: f.app.conversationId, text: '@peer is away', replyTo: null,
      recipientIds: [f.lead], agentOnly: true }, { kind: 'agent', agentId: f.lead, machineOwnerId: 'owner' }).messages.at(-1)!
    expect(notice.mentions ?? []).toEqual([])
  })

  it('keeps at most MAX_MENTIONS tags, the picked ones first', () => {
    const f = fixture()
    for (const name of ['p4', 'p5', 'p6', 'p7']) {
      const invited = f.run({ type: 'invite.create', email: `${name}@example.com`, role: 'collaborator', conversationId: 'lead' })
      f.run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, { kind: 'person', userId: name, email: `${name}@example.com` })
    }
    const many = f.say(f.group, '@p4 @p5 @p6 @p7 @third', owner, ['peer'])
    expect(many.mentions).toEqual(['peer', 'p4', 'p5', 'p6', 'p7'].slice(0, MAX_MENTIONS))
  })
})

describe('a picked tag the text does not say', () => {
  it('opens the first line of the stored text, once', () => {
    const f = fixture()
    const sent = f.send(f.group, ['peer', 'third'])
    expect(sent.text).toBe('@peer @third Please look.')
    expect(sent.mentions).toEqual(['peer', 'third'])
  })

  it('gets a line of its own when the text opens with a block', () => {
    const f = fixture()
    expect(f.say(f.group, '- one\n- two', owner, ['peer']).text).toBe('@peer\n\n- one\n- two')
    expect(f.say(f.group, '\n\nShipped:\n- Desktop', owner, ['peer']).text).toBe('@peer Shipped:\n- Desktop')
  })

  it('is not added again when the text already names them, in any case, with a dot or by address', () => {
    const f = fixture()
    for (const text of ['Ask @Peer.', 'cc @peer@example.com', '@peer: done']) {
      expect(f.say(f.group, text, owner, ['peer']).text).toBe(text)
    }
    // A name inside code is not a tag, so the tag still opens the line.
    expect(f.say(f.group, 'run `@peer`', owner, ['peer']).text).toBe('@peer run `@peer`')
  })

  it('is written the same way when the command is retried', () => {
    const command = { type: 'message.send' as const, conversationId: '', text: 'Please look.', replyTo: null, recipientIds: [], mentions: ['peer'] }
    const first = fixture(), again = fixture()
    expect(first.run({ ...command, conversationId: first.group }).messages.at(-1)!.text)
      .toBe(again.run({ ...command, conversationId: again.group }).messages.at(-1)!.text)
    // A client that sends back the text the server wrote does not get the tag twice.
    expect(first.say(first.group, '@peer Please look.', owner, ['peer']).text).toBe('@peer Please look.')
  })

  it('is the whole text of a post that is only files', () => {
    const f = fixture()
    const sent = f.run({ type: 'message.send', conversationId: f.group, text: '', replyTo: null, recipientIds: [], mentions: ['peer'],
      attachmentIds: ['file'] }, owner, { attachments: [{ id: 'file', name: 'a.png', url: 'https://cdn.example.com/a.png', size: 1, mime: 'image/png' }] }).messages.at(-1)!
    expect(sent.text).toBe('@peer')
  })
})
