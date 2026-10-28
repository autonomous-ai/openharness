import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor } from './model.js'

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

describe('status line', () => {
  it('sets and clears the person’s own status', () => {
    const f = fixture()
    f.run({ type: 'member.status', status: { text: '  Out until 2pm ', emoji: '🌴', until: '2026-10-27T14:00:00.000Z' } })
    expect(f.member('owner')!.status).toEqual({ text: 'Out until 2pm', emoji: '🌴', until: '2026-10-27T14:00:00.000Z' })
    f.run({ type: 'member.status', status: { text: 'Focus' } })
    expect(f.member('owner')!.status).toEqual({ text: 'Focus', emoji: null, until: null })
    f.run({ type: 'member.status', status: null })
    expect(f.member('owner')!.status).toBeUndefined()
  })

  it('refuses a status that is too long, unprintable, already over or set as an agent', () => {
    const f = fixture()
    expect(() => f.run({ type: 'member.status', status: { text: 'x'.repeat(81) } })).toThrow()
    expect(() => f.run({ type: 'member.status', status: { text: 'Focus‮' } })).toThrow()
    expect(() => f.run({ type: 'member.status', status: { text: 'Lunch', emoji: '💣' } } as unknown as Command)).toThrow()
    expect(() => f.run({ type: 'member.status', status: { text: 'Lunch', until: '2026-10-27T08:59:59.000Z' } }))
      .toThrow(expect.objectContaining({ code: 'STATUS_EXPIRED' }))
    expect(() => f.run({ type: 'member.status', status: { text: 'Lunch' } }, { kind: 'agent', agentId: 'a1', machineOwnerId: 'owner' })).toThrow()
    expect(f.member('owner')!.status).toBeUndefined()
  })

  it('keeps a credential out of the status', () => {
    const f = fixture()
    const effects = f.run({ type: 'member.status', status: { text: 'key ghp_R4nd0mT0k3nV4lu3Xq9Lp2Zs8Wd5Yb7Hc1Jk6Mn' } })
    expect(f.member('owner')!.status!.text).not.toContain('ghp_R4nd0m')
    expect(effects.result.credentialsRemoved).toBeTruthy()
  })

  it('is refused for a viewer and read only by members', () => {
    const f = fixture()
    f.invite('viewer')
    expect(() => f.run({ type: 'member.status', status: { text: 'Coffee', emoji: '☕' } }, peer))
      .toThrow(expect.objectContaining({ code: 'READ_ONLY' }))
    f.run({ type: 'member.status', status: { text: 'Coffee', emoji: '☕' } })
    expect(visibleState(f.state, peer).people.find(p => p.id === 'owner')!.status!.text).toBe('Coffee')
    expect(() => visibleState(f.state, stranger)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })
})

describe('avatars', () => {
  const upload = { id: 'u1', key: 'avatars/tab/0123abcd/avatar' }
  const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
  const agentFixture = () => {
    const f = fixture()
    f.invite()
    const add = (harnessId: string, contributor: Extract<Actor, { kind: 'person' }>, lead = false) =>
      f.run({ type: 'agent.add', conversationId: 'lead', machineId: 'host', harnessId, name: harnessId, configuration: config, lead }, contributor,
        { contribution: { machineOwnerId: 'host-owner', contributorId: contributor.userId } }).result.agentId as string
    const lead = add('lead-h', owner, true)
    const worker = add('worker-h', peer)
    const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
    return Object.assign(f, { lead, worker, as })
  }

  it('lets a person pick a preset, use their upload, and clear it', () => {
    const f = fixture()
    f.run({ type: 'member.avatar', avatar: { kind: 'preset', key: 'fox' } })
    expect(f.member('owner')!.avatar).toEqual({ kind: 'preset', key: 'fox' })
    f.run({ type: 'member.avatar', avatar: { kind: 'upload', id: 'u1' } }, owner, { avatarUpload: upload })
    expect(f.member('owner')!.avatar).toEqual({ kind: 'upload', key: upload.key })
    f.run({ type: 'member.avatar', avatar: null })
    expect(f.member('owner')!.avatar).toBeUndefined()
  })

  it('refuses an upload the store did not find for this actor, and an unknown preset', () => {
    const f = fixture()
    expect(() => f.run({ type: 'member.avatar', avatar: { kind: 'upload', id: 'u1' } })).toThrow(expect.objectContaining({ code: 'AVATAR_UNAVAILABLE' }))
    expect(() => f.run({ type: 'member.avatar', avatar: { kind: 'preset', key: 'https://evil.example/x.png' } } as unknown as Command)).toThrow()
    expect(f.member('owner')!.avatar).toBeUndefined()
  })

  it('lets the project’s Lead or the agent’s contributor change an agent’s avatar, nobody else', () => {
    const f = agentFixture()
    const avatarOf = (id: string) => f.state.agents.find(a => a.id === id)!.avatar
    f.run({ type: 'agent.avatar', agentId: f.worker, avatar: { kind: 'preset', key: 'owl' } }, f.as(f.lead))
    expect(avatarOf(f.worker)).toEqual({ kind: 'preset', key: 'owl' })
    f.run({ type: 'agent.avatar', agentId: f.worker, avatar: { kind: 'upload', id: 'u1' } }, peer, { avatarUpload: upload })
    expect(avatarOf(f.worker)).toEqual({ kind: 'upload', key: upload.key })
    expect(() => f.run({ type: 'agent.avatar', agentId: f.lead, avatar: { kind: 'preset', key: 'cat' } }, peer))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => f.run({ type: 'agent.avatar', agentId: f.worker, avatar: { kind: 'preset', key: 'cat' } }, f.as(f.worker)))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    f.run({ type: 'agent.avatar', agentId: f.worker, avatar: null }, f.as(f.lead))
    expect(avatarOf(f.worker)).toBeUndefined()
  })

  it('shows avatars to members only', () => {
    const f = agentFixture()
    f.run({ type: 'member.avatar', avatar: { kind: 'upload', id: 'u1' } }, owner, { avatarUpload: upload })
    f.run({ type: 'agent.avatar', agentId: f.worker, avatar: { kind: 'upload', id: 'u1' } }, peer, { avatarUpload: upload })
    const seen = visibleState(f.state, peer)
    // Readers learn there is a picture; its stored key stays on the server, and a link comes only signed (avatarLinks.ts).
    expect(seen.people.find(p => p.id === 'owner')!.avatar).toEqual({ kind: 'upload' })
    expect(seen.agents.find(a => a.id === f.worker)!.avatar).toEqual({ kind: 'upload' })
    expect(() => visibleState(f.state, stranger)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })
})
