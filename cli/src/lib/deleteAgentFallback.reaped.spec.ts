import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { checkPidRuntime } from './deleteAgentFallback.js'
import { ownProcessGroup } from './windows/noWindow.js'

const rows = vi.hoisted(() => vi.fn(async () => null))
vi.mock('./processTable.js', async original => ({ ...await original<object>(), processRows: rows }))

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'uses the real kernel absence of a reaped child without asking an unavailable census', async () => {
    const root = mkdtempSync(join(tmpdir(), 'reaped-engine-proof-'))
    const child = spawn(process.execPath, ['-e', ''], {
      ...ownProcessGroup(), stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: root },
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        closed = true
        if (code === 0 && signal === null) resolve()
        else reject(new Error('fixture child did not exit successfully'))
      })
    })
    try {
      await Promise.race([completion, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('fixture child exit timed out')), 5_000)
      })])
      expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      expect(await checkPidRuntime({ engine: 'hermes', processIdentity: {
        pid: child.pid!, executable: process.execPath, startMarker: 'owned reaped fixture',
      } })).toMatchObject({ state: 'gone' })
      expect(rows).not.toHaveBeenCalled()
    } finally {
      clearTimeout(timer)
      if (!closed) child.kill('SIGKILL')
      await completion.catch(() => {})
      if (closed) rmSync(root, { recursive: true, force: true })
    }
  },
)
