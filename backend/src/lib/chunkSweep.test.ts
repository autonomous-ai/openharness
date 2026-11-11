import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeChunk, startChunkSweep } from './chunkSweep.js'

const RANGE = { updatedAt: { $lt: { $date: '2026-05-08T00:00:00.000Z' } } }
const CHUNK = { collection: 'SuperTabReadMark', filter: RANGE, sort: { updatedAt: 1 as const }, hint: 'read_mark_expiry', chunk: 3 }

/** A database whose find answers [found] ids, and whose delete removes as many as it is given; it records every command. */
function database(found: string[], deleteAnswer?: (ids: string[]) => unknown) {
  const commands: Record<string, unknown>[] = []
  const db = { $runCommandRaw: vi.fn(async (command: Record<string, unknown>) => {
    commands.push(command)
    if ('find' in command) return { cursor: { firstBatch: found.map(_id => ({ _id })) } }
    const ids = ((command.deletes as Array<{ q: { _id: { $in: string[] } } }>)[0]).q._id.$in
    return deleteAnswer ? deleteAnswer(ids) : { n: ids.length }
  }) }
  return { db: db as never, commands }
}

describe('removeChunk', () => {
  it('reads one bounded chunk of ids by the index it names, the whole chunk in one batch', async () => {
    const { db, commands } = database(['a', 'b', 'c'])
    await removeChunk(db, CHUNK)
    expect(commands[0]).toEqual({ find: 'SuperTabReadMark', filter: RANGE, projection: { _id: 1 }, sort: { updatedAt: 1 }, hint: 'read_mark_expiry',
      limit: 3, batchSize: 3, singleBatch: true })
  })

  it('removes exactly those ids by _id, their range checked again so one moved since the read stays', async () => {
    const { db, commands } = database(['a', 'b', 'c'], () => ({ n: 2 }))
    await expect(removeChunk(db, CHUNK)).resolves.toBe(2)
    expect(commands[1]).toEqual({ delete: 'SuperTabReadMark', deletes: [{ q: { _id: { $in: ['a', 'b', 'c'] }, ...RANGE }, limit: 0, hint: { _id: 1 } }] })
  })

  it('sends no delete when nothing is past the range', async () => {
    const { db, commands } = database([])
    await expect(removeChunk(db, CHUNK)).resolves.toBe(0)
    expect(commands).toHaveLength(1)
  })

  it('fails when the database refuses a removal', async () => {
    const { db } = database(['a'], () => ({ n: 0, writeErrors: [{ code: 2 }] }))
    await expect(removeChunk(db, CHUNK)).rejects.toThrow('The database refused some removals from SuperTabReadMark')
  })
})

describe('startChunkSweep', () => {
  afterEach(() => { vi.useRealTimers() })
  const lines = () => {
    const logged: string[] = []
    return { logged, log: { info: (message: string) => logged.push(`info ${message}`), warn: (message: string) => logged.push(`warn ${message}`) } }
  }

  it('runs a pass at once and every everyMs, and skips one due while the last still runs', async () => {
    vi.useFakeTimers()
    let release = () => {}
    const pass = vi.fn(() => new Promise<{ removed: number; done: boolean }>(resolve => { release = () => resolve({ removed: 0, done: false }) }))
    const stop = startChunkSweep({ label: '[test]', everyMs: 1000, pass, log: lines().log })
    expect(pass).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(pass).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(1000)
    expect(pass).toHaveBeenCalledTimes(2)
    stop()
  })

  it('logs each pass that removed some, and stops once a pass says it is done', async () => {
    vi.useFakeTimers()
    const answers = [{ removed: 3, done: false }, { removed: 0, done: false }, { removed: 2, done: true }]
    const pass = vi.fn(async () => answers.shift() ?? { removed: 0, done: true })
    const { logged, log } = lines()
    startChunkSweep({ label: '[test]', everyMs: 1000, pass, doneMessage: 'done: nothing left', log })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pass).toHaveBeenCalledTimes(3)
    expect(logged).toEqual(['info [test] pass', 'info [test] pass', 'info [test] done: nothing left'])
  })

  it('logs a failed pass and carries on with the next; an error the caller handles is not logged as a failure', async () => {
    vi.useFakeTimers()
    const errors = [new Error('connection closed'), new Error('handled')]
    const pass = vi.fn(async () => {
      const error = errors.shift()
      if (error) throw error
      return { removed: 1, done: false }
    })
    const { logged, log } = lines()
    const stop = startChunkSweep({ label: '[test]', everyMs: 1000, pass, log, handle: error => (error as Error).message === 'handled' })
    await vi.advanceTimersByTimeAsync(2000)
    stop()
    expect(logged).toEqual(['warn [test] pass failed; retrying next pass', 'info [test] pass'])
  })
})
