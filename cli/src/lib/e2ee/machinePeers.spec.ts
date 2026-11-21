import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../../config/env.js'
import { StateFileUnreadable } from '../secureState.js'
import { MachinePeerStore, machinePeerFiles } from './machinePeers.js'

const FILE = join(env.ADAPTER_DATA_DIR, 'e2e', 'machinePeers.json')
const GONE_FILE = join(env.ADAPTER_DATA_DIR, 'e2e', 'machinePeers-gone.json')

// Pass-through until a test fills the disk: a write then stops part way, as ENOSPC leaves it. `failedReads`: the next
// reads of the gone list that fail (EIO), as a scanner or a full descriptor table fails them.
const disk = vi.hoisted(() => ({ full: false, failedReads: 0 }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (disk.failedReads > 0 && String(args[0]).endsWith('machinePeers-gone.json')) {
        disk.failedReads--
        throw Object.assign(new Error('EIO: fixture'), { code: 'EIO' })
      }
      return actual.readFileSync(...args)
    }) as typeof actual.readFileSync,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (!disk.full) return actual.writeFileSync(...args)
      actual.writeFileSync(args[0], String(args[1]).slice(0, 8))
      throw Object.assign(new Error('ENOSPC: fixture'), { code: 'ENOSPC' })
    },
  }
})

beforeEach(() => { rmSync(FILE, { force: true }); rmSync(GONE_FILE, { force: true }) })
afterEach(() => { disk.full = false; disk.failedReads = 0; vi.restoreAllMocks() })

/** A machine the backend said was deleted (remoteRelay.ts): unpinned and remembered, so the trust group does not pin it
 *  again (groupSyncer.ts), until the account's machine list shows it again. */
describe('a machine marked gone', () => {
  const a = 'a'.repeat(32)
  const b = 'b'.repeat(32)
  beforeEach(() => { const peers = new MachinePeerStore(); peers.restore(peers.gone()); for (const p of peers.list()) peers.unlink(p.machineId) })

  it('loses its pin, and the mark outlives the store that made it', () => {
    const peers = new MachinePeerStore()
    peers.pin(a, 'pub-a', 'A'); peers.pin(b, 'pub-b', 'B')
    peers.markGone(a)
    expect(peers.get(a)).toBeNull()
    expect(peers.get(b)?.pub).toBe('pub-b')
    expect([...new MachinePeerStore().gone()]).toEqual([a])
  })

  it('is cleared once the machine list shows it again, and only then', () => {
    const peers = new MachinePeerStore()
    peers.markGone(a)
    expect(peers.restore([b])).toBe(false)
    expect(peers.gone().has(a)).toBe(true)
    expect(peers.restore([b, a])).toBe(true)
    expect(peers.gone().has(a)).toBe(false)
  })

  it('keeps only the most recent 256', () => {
    const id = (n: number) => n.toString(16).padStart(32, '0')
    const saved = Array.from({ length: 256 }, (_, i) => id(i))
    // Exercise retention at the boundary without hundreds of unrelated durable setup writes.
    mkdirSync(join(env.ADAPTER_DATA_DIR, 'e2e'), { recursive: true, mode: 0o700 })
    writeFileSync(GONE_FILE, JSON.stringify(saved), { mode: 0o600 })
    const peers = new MachinePeerStore()
    peers.markGone(id(0))
    expect([...peers.gone()]).toEqual([...saved.slice(1), id(0)])
    peers.markGone(id(256))
    const expected = [...saved.slice(2), id(0), id(256)]
    expect([...peers.gone()]).toEqual(expected)
    expect([...new MachinePeerStore().gone()]).toEqual(expected)
    expect(JSON.parse(readFileSync(GONE_FILE, 'utf8'))).toEqual(expected)
  })

  // Review of #2101 (Batch S): restore() runs in the machine-list callback, and a mark file it cannot rewrite (a full or
  // read-only disk) threw out of it. The machine is back for this process all the same, and the log says so.
  it('is back even when the file cannot be rewritten, without throwing', () => {
    const peers = new MachinePeerStore()
    peers.markGone(a)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    disk.full = true
    expect(peers.restore([a])).toBe(true)
    expect(peers.gone().has(a)).toBe(false)
    expect(new MachinePeerStore().gone().has(a)).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record'))
    // Marked gone again later, it is gone again.
    disk.full = false
    peers.markGone(a)
    expect(peers.gone().has(a)).toBe(true)
  })
})

