import { describe, expect, it } from 'vitest'
import { ALL_HOSTS } from '../cache.js'
import { extracted, writeHosts } from './write.js'
import type { GroupData } from './types.js'

describe('the host-fields digest a conversation write stores (group 3b)', () => {
  const group = (change: Partial<GroupData> = {}): GroupData => ({ id: 'g', projectId: 'p', title: 'Work', leadId: 'lead', agentIds: ['lead', 'worker'],
    archived: false, brief: 'Do it', checks: [], lastMessageSequence: 10, messageSeq: 10, reportSeq: 10, lastActivityAt: '2026-10-26T10:00:00.000Z',
    assignment: { id: 'w', agentId: 'worker', status: 'working', configuration: { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null },
      execution: { machineId: 'm', harnessId: 'h', machineOwnerId: 'o' }, result: null }, ...change })
  const digest = (data: GroupData) => extracted('group', data, 1).hostDigest

  it('stays the same for a post, a rename or a new brief, which no host row shows', () => {
    const before = digest(group())
    expect(before).toMatch(/^[A-Za-z0-9_-]{16,}$/)
    expect(digest(group({ lastMessageSequence: 11, messageSeq: 11, reportSeq: 11, lastActivityAt: '2026-10-26T11:00:00.000Z', pullRequestUrls: ['x'] }))).toBe(before)
    expect(digest(group({ title: 'Renamed', brief: 'Something else', checks: [{ id: 'c', description: 'd', independent: false, evidence: 'e', passedBy: null }] }))).toBe(before)
  })

  it('changes with what host rows read, and differs between conversations: its id, members, the Lead, archiving, the project, privacy, and the work', () => {
    const before = digest(group())
    const work = group().assignment!
    for (const change of [{ id: 'another' }, { agentIds: ['lead'] }, { leadId: null }, { archived: true }, { projectId: 'q' }, { audience: { people: [] } },
      { assignment: { ...work, status: 'needs_human' as const } }, { assignment: { ...work, agentId: 'other' } }, { assignment: { ...work, result: 'Blocked on a key' } },
      { assignment: { ...work, execution: { ...work.execution, machineId: 'n' } } }, { assignment: null }]) {
      expect(digest(group(change))).not.toBe(before)
    }
  })
})

describe('the finished-work mark a conversation write stores', () => {
  const group = (status: string | null): GroupData => ({ id: 'g', projectId: 'p', title: 'Work', leadId: 'lead', agentIds: ['lead'], archived: false,
    brief: '', checks: [], lastMessageSequence: 0, assignment: status === null ? null : { id: 'w', agentId: 'worker', status: status as never,
      configuration: { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null },
      execution: { machineId: 'm', harnessId: 'h', machineOwnerId: 'o' }, result: null } })

  it('is set only while its task is done or cancelled: the archive pass reads only those (archive.ts)', () => {
    expect(extracted('group', group('done'), 1).workFinished).toBe(true)
    expect(extracted('group', group('cancelled'), 1).workFinished).toBe(true)
    for (const status of ['working', 'review', 'lost', 'stopped', null]) expect(extracted('group', group(status), 1).workFinished).toBe(false)
  })

  // Every linked group is a step, which closes with its task, never on its own clock (task steps design; Ken, 2026-11-02).
  // A row written before keeps the mark it had until it is written again, and the pass still closes those as before.
  it('is never set on a linked group: it closes with its task', () => {
    const linked = (status: string | null) => ({ ...group(status), reviewOf: 'built' })
    for (const status of [null, 'lost', 'stopped', 'done', 'cancelled', 'working', 'review']) expect(extracted('group', linked(status), 1).workFinished).toBe(false)
  })
})

// The host stamps that keep a machine's reading-only reports off the Swarm's load (task #3119) move by the rule the host read
// wakes by: a write this table leaves out would let a reading skip a change its full report decides from.
describe('which hosts a write concerns', () => {
  const update = (kind: Parameters<typeof writeHosts>[0]['kind'], data: unknown, host?: { hostChangedAt?: Date; hostMachineIds?: string[] }) =>
    writeHosts({ op: 'update', kind, key: 'k', seen: 1, data, ...host ? { host } : {} })

  it('is every host for the head, a member, a machine\'s settings, and a part whose host its data does not name', () => {
    expect(update('head', {})).toEqual([ALL_HOSTS])
    expect(update('member', {})).toEqual([ALL_HOSTS])
    expect(update('machine', {}, { hostChangedAt: new Date(1) })).toEqual([ALL_HOSTS])
    expect(update('group', {})).toEqual([ALL_HOSTS])
    expect(update('agent', {})).toEqual([ALL_HOSTS])
    expect(update('start', { request: {} })).toEqual([ALL_HOSTS])
  })

  it('is an agent\'s or a start\'s machine, and the machines a group\'s marker names, added or removed alike', () => {
    expect(update('agent', { machineId: 'A' })).toEqual(['A'])
    expect(update('start', { request: { machineId: 'B' } })).toEqual(['B'])
    expect(update('group', {}, { hostMachineIds: ['A', 'C'] })).toEqual(['A', 'C'])
    expect(update('group', {}, { hostMachineIds: [] })).toEqual([])
    expect(writeHosts({ op: 'remove', kind: 'agent', key: 'k', seen: 1, data: { machineId: 'A' } })).toEqual(['A'])
    expect(writeHosts({ op: 'insert', kind: 'start', key: 'k', ordinal: 1, data: { request: { machineId: 'B' } } })).toEqual(['B'])
  })

  it('is none for a machine\'s own reading, a touch, or project progress', () => {
    expect(update('machine', {})).toEqual([])
    expect(writeHosts({ op: 'touch', kind: 'head', key: 'head', seen: 1 })).toEqual([])
    expect(update('progress', {})).toEqual([])
  })
})
