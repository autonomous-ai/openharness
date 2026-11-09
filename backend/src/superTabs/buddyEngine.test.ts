import { describe, expect, it } from 'vitest'
import { applyCommand, type Command } from './commands.js'
import { createSuperTab, type Actor } from './model.js'
import type { ContributedMachine } from './machines.js'
import { staleSwitches } from './tidy.js'
import { hostTab } from './read/hostRows.js'
import { touchesFor } from './parts/touches.js'

const NOW = 1_800_000_000_000
const person: Actor = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
function setup() {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  state.people.push({ id: 'peer', email: 'peer@example.com', role: 'collaborator', generation: 'first' })
  state.machines = [{ machineId: 'mac', name: 'My computer', contributorId: 'peer', membershipGeneration: 'first', generation: 'g1',
    cwd: '/swarm', scope: 'swarm', engines: ['claude', 'codex'], maxAgents: 4, paused: false,
    observation: { generation: 'g1', receivedAt: NOW, sessionKind: 'computer',
      resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null,
        projectDiskFreeBytes: null, deviceType: null, chip: null, os: null, gpuPercent: null },
      tools: {}, quotas: [], runningHarnessIds: ['h-old'], stoppedHarnessIds: [], capabilities: ['swarmBuddy', 'buddyModel', 'buddyEngine'],
      readiness: { engines: [{ engine: 'claude', installed: true, signedIn: true }, { engine: 'codex', installed: true, signedIn: true }] } } } satisfies ContributedMachine]
  let operation = 0
  const run = (command: Record<string, unknown>, actor = person, now = NOW) => {
    const effects = applyCommand(state, actor, command as Command, { operationId: `op${++operation}`, now,
      contribution: { machineOwnerId: 'peer', contributorId: 'peer', hostGrant: null } })
    state = effects.state
    return effects
  }
  const startId = run({ type: 'buddy.create', machineId: 'mac', engine: 'claude' }).result.startId
  const id = run({ type: 'agent.started', startId, harnessId: 'h-old', configuration }).result.agentId as string
  run({ type: 'agent.startSettled', startId, warning: null })
  const chat = state.conversations.find(c => c.agentIds.includes(id))!.id
  const host: Actor = { kind: 'agent', agentId: id, machineOwnerId: 'peer' }
  const target = () => state.agents.find(a => a.id === id)!
  const request = () => target().switchRequest!.id
  const rebind = () => run({ type: 'agent.rebind', agentId: id, machineId: 'mac', previousHarnessId: 'h-old', harnessId: 'h-new',
    configuration: { ...configuration, engine: 'codex' } }, host)
  return { run, target, request, rebind, id, chat, host, get state() { return state }, pool: () => state.machines![0]! }
}

function addBuddy(f: ReturnType<typeof setup>) {
  const startId = f.run({ type: 'buddy.create', machineId: 'mac', engine: 'claude', name: 'Moss' }).result.startId
  const id = f.run({ type: 'agent.started', startId, harnessId: 'h-moss', configuration }).result.agentId as string
  f.run({ type: 'agent.startSettled', startId, warning: null })
  const chat = f.state.conversations.find(c => c.agentIds.includes(id))!.id
  return { id, chat, target: () => f.state.agents.find(a => a.id === id)!,
    host: { kind: 'agent', agentId: id, machineOwnerId: 'peer' } as Actor }
}

