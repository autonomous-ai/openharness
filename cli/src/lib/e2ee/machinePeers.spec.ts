import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../../config/env.js'
import { MachinePeerStore } from './machinePeers.js'

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
    const peers = new MachinePeerStore()
    for (let i = 0; i < 300; i++) peers.markGone(i.toString(16).padStart(32, '0'))
    const gone = peers.gone()
    expect(gone.size).toBe(256)
    expect(gone.has((299).toString(16).padStart(32, '0'))).toBe(true)
    expect(gone.has((0).toString(16).padStart(32, '0'))).toBe(false)
  })

  // Review of #2101 (Batch S): restore() runs in the machine-list callback, and a mark file it cannot rewrite (a full or
  // read-only disk) threw out of it. The machine is back for this process all the same, and the log says so.
  it('is back even when the file cannot be rewritten, without throwing', () => {
    const peers = new MachinePeerStore()
    peers.markGone(a)
    const file = join(env.ADAPTER_DATA_DIR, 'e2e', 'machinePeers-gone.json')
    chmodSync(file, 0o400)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(peers.restore([a])).toBe(true)
      expect(peers.gone().has(a)).toBe(false)
      expect(new MachinePeerStore().gone().has(a)).toBe(false)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record'))
      // Marked gone again later, it is gone again.
      chmodSync(file, 0o600)
      peers.markGone(a)
      expect(peers.gone().has(a)).toBe(true)
    } finally {
      chmodSync(file, 0o600)
      warn.mockRestore()
    }
  })
})
