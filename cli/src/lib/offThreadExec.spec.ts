import { execFile, execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enableOffThreadExec, execFileOffThread, offThreadExecActive, probeExecFile, resetOffThreadExec,
  stopProbeWorkerForTest, type ProbeOptions,
} from './offThreadExec.js'
import { launchEnvironment, clearLaunchEnvironmentCache } from '../engines/kit/launchExecutable.js'
import { clearProcessEnvCache, readProcessEnv } from './processEnv.js'

// The real execFile, watched: a probe the route sends to the worker must never reach it on this thread.
// The worker's own child_process is its thread's, untouched by this mock.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

afterEach(() => { resetOffThreadExec(); vi.unstubAllEnvs() })

const call = (file: string, args: string[], options: ProbeOptions = {}) =>
  new Promise<{ error: (Error & Record<string, unknown>) | null; stdout: string; stderr: string; killed?: boolean }>((resolve) => {
    const child = execFileOffThread(file, args, options, (error, stdout, stderr) =>
      resolve({ error: error as never, stdout, stderr, killed: child.killed }))
  })

describe('probes spawned from a worker thread', () => {
  it('answers what the child printed', async () => {
    expect(await call('echo', ['still here'])).toMatchObject({ error: null, stdout: 'still here\n', stderr: '' })
  })

  it('passes an exit code through with both outputs', async () => {
    const { error, stdout, stderr } = await call('sh', ['-c', 'echo out; echo err >&2; exit 3'])
    expect(error).toMatchObject({ code: 3 })
    expect([stdout, stderr]).toEqual(['out\n', 'err\n'])
  })

  it('reports a binary that does not exist as execFile does', async () => {
    expect((await call('/no/such/binary', [])).error).toMatchObject({ code: 'ENOENT' })
  })

  it('times a child out in the worker, killed with the signal asked for', async () => {
    const { error, killed } = await call('sleep', ['5'], { timeout: 100, killSignal: 'SIGKILL' })
    expect(error).toMatchObject({ killed: true, signal: 'SIGKILL' })
    expect(killed).toBe(true)
  })

  it('kills a child from the main thread', async () => {
    const answered = new Promise<Error | null>((resolve) => {
      const child = execFileOffThread('sleep', ['5'], {}, (error) => resolve(error))
      setTimeout(() => child.kill('SIGKILL'), 50)
    })
    expect(await answered).toMatchObject({ signal: 'SIGKILL' })
  })

  it('ends the child\'s stdin, so a probe that reads it finishes', async () => {
    // The launch-environment capture is an interactive login shell, which reads stdin.
    expect(await call('sh', ['-c', 'cat; echo done'], { timeout: 5_000 })).toMatchObject({ error: null, stdout: 'done\n' })
  })

  it('stops reading at maxBuffer, as execFile does', async () => {
    const { error } = await call('sh', ['-c', 'yes | head -c 5000'], { maxBuffer: 100 })
    expect(error).toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
  })

  it('runs the child in the environment the caller has now, not the one the worker started with', async () => {
    // The core prepends tmux's folder to PATH after it starts (tmuxOnPath.ts): a worker's own copy of
    // process.env, made at its start, would find another tmux.
    vi.stubEnv('HARNESS_PROBE_ENV', 'before')
    expect((await call('sh', ['-c', 'printf %s "$HARNESS_PROBE_ENV"'])).stdout).toBe('before')
    vi.stubEnv('HARNESS_PROBE_ENV', 'after')
    expect((await call('sh', ['-c', 'printf %s "$HARNESS_PROBE_ENV"'])).stdout).toBe('after')
    expect((await call('sh', ['-c', 'printf %s "$HARNESS_PROBE_ENV"'], { env: { HARNESS_PROBE_ENV: 'given' } })).stdout).toBe('given')
  })

  it('fails the calls in flight when the worker dies, and starts a new one for the next', async () => {
    const inFlight = call('sleep', ['5'])
    await new Promise((resolve) => setTimeout(resolve, 50))
    await stopProbeWorkerForTest()
    expect((await inFlight).error).toMatchObject({ code: 'EWORKER' })
    expect(await call('echo', ['again'])).toMatchObject({ error: null, stdout: 'again\n' })
  })

  it('keeps a process alive while a probe is in flight, as a child of its own would', () => {
    // Found by CI: a signed-out `harness start` awaited a probe with nothing else holding its loop yet, and
    // exited 0 mid-start, because the worker was unref'd even while it owed an answer.
    const module = fileURLToPath(new URL('./offThreadExec.ts', import.meta.url))
    const script = `import(${JSON.stringify(module)}).then(m => m.execFileOffThread('sh', ['-c', 'sleep 0.3; echo answered'], {}, (e, out) => process.stdout.write(out)))`
    expect(execFileSync(process.execPath, ['--import', 'tsx', '-e', script], { timeout: 10_000, encoding: 'utf8' })).toBe('answered\n')
  })

  it('lets a script that used it exit: the worker never keeps a process alive', () => {
    const module = fileURLToPath(new URL('./offThreadExec.ts', import.meta.url))
    const script = `import(${JSON.stringify(module)}).then(m => m.execFileOffThread('echo', ['x'], {}, () => {}))`
    // Throws if the process is still running after 10 s.
    execFileSync(process.execPath, ['--import', 'tsx', '-e', script], { timeout: 10_000 })
  })
})

