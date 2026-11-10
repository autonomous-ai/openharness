import { numberMessages } from './parts/commit.js'
import { describe, expect, it } from 'vitest'
import { createSuperTab, visibleState, type Agent } from './model.js'
import { openSwarmBuddyChat } from './buddies.js'
import { projectsOf } from './projects.js'
import { machine, NOW, config } from './crewKeep.test-support.js'
import { buddySleepCandidates, buddySleepManaged, sleepBuddies } from './buddySleep.js'

// #3824: dropping any check below could close a busy Buddy, an unswitched project's Buddy, or the wrong membership's.
function fixture() {
  const state = createSuperTab('tab', 'Work', { id: 'owner', email: 'owner@example.test' }, 'prod')
  state.projects = projectsOf(state).map(p => ({ ...p, boardMode: true }))
  const owner = state.people[0]!
  const chat = openSwarmBuddyChat(state, owner)
  chat.lastActivityAt = new Date(NOW - 3_600_000).toISOString()
  const buddy: Agent = { id: 'buddy', name: 'Code', machineId: 'mac', machineOwnerId: owner.id, contributorId: owner.id,
    membershipGeneration: owner.generation, hostGrant: null, harnessId: 'buddy-h', configuration: config,
    buddyOf: { personId: owner.id, generation: owner.generation }, buddyScope: 'swarm',
    startedSession: { creationId: 'created', sessionId: 'session', createdAt: new Date(NOW - 7_200_000).toISOString() } }
  state.agents.push(buddy)
  chat.agentIds.push(buddy.id)
  state.machines = [machine('mac')]
  const pool = state.machines[0]!
  pool.membershipGeneration = owner.generation
  Object.assign(pool.observation!, { runningHarnessIds: ['buddy-h'], idleBuddyHarnessIds: ['buddy-h'] })
  return { state, buddy, chat, pool, owner }
}

describe('server-owned Buddy sleep', () => {
  it.each(['requested', 'landed'])('does not sleep during a %s engine switch', phase => {
    const f = fixture()
    if (phase === 'requested') f.buddy.switchRequest = { id: 'switch', engine: 'codex', profileId: 'default', requestedBy: 'owner', at: new Date(NOW).toISOString() }
    else f.buddy.switchLanded = { id: 'switch', requestedBy: 'owner' }
    expect(buddySleepCandidates(f.state, NOW)).toEqual([])
  })

  it('keeps private engine-idle proof out of member reads', () => {
    const f = fixture()
    const visible = visibleState(f.state, { kind: 'person', userId: f.owner.id, email: f.owner.email }, NOW)
    expect(visible.machines![0]!.observation).not.toHaveProperty('idleBuddyHarnessIds')
  })

  it('sleeps at one idle hour, once, and preserves identity and the session', () => {
    const f = fixture()
    expect(buddySleepCandidates(f.state, NOW - 1)).toEqual([])
    const candidates = buddySleepCandidates(f.state, NOW)
    expect(candidates.map(a => a.id)).toEqual(['buddy'])
    sleepBuddies(f.state, candidates, new Set(), NOW)
    expect(f.buddy).toMatchObject({ asleep: { since: NOW }, harnessId: 'buddy-h', buddyOf: { personId: 'owner', generation: f.owner.generation } })
    expect(buddySleepCandidates(f.state, NOW + 1)).toEqual([])
  })

  it.each(['queued', 'claimed', 'uncertain'])('a %s delivery prevents sleep', () => {
    const f = fixture()
    sleepBuddies(f.state, buddySleepCandidates(f.state, NOW), new Set(['buddy']), NOW)
    expect(f.buddy.asleep).toBeUndefined()
  })

  it.each(['unknown', 'working', 'stale', 'not-running'])('a %s engine reading is no idle proof', which => {
    const f = fixture()
    if (which === 'unknown') delete (f.pool.observation as unknown as { idleBuddyHarnessIds?: string[] }).idleBuddyHarnessIds
    if (which === 'working') Object.assign(f.pool.observation!, { idleBuddyHarnessIds: [] })
    if (which === 'stale') f.pool.observation!.receivedAt = NOW - 45_001
    if (which === 'not-running') f.pool.observation!.runningHarnessIds = []
    expect(buddySleepCandidates(f.state, NOW)).toEqual([])
  })

  it('does not sleep during active work or a model switch', () => {
    const f = fixture()
    Object.assign(f.chat, { assignment: { agentId: 'buddy', status: 'working' } })
    expect(buddySleepCandidates(f.state, NOW)).toEqual([])
    f.chat.assignment = null
    f.buddy.modelRequest = { id: 'request' } as NonNullable<Agent['modelRequest']>
    expect(buddySleepCandidates(f.state, NOW)).toEqual([])
  })

  it('leaves an unswitched project and a Swarm Buddy reading mixed projects unchanged', () => {
    const f = fixture()
    delete f.state.projects![0]!.boardMode
    expect(buddySleepManaged(f.state, f.buddy)).toBe(false)
    expect(buddySleepCandidates(f.state, NOW)).toEqual([])
    f.state.projects![0]!.boardMode = true
    f.state.projects!.push({ ...f.state.projects![0]!, id: 'other', boardMode: undefined })
    expect(buddySleepManaged(f.state, f.buddy)).toBe(false)
  })

  it('keeps a sleeping Buddy managed through switch-back and the ensuing wake', () => {
    const f = fixture()
    f.buddy.asleep = { since: NOW - 1_000 }
    delete f.state.projects![0]!.boardMode
    expect(buddySleepManaged(f.state, f.buddy)).toBe(true)
    numberMessages(f.state, [{ id: 'wake', conversationId: f.chat.id, replyTo: null, text: 'Continue', recipients: ['buddy'],
      author: { kind: 'person', id: f.owner.id, name: f.owner.email, membershipGeneration: f.owner.generation } }], NOW)
    expect(f.buddy.asleep).toBeUndefined()
    expect(buddySleepManaged(f.state, f.buddy)).toBe(true)
    delete f.buddy.crewWaking
    expect(buddySleepManaged(f.state, f.buddy)).toBe(false)
  })

  it.each(['old-membership', 'session', 'stopping'])('never sleeps a %s Buddy', which => {
    const f = fixture()
    if (which === 'old-membership') f.buddy.buddyOf!.generation = 'old'
    if (which === 'session') f.buddy.buddySession = { thread: 'thread', from: 0 }
    if (which === 'stopping') f.buddy.workDecision = 'stop'
    expect(buddySleepManaged(f.state, f.buddy)).toBe(false)
    expect(buddySleepCandidates(f.state, NOW)).toEqual([])
  })
})


