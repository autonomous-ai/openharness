/**
 * One reader of the process table on every OS: `processRows()` with no source installed. Windows has no `ps`, so a
 * process that has not installed the daemon's source (`harness uninstall`, for one) reads harness-pty's table there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execFile: vi.fn(), windowsProcessRows: vi.fn() }))
vi.mock('child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('child_process')>(), execFile: mocks.execFile }))
vi.mock('./windows/processTable.js', () => ({ windowsProcessRows: mocks.windowsProcessRows }))

import { processRows, setProcessTableSource, type ProcessRow } from './processTable.js'

const HOST_EXE = 'C:\\Users\\u\\.harness\\runtime\\pty\\0.5.0\\harness-pty.exe'
const WINDOWS_ROWS: ProcessRow[] = [{ pid: 4120, parentPid: 1, executable: HOST_EXE, startMarker: 'w:1', args: `"${HOST_EXE}" serve` }]
const PS_ROW = '  123     1 claude          Mon Sep 21 10:00:00 2026 claude --resume\n'

describe('processRows with no source installed', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => {
    setProcessTableSource(null)
    mocks.execFile.mockReset().mockImplementation((_file, _args, _options, done) => { done(null, PS_ROW, ''); return {} })
    mocks.windowsProcessRows.mockReset().mockResolvedValue(WINDOWS_ROWS)
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    setProcessTableSource(null)
  })

  it("on Windows, reads harness-pty's table and runs no ps", async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(await processRows()).toEqual(WINDOWS_ROWS)
    expect(mocks.windowsProcessRows).toHaveBeenCalledWith(null)
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('on Linux, reads ps as before', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    expect(await processRows()).toEqual([expect.objectContaining({ pid: 123, parentPid: 1, args: 'claude --resume' })])
    expect(mocks.execFile).toHaveBeenCalledWith('ps', ['-axo', 'pid=,ppid=,comm=,lstart=,args='], expect.anything(), expect.any(Function))
    expect(mocks.windowsProcessRows).not.toHaveBeenCalled()
  })

  it("on Windows, the daemon's installed source still wins", async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const installed: ProcessRow[] = [{ ...WINDOWS_ROWS[0]!, pid: 4121 }]
    setProcessTableSource(async () => installed)
    expect(await processRows()).toBe(installed)
    expect(mocks.windowsProcessRows).not.toHaveBeenCalled()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })
})
