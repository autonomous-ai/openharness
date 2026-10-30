import { describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from '../processTable.js'
import { terminateVerified, type TerminateDeps } from './terminate.js'

const row = (pid: number, startMarker: string): ProcessRow => ({ pid, parentPid: 1, executable: 'node.exe', startMarker, args: 'node cli.js __run' })

function deps(rows: ProcessRow[] | null, kill: TerminateDeps['kill'] = vi.fn()): TerminateDeps {
  return { rows: async () => rows, kill }
}

describe('ending one Windows process', () => {
  it('ends the process it was meant to, after checking it is still that process', async () => {
    const kill = vi.fn()
    await expect(terminateVerified(500, 'w:1', deps([row(500, 'w:1')], kill))).resolves.toBe('ended')
    expect(kill).toHaveBeenCalledWith(500)
  })

  it('ends nothing when the pid is gone, was given to another process, or cannot be identified', async () => {
    const kill = vi.fn()
    await expect(terminateVerified(500, 'w:1', deps([row(501, 'w:1')], kill))).resolves.toBe('gone')
    await expect(terminateVerified(500, 'w:1', deps([row(500, 'w:2')], kill))).resolves.toBe('mismatch')
    await expect(terminateVerified(500, 'w:1', deps(null, kill))).resolves.toBe('mismatch')
    await expect(terminateVerified(500, 'w:1', { rows: async () => { throw new Error('no host') }, kill })).resolves.toBe('mismatch')
    await expect(terminateVerified(500, '', deps([row(500, '')], kill))).resolves.toBe('mismatch')
    await expect(terminateVerified(process.pid, 'w:1', deps([row(process.pid, 'w:1')], kill))).resolves.toBe('mismatch')
    await expect(terminateVerified(0, 'w:1', deps([], kill))).resolves.toBe('mismatch')
    expect(kill).not.toHaveBeenCalled()
  })

  it('reads a process that left between the check and the end as gone', async () => {
    const gone = vi.fn(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) })
    await expect(terminateVerified(500, 'w:1', deps([row(500, 'w:1')], gone))).resolves.toBe('gone')
    const refused = vi.fn(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) })
    await expect(terminateVerified(500, 'w:1', deps([row(500, 'w:1')], refused))).resolves.toBe('mismatch')
  })
})
