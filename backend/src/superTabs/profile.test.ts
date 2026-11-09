import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor } from './model.js'
import { split } from './parts/shape.js'
import { setAgentAvatar } from './profile.js'
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
    const part = readerView(split(f.state, { tabId: 'tab', version: 1, now: NOW }), peer, NOW, { teamMachines: [] }).parts.members.find(m => m.key === 'owner')!
    expect(part.data).not.toHaveProperty('status')
    expect(part.data).not.toHaveProperty('timeZone')
    expect(part.data.avatar).toEqual({ kind: 'preset', key: 'fox' })
    expect(f.member('owner')).toHaveProperty('status')
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

  it('lets the project’s Lead or the agent’s contributor change an agent’s avatar, and no other person', () => {
    const f = agentFixture()
    const avatarOf = (id: string) => f.state.agents.find(a => a.id === id)!.avatar
    f.run({ type: 'agent.avatar', agentId: f.worker, avatar: { kind: 'preset', key: 'owl' } }, f.as(f.lead))
    expect(avatarOf(f.worker)).toEqual({ kind: 'preset', key: 'owl' })
    f.run({ type: 'agent.avatar', agentId: f.worker, avatar: { kind: 'upload', id: 'u1' } }, peer, { avatarUpload: upload })
    expect(avatarOf(f.worker)).toEqual({ kind: 'upload', key: upload.key })
    expect(() => f.run({ type: 'agent.avatar', agentId: f.lead, avatar: { kind: 'preset', key: 'cat' } }, peer))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    f.run({ type: 'agent.avatar', agentId: f.worker, avatar: null }, f.as(f.lead))
    expect(avatarOf(f.worker)).toBeUndefined()
  })

  // Naming and picturing the project's agents is workflow (project instructions, phase 4), never another project's.
  it('lets any agent of the project set an agent\'s avatar', () => {
    const f = agentFixture()
    const avatarOf = (id: string) => f.state.agents.find(a => a.id === id)!.avatar
    f.run({ type: 'agent.avatar', agentId: f.lead, avatar: { kind: 'preset', key: 'owl' } }, f.as(f.worker))
    expect(avatarOf(f.lead)).toEqual({ kind: 'preset', key: 'owl' })
    f.run({ type: 'agent.avatar', agentId: f.worker, avatar: { kind: 'preset', key: 'cat' } }, f.as(f.worker))
    expect(avatarOf(f.worker)).toEqual({ kind: 'preset', key: 'cat' })
    const other = f.run({ type: 'project.create', name: 'Other', visibility: 'public', brief: '' }).result.conversationId as string
    const outsider = f.run({ type: 'agent.add', conversationId: other, machineId: 'host', harnessId: 'outsider', name: 'outsider', configuration: config, lead: false },
      owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
    expect(() => setAgentAvatar(f.state, f.as(outsider), f.worker, { kind: 'preset', key: 'fox' }, undefined))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => f.run({ type: 'agent.avatar', agentId: f.worker, avatar: { kind: 'preset', key: 'fox' } }, f.as(outsider))).toThrow()
    expect(avatarOf(f.worker)).toEqual({ kind: 'preset', key: 'cat' })
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