describe('authorized input wakes the same Buddy', () => {
  it.each(['person', 'proposal-question'])('wakes only the intended Buddy for %s input before agent-only filtering', kind => {
    const f = fixture()
    f.buddy.asleep = { since: NOW - 1_000 }
    const other = { ...structuredClone(f.buddy), id: 'other', harnessId: 'other-h' }
    f.state.agents.push(other)
    const own = kind === 'person'
    const message = { id: 'input', conversationId: own ? f.chat.id : 'lead', replyTo: null,
      author: { kind: 'person' as const, id: f.owner.id, name: f.owner.email, membershipGeneration: f.owner.generation },
      recipients: own ? ['buddy'] : [], ...own ? {} : { buddyRecipients: ['buddy'], source: { kind: 'agent-only' } }, text: 'Please answer' }
    numberMessages(f.state, [message], NOW)
    expect(f.buddy.asleep).toBeUndefined()
    expect(f.buddy).toMatchObject({ keptAt: NOW, downSince: new Date(NOW).toISOString(), crewWaking: { at: NOW, conversationId: message.conversationId },
      harnessId: 'buddy-h', buddyOf: { personId: f.owner.id, generation: f.owner.generation } })
    expect(other.asleep).toEqual({ since: NOW - 1_000 })
    numberMessages(f.state, [{ ...message, id: 'second' }], NOW + 1)
    expect(f.buddy.crewWaking!.at).toBe(NOW)
    expect(buddySleepCandidates(f.state, NOW + 3_599_999)).toEqual([])
  })

  it.each(['stale-person', 'private-chat'])('does not wake for %s input it cannot read', kind => {
    const f = fixture()
    f.buddy.asleep = { since: NOW - 1_000 }
    if (kind === 'stale-person') f.buddy.buddyOf!.generation = 'old'
    else f.chat.audience!.people[0]!.generation = 'old'
    numberMessages(f.state, [{ id: 'input', conversationId: f.chat.id, replyTo: null, text: 'No', recipients: ['buddy'],
      author: { kind: 'person', id: 'owner', name: 'owner', membershipGeneration: f.owner.generation } }], NOW)
    expect(f.buddy.asleep).toEqual({ since: NOW - 1_000 })
  })
})
