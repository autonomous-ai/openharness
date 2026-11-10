import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor } from './model.js'
import { personView } from './profile.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const stranger: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'stranger', email: 'stranger@example.com' }
const NOW = Date.parse('2026-10-27T09:00:00.000Z')

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invite = (role: 'viewer' | 'collaborator' = 'collaborator') => {
    const invited = run({ type: 'invite.create', email: peer.email, role, conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  }
  const member = (id: string) => state.people.find(p => p.id === id)
  return { run, invite, member, get state() { return state } }
}

describe('what readers get of a person', () => {
  // Their name follows their account (personNames.ts nameFromAccount): the one they chose before is kept and read by nobody.
  it('leaves out the name a person chose before their name followed their account', () => {
    const f = fixture()
    f.invite()
    Object.assign(f.member('owner')!, { name: 'Ken Tran', chosenName: 'Ken (ops)', nameFollowsAccount: true })
    const seen = visibleState(f.state, peer).people.find(p => p.id === 'owner')!
    expect(seen.name).toBe('Ken Tran')
    expect(seen).not.toHaveProperty('chosenName')
    expect(seen).not.toHaveProperty('nameFollowsAccount')
  })

  it('copies nobody who has neither stored, as a read always gave them', () => {
    const plain = { id: 'a', email: 'a@example.com', role: 'owner' as const, generation: 'g', avatar: undefined }
    expect(personView(plain)).toBe(plain)
    const picture = { ...plain, avatar: { kind: 'preset' as const, key: 'owl' as const } }
    expect(personView(picture)).toEqual(picture)
  })
})

describe('avatars', () => {
  const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
  const upload = { kind: 'upload', key: 'avatars/tab/0123abcd/avatar' }
  const withPictures = () => {
    const f = fixture()
    f.invite()
    const add = (harnessId: string, contributor: Extract<Actor, { kind: 'person' }>, lead = false) =>
      f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId, name: harnessId, configuration: config, lead }, contributor,
        { contribution: { machineOwnerId: 'host-owner', contributorId: contributor.userId } }).result.agentId as string
    const lead = add('lead-h', owner, true), worker = add('worker-h', peer)
    // As the picture commands set them before 2026-11-09.
    Object.assign(f.member('owner')!, { avatar: upload })
    for (const id of [lead, worker]) Object.assign(f.state.agents.find(a => a.id === id)!, { avatar: { kind: 'preset', key: 'owl' } })
    const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
    const avatarOf = (id: string) => f.state.agents.find(a => a.id === id)!.avatar
    return Object.assign(f, { lead, worker, as, avatarOf })
  }

  // The pictures already set stay: readers learn there is one, its stored key stays on the server and a link comes only signed
  // (avatarLinks.ts), and only members read it.
  it('shows avatars to members only, an upload as no more than that there is one', () => {
    const f = withPictures()
    const seen = visibleState(f.state, peer)
    expect(seen.people.find(p => p.id === 'owner')!.avatar).toEqual({ kind: 'upload' })
    expect(seen.agents.find(a => a.id === f.worker)!.avatar).toEqual({ kind: 'preset', key: 'owl' })
    expect(() => visibleState(f.state, stranger)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })

})
