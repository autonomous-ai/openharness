import type { execFile, ExecFileException } from 'node:child_process'
import * as processes from 'node:child_process'
import { once } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createSetupProbeExecutor } from './setupProbe.js'

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
let executor: ReturnType<typeof createSetupProbeExecutor>
beforeEach(() => { executor = createSetupProbeExecutor() })
afterEach(() => { executor.close(); vi.restoreAllMocks(); vi.clearAllMocks() })
function run(script: string, options: { maxBuffer?: number; timeout?: number } = {}) {
  let child!: ReturnType<typeof execFile>
  const result = new Promise<{ error: ExecFileException | null; stdout: string; stderr: string }>(resolve => {
    child = executor.execute(process.execPath, ['-e', script], { encoding: 'utf8', ...options },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  return { result, cancel: () => child.kill('SIGKILL') }
}

it('returns stdout, stderr and the actual probe exit status without splitting UTF-8', async () => {
  const okay = await run("process.stdout.write('ready 😺'); process.stderr.write('note')").result
  expect(okay).toEqual({ error: null, stdout: 'ready 😺', stderr: 'note' })
  const failed = await run("process.stdout.write('before'); process.exit(7)").result
  expect(failed.error?.code).toBe(7); expect(failed.stdout).toBe('before')
})

it('bounds output and cancels the child when its caller cancels', async () => {
  const excessive = await run("process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)", { maxBuffer: 32 }).result
  expect(excessive.error?.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  expect(excessive.stdout.length).toBeLessThanOrEqual(32)
  const pending = run('setInterval(() => {}, 1000)')
  pending.cancel()
  expect((await pending.result).error?.code).toBe('SETUP_PROBE_CANCELLED')
})

it('caps in-flight helpers and settles all admitted work when setup closes', async () => {
  const own = createSetupProbeExecutor()
  own.warmOnce()
  const requests = Array.from({ length: 9 }, () => new Promise<string | number | null | undefined>(resolve => {
    own.execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { encoding: 'utf8' }, error => resolve(error?.code))
  }))
  expect(await requests[8]).toBe('SETUP_PROBE_BUSY')
  own.close()
  expect(await Promise.all(requests.slice(0, 8))).toEqual(Array(8).fill('SETUP_PROBE_CANCELLED'))
})

it('warms once after use and consumes that exact keeper without creating another', async () => {
  const spawn = vi.mocked(processes.spawn), own = createSetupProbeExecutor()
  expect(spawn).not.toHaveBeenCalled()
  own.warmOnce(); own.warmOnce()
  expect(spawn).toHaveBeenCalledTimes(1)
  const keeper = spawn.mock.results[0]!.value as processes.ChildProcess
  try {
    const exited = once(keeper, 'exit')
    const result = new Promise<string>((resolve, reject) => {
      const used = own.execute(process.execPath, ['-e', "process.stdout.write('ready')"], { encoding: 'utf8' },
        (error, stdout) => error ? reject(error) : resolve(stdout))
      expect(used === keeper).toBe(true)
    })
    expect(await result).toBe('ready'); await exited
    own.warmOnce()
    expect(spawn).toHaveBeenCalledTimes(1)
  } finally { own.close() }
})

it('expires an unused keeper under its own deadline and never replenishes it on cached requests', { timeout: 12_000 }, async () => {
  const spawn = vi.mocked(processes.spawn), own = createSetupProbeExecutor(), start = performance.now()
  own.warmOnce()
  const keeper = spawn.mock.results[0]!.value as processes.ChildProcess
  try {
    expect((await once(keeper, 'exit'))[0]).toBe(0)
    expect(performance.now() - start).toBeGreaterThanOrEqual(4500)
    own.warmOnce(); expect(spawn).toHaveBeenCalledTimes(1)
    const result = await new Promise<string>((resolve, reject) => {
      own.execute(process.execPath, ['-e', "process.stdout.write('fresh')"], { encoding: 'utf8' },
        (error, stdout) => error ? reject(error) : resolve(stdout))
    })
    expect(result).toBe('fresh'); expect(spawn).toHaveBeenCalledTimes(2)
  } finally { own.close() }
})

it('names a refused warmup once, then admits only an actual requested probe', async () => {
  const spawn = vi.mocked(processes.spawn), warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  spawn.mockImplementationOnce(() => { throw Error('fixture spawn refused') })
  const own = createSetupProbeExecutor()
  own.warmOnce(); own.warmOnce()
  expect(warning).toHaveBeenCalledExactlyOnceWith('[engine-setup] SETUP_PROBE_WARMUP_UNAVAILABLE · Error')
  expect(spawn).toHaveBeenCalledTimes(1)
  try {
    const result = await new Promise<string>((resolve, reject) => {
      own.execute(process.execPath, ['-e', "process.stdout.write('requested')"], { encoding: 'utf8' },
        (error, stdout) => error ? reject(error) : resolve(stdout))
    })
    expect(result).toBe('requested'); expect(spawn).toHaveBeenCalledTimes(2)
    own.warmOnce(); expect(spawn).toHaveBeenCalledTimes(2)
  } finally { own.close() }
})

it('cancels an unused keeper on stop without creating a later replacement', async () => {
  const spawn = vi.mocked(processes.spawn), own = createSetupProbeExecutor()
  own.warmOnce()
  const keeper = spawn.mock.results[0]!.value as processes.ChildProcess, exited = once(keeper, 'exit')
  own.close(); expect((await exited)[0]).toBe(0)
  own.warmOnce(); expect(spawn).toHaveBeenCalledTimes(1)
})
