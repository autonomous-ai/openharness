import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type Author, type Person } from './model.js'
import { split } from './parts/shape.js'
import { readerView } from './read/views.js'
import { actorName } from './activity.js'
import { authorForAgent, lazyUsernames, nameFromAccount, namesPerson, nameRefusal, rowForAgent, shownNameOf, writtenNameOf } from './personNames.js'
import { swarmUsernames, usernameOf } from './usernames.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'Ken15@autonomous.ai' }
const NOW = Date.parse('2026-11-03T10:00:00.000Z')
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const person = (id: string, email: string) => ({ kind: 'person', userId: id, email }) as Extract<Actor, { kind: 'person' }>
const relay = person('relay', 'wkpnjjhbnm@privaterelay.appleid.com')
const peer = person('peer', 'dee@autonomous.ai')

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const join = (who: Extract<Actor, { kind: 'person' }>, role: 'viewer' | 'collaborator' = 'collaborator') => {
    const invited = run({ type: 'invite.create', email: who.email, role, conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, who)
  }
  join(relay)
  join(peer)
  const name = (id: string) => state.people.find(p => p.id === id)!.name
  const shown = (id: string) => shownNameOf(state, id)
  // No command sets a name or a username any more (2026-11-09): people who set one before still have it stored, so these
  // tests store it as it was.
  const setName = (value: string | null, id = 'relay') => {
    const stored = state.people.find(p => p.id === id)!
    if (value === null) delete stored.name
    else stored.name = value
  }
  const setUsername = (value: string, id = 'relay') => { state.people.find(p => p.id === id)!.username = value }
  return { run, join, name, shown, setName, setUsername, get state() { return state } }
}

describe('the name a person set', () => {
  it('shows the username until a person sets a name, and again once they clear it', () => {
    const f = fixture()
    expect(f.shown('relay')).toBe('wkpnjjhbnm')
    f.setName('Minh Nguyen')
    expect(f.name('relay')).toBe('Minh Nguyen')
    expect(f.shown('relay')).toBe('Minh Nguyen')
    f.setName(null)
    expect(f.name('relay')).toBeUndefined()
    expect(f.shown('relay')).toBe('wkpnjjhbnm')
  })

  // Activity and reminders name a person through actorName: the stored name first, else the username (end to end, an integration
  // test set the name with the command that is gone).
  it('is the name Activity and reminders show for a person', () => {
    const f = fixture()
    expect(actorName(f.state, 'person', 'relay')).toBe('wkpnjjhbnm')
    f.setName('Minh Nguyen')
    expect(actorName(f.state, 'person', 'relay')).toBe('Minh Nguyen')
    expect(actorName(f.state, 'person', 'gone')).toBe('Someone')
  })

  it('reaches members with the rest of the person, and only members', () => {
    const f = fixture()
    f.setName('Minh Nguyen')
    const view = readerView(split(f.state, { tabId: 'tab', version: 1, now: NOW }), peer, NOW, {})
    expect(view.parts.members.find(m => m.key === 'relay')!.data.name).toBe('Minh Nguyen')
    expect(visibleState(f.state, peer, NOW).people.find(p => p.id === 'relay')!.name).toBe('Minh Nguyen')
    expect(() => visibleState(f.state, person('stranger', 'stranger@example.com'), NOW)).toThrow()
  })

  // The account name and an agent's name refuse what a Swarm name did (nameRefusal), so these stay.
  it('refuses a role’s or the Swarm’s own name, numbered too (review 1 of #2794)', () => {
    for (const name of ['Product Manager', 'PM', 'pm 2', 'Lead', 'Engineer', 'Reviewer', 'Tester', 'Harness', 'System', 'Admin',
      'Everyone', 'Swarm', 'You', 'Someone']) {
      expect(nameRefusal(name), name).toMatchObject({ code: 'NAME_RESERVED' })
    }
    // Width variants too, as every name compare reads them (review 2 of #2794).
    for (const name of ['ＰＭ', 'Ｌｅａｄ', 'ｓｙｓｔｅｍ']) expect(nameRefusal(name), name).toMatchObject({ code: 'NAME_RESERVED' })
    expect(nameRefusal('Leading Light')).toBeNull()
  })

  it('numbers a later joiner’s default around a name someone set, never the person’s own (review 1 of #2794)', () => {
    const f = fixture()
    f.setName('Bob')
    f.join(person('bob', 'bob@example.com'))
    expect(usernameOf(f.state, 'bob')).toBe('bob2')
    // One's own name never moves one's own default.
    f.setName('WKPNJJHBNM')
    expect(usernameOf(f.state, 'relay')).toBe('wkpnjjhbnm')
  })

  it('refuses a web address as a name, which server lines would show as a link (review 2 of #2794)', () => {
    for (const name of ['https://ev.il/x', 'ev.il://x', 'www.ev.il', 'WWW.EV.IL', '//ev.il', '[Ken](//ev.il)']) {
      expect(nameRefusal(name), name).toMatchObject({ code: 'INVALID_NAME' })
    }
  })

  it('writes a name into server-written text as plain words, never Markdown (review 1 of #2794)', () => {
    const f = fixture()
    f.setName('[Ken](ev.il/x) *x*')
    expect(writtenNameOf(f.state, 'relay')).toBe('\\[Ken\\]\\(ev.il/x\\) \\*x\\*')
    f.setName('1. Minh')
    expect(writtenNameOf(f.state, 'relay')).toBe('1\\. Minh')
    // A username is written as it is today.
    expect(writtenNameOf(f.state, 'peer')).toBe('dee')
  })
})

