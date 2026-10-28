import { describe, expect, it } from 'vitest'
import { queryShape, renderProfile, summarizeProfile, type ProfileEntry } from './profile.js'

const find = (filter: Record<string, unknown>, extra: Partial<ProfileEntry> = {}): ProfileEntry => ({ op: 'command', ns: 'bench.SwarmGroup',
  command: { aggregate: 'SwarmGroup', pipeline: [{ $match: filter }, { $project: { _id: 1 } }] }, planSummary: 'IXSCAN { tabId: 1, key: 1 }',
  docsExamined: 1, keysExamined: 1, nreturned: 1, millis: 0, ...extra })

describe('queryShape', () => {
  it('keeps fields and operators, never values', () => {
    expect(queryShape({ tabId: 't1', status: { $in: ['queued', 'claimed'] }, $or: [{ key: { $in: ['a'] } }, { executionMachineId: { $ne: null } }] }))
      .toBe('{"$or":[{"key":{"$in":"?"}},{"executionMachineId":{"$ne":"?"}}],"status":{"$in":"?"},"tabId":"?"}')
  })

  it('keeps the fields Prisma compares inside $expr', () => {
    expect(queryShape({ $expr: { $and: [{ $eq: ['$tabId', 't1'] }, { $or: [{ $eq: ['$status', 'queued'] }, { $eq: ['$status', 'claimed'] }] }] } }))
      .toBe('{"$expr":{"$and":[{"$eq":["$tabId","?"]},{"$or":[{"$eq":["$status","?"]},{"$eq":["$status","?"]}]}]}}')
  })

  it('is the same for the same filter in another field order', () => {
    expect(queryShape({ b: 1, a: { $gt: 2 } })).toBe(queryShape({ a: { $gt: 9 }, b: 'x' }))
  })
})

describe('summarizeProfile', () => {
  it('groups operations by collection and filter shape, with plans, documents read and time percentiles', () => {
    const entries = [
      find({ tabId: 'a', deleted: false }, { millis: 1, docsExamined: 10 }),
      find({ tabId: 'b', deleted: false }, { millis: 3, docsExamined: 30 }),
      find({ tabId: 'c', deleted: false }, { millis: 40, docsExamined: 20, planSummary: 'COLLSCAN' }),
      { op: 'update', ns: 'bench.SuperTabDelivery', command: { q: { _id: { $in: ['d'] } }, u: { $set: { status: 'claimed' } } },
        planSummary: 'IXSCAN { _id: 1 }', docsExamined: 1, keysExamined: 1, nreturned: 0, millis: 2 },
    ]
    const summary = summarizeProfile(entries)
    expect(summary.operations).toBe(4)
    expect(summary.collscans).toBe(1)
    expect(summary.p95Ms).toBe(40)
    expect(summary.shapes).toEqual([
      { collection: 'SwarmGroup', op: 'aggregate', shape: '{"deleted":"?","tabId":"?"}', count: 3, collscans: 1,
        plans: ['COLLSCAN', 'IXSCAN { tabId: 1, key: 1 }'], docsExaminedMax: 30, docsExaminedP95: 30, keysExaminedMax: 1, returnedMax: 1, p50Ms: 3, p95Ms: 40, maxMs: 40 },
      { collection: 'SuperTabDelivery', op: 'update', shape: '{"_id":{"$in":"?"}}', count: 1, collscans: 0,
        plans: ['IXSCAN { _id: 1 }'], docsExaminedMax: 1, docsExaminedP95: 1, keysExaminedMax: 1, returnedMax: 0, p50Ms: 2, p95Ms: 2, maxMs: 2 },
    ])
  })

  it('leaves out the profiler reading itself and operations that read no collection', () => {
    const summary = summarizeProfile([
      { op: 'query', ns: 'bench.system.profile', command: { find: 'system.profile', filter: {} }, planSummary: 'COLLSCAN', docsExamined: 5, millis: 0 },
      { op: 'command', ns: 'bench.$cmd', command: { endSessions: [] }, millis: 0 },
      { op: 'command', ns: 'bench.SwarmHead', command: { commitTransaction: 1 }, millis: 0 },
    ])
    expect(summary).toEqual({ operations: 0, collscans: 0, p95Ms: null, shapes: [] })
  })
})

describe('renderProfile', () => {
  it('states the KPI lines first, then one row per shape with its plan and what it read', () => {
    const summary = summarizeProfile([find({ tabId: 'a' }, { millis: 25, docsExamined: 120, planSummary: 'COLLSCAN' })])
    expect(renderProfile({ ...summary, peakConnections: 7 }).split('\n')).toEqual([
      '## Database operations (Mongo profiler)',
      '',
      'Operations: 1. Full collection scans: 1. p95: 25 ms. Peak server connections: 7.',
      '',
      '| Collection | Op | Filter shape | Count | COLLSCAN | Plans | Docs read p95 | Docs read max | Returned max | p50 ms | p95 ms | max ms |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
      '| SwarmGroup | aggregate | `{"tabId":"?"}` | 1 | 1 | COLLSCAN | 120 | 120 | 1 | 25 | 25 | 25 |',
      '',
    ])
  })
})
