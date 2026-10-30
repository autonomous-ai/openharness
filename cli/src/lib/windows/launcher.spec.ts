import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { LAUNCH_TIMEOUT_MS, launchDetached, type LaunchRun } from './launcher.js'

function fakeRun(end: (child: EventEmitter) => void) {
  const runs: Array<{ file: string; args: readonly string[]; options: object }> = []
  const run: LaunchRun = (file, args, options) => {
    runs.push({ file, args, options })
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    queueMicrotask(() => end(child))
    return child as unknown as ChildProcess
  }
  return { run, runs }
}

describe('the windowless launcher', () => {
  it('is given its root and the CLI\'s arguments, hidden, with this environment, and has started them once it exits 0', async () => {
    const { run, runs } = fakeRun((child) => child.emit('exit', 0, null))
    await expect(launchDetached('C:\\h\\bin\\harness-launch.exe', 'C:\\h', ['start', '--if-down'], { A: '1' }, run)).resolves.toEqual({ ok: true })
    expect(runs).toEqual([{ file: 'C:\\h\\bin\\harness-launch.exe', args: ['--root', 'C:\\h', '--', 'start', '--if-down'], options: { env: { A: '1' }, windowsHide: true, stdio: 'ignore' } }])
  })

  it('says why it could not start them: an exit code and where it logged, a launcher that cannot run, one that hangs', async () => {
    const failed = await launchDetached('C:\\h\\bin\\harness-launch.exe', 'C:\\h', ['__harnessd'], {}, fakeRun((child) => child.emit('exit', 3, null)).run)
    expect(failed).toEqual({ ok: false, detail: `C:\\h\\bin\\harness-launch.exe exited 3 — see ${join('C:\\h', 'cli', 'data', 'logs', 'launch.log')}` })
    // Ended by TerminateProcess: Windows' -1, not Node's unsigned 4294967295.
    const ended = await launchDetached('L', 'C:\\h', ['__harnessd'], {}, fakeRun((child) => child.emit('exit', 0xffff_ffff, null)).run)
    expect(ended).toEqual({ ok: false, detail: `L exited -1 — see ${join('C:\\h', 'cli', 'data', 'logs', 'launch.log')}` })
    const missing = await launchDetached('L', 'C:\\h', [], {}, fakeRun((child) => child.emit('error', new Error('spawn L ENOENT'))).run)
    expect(missing).toEqual({ ok: false, detail: 'L could not be run: spawn L ENOENT' })
    const thrown = await launchDetached('L', 'C:\\h', [], {}, () => { throw new Error('EMFILE') })
    expect(thrown).toEqual({ ok: false, detail: 'L could not be run: EMFILE' })
    vi.useFakeTimers()
    try {
      // Cast, not annotated: assigned only in a callback, an annotated `null` stays narrowed to null (TS2339 below).
      let hung = null as (EventEmitter & { kill: ReturnType<typeof vi.fn> }) | null
      const pending = launchDetached('L', 'C:\\h', [], {}, fakeRun((child) => { hung = child as never }).run)
      await vi.advanceTimersByTimeAsync(LAUNCH_TIMEOUT_MS)
      await expect(pending).resolves.toEqual({ ok: false, detail: `L did not return within ${LAUNCH_TIMEOUT_MS} ms` })
      expect(hung!.kill).toHaveBeenCalled()
      hung!.emit('exit', 0, null)
    } finally { vi.useRealTimers() }
  })
})