// Task #2954 (Ken, 11-04): a person's message is stored with their email as its author's name, and agents copied it into
// commands and pull request bodies until a machine's privacy hook stopped their sessions. An agent reads names instead.
// anh Dee, 2026-11-10: with no editor left, a person's name in a Swarm follows their account's.
describe('a name that follows the account', () => {
  const someone = (): Person => ({ id: 'p1', email: 'minh@example.com', role: 'collaborator', generation: 'g' })

  it('takes the account name, keeps a name chosen here before out of sight, and keeps it only once', () => {
    const chose: Person = { ...someone(), name: 'Minh (design)' }
    expect(nameFromAccount(chose, ' Minh Nguyen ')).toBe(true)
    expect(chose).toMatchObject({ name: 'Minh Nguyen', chosenName: 'Minh (design)', nameFollowsAccount: true })
    expect(nameFromAccount(chose, 'Minh Tran')).toBe(true)
    expect(chose).toMatchObject({ name: 'Minh Tran', chosenName: 'Minh (design)' })
    expect(nameFromAccount(chose, 'Minh Tran')).toBe(false)
  })

  it('shows the username when the account has no name, and keeps no chosen name where there was none', () => {
    const plain = someone()
    expect(nameFromAccount(plain, null)).toBe(true)
    expect(plain).toEqual({ ...someone(), nameFollowsAccount: true })
    expect(nameFromAccount(plain, '  ')).toBe(false)
    const named: Person = { ...someone(), name: 'Minh' }
    nameFromAccount(named, null)
    expect(named).not.toHaveProperty('name')
    expect(named.chosenName).toBe('Minh')
  })

  it('names them so everywhere the Swarm shows them, and an agent reads it', () => {
    const f = fixture()
    const stored = f.state.people.find(p => p.id === 'peer')!
    nameFromAccount(stored, 'Dee Ho')
    expect(f.shown('peer')).toBe('Dee Ho')
    expect(writtenNameOf(f.state, 'peer')).toBe('Dee Ho')
    const author: Author = { kind: 'person', id: 'peer', name: 'dee@autonomous.ai', membershipGeneration: 'g' }
    expect(authorForAgent(f.state, author, lazyUsernames(f.state)).displayName).toBe('Dee Ho')
  })

  it('takes the account name when an invitation is accepted', () => {
    const f = fixture()
    const newcomer = person('newcomer', 'nam@example.com')
    const invited = f.run({ type: 'invite.create', email: newcomer.email, role: 'collaborator', conversationId: 'lead' })
    f.run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, newcomer, { accountName: 'Nam Le' })
    expect(f.shown('newcomer')).toBe('Nam Le')
  })
})

