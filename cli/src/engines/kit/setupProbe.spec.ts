import type { execFile, ExecFileException } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { createSetupProbeExecutor } from './setupProbe.js'

const executor = createSetupProbeExecutor()
afterEach(() => executor.close())
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
  const requests = Array.from({ length: 9 }, () => new Promise<string | number | null | undefined>(resolve => {
    own.execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { encoding: 'utf8' }, error => resolve(error?.code))
  }))
  expect(await requests[8]).toBe('SETUP_PROBE_BUSY')
  own.close()
  expect(await Promise.all(requests.slice(0, 8))).toEqual(Array(8).fill('SETUP_PROBE_CANCELLED'))
})
