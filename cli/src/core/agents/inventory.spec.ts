import { describe, expect, it } from 'vitest'
import type { AgentFrame } from '../../lib/agentFrame.js'
import { createAgentInventory } from './inventory.js'
const agent = (id: string, name = id) => ({ id, name, createdAt: '2026-10-07T00:00:00Z', gitContext: { history: { branches: [], pullRequests: [] } } }) as unknown as AgentFrame
const req = (since?: unknown) => ({ sync: { version: 1, since } })
const token = (result: Record<string, unknown>) => (result.sync as { revision: string }).revision

describe('complete pane snapshots and opt-in deltas', () => {
  it('keeps the legacy shape for absent, invalid and unsupported sync requests', () => {
    const send = createAgentInventory(), agents = [agent('a')]
    for (const sync of [undefined, null, true, 'v1', [], {}, { version: 2 }]) expect(send(agents, { sync }, 'web')).toEqual({ agents })
  })
  it('reconciles unchanged, edited, new, removed and reordered panes without losing details', () => {
    const send = createAgentInventory(), a = agent('a'), b = agent('b')
    const first = send([a, b], req(), 'web')
    const one = token(first)
    expect(first).toEqual({ agents: [a, b], sync: { version: 1, revision: one } })
    expect(send([a, b], req(one), 'web')).toEqual({ agents: [], sync: { version: 1, base: one, revision: one } })
    const edited = agent('a', 'Renamed'), c = agent('c')
    const next = send([b, edited, c], req(one), 'web')
    expect(next).toEqual({ agents: [edited, c], sync: { version: 1, base: one, revision: token(next), order: ['b', 'a', 'c'] } })
    expect(send([c, edited], req(token(next)), 'web')).toMatchObject({ agents: [], sync: { order: ['c', 'a'] } })
    expect(send([], req(one), 'web')).toMatchObject({ agents: [], sync: { order: [] } })
  })
  it('changes the fingerprint for nested metadata, even with the same identity', () => {
    const send = createAgentInventory(), a = agent('a')
    const first = send([a], req(), 'web')
    const changed = { ...a, terminal: { available: false, primary: '', runtimes: [] } } as AgentFrame
    expect(send([changed], req(token(first)), 'web').agents).toEqual([changed])
  })
  it('returns a full snapshot after restart, an unknown token, or a visibility-scope change', () => {
    const send = createAgentInventory(), agents = [agent('a')]
    const first = send(agents, req(), 'web-live')
    for (const since of ['missing', {}, 1]) expect(send(agents, req(since), 'web-live')).toEqual(first)
    const scoped = send(agents, req(token(first)), 'web-stopped')
    expect(scoped.agents).toEqual(agents)
    expect(scoped.sync).not.toHaveProperty('base')
    expect(createAgentInventory()(agents, req(token(first)), 'web-live')).toMatchObject({ agents: [] })
    // A changed daemon has no prior fingerprints, and falls back to the complete current rows.
    expect(createAgentInventory()([agent('b')], req(token(first)), 'web-live').sync).not.toHaveProperty('base')
  })
  it('evicts old revisions by snapshot count', () => {
    const send = createAgentInventory()
    const first = send([agent('a')], req(), 'web')
    for (let i = 0; i < 8; i++) send([agent(`next-${i}`)], req(), 'web')
    expect(send([agent('latest')], req(token(first)), 'web').sync).not.toHaveProperty('base')
  })
  it('bounds cached row count and falls back instead of truncating a large list', () => {
    const send = createAgentInventory(), agents = Array.from({ length: 4200 }, (_, i) => agent(`${i}`))
    const first = send(agents, req(), 'web')
    send(agents.map(a => ({ ...a, name: 'changed' })), req(), 'web')
    expect(send([agent('latest')], req(token(first)), 'web').sync).not.toHaveProperty('base')
    const huge = Array.from({ length: 8193 }, (_, i) => agent(`${i}`))
    const uncached = send(huge, req(), 'web')
    expect(uncached.agents).toHaveLength(8193)
    expect(send([agent('later')], req(token(uncached)), 'web').sync).not.toHaveProperty('base')
  })
  it('bounds cached bytes even when row counts are small', () => {
    const send = createAgentInventory()
    const first = send([agent('a'.repeat(600_000))], req(), 'web')
    send([agent('b'.repeat(600_000))], req(), 'web')
    expect(send([agent('next')], req(token(first)), 'web').sync).not.toHaveProperty('base')
    const huge = send([agent('c'.repeat(1_100_000))], req(), 'web')
    expect(send([agent('next')], req(token(huge)), 'web').sync).not.toHaveProperty('base')
  })
})
