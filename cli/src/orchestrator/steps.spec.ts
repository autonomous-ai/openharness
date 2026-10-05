// cli/src/orchestrator/steps.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as shell from '../dsh/shell.js'
import { STEP_LOG_LIMIT, processGone, startStep, stepFailure, type StepSpawner } from './steps.js'

/** While `hold` is set, every log file opened from then on finishes closing only once it settles. */
const logGate = vi.hoisted(() => ({ hold: null as Promise<void> | null }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const createWriteStream = ((...args: Parameters<typeof fs.createWriteStream>) => {
    const out = fs.createWriteStream(...args)
    const hold = logGate.hold
    if (hold) {
      const end = out.end.bind(out) as (...rest: unknown[]) => unknown
      out.end = ((...rest: unknown[]) => { void hold.then(() => end(...rest)); return out }) as typeof out.end
    }
    return out
  }) as typeof fs.createWriteStream
  return { ...fs, createWriteStream }
})
/** Keeps the logs of the next step closing until the returned release is called. */
const holdLogs = (): (() => void) => {
  let release!: () => void
  logGate.hold = new Promise(resolve => { release = resolve })
  return () => { logGate.hold = null; release() }
}

/** The detached shells `sh` spawned: each is its own process-group leader. */
const leaders: ChildProcess[] = []
const sh: StepSpawner = (script, opts) => {
  const child = spawn('/bin/sh', ['-c', script], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  leaders.push(child)
  return child
}
const fakeChild = ({ pid }: { pid?: number }) => Object.assign(new EventEmitter(), { pid, stdout: new PassThrough(), stderr: new PassThrough() })
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

describe('shell steps', () => {
  let cwd: string
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'steps-')) })
  const pids: number[] = []
  afterEach(() => { logGate.hold = null; for (const child of leaders) { if (child.pid && child.exitCode === null && child.signalCode === null) for (const target of [-child.pid, child.pid]) { try { process.kill(target, 'SIGKILL') } catch { /* gone */ } } } for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } pids.length = 0; leaders.length = 0; vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true }) })

  it('keeps a 4000-character tail but a failure text of at most 2000', async () => {
    const step = startStep(`printf '%5000s' x | tr ' ' a; exit 1`, { cwd, env: {}, spawn: sh })
    const result = await step.done
    expect(result.stdoutTail).toHaveLength(4000)
    expect(stepFailure(result).length).toBeLessThanOrEqual(2000)
  })
  it('writes its logs where it is told to', async () => {
    const logs = join(cwd, 'logs'); mkdirSync(logs)
    await startStep('echo out; echo err >&2', { cwd, env: {}, spawn: sh, logs: { stdout: join(logs, 'o.log'), stderr: join(logs, 'e.log') } }).done
    expect(readFileSync(join(logs, 'o.log'), 'utf8')).toBe('out\n')
    expect(readFileSync(join(logs, 'e.log'), 'utf8')).toBe('err\n')
    expect(existsSync(join(cwd, 'stdout.log'))).toBe(false)
  })
  it('runs in the task folder with env inputs that stay literal', async () => {
    const result = await startStep('pwd; printf "%s" "$HARNESS_INPUT_X"; echo warn >&2', { cwd, env: { HARNESS_INPUT_X: '$(echo pwned)"\'' }, spawn: sh }).done
    expect(result).toMatchObject({ code: 0, signal: null, error: null, started: true })
    expect(readFileSync(join(cwd, 'stdout.log'), 'utf8')).toContain(`$(echo pwned)"'`)
    expect(readFileSync(join(cwd, 'stderr.log'), 'utf8')).toBe('warn\n')
  })
  it('reports failures with the output tail, never the script, within 2000 chars', async () => {
    const result = await startStep('echo secret-script >/dev/null; echo boom >&2; exit 3', { cwd, env: {}, spawn: sh }).done
    expect(stepFailure(result)).toBe('exit 3: boom')
    expect(stepFailure({ code: 1, signal: null, error: null, started: true, stdoutTail: 'only stdout\n', stderrTail: '' })).toBe('exit 1: only stdout')
    expect(stepFailure({ code: null, signal: 'SIGTERM', error: null, started: true, stdoutTail: '', stderrTail: '' })).toBe('stopped by SIGTERM')
    expect(stepFailure({ code: 1, signal: null, error: null, started: true, stdoutTail: '', stderrTail: 'x'.repeat(5000) })).toHaveLength(2000)
  })
  it('stops descendants that ignore SIGTERM, even after the shell is gone', async () => {
    const step = startStep(`sh -c 'trap "" TERM; echo $$ > child.pid; while :; do sleep 1; done' & wait`, { cwd, env: {}, spawn: sh, graceMs: 200 })
    await vi.waitFor(() => expect(readFileSync(join(cwd, 'child.pid'), 'utf8')).toMatch(/\d+\n/))
    const child = Number(readFileSync(join(cwd, 'child.pid'), 'utf8'))
    pids.push(child)
    step.stop()
    await step.done
    await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 3000 })
  })
  it('ends only once the leftovers of its group are gone, even with their output redirected', async () => {
    const step = startStep(`sh -c 'trap "" TERM; echo $$ > child.pid; while :; do sleep 1; done' >/dev/null 2>&1 & sleep 0.3; exit 1`, { cwd, env: {}, spawn: sh, graceMs: 300 })
    await vi.waitFor(() => expect(readFileSync(join(cwd, 'child.pid'), 'utf8')).toMatch(/\d+\n/))
    const child = Number(readFileSync(join(cwd, 'child.pid'), 'utf8'))
    pids.push(child)
    expect(await step.done).toMatchObject({ code: 1, error: null })
    expect(alive(child)).toBe(false)
  })
  it('kills the whole group at once when stopped now', async () => {
    const step = startStep(`sh -c 'trap "" TERM; echo $$ > child.pid; while :; do sleep 1; done' & wait`, { cwd, env: {}, spawn: sh, graceMs: 30_000 })
    await vi.waitFor(() => expect(readFileSync(join(cwd, 'child.pid'), 'utf8')).toMatch(/\d+\n/))
    const child = Number(readFileSync(join(cwd, 'child.pid'), 'utf8'))
    pids.push(child)
    step.stop({ now: true })
    await vi.waitFor(() => expect(alive(child)).toBe(false), { timeout: 1000 })
    step.stop() // a graceful stop afterwards changes nothing
    expect(await step.done).toMatchObject({ signal: 'SIGKILL', error: null })
  })
  it('is disarmed once its group is gone, so a later stop sends nothing', async () => {
    const killed = vi.spyOn(process, 'kill')
    const step = startStep('sleep 5', { cwd, env: {}, spawn: sh, graceMs: 60_000 }) // escalation far in the future
    expect(step.armed()).toBe(true)
    step.stop() // SIGTERM now; SIGKILL scheduled in 60 s
    await step.done
    expect(step.armed()).toBe(false)
    const sigkills = () => killed.mock.calls.filter(([, signal]) => signal === 'SIGKILL').length
    const before = sigkills()
    step.stop(); step.stop({ now: true })
    expect(sigkills()).toBe(before)
  })
  it('cancels the escalation timer once the group is gone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fake = fakeChild({ pid: 4242 })
      const signals: Array<[number, unknown]> = []
      vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: unknown) => {
        if (Math.abs(target) !== 4242) return true
        if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' }) // the group probe: gone
        signals.push([target, signal]); return true
      }) as typeof process.kill)
      const step = startStep('x', { cwd, env: {}, spawn: () => fake as never, graceMs: 1000 })
      step.stop() // SIGTERM now, SIGKILL scheduled at +1000 ms
      fake.emit('exit', 0, null); fake.emit('close')
      await vi.advanceTimersByTimeAsync(500) // before the escalation: the step ends and disarms
      await step.done
      expect(step.armed()).toBe(false)
      const before = signals.length
      await vi.advanceTimersByTimeAsync(5000) // well past the escalation
      expect(signals.slice(before)).toEqual([]) // no SIGKILL fired after the group was gone
    } finally { vi.useRealTimers() }
  })
  /** Fakes `process.kill` for one fake pid: the group probe answers `alive()`, every other signal is recorded. */
  const fakeKill = (pid: number, alive: () => boolean): unknown[] => {
    const signals: unknown[] = []
    vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: unknown) => {
      if (Math.abs(target) !== pid) return true
      if (signal === 0) { if (alive()) return true; throw Object.assign(new Error('gone'), { code: 'ESRCH' }) }
      signals.push(signal); return true
    }) as typeof process.kill)
    return signals
  }
  it('sends no SIGKILL after the group is gone even while its logs are still closing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const release = holdLogs()
    try {
      const fake = fakeChild({ pid: 4243 })
      const signals = fakeKill(4243, () => false)
      const step = startStep('x', { cwd, env: {}, spawn: () => fake as never, graceMs: 1000 })
      step.stop()
      fake.emit('exit', 0, null); fake.emit('close')
      let ended = false
      void step.done.then(() => { ended = true })
      await vi.advanceTimersByTimeAsync(1500) // the logs are held closing while the escalation time passes
      expect(ended).toBe(false)
      expect(signals).not.toContain('SIGKILL')
      release()
      await step.done
      expect(step.armed()).toBe(false)
      expect(signals).not.toContain('SIGKILL')
    } finally { release(); vi.useRealTimers() }
  })
  it('sends no SIGKILL once the group is gone while a leftover still holds its pipes open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fake = fakeChild({ pid: 4244 })
      const signals = fakeKill(4244, () => false) // the whole group is gone
      const step = startStep('x', { cwd, env: {}, spawn: () => fake as never, graceMs: 1000 })
      step.stop() // SIGTERM now, SIGKILL due at +1000 ms
      fake.emit('exit', 0, null) // no close yet: an escaped process keeps a pipe open
      await vi.advanceTimersByTimeAsync(1000) // the escalation comes due before the step ends
      expect(signals).toEqual(['SIGTERM', 'SIGTERM'])
      expect(step.armed()).toBe(false)
      fake.emit('close')
      await step.done
      expect(signals).toEqual(['SIGTERM', 'SIGTERM'])
    } finally { vi.useRealTimers() }
  })
  it('still sends the SIGKILL while a process of the group is alive', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fake = fakeChild({ pid: 4245 })
      let alive = true
      const signals = fakeKill(4245, () => alive)
      const step = startStep('x', { cwd, env: {}, spawn: () => fake as never, graceMs: 1000 })
      step.stop()
      fake.emit('exit', null, 'SIGTERM') // the leader is gone; a descendant ignoring SIGTERM is not
      await vi.advanceTimersByTimeAsync(1000)
      expect(signals).toEqual(['SIGTERM', 'SIGTERM', 'SIGKILL', 'SIGKILL'])
      expect(step.armed()).toBe(true)
      alive = false
      fake.emit('close')
      await vi.advanceTimersByTimeAsync(100)
      expect(await step.done).toMatchObject({ signal: 'SIGTERM', error: null })
      expect(step.armed()).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it('is never armed when the shell could not be spawned', async () => {
    const step = startStep('x', { cwd, env: {}, spawn: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }) } })
    expect(step.armed()).toBe(false)
    await step.done
  })
  it('says so when it cannot confirm its group stopped', async () => {
    const kill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 0) throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
      return kill(pid, signal)
    })
    const fake = Object.assign(new EventEmitter(), { pid: 999_999, stdout: null, stderr: null }) as unknown as ChildProcess
    const step = startStep('true', { cwd, env: {}, spawn: () => fake, graceMs: 10 })
    fake.emit('exit', 0, null); fake.emit('close', 0, null)
    expect(await step.done).toMatchObject({ code: 0, error: 'processes it started could not be confirmed stopped' })
  })
  it('does not wait forever for pipes a leftover process keeps open', async () => {
    const result = await startStep('(trap "" TERM; sleep 30) & echo done', { cwd, env: {}, spawn: sh, graceMs: 200 }).done
    expect(result).toMatchObject({ code: 0, stdoutTail: 'done\n' })
  })
  it('caps each log and keeps a readable tail', async () => {
    const result = await startStep(`head -c ${STEP_LOG_LIMIT + 4096} /dev/zero | tr '\\0' 'a'; printf 'é-end'`, { cwd, env: {}, spawn: sh }).done
    expect(statSync(join(cwd, 'stdout.log')).size).toBeLessThan(STEP_LOG_LIMIT + 100)
    expect(readFileSync(join(cwd, 'stdout.log'), 'utf8').endsWith('[output truncated]\n')).toBe(true)
    expect(result.stdoutTail.endsWith('é-end')).toBe(true)
  })
  it('stops the step when its log cannot be written', async () => {
    mkdirSync(join(cwd, 'stdout.log')) // opening a folder as a file fails (EISDIR)
    const result = await startStep('sleep 30', { cwd, env: {}, spawn: sh, graceMs: 200 }).done
    expect(result.error).toMatch(/^could not write stdout\.log: /)
  })
  it('turns spawn failures into worded results', async () => {
    const thrown = (error: Error): StepSpawner => () => { throw error }
    expect(await startStep('true', { cwd, env: {}, spawn: thrown(Object.assign(new Error('x'), { code: 'ENOENT' })) }).done).toMatchObject({ error: 'the shell could not be found (ENOENT)', started: false })
    expect((await startStep('true', { cwd, env: {}, spawn: thrown(Object.assign(new Error('x'), { code: 'EACCES' })) }).done).error).toBe('the shell is not executable (EACCES)')
    const plain = startStep('true', { cwd, env: {}, spawn: thrown(new Error('weird')) })
    plain.stop() // no process: a no-op
    expect((await plain.done).error).toBe('the shell could not start (unknown error)')
    const nul = await startStep('echo secret\0script', { cwd, env: {}, spawn: sh }).done
    expect(nul.error).toMatch(/^the shell could not start \(ERR_/)
    expect(nul.error).not.toContain('secret')
    const missing: StepSpawner = (_s, o) => spawn(join(cwd, 'missing-shell'), [], { cwd: o.cwd, stdio: 'ignore' }) // async ENOENT, no pipes
    expect(await startStep('true', { cwd, env: {}, spawn: missing }).done).toMatchObject({ code: 127, error: 'the shell could not be found (ENOENT)', started: false })
  })
  it('keeps an error reported by a process that did start', async () => {
    const fake = Object.assign(new EventEmitter(), { pid: 999_999, stdout: null, stderr: null }) as unknown as ChildProcess
    const step = startStep('true', { cwd, env: {}, spawn: () => fake, graceMs: 10 })
    fake.emit('error', new Error('kill failed'))
    fake.emit('exit', 1, null); fake.emit('close', 1, null)
    expect(await step.done).toMatchObject({ code: 1, error: "the step's process reported an error (unknown error)", started: true })
  })
  it('names the code of a running process error', async () => {
    const fake = Object.assign(new EventEmitter(), { pid: 999_999, stdout: null, stderr: null }) as unknown as ChildProcess
    const step = startStep('x', { cwd, env: {}, spawn: () => fake, graceMs: 10 })
    fake.emit('error', Object.assign(new Error('pipe'), { code: 'EPIPE' }))
    fake.emit('exit', 1, null); fake.emit('close', 1, null)
    expect((await step.done).error).toBe("the step's process reported an error (EPIPE)")
  })
  it('settles once when a process that never started also reports an exit', async () => {
    const fake = Object.assign(new EventEmitter(), { pid: undefined, stdout: null, stderr: null }) as unknown as ChildProcess
    const step = startStep('true', { cwd, env: {}, spawn: () => fake, graceMs: 10 })
    fake.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))
    fake.emit('exit', 1, null); fake.emit('close', 1, null)
    expect(await step.done).toMatchObject({ code: 127, error: 'the shell could not be found (ENOENT)' })
  })
  it('stops the step when its output stream errors', async () => {
    const stdout = new PassThrough()
    const fake = Object.assign(new EventEmitter(), { pid: 999_999, stdout, stderr: null }) as unknown as ChildProcess
    const step = startStep('true', { cwd, env: {}, spawn: () => fake, graceMs: 10 })
    stdout.emit('error', new Error('pipe broke'))
    fake.emit('exit', null, 'SIGTERM'); fake.emit('close', null, 'SIGTERM')
    expect(await step.done).toMatchObject({ code: 127, error: 'could not read the step output: pipe broke' })
  })
  it('truncates at the exact limit when a chunk straddles it', async () => {
    const stdout = new PassThrough()
    const fake = Object.assign(new EventEmitter(), { pid: 999_999, stdout, stderr: null }) as unknown as ChildProcess
    const step = startStep('true', { cwd, env: {}, spawn: () => fake, graceMs: 10 })
    stdout.write(Buffer.alloc(STEP_LOG_LIMIT - 2, 'a')); stdout.write(Buffer.alloc(10, 'b')); stdout.write('ignored')
    await new Promise(r => setImmediate(r))
    fake.emit('exit', 0, null); fake.emit('close', 0, null)
    await step.done
    const log = readFileSync(join(cwd, 'stdout.log'), 'utf8')
    expect(log.endsWith('bb\n[output truncated]\n')).toBe(true)
    expect(log.length).toBe(STEP_LOG_LIMIT + '\n[output truncated]\n'.length)
  })
  it('uses the login-shell spawner by default', async () => {
    const spy = vi.spyOn(shell, 'spawnDshCommand').mockImplementation((script, opts) => sh(script, { cwd: opts.cwd, env: opts.env ?? {} }))
    await startStep('true', { cwd, env: { A: '1' } }).done
    expect(spy).toHaveBeenCalledWith('true', { cwd, env: { A: '1' } })
  })
  it('counts a recorded process as gone only when its leader and its group are gone', () => {
    const real = process.kill.bind(process)
    const answers = new Map<number, string | null>([[999_999, 'ESRCH'], [-999_999, null]])
    vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => {
      if (!answers.has(target)) return real(target, signal as NodeJS.Signals)
      const code = answers.get(target)
      if (code) throw Object.assign(new Error(code), { code })
      return true
    }) as typeof process.kill)
    expect(processGone(999_999)).toBe(false) // the leader exited, a process of its group still runs
    answers.set(-999_999, 'ESRCH'); expect(processGone(999_999)).toBe(true)
    answers.set(999_999, 'EPERM'); expect(processGone(999_999)).toBe(false) // a probe we may not make counts as alive
    answers.set(999_999, null); expect(processGone(999_999)).toBe(false)
    answers.set(999_999, 'ESRCH'); answers.set(-999_999, 'EPERM'); expect(processGone(999_999)).toBe(false)
  })
})