describe('the route the core turns on', () => {
  it('is off until the core enables it, and probeExecFile calls the execFile it was given', () => {
    expect(offThreadExecActive()).toBe(false)
    const inThread = vi.fn((_f: string, _a: string[], _o: object, done: (...a: unknown[]) => void) => { done(null, 'mocked', ''); return { kill: () => true } })
    const done = vi.fn()
    probeExecFile(inThread)('ps', ['-ax'], { timeout: 10 }, done)
    expect(inThread).toHaveBeenCalledWith('ps', ['-ax'], { timeout: 10 }, done)
    expect(done).toHaveBeenCalledWith(null, 'mocked', '')
  })

  it('sends probes to the worker once enabled', async () => {
    enableOffThreadExec()
    expect(offThreadExecActive()).toBe(true)
    const inThread = vi.fn()
    const stdout = await new Promise<string>((resolve) => { probeExecFile(inThread)('echo', ['worker'], {}, (_e, out) => resolve(out)) })
    expect(stdout).toBe('worker\n')
    expect(inThread).not.toHaveBeenCalled()
  })

  it('falls back to the main thread for good after the worker dies twice in a minute', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    enableOffThreadExec()
    await call('echo', ['one'])
    await stopProbeWorkerForTest()
    await call('echo', ['two'])
    await stopProbeWorkerForTest()
    expect(offThreadExecActive()).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    const inThread = vi.fn()
    probeExecFile(inThread)('echo', [], {}, () => {})
    expect(inThread).toHaveBeenCalledOnce()
  })
})

describe('the probes that called execFile directly', () => {
  afterEach(() => { clearProcessEnvCache(); clearLaunchEnvironmentCache() })

  it.runIf(process.platform === 'darwin')('reads a process environment through the worker', async () => {
    enableOffThreadExec()
    // A Node child with a mark of its own: `ps eww` shows a process's environment as it started, and Apple's
    // platform binaries (sleep, sh) refuse to show theirs at all.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { env: { ...process.env, HARNESS_PROBE_MARK: 'marked' }, stdio: 'ignore' })
    try {
      const env = await readProcessEnv({ pid: child.pid!, startMarker: 'x', executable: process.execPath } as never)
      expect(env?.HARNESS_PROBE_MARK).toBe('marked')
    } finally { child.kill() }
  })

  it('captures the launch environment through the worker', async () => {
    enableOffThreadExec()
    const env = await launchEnvironment('/bin/sh')
    expect(env?.HOME).toBe(process.env.HOME)
  })

  it('does not spawn on this thread once the route is on', async () => {
    enableOffThreadExec()
    vi.mocked(execFile).mockClear()
    await launchEnvironment('/bin/sh')
    if (process.platform === 'darwin') await readProcessEnv({ pid: process.pid, startMarker: 'y', executable: process.execPath } as never)
    expect(execFile).not.toHaveBeenCalled()
  })
})
