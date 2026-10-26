import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resetBoard } from './boardReset.js'

describe('resetting a board over its cable', () => {
  it('holds RTS with DTR low for 200 ms, then lets go: the pulse esptool calls a hard reset', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }))
    expect(await resetBoard('/dev/cu.usbmodem143101', { platform: 'darwin', run })).toBe(true)
    // TIOCMSET is _IOW('t', 109, int) on macOS; TIOCM_RTS = 0x004.
    expect(run).toHaveBeenCalledWith('perl', ['-e', expect.any(String), '/dev/cu.usbmodem143101', '0x8004746d', '4:200', '0:200'], { timeout: 5000 })
    run.mockClear()
    expect(await resetBoard('/dev/ttyACM0', { platform: 'linux', run })).toBe(true)
    expect(run).toHaveBeenCalledWith('perl', ['-e', expect.any(String), '/dev/ttyACM0', '0x5418', '4:200', '0:200'], { timeout: 5000 })
  })

  it('says it could not, and runs nothing, where there is no way to set the lines', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }))
    expect(await resetBoard('COM3', { platform: 'win32', run })).toBe(false)
    expect(run).not.toHaveBeenCalled()
    // No perl on the PATH: the failed spawn is a "no", never a throw.
    const missing = vi.fn(async () => { throw Object.assign(new Error('spawn perl ENOENT'), { code: 'ENOENT' }) })
    expect(await resetBoard('/dev/cu.usbmodem1', { platform: 'darwin', run: missing })).toBe(false)
  })

  // Windows has no /dev/null tty to refuse the lines, and the reset is never attempted there (the case above).
  it.skipIf(process.platform === 'win32')('is a script the real perl runs, and a port that refuses the lines is a "no"', async () => {
    // /dev/null opens but is no tty, so the ioctl fails: exit 3 says the script parsed and got as far as the
    // first TIOCMSET (a syntax error would be 255, a failed open 2), and it still comes back as a plain "no".
    let code: unknown
    const run = async (file: string, args: string[], options: { timeout: number }) => {
      try { return await promisify(execFile)(file, args, options) } catch (error) { code = (error as { code?: unknown }).code; throw error }
    }
    expect(await resetBoard('/dev/null', { platform: process.platform, run })).toBe(false)
    expect(code).toBe(3)
  })
})
