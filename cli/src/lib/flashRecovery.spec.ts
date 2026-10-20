import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DialVerdicts } from '../cable/dialPortVerdicts.js'
import type { DialPort } from '../cable/serial.js'
import { completeFlash } from './flashRecovery.js'

const a: DialPort = { path: 'COM3', serialNumber: 'FIXTURE-A', session: 'attachment-a', vendorId: 0x303a, productId: 0x1001 }
const b: DialPort = { ...a, path: 'COM4', serialNumber: 'FIXTURE-B', session: 'attachment-b' }
const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(ports: DialPort[] = [a, b]) {
  const dir = mkdtempSync(join(tmpdir(), 'flash-recovery-')); directories.push(dir)
  const verdictFile = join(dir, 'dial-ports.json')
  const before = new DialVerdicts(verdictFile)
  before.markForeign(a); before.markForeign(b)
  const stopDiscovery = vi.fn()
  return { verdictFile, findPorts: async () => ports, stopDiscovery }
}

describe('a successful flash while the daemon was stopped', () => {
  it('forgets only the selected board, persisting before the next daemon reads the unchanged attachment', async () => {
    const f = fixture()
    await completeFlash('com3', f)
    const after = new DialVerdicts(f.verdictFile)
    expect(after.isForeign(a)).toBe(false)
    expect(after.isForeign(b)).toBe(true)
    expect(f.stopDiscovery).toHaveBeenCalledOnce()
  })

  it.each([
    ['missing', [b]],
    ['ambiguous COM port', [a, { ...b, path: a.path }]],
    ['ambiguous board identity', [a, { ...b, serialNumber: a.serialNumber }]],
    ['case-insensitive duplicate identity', [a, { ...b, serialNumber: a.serialNumber!.toLowerCase() }]],
    ['missing stable identity', [{ ...a, serialNumber: undefined }, b]],
    ['empty stable identity', [{ ...a, serialNumber: '' }, b]],
  ] as const)('preserves every verdict when the selected board is %s', async (_reason, ports) => {
    const f = fixture([...ports])
    const bytes = readFileSync(f.verdictFile, 'utf8')
    await expect(completeFlash('COM3', f)).rejects.toThrow(/identify/)
    expect(readFileSync(f.verdictFile, 'utf8')).toBe(bytes)
    expect(f.stopDiscovery).toHaveBeenCalledOnce()
  })

  it('closes the read-only watch when discovery fails', async () => {
    const f = fixture()
    const bytes = readFileSync(f.verdictFile, 'utf8')
    await expect(completeFlash('COM3', { ...f, findPorts: async () => { throw new Error('discovery failed') } })).rejects.toThrow('discovery failed')
    expect(readFileSync(f.verdictFile, 'utf8')).toBe(bytes)
    expect(f.stopDiscovery).toHaveBeenCalledOnce()
  })

  it('rejects a malformed port without touching the persisted verdicts', async () => {
    const f = fixture()
    const bytes = readFileSync(f.verdictFile, 'utf8')
    await expect(completeFlash('COM3 & COM4', f)).rejects.toThrow(/COM port/)
    expect(readFileSync(f.verdictFile, 'utf8')).toBe(bytes)
    expect(f.stopDiscovery).toHaveBeenCalledOnce()
  })
})
