import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { conversationKey, createConversationOwners, type ConversationOwnersDeps } from './conversationOwners.js'

const row = (agentId: string, sessionId: string, extra: Partial<RegisteredSession> = {}): RegisteredSession => ({
  agentId, sessionId, engine: 'claude', codexHome: null, hermesHome: null, boundAt: 1000, registeredAt: 500, touchedAt: 2000,
  ...extra,
} as RegisteredSession)

/** A stopped store holding [stopped], live harnesses [live], and what was said to the apps. */
function setup(stopped: RegisteredSession[], live: RegisteredSession[] = [], extra: Partial<ConversationOwnersDeps> = {}) {
  const records = new Map(stopped.map((saved) => [saved.agentId, saved]))
  const reservations = new Map<string, number>()
  const sent: unknown[] = []
  const commander: unknown[] = []
  const stoppedAgents = {
    list: vi.fn(() => [...records.values()]),
    get: vi.fn((id: string) => records.get(id) ?? null),
    supersede: vi.fn((id: string) => { const saved = records.get(id) ?? null; records.delete(id); return saved }),
    resumeReservedAt: vi.fn((id: string) => reservations.get(id) ?? null),
  }
  const owners = createConversationOwners({
    stoppedAgents, live: () => live, clients: { send: (frame) => sent.push(frame), sendCommander: (frame) => commander.push(frame) },
    reservationMs: 600_000, now: () => 10_000_000, ...extra,
  })
  return { owners, records, reservations, sent, commander, stoppedAgents }
}

describe('a conversation', () => {
  it('is its engine, profile, home and id; a record without one, or a terminal, holds none', () => {
    expect(conversationKey(row('a', 'c1'))).toBe('claude\u0000\u0000\u0000c1')
    expect(conversationKey(row('a', 'c1', { engine: 'codex', codexHome: '/p' }))).not.toBe(conversationKey(row('a', 'c1', { engine: 'codex' })))
    expect(conversationKey(row('a', 'c1', { engine: 'hermes', hermesHome: '/h' }))).not.toBe(conversationKey(row('a', 'c1', { engine: 'hermes' })))
    expect(conversationKey(row('a', ''))).toBeNull()
    expect(conversationKey(row('a', 'c1', { engine: 'terminal' }))).toBeNull()
  })
})

describe('one owner per conversation, stopped harnesses included', () => {
  afterEach(() => vi.restoreAllMocks())

  it('a running harness wins: every stopped record of another harness holding it is set aside and announced', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { owners, records, sent, commander } = setup([row('old', 'c1', { boundAt: 9_000 }), row('older', 'c1')], [row('new', 'c1', { boundAt: 1 })])
    expect(owners.settle().sort()).toEqual(['old', 'older'])
    expect([...records.keys()]).toEqual([])
    expect(sent).toContainEqual({ type: 'agent_deleted', payload: { agentId: 'old', retained: false, successor: 'new' } })
    expect(commander).toContainEqual({ type: 'agent_deleted', payload: { agentId: 'old' } })
  })

  it('among stopped records the newest binding wins, then the newest record, then the id', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const bound = setup([row('a', 'c1', { boundAt: 3000 }), row('b', 'c1', { boundAt: 5000 }), row('c', 'c1', { boundAt: null })])
    expect(bound.owners.settle().sort()).toEqual(['a', 'c'])
    expect([...bound.records.keys()]).toEqual(['b'])
    const touched = setup([row('a', 'c1', { touchedAt: 9 }), row('b', 'c1', { touchedAt: 7 })])
    expect(touched.owners.settle()).toEqual(['b'])
    const named = setup([row('b', 'c1'), row('a', 'c1')])
    expect(named.owners.settle()).toEqual(['b'])
    // A record bound before its fields existed dates from its registration.
    const legacy = setup([row('a', 'c1', { boundAt: null, registeredAt: 7000 }), row('b', 'c1', { boundAt: 6000 })])
    expect(legacy.owners.settle()).toEqual(['b'])
  })

  it('leaves alone what has one owner: a lone record, a running harness\'s own record, other conversations', () => {
    const { owners, records } = setup([row('a', 'c1'), row('b', 'c2'), row('live', 'c3'), row('t', '', { engine: 'terminal' })], [row('live', 'c3'), row('other', 'c4')])
    expect(owners.settle()).toEqual([])
    expect([...records.keys()]).toEqual(['a', 'b', 'live', 't'])
  })

  it('never sets aside a record whose resume is in flight; an older reservation protects nothing', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { owners, records, reservations } = setup([row('a', 'c1', { boundAt: 1 }), row('b', 'c1', { boundAt: 2 }), row('c', 'c1', { boundAt: 3 })])
    reservations.set('a', 10_000_000 - 1000)
    reservations.set('b', 10_000_000 - 600_001)
    expect(owners.settle()).toEqual(['b'])
    expect([...records.keys()].sort()).toEqual(['a', 'c'])
  })

  it('settles only the conversations named, and nothing for none', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { owners, stoppedAgents } = setup([row('a', 'c1'), row('b', 'c1', { boundAt: 2000 }), row('x', 'c2'), row('y', 'c2', { boundAt: 2000 })])
    expect(owners.settle([null])).toEqual([])
    expect(stoppedAgents.list).not.toHaveBeenCalled()
    expect(owners.settle([conversationKey(row('?', 'c1'))])).toEqual(['a'])
    expect(owners.settle()).toEqual(['x'])
  })

  it('a record that vanished or cannot be moved stays, said, and the others still settle', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { owners, stoppedAgents, sent } = setup([row('gone', 'c1'), row('stuck', 'c1'), row('ok', 'c1'), row('owner', 'c1', { boundAt: 9000 })])
    stoppedAgents.supersede.mockImplementation((id: string) => {
      if (id === 'gone') return null
      if (id === 'stuck') throw new Error('disk full')
      if (id === 'ok') return row('ok', 'c1')
      throw 'not a record'
    })
    expect(owners.settle()).toEqual(['ok'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'))
    expect(sent).toHaveLength(1)
  })

  it('a non-Error failure is said in words too', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { owners, stoppedAgents } = setup([row('a', 'c1'), row('b', 'c1', { boundAt: 9000 })])
    stoppedAgents.supersede.mockImplementation(() => { throw 'plain' })
    expect(owners.settle()).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plain'))
  })

  it('settles the conversation a stopped record holds as saved, or nothing when there is no record', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { owners } = setup([row('stopped-now', 'c1', { boundAt: 1000 }), row('took-it', 'c1', { boundAt: 5000 })])
    expect(owners.settleSaved('nobody')).toEqual([])
    expect(owners.settleSaved('stopped-now')).toEqual(['stopped-now'])
  })

  it('reads the clock it is given, or the real one', () => {
    const { stoppedAgents } = setup([])
    const owners = createConversationOwners({ stoppedAgents, live: () => [], clients: { send: () => {}, sendCommander: () => {} }, reservationMs: 1 })
    stoppedAgents.list.mockReturnValue([row('a', 'c1'), row('b', 'c1', { boundAt: 9000 })])
    stoppedAgents.resumeReservedAt.mockReturnValue(Date.now() + 60_000)
    expect(owners.settle()).toEqual([])
  })
})
