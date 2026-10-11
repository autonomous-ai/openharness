import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LIMITS, type Message } from './model.js'
import { MessageStore } from './store.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'store-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const message = (n: number, tabId = 'app'): Message => ({
  id: `m${String(n).padStart(7, '0')}`, tabId, text: `t${n}`, at: n,
  from: { machineId: 'm1', agentId: 'a', name: 'a', engine: 'claude', machine: 'studio' },
  to: [{ machineId: 'm1', agentId: 'b', name: 'b' }],
})

describe('Agent Messages\' saved state', () => {
  it('starts empty, saves privately, and reads back only what parses', () => {
    const store = new MessageStore(join(dir, 'state'))
    expect(store.state).toEqual({ history: [], local: [], outbox: [], noted: {}, notes: {} })
    store.record(message(1))
    store.state.local.push({ key: 'k', messageId: 'm0000001', agentId: 'b', pane: '%1', state: 'queued', tries: 0, nextTryAt: 0, at: 0 })
    store.state.outbox.push({ messageId: 'm0000001', machineId: 'm2', nextTryAt: 0, tries: 0 })
    store.state.noted.b = 'sig'
    store.state.notes.b = { pane: '%1', key: '0note-sig', signature: 'sig' }
    store.save()
    const again = new MessageStore(join(dir, 'state'))
    expect(again.state.history.map((e) => e.message.id)).toEqual(['m0000001'])
    expect(again.state.local).toHaveLength(1)
    expect(again.state.outbox).toHaveLength(1)
    expect(again.state.noted).toEqual({ b: 'sig' })
    expect(again.state.notes).toEqual({ b: { pane: '%1', key: '0note-sig', signature: 'sig' } })
    writeFileSync(join(dir, 'state', 'state.json'), JSON.stringify({ history: [{ message: { id: 'bad' } }, { message: message(2) }], local: [null, { key: 1 }], outbox: [null], noted: 'x', notes: [] }))
    const partial = new MessageStore(join(dir, 'state'))
    expect(partial.state).toEqual({ history: [{ message: message(2), statuses: [] }], local: [], outbox: [], noted: {}, notes: {} })
  })

  it('keeps an unreadable file for a person to inspect, never reading it as empty', () => {
    mkdirSync(join(dir, 'state'))
    writeFileSync(join(dir, 'state', 'state.json'), '{')
    const store = new MessageStore(join(dir, 'state'))
    expect(store.state.history).toEqual([])
    expect(readdirSync(join(dir, 'state')).some((name) => name.startsWith('state.json.unreadable-'))).toBe(true)
  })

  it('keeps each tab\'s newest messages, and never one still waiting here', () => {
    const store = new MessageStore(join(dir, 'state'))
    store.record(message(1))
    store.state.local.push({ key: 'k', messageId: 'm0000001', agentId: 'b', pane: '%1', state: 'queued', tries: 0, nextTryAt: 0, at: 0 })
    for (let n = 2; n <= LIMITS.history + 5; n++) store.record(message(n))
    store.record(message(9_999_999, 'other'))
    const app = store.state.history.filter((e) => e.message.tabId === 'app')
    expect(app).toHaveLength(LIMITS.history + 1)
    expect(app[0].message.id).toBe('m0000001')
    expect(store.record(message(1))).toBe(app[0])
  })

  it('records what became of a message per recipient; a final state is final', () => {
    const store = new MessageStore(join(dir, 'state'))
    const status = (state: 'queued' | 'delivered' | 'failed', reason?: string) => ({ messageId: 'm0000001', machineId: 'm1', agentId: 'b', state, at: 1, ...(reason ? { reason } : {}) })
    expect(store.status(status('queued'))).toBe(false)
    store.record(message(1))
    expect(store.status(status('queued'))).toBe(true)
    expect(store.status(status('queued'))).toBe(false)
    expect(store.status(status('queued', 'working'))).toBe(true)
    expect(store.status(status('delivered'))).toBe(true)
    expect(store.status(status('queued'))).toBe(false)
    expect(store.entry('m0000001')!.statuses).toEqual([status('delivered')])
  })
})
