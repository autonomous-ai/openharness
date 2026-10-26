import { describe, expect, it } from 'vitest'
import { normalize } from './normalize.js'
import { NOW, richSwarm } from '../read/fixture.test-support.js'
import type { Conversation, SuperTabState } from '../model.js'

const DAY = 86_400_000
const group = (state: SuperTabState, id: string) => state.conversations.find(c => c.id === id)!
const finish = (c: Conversation, status: 'done' | 'cancelled' | 'stopped') => { c.assignment = { ...c.assignment!, status } }

describe('migration normalize (design 6.1.2 step 2)', () => {
  it('persists what reads derive today: display names, numbers, rule projects, agent projects', () => {
    const s = richSwarm()
    const legacy = structuredClone(s.state)
    delete legacy.agents[1]!.displayName
    delete legacy.agents[1]!.projectId
    delete group(legacy, s.done).number
    legacy.retiredConversationNumber = 10
    legacy.rules = [{ id: 'r', rule: { kind: 'preferEngine', taskKind: 'ui', engine: 'codex' }, text: 'Codex for UI.', askedBy: 'owner', askedIn: null } as never]
    const state = normalize(legacy, { now: NOW, lastActivity: new Map() })
    expect(state.agents[1]!.displayName).toBe(s.state.agents[1]!.displayName)
    expect(state.agents[1]!.projectId).toBe('lead')
    expect(group(state, s.done).number).toBe(11)
    expect(state.rules![0]!.projectId).toBe('lead')
  })

  it('leaves an agent without a project alone in a Swarm from before projects', () => {
    const legacy = structuredClone(richSwarm().state)
    delete legacy.projects
    delete legacy.agents[1]!.projectId
    expect(normalize(legacy, { now: NOW, lastActivity: new Map() }).agents[1]).not.toHaveProperty('projectId')
  })

  it('persists the awaiting decision of a worker whose work ended before decisions were stored', () => {
    const s = richSwarm()
    const legacy = structuredClone(s.state)
    finish(group(legacy, s.web), 'done')
    delete legacy.agents.find(a => a.id === s.worker)!.workDecision
    expect(normalize(legacy, { now: NOW, lastActivity: new Map() }).agents.find(a => a.id === s.worker)!.workDecision).toBe('awaiting')
  })

  it('makes archived groups and finished groups quiet for a day dormant, never a Lead conversation or running work', () => {
    const s = richSwarm()
    const legacy = structuredClone(s.state)
    finish(group(legacy, s.web), 'done')
    group(legacy, s.done).archived = true
    const quiet = NOW - DAY - 1
    const activity = new Map([[s.web, quiet], ['lead', quiet], [s.secretGroup, quiet]])
    const state = normalize(legacy, { now: NOW, lastActivity: activity })
    expect(state.conversations.filter(c => c.dormant).map(c => c.id).sort()).toEqual([s.web, s.done].sort())

    const recent = normalize(legacy, { now: NOW, lastActivity: new Map([[s.web, NOW - DAY + 1]]) })
    expect(group(recent, s.web).dormant).toBeUndefined()
    const stopped = structuredClone(legacy)
    finish(group(stopped, s.web), 'stopped')
    expect(group(normalize(stopped, { now: NOW, lastActivity: activity }), s.web).dormant).toBeUndefined()
  })

  it('parks conversations of an unknown kind and keeps the Leads conversation in step, as reading the row does', () => {
    const legacy = structuredClone(richSwarm().state)
    legacy.conversations.push({ id: 'later', kind: 'future' as never, title: 'Later', leadId: null, agentIds: [], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 })
    legacy.conversations = legacy.conversations.filter(c => c.kind !== 'leads')
    const state = normalize(legacy, { now: NOW, lastActivity: new Map() })
    expect(state.parkedConversations!.map(c => c.id)).toEqual(['later'])
    expect(state.conversations.at(-1)!.kind).toBe('leads')
  })

  it('does not change its input', () => {
    const legacy = structuredClone(richSwarm().state)
    const copy = structuredClone(legacy)
    normalize(legacy, { now: NOW, lastActivity: new Map() })
    expect(legacy).toEqual(copy)
  })
})
