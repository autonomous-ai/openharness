import { afterEach, expect, it, vi } from 'vitest'
import { readOffThread, resetOffThreadSqlite } from './sqliteThread.js'

const workers = vi.hoisted(() => [] as Array<{ messages: Array<Record<string, unknown>>; emit(event: string, value: unknown): boolean }>)
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return { Worker: class extends EventEmitter {
    messages: Array<Record<string, unknown>> = []
    constructor() { super(); workers.push(this) }
    postMessage(message: Record<string, unknown>) { this.messages.push(message) }
    ref() {} unref() {}
    async terminate() { this.emit('exit', 0); return 0 }
  } }
})
afterEach(async () => { await resetOffThreadSqlite(); workers.length = 0 })

it('never joins a fresh checkpoint read to a pre-existing in-flight poll', async () => {
  const old = readOffThread('/store', 'SELECT body FROM messages', [], 250, 5_000, 1024)
  const fresh = readOffThread('/store', 'SELECT body FROM messages', [], 250, 5_000, 1024, true)
  expect(workers).toHaveLength(2)
  expect(workers[1].messages[0].fresh).toBe(true)
  workers[1].emit('message', { id: workers[1].messages[0].id, ok: true, rows: [{ body: 'current' }] })
  workers[0].emit('message', { id: workers[0].messages[0].id, ok: true, rows: [{ body: 'old' }] })
  expect(await fresh).toMatchObject({ ok: true, rows: [{ body: 'current' }] })
  expect(await old).toMatchObject({ ok: true, rows: [{ body: 'old' }] })
})

it('keeps ordinary reads coalesced while fresh reads each get their own operation', async () => {
  const first = readOffThread('/store', 'SELECT 1', [], 250, 5_000, 1024)
  const joined = readOffThread('/store', 'SELECT 1', [], 250, 5_000, 1024)
  expect(workers).toHaveLength(1)
  const a = readOffThread('/store', 'SELECT 1', [], 250, 5_000, 1024, true)
  const b = readOffThread('/store', 'SELECT 1', [], 250, 5_000, 1024, true)
  expect(workers).toHaveLength(2)
  workers[1].emit('message', { id: workers[1].messages[0].id, ok: true, rows: [{ value: 2 }] })
  expect(workers[1].messages).toHaveLength(2)
  workers[1].emit('message', { id: workers[1].messages[1].id, ok: true, rows: [{ value: 3 }] })
  workers[0].emit('message', { id: workers[0].messages[0].id, ok: true, rows: [{ value: 1 }] })
  expect(await first).toEqual(await joined)
  expect(await a).toMatchObject({ rows: [{ value: 2 }] })
  expect(await b).toMatchObject({ rows: [{ value: 3 }] })
})
