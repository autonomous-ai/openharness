import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dataDir = ''

describe('removePidFileIf', () => {
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'adapter-launch-')) })
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); delete process.env.ADAPTER_DATA_DIR })

  it('removes the file only when it names the given pid', async () => {
    vi.resetModules()
    process.env.ADAPTER_DATA_DIR = dataDir
    const { PID_FILE, removePidFileIf } = await import('./daemonState.js')
    writeFileSync(PID_FILE, '777\n')
    expect(removePidFileIf(778)).toBe(false)
    expect(existsSync(PID_FILE)).toBe(true) // another daemon's record survives our failed child
    expect(removePidFileIf(undefined)).toBe(false)
    expect(removePidFileIf(777)).toBe(true)
    expect(existsSync(PID_FILE)).toBe(false)
  })
})