describe('a person switching their Buddy engine', () => {
  it('wakes a sleeping Buddy before requesting its engine switch', () => {
    const f = setup()
    f.target().asleep = { since: NOW - 60_000 }
    f.run({ type: 'buddy.engine', engine: 'codex' })
    expect(f.target().asleep).toBeUndefined()
    expect(f.target().switchRequest?.engine).toBe('codex')
    expect(f.target().harnessId).toBe('h-old')
    expect(f.state.conversations.find(c => c.id === f.chat)?.agentIds).toEqual([f.id])
  })

  it.each(['named', 'default'])('guards the %s Buddy’s machine against a concurrent readiness change', choice => {
    const f = setup(), second = addBuddy(f)
    f.state.machines!.push({ ...structuredClone(f.pool()), machineId: 'second-mac' })
    second.target().machineId = 'second-mac'
    if (choice === 'default') f.run({ type: 'buddy.default', conversationId: second.chat })
    const command: Command = { type: 'buddy.engine', engine: 'codex', ...(choice === 'named' ? { conversationId: second.chat } : {}) }
    const before = structuredClone(f.state)
    const effects = f.run(command)
    expect(second.target().switchRequest?.engine).toBe('codex')
    expect(touchesFor(command, person, before, effects).filter(t => t.kind === 'machine'))
      .toEqual([{ kind: 'machine', key: 'second-mac' }])
  })

  it('switches the default Buddy when an older client names no chat', () => {
    const f = setup(), second = addBuddy(f)
    f.run({ type: 'buddy.default', conversationId: second.chat })
    f.run({ type: 'buddy.engine', engine: 'codex' })
    expect(second.target().switchRequest?.engine).toBe('codex')
    expect(f.target().switchRequest).toBeUndefined()
  })

  it('switches exactly the named Buddy even when another is the default, preserving its private chat', () => {
    const f = setup(), second = addBuddy(f)
    f.run({ type: 'buddy.engine', engine: 'codex', conversationId: second.chat })
    expect(f.target().switchRequest).toBeUndefined()
    const switchId = second.target().switchRequest!.id
    f.run({ type: 'agent.switchClaim', agentId: second.id, switchId }, second.host)
    f.run({ type: 'agent.rebind', agentId: second.id, machineId: 'mac', previousHarnessId: 'h-moss', harnessId: 'h-moss-new',
      configuration: { ...configuration, engine: 'codex' } }, second.host)
    const result = f.run({ type: 'agent.switchResult', agentId: second.id, switchId, ok: true }, second.host)
    expect(result.messages).toEqual([expect.objectContaining({ conversationId: second.chat, text: 'Your Buddy now runs on Codex.' })])
    expect(f.state.agents).toHaveLength(2)
    expect(f.state.conversations.find(c => c.id === second.chat)?.agentIds).toEqual([second.id])
    expect(f.target().configuration.engine).toBe('claude')
  })

  it('refuses another person, archived, missing or old-membership chat instead of falling back', () => {
    for (const kind of ['other person', 'archived', 'missing', 'old membership']) {
      const f = setup(), second = addBuddy(f)
      const chat = f.state.conversations.find(c => c.id === second.chat)!
      if (kind === 'archived') chat.archived = true
      if (kind === 'old membership') chat.audience!.people[0]!.generation = 'old'
      const actor = kind === 'other person' ? { kind: 'person', userId: 'owner', email: 'owner@example.com' } as Actor : person
      expect(() => f.run({ type: 'buddy.engine', engine: 'codex', conversationId: kind === 'missing' ? 'gone' : second.chat }, actor))
        .toThrow(/unavailable/)
      expect(f.target().switchRequest).toBeUndefined()
      expect(second.target().switchRequest).toBeUndefined()
    }
  })

  it('reports a failed or expired named Buddy switch in that Buddy chat', () => {
    for (const expire of [false, true]) {
      const f = setup(), second = addBuddy(f)
      second.target().switchRequest = { id: 'switch-moss', engine: 'codex', profileId: 'default', requestedBy: 'peer', at: new Date(NOW).toISOString() }
      const messages = expire ? staleSwitches(f.state, NOW + 120_001)
        : f.run({ type: 'agent.switchResult', agentId: second.id, switchId: 'switch-moss', ok: false, error: 'signed out' }, second.host).messages
      expect(messages).toEqual([expect.objectContaining({ conversationId: second.chat, text: expect.stringMatching(/Couldn't switch/) })])
    }
  })

  it('gives the host each Buddy’s own private chat and keeps its subscription alert there', async () => {
    const f = setup(), second = addBuddy(f)
    const rows = await hostTab('swarm', f.state, 'mac', { sub: 'peer', email: 'peer@example.com' } as never, NOW,
      { people: [], confidential: new Set(), agentGrant: async () => {}, githubApp: false })
    expect(rows.roster.find(r => 'agent' in r && r.agent.id === second.id)).toMatchObject({ buddyConversationId: second.chat })
    expect(rows.roster.find(r => 'agent' in r && r.agent.id === f.id)).toMatchObject({ buddyConversationId: f.chat })
    expect(f.run({ type: 'agent.alert', agentId: second.id, alert: 'limit', active: true }, second.host).messages)
      .toEqual([expect.objectContaining({ conversationId: second.chat, text: expect.stringMatching(/subscription limit/) })])
  })

  it('keeps the same Buddy and chat through claim, replacement and result', () => {
    const f = setup(), before = structuredClone(f.state.conversations.find(c => c.id === f.chat))
    f.run({ type: 'buddy.engine', engine: 'codex' })
    expect(f.target().switchRequest).toMatchObject({ engine: 'codex', profileId: 'default', requestedBy: 'peer' })
    const switchId = f.request()
    f.run({ type: 'agent.switchClaim', agentId: f.id, switchId }, f.host)
    f.rebind()
    const result = f.run({ type: 'agent.switchResult', agentId: f.id, switchId, ok: true }, f.host)
    expect(f.state.agents).toHaveLength(1)
    expect(f.target()).toMatchObject({ id: f.id, harnessId: 'h-new', buddyScope: 'swarm', buddyOf: { personId: 'peer', generation: 'first' }, configuration: { engine: 'codex' } })
    expect(f.state.conversations.find(c => c.id === f.chat)).toMatchObject({ id: before!.id, agentIds: before!.agentIds, audience: before!.audience })
    expect(result.messages).toEqual([expect.objectContaining({ conversationId: f.chat, recipients: [], text: 'Your Buddy now runs on Codex.' })])
    expect(f.target().switchRequest).toBeUndefined()
  })

  it.each([false, null])('refuses a destination with sign-in %s before changing the Buddy', signedIn => {
    const f = setup()
    f.pool().observation!.readiness!.engines![1]!.signedIn = signedIn
    expect(() => f.run({ type: 'buddy.engine', engine: 'codex' })).toThrow(/signed in/i)
    expect(f.target().harnessId).toBe('h-old')
    expect(f.target().switchRequest).toBeUndefined()
  })

  it('refuses an engine not installed, a missing reading, a stale reading and an old host', () => {
    for (const edit of [
      (f: ReturnType<typeof setup>) => { f.pool().observation!.readiness!.engines![1]!.installed = false },
      (f: ReturnType<typeof setup>) => { delete f.pool().observation!.readiness!.engines },
      (f: ReturnType<typeof setup>) => { f.pool().observation!.receivedAt -= 600_000 },
      (f: ReturnType<typeof setup>) => { f.pool().observation!.capabilities = ['swarmBuddy'] },
    ]) {
      const f = setup(); edit(f)
      expect(() => f.run({ type: 'buddy.engine', engine: 'codex' })).toThrow()
      expect(f.target().switchRequest).toBeUndefined()
    }
  })

  it('allows a Buddy-only machine but never another person or the Buddy to request the switch', () => {
    const f = setup()
    f.pool().buddyOnly = true
    for (const actor of [{ kind: 'person', userId: 'owner', email: 'owner@example.com' } as Actor, f.host]) {
      expect(() => f.run({ type: 'buddy.engine', engine: 'codex' }, actor)).toThrow()
    }
    f.run({ type: 'buddy.engine', engine: 'codex' })
    expect(f.target().switchRequest?.engine).toBe('codex')
  })

  it('refuses an owner machine whose account became a Team account', () => {
    const f = setup()
    f.pool().observation!.sessionKind = 'team'
    expect(() => f.run({ type: 'buddy.engine', engine: 'codex' })).toThrow(/own machine/i)
    expect(f.target().switchRequest).toBeUndefined()
    expect(f.target().harnessId).toBe('h-old')
  })

  it('excludes concurrent engine and model changes in both directions', () => {
    const f = setup()
    f.run({ type: 'buddy.engine', engine: 'codex' })
    expect(() => f.run({ type: 'buddy.engine', engine: 'codex' })).toThrow(/already switching/i)
    expect(() => f.run({ type: 'buddy.model', gridModel: null })).toThrow(/already switching/i)
    const g = setup()
    g.run({ type: 'buddy.model', gridModel: null })
    expect(() => g.run({ type: 'buddy.engine', engine: 'codex' })).toThrow(/already switching/i)
  })

  it('refuses a Buddy replacement without its own claimed switch or for a different engine', () => {
    const f = setup()
    expect(() => f.rebind()).toThrow()
    f.run({ type: 'buddy.engine', engine: 'codex' })
    expect(() => f.rebind()).toThrow()
    f.run({ type: 'agent.switchClaim', agentId: f.id, switchId: f.request() }, f.host)
    expect(() => f.run({ type: 'agent.rebind', agentId: f.id, machineId: 'mac', previousHarnessId: 'h-old', harnessId: 'h-new', configuration }, f.host)).toThrow()
    f.rebind()
    expect(() => f.rebind()).not.toThrow()
  })

  it('reports failure privately, keeps the old engine, and rejects a stale outcome', () => {
    const f = setup()
    f.run({ type: 'buddy.engine', engine: 'codex' })
    const switchId = f.request()
    const result = f.run({ type: 'agent.switchResult', agentId: f.id, switchId, ok: false, error: 'that account is signed out' }, f.host)
    expect(result.messages).toEqual([expect.objectContaining({ conversationId: f.chat, text: expect.stringMatching(/signed out.*Claude Code/) })])
    expect(f.target().configuration.engine).toBe('claude')
    expect(() => f.run({ type: 'agent.switchResult', agentId: f.id, switchId, ok: true }, f.host)).toThrow()
  })

  it('expires a host that never answers with a private visible failure', () => {
    const f = setup()
    f.run({ type: 'buddy.engine', engine: 'codex' })
    const lines = staleSwitches(f.state, NOW + 120_001)
    expect(lines).toEqual([expect.objectContaining({ conversationId: f.chat, text: expect.stringMatching(/Couldn't switch.*machine did not answer/) })])
    expect(f.target().switchRequest).toBeUndefined()
  })

  it('offers an engine switch once per subscription-limit episode in its own chat', () => {
    const f = setup()
    const alert = { type: 'agent.alert', agentId: f.id, alert: 'limit', active: true }
    const lines = f.run(alert, f.host).messages
    expect(lines).toEqual([expect.objectContaining({ conversationId: f.chat, text: expect.stringMatching(/subscription limit.*[Ss]witch.*engine/), source: expect.objectContaining({ alert: 'limit' }) })])
    expect(f.run(alert, f.host).messages).toEqual([])
  })

  it('gives only its host the Buddy chat needed to restart in place', async () => {
    const f = setup()
    const rows = await hostTab('swarm', f.state, 'mac', { sub: 'peer', email: 'peer@example.com' } as never, NOW,
      { people: [], confidential: new Set(), agentGrant: async () => {}, githubApp: false })
    expect(rows.roster.find(r => 'agent' in r && r.agent.id === f.id)).toMatchObject({ buddyConversationId: f.chat })
  })
})