/** A file an older build was writing in place, or a disk that filled: read as nothing pinned, and never written over,
 *  which would leave one pin where there were many. Made whole again, it is used again. */
describe('a pin file that cannot be read', () => {
  const a = 'a'.repeat(32)
  const b = 'b'.repeat(32)
  const c = 'c'.repeat(32)
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })

  it('a torn machinePeers.json is never written over', () => {
    writeFileSync(FILE, '[{"machineId":"' + a)
    const peers = new MachinePeerStore()
    expect(peers.get(a)).toBeNull(); expect(peers.list()).toEqual([])
    expect(() => peers.pin(b, 'pub-b', 'B')).toThrow(StateFileUnreadable)
    expect(() => peers.unlink(a)).toThrow(StateFileUnreadable)
    expect(readFileSync(FILE, 'utf8')).toBe('[{"machineId":"' + a)
  })

  it('an object where the list should be is unreadable too', () => {
    writeFileSync(FILE, '{}')
    const peers = new MachinePeerStore()
    expect(peers.get(a)).toBeNull(); expect(peers.list()).toEqual([])
    expect(() => peers.pin(b, 'pub-b', 'B')).toThrow(StateFileUnreadable)
    expect(() => peers.unlink(a)).toThrow(StateFileUnreadable)
    expect(readFileSync(FILE, 'utf8')).toBe('{}')
  })

  it('a pin that fails part way leaves the old pins', () => {
    const peers = new MachinePeerStore()
    peers.pin(a, 'pub-a', 'A'); peers.pin(b, 'pub-b', 'B')
    disk.full = true
    expect(() => peers.pin(c, 'pub-c', 'C')).toThrow(/ENOSPC/)
    disk.full = false
    expect(new MachinePeerStore().list().map(p => p.machineId).sort()).toEqual([a, b])
  })

  it('a torn gone list keeps its marks in memory and is not rewritten', () => {
    writeFileSync(GONE_FILE, '["' + b)
    const peers = new MachinePeerStore()
    expect(() => peers.markGone(a)).toThrow(StateFileUnreadable)
    expect(peers.gone().has(a)).toBe(true)
    expect(readFileSync(GONE_FILE, 'utf8')).toBe('["' + b)
    expect(peers.restore([a])).toBe(true)
    expect(peers.gone().has(a)).toBe(false)
    expect(readFileSync(GONE_FILE, 'utf8')).toBe('["' + b)
  })

  // A read that failed read nothing: the marks it holds must not be written over by those in memory alone.
  it('a gone list a read failed on is not written over by a mark or a return', async () => {
    const { READ_TRIES } = await import('../secureState.js')
    const peers = new MachinePeerStore()
    peers.markGone(b)
    peers.markGone(c)
    disk.failedReads = READ_TRIES
    expect(() => peers.markGone(a)).toThrow(StateFileUnreadable)
    expect(JSON.parse(readFileSync(GONE_FILE, 'utf8'))).toEqual([b, c])
    expect(peers.gone().has(a)).toBe(true)
    // Back in memory: the mark only this process held goes, and the file keeps the others.
    disk.failedReads = READ_TRIES
    expect(peers.restore([a])).toBe(true)
    expect(peers.gone().has(a)).toBe(false)
    expect(JSON.parse(readFileSync(GONE_FILE, 'utf8'))).toEqual([b, c])
  })

  it('a file made whole again is used', () => {
    writeFileSync(FILE, '[{"machineId":"' + a)
    const peers = new MachinePeerStore()
    expect(() => peers.pin(b, 'pub-b', 'B')).toThrow(StateFileUnreadable)
    writeFileSync(FILE, JSON.stringify([{ machineId: a, pub: 'pub-a', label: 'A', linkedAt: 1 }]))
    peers.pin(b, 'pub-b', 'B', 2)
    expect(peers.list().map(p => p.machineId)).toEqual([b, a])
  })

  it('names both files, each read as a list, for whoever reports the unreadable ones', () => {
    expect(machinePeerFiles().map(f => f.file)).toEqual([FILE, GONE_FILE])
    for (const { parse } of machinePeerFiles()) {
      expect(parse('["x"]')).toEqual(['x'])
      expect(() => parse('{}')).toThrow()
    }
  })
})
