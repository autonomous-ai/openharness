import { describe, expect, it } from 'vitest'
import { extracted } from './write.js'
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
})
