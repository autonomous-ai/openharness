import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor } from './model.js'
import { split } from './parts/shape.js'
import { personView } from './profile.js'
import { readerView } from './read/views.js'

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
  // Swarms from before v4 hold a status and a time zone that nothing sets any more and no app draws (2026-11-09): a status with
  // no end would haunt an older app for ever, so readers get neither, though they stay stored.
  it('leaves out the status and time zone a person stored, keeps their avatar, and reads the same for a member part', () => {
    const f = fixture()
    f.invite()
    Object.assign(f.member('owner')!, { status: { text: 'Out', emoji: '🌴', until: null }, timeZone: 'Asia/Ho_Chi_Minh',
      avatar: { kind: 'preset', key: 'fox' } })
    const seen = visibleState(f.state, peer).people.find(p => p.id === 'owner')!
    expect(seen).not.toHaveProperty('status')
    expect(seen).not.toHaveProperty('timeZone')
    expect(seen.avatar).toEqual({ kind: 'preset', key: 'fox' })
    const part = readerView(split(f.state, { tabId: 'tab', version: 1, now: NOW }), peer, NOW, {}).parts.members.find(m => m.key === 'owner')!
    expect(part.data).not.toHaveProperty('status')
    expect(part.data).not.toHaveProperty('timeZone')
    expect(part.data.avatar).toEqual({ kind: 'preset', key: 'fox' })
    expect(f.member('owner')).toHaveProperty('status')
    expect(() => visibleState(f.state, stranger)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })

  it('copies nobody who has neither stored, as a read always gave them', () => {
    const plain = { id: 'a', email: 'a@example.com', role: 'owner' as const, generation: 'g', avatar: undefined }
    expect(personView(plain)).toBe(plain)
    const picture = { ...plain, avatar: { kind: 'preset' as const, key: 'owl' as const } }
    expect(personView(picture)).toEqual(picture)
    const stored: typeof plain & { status?: unknown; timeZone?: unknown } = { ...plain, status: { text: 'Out' }, timeZone: 'UTC' }
    expect(personView(stored)).toEqual(plain)
  })
})

describe('avatars', () => {
  const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
  // The pictures already set stay: readers learn there is one, its stored key stays on the server and a link comes only signed
  // (avatarLinks.ts), and only members read it. Nothing sets one any more (2026-11-09).
  it('shows avatars to members only, an upload as no more than that there is one', () => {
    const f = fixture()
    f.invite()
    const worker = f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId: 'worker-h', name: 'worker-h', configuration: config, lead: false },
      peer, { contribution: { machineOwnerId: 'host-owner', contributorId: peer.userId } }).result.agentId as string
    const upload = { kind: 'upload', key: 'avatars/tab/0123abcd/avatar' }
    Object.assign(f.member('owner')!, { avatar: upload })
    Object.assign(f.state.agents.find(a => a.id === worker)!, { avatar: upload })
    const seen = visibleState(f.state, peer)
    expect(seen.people.find(p => p.id === 'owner')!.avatar).toEqual({ kind: 'upload' })
    expect(seen.agents.find(a => a.id === worker)!.avatar).toEqual({ kind: 'upload' })
    expect(() => visibleState(f.state, stranger)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })
})
