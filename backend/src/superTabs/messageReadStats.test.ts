import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordMessageRead, startMessageReadStats } from './messageReadStats.js'

describe('messages by reader', () => {
  let stop = () => {}
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  it('counts reads per reader and cursor, with batches and rows, and names nothing', () => {
    const logged: Array<[string, Record<string, unknown>]> = []
    stop = startMessageReadStats({ everyMs: 60_000, log: (message, context) => logged.push([message, context]) })
    recordMessageRead({ reader: 'person', cursor: 'before', session: 'sso' }, 2, 202, 100)
    recordMessageRead({ reader: 'person', cursor: 'before', session: 'sso' }, 2, 202, 100)
    recordMessageRead({ reader: 'agent', cursor: 'latest', session: 'computer' }, 1, 101, 100)
    vi.advanceTimersByTime(60_000)
    expect(logged).toHaveLength(1)
    const [message, context] = logged[0]!
    expect(message).toBe('messages by reader')
    expect(context.windowMs).toBe(60_000)
    expect(context.rows).toEqual([
      { reader: 'person', cursor: 'before', session: 'sso', n: 2, batches: 4, decoded: 404, shown: 200 },
      { reader: 'agent', cursor: 'latest', session: 'computer', n: 1, batches: 1, decoded: 101, shown: 100 },
    ])
    expect(JSON.stringify(context)).not.toMatch(/[0-9a-f]{12,}|@/i)
  })

  it('logs nothing for a quiet minute, and starts each window empty', () => {
    const logged: Array<Record<string, unknown>> = []
    stop = startMessageReadStats({ everyMs: 60_000, log: (_message, context) => logged.push(context) })
    recordMessageRead({ reader: 'buddy', cursor: 'after', session: 'sso' }, 1, 0, 0)
    vi.advanceTimersByTime(180_000)
    expect(logged).toEqual([{ windowMs: 60_000, rows: [{ reader: 'buddy', cursor: 'after', session: 'sso', n: 1, batches: 1, decoded: 0, shown: 0 }] }])
  })

  it('keeps nothing while stopped, and logs what is left when it stops', () => {
    recordMessageRead({ reader: 'person', cursor: 'latest', session: 'sso' }, 1, 1, 1)
    const logged: Array<Record<string, unknown>> = []
    stop = startMessageReadStats({ everyMs: 60_000, log: (_message, context) => logged.push(context) })
    stop()
    expect(logged).toEqual([])
    stop = startMessageReadStats({ everyMs: 60_000, log: (_message, context) => logged.push(context) })
    recordMessageRead({ reader: 'person', cursor: 'catchUp', session: 'team' }, 1, 3, 2)
    vi.advanceTimersByTime(10_000)
    stop()
    expect(logged).toEqual([{ windowMs: 10_000, rows: [{ reader: 'person', cursor: 'catchUp', session: 'team', n: 1, batches: 1, decoded: 3, shown: 2 }] }])
  })
})
