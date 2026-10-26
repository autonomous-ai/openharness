import { describe, expect, it } from 'vitest'
import { percentile, Recorder } from './metrics.js'

describe('percentile', () => {
  it('takes the nearest rank', () => {
    const values = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6]
    expect(percentile(values, 50)).toBe(5)
    expect(percentile(values, 95)).toBe(10)
    expect(percentile(values, 100)).toBe(10)
    expect(percentile([42], 95)).toBe(42)
  })

  it('is null for no values', () => {
    expect(percentile([], 50)).toBeNull()
  })
})

describe('Recorder', () => {
  it('sums count, retries by code, Swarm busy and errors, and latency per operation and per writer', () => {
    const recorder = new Recorder()
    recorder.add({ op: 'message.send', writer: 'agent-01', ms: 10, failedAttempts: [], outcome: 'ok' })
    recorder.add({ op: 'message.send', writer: 'agent-01', ms: 30, failedAttempts: ['P2034', 'P2034'], outcome: 'ok' })
    recorder.add({ op: 'message.send', writer: 'agent-02', ms: 50, failedAttempts: Array(7).fill('P2034'), outcome: 'SWARM_BUSY' })
    recorder.add({ op: 'work.check', writer: 'agent-02', ms: 20, failedAttempts: ['TRANSIENT'], outcome: 'NOT_FOUND' })

    const send = recorder.byOp().find(row => row.key === 'message.send')!
    expect(send).toEqual({ key: 'message.send', count: 3, ok: 2, conflicts: 9, retriedCalls: 2, swarmBusy: 1, errors: {},
      p50Ms: 30, p95Ms: 50, maxMs: 50, bytes: null })
    const check = recorder.byOp().find(row => row.key === 'work.check')!
    expect(check).toMatchObject({ count: 1, ok: 0, conflicts: 1, retriedCalls: 1, swarmBusy: 0, errors: { NOT_FOUND: 1 } })

    const second = recorder.byWriter().find(row => row.key === 'agent-02')!
    expect(second).toMatchObject({ count: 2, ok: 0, conflicts: 8, retriedCalls: 2, swarmBusy: 1, p50Ms: 20, p95Ms: 50 })
  })

  it('reports bytes per call for readers: mean, p50 and p95', () => {
    const recorder = new Recorder()
    for (const bytes of [100, 200, 300, 400]) recorder.add({ op: 'read.full', writer: 'desktop-0', ms: 5, failedAttempts: [], outcome: 'ok', bytes })
    expect(recorder.byOp()[0]!.bytes).toEqual({ mean: 250, p50: 200, p95: 400, total: 1000 })
  })

  it('counts each writer\'s calls per operation', () => {
    const recorder = new Recorder()
    for (const op of ['message.send', 'message.send', 'work.check']) recorder.add({ op, writer: 'lead', ms: 1, failedAttempts: [], outcome: 'ok' })
    expect(recorder.byWriter()[0]!.byOp).toEqual({ 'message.send': 2, 'work.check': 1 })
  })

  it('totals by kind of writer, so a machine conflicting with group writes shows on its own line', () => {
    const recorder = new Recorder()
    recorder.add({ op: 'message.send', writer: 'worker-01', ms: 1, failedAttempts: ['P2034'], outcome: 'ok' })
    recorder.add({ op: 'native.append', writer: 'worker-12', ms: 1, failedAttempts: [], outcome: 'ok' })
    recorder.add({ op: 'observeMachine', writer: 'machine-3', ms: 1, failedAttempts: ['P2034', 'P2034'], outcome: 'ok' })
    recorder.add({ op: 'read.desktop', writer: 'desktop:bench-0@example.com', ms: 1, failedAttempts: [], outcome: 'ok', bytes: 10 })
    expect(recorder.byWriterKind().map(row => [row.key, row.count, row.conflicts])).toEqual([['desktop', 1, 0], ['machine', 1, 2], ['worker', 2, 1]])
  })

  it('keeps operations and writers in name order', () => {
    const recorder = new Recorder()
    for (const op of ['work.status', 'message.send', 'observeMachine']) recorder.add({ op, writer: `w-${op}`, ms: 1, failedAttempts: [], outcome: 'ok' })
    expect(recorder.byOp().map(row => row.key)).toEqual(['message.send', 'observeMachine', 'work.status'])
    expect(recorder.byWriter().map(row => row.key)).toEqual(['w-message.send', 'w-observeMachine', 'w-work.status'])
  })
})