describe('a person author as an agent reads it', () => {
  const stored = (id: string, email: string) => ({ kind: 'person' as const, id, name: email, membershipGeneration: 'g' })

  it('names them by username and the name they show, never by email', () => {
    const f = fixture()
    f.setName('Minh Nguyen')
    const names = swarmUsernames(f.state)
    expect(authorForAgent(f.state, stored('relay', relay.email), names))
      .toEqual({ kind: 'person', id: 'relay', name: 'wkpnjjhbnm', displayName: 'Minh Nguyen', membershipGeneration: 'g' })
    expect(authorForAgent(f.state, stored('peer', peer.email), names))
      .toEqual({ kind: 'person', id: 'peer', name: 'dee', displayName: 'dee', membershipGeneration: 'g' })
  })

  // A stored name may be the person's own email, which the old name editor allowed: an agent still never reads it.
  it('names a person whose name is their own email by username', () => {
    const f = fixture()
    f.setName(relay.email)
    expect(authorForAgent(f.state, stored('relay', relay.email), swarmUsernames(f.state)))
      .toEqual({ kind: 'person', id: 'relay', name: 'wkpnjjhbnm', displayName: 'wkpnjjhbnm', membershipGeneration: 'g' })
    // Or holds it among other words (review of #2954).
    f.setName(`Minh ${relay.email}`)
    expect(authorForAgent(f.state, stored('relay', relay.email), swarmUsernames(f.state))).toMatchObject({ displayName: 'wkpnjjhbnm' })
  })

  it('reads every username as swarmUsernames gives it, working them out only for one not stored', () => {
    const f = fixture()
    f.setUsername('minh')
    const lazy = lazyUsernames(f.state), all = swarmUsernames(f.state)
    for (const p of f.state.people) expect(lazy.get(p.id), p.id).toBe(all.get(p.id))
    expect(lazy.get('gone')).toBeUndefined()
  })

  it('names someone who left as a person, and leaves an agent author as it is', () => {
    const f = fixture()
    const names = swarmUsernames(f.state)
    const gone = authorForAgent(f.state, stored('gone', 'gone@example.com'), names)
    expect(gone).toEqual({ kind: 'person', id: 'gone', name: 'a person', displayName: 'a person', membershipGeneration: 'g' })
    expect(JSON.stringify(gone)).not.toContain('@')
    const agent = { kind: 'agent' as const, id: 'a1', name: 'Lead', displayName: 'River', membershipGeneration: 'g' }
    expect(authorForAgent(f.state, agent, names)).toBe(agent)
  })

  it('names the person who typed into an agent\'s terminal by name too, in a row an agent reads', () => {
    const f = fixture()
    const names = swarmUsernames(f.state)
    const agent = { kind: 'agent' as const, id: 'a1', name: 'Builder', displayName: 'Robin', membershipGeneration: 'g' }
    const native = { id: 'm1', author: agent, text: 'npm test', source: { kind: 'native', phase: 'input', operator: stored('peer', peer.email) } }
    expect(namesPerson(native)).toBe(true)
    const read = rowForAgent(f.state, names, native)
    expect(read).toEqual({ ...native, source: { kind: 'native', phase: 'input', operator: { kind: 'person', id: 'peer', name: 'dee', displayName: 'dee', membershipGeneration: 'g' } } })
    expect(JSON.stringify(read)).not.toContain('@')
    const plain = { id: 'm2', author: agent, text: 'Done.', source: null }
    expect(namesPerson(plain)).toBe(false)
    expect(rowForAgent(f.state, names, plain)).toEqual(plain)
  })
})
