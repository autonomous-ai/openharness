import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { feedbackText, runCheck } from './loop.js'
import type { StepSpawner } from './steps.js'

/** The detached shells `sh` spawned: each is its own process-group leader. */
const leaders: ChildProcess[] = []
const sh: StepSpawner = (script, opts) => {
  const child = spawn('/bin/sh', ['-c', script], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  leaders.push(child)
  return child
}
const realKill = process.kill.bind(process)

describe('loop checks', () => {
  let cwd: string
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'loop-')) })
  afterEach(() => {
    vi.useRealTimers(); vi.restoreAllMocks()
    // Only shells this test spawned and that were not reaped yet: a reaped pid may belong to someone else by now.
    for (const child of leaders) {
      if (child.pid && child.exitCode === null && child.signalCode === null) for (const target of [-child.pid, child.pid]) { try { process.kill(target, 'SIGKILL') } catch { /* gone */ } }
    }
    leaders.length = 0
    rmSync(cwd, { recursive: true, force: true })
  })
  const check = (cmd: string, timeoutMs?: number) => runCheck(cmd, { cwd, logDir: join(cwd, '.harness/loop'), number: 1, env: { X: 'y' }, spawn: sh, timeoutMs }).result
  it('classifies a check by how it ended, with its logs in the loop folder', async () => {
    expect(await check('test "$X" = y')).toEqual({ kind: 'passed' })
    expect(await check('echo bad >&2; exit 2')).toEqual({ kind: 'failed', how: 'exit 2', tail: 'bad' })
    expect(readFileSync(join(cwd, '.harness/loop/1.stderr.log'), 'utf8')).toBe('bad\n')
    expect(await check('echo only out; exit 3')).toEqual({ kind: 'failed', how: 'exit 3', tail: 'only out' })
    expect(await check('sleep 5', 200)).toEqual({ kind: 'timeout' }) // the check's own limit, not a test delay
    expect(await runCheck('x', { cwd, logDir: join(cwd, 'l'), number: 1, env: {}, spawn: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }) } }).result)
      .toEqual({ kind: 'could-not-start', error: 'the shell could not be found (ENOENT)' })
    expect(await check('kill -TERM $$')).toEqual({ kind: 'failed', how: 'stopped by SIGTERM', tail: '' })
  })
  it('reports a check whose log could not be written as an error', async () => {
    mkdirSync(join(cwd, '.harness/loop/1.stdout.log'), { recursive: true })
    expect(await check('true')).toMatchObject({ kind: 'error', error: expect.stringMatching(/^could not write 1\.stdout\.log/) })
  })
  it('never throws when it cannot prepare the check', async () => {
    writeFileSync(join(cwd, 'file'), '')
    const run = runCheck('true', { cwd, logDir: join(cwd, 'file', 'loop'), number: 1, env: {}, spawn: sh })
    expect(run.handle.armed()).toBe(false)
    run.handle.stop()
    expect(await run.handle.done).toMatchObject({ started: false })
    expect(await run.result).toMatchObject({ kind: 'error', error: expect.stringMatching(/^the check could not be prepared: ENOTDIR/) })
  })
  it.each([
    ['.harness', 'elsewhere', '.harness is a link'],
    ['.harness/loop', 'elsewhere', '.harness/loop is a link'],
  ])('refuses a log folder where %s is a link, and writes nothing through it', async (link, target, message) => {
    mkdirSync(join(cwd, target)); mkdirSync(join(cwd, link, '..'), { recursive: true }); symlinkSync(join(cwd, target), join(cwd, link))
    const run = runCheck('true', { cwd, logDir: join(cwd, '.harness/loop'), number: 1, env: {}, spawn: sh })
    expect(run.handle.armed()).toBe(false)
    expect(await run.result).toEqual({ kind: 'error', error: `the check could not be prepared: ${message}` })
    expect(leaders).toHaveLength(0)
    expect(existsSync(join(cwd, target, 'loop'))).toBe(false)
    expect(existsSync(join(cwd, target, '1.stdout.log'))).toBe(false)
  })
  it('replaces a log left at its name instead of writing through it', async () => {
    writeFileSync(join(cwd, 'precious'), 'keep')
    mkdirSync(join(cwd, '.harness/loop'), { recursive: true }); symlinkSync(join(cwd, 'precious'), join(cwd, '.harness/loop/1.stdout.log'))
    expect(await check('echo new')).toEqual({ kind: 'passed' })
    expect(readFileSync(join(cwd, 'precious'), 'utf8')).toBe('keep')
    expect(readFileSync(join(cwd, '.harness/loop/1.stdout.log'), 'utf8')).toBe('new\n')
  })
  it('calls a check whose group could not be confirmed gone uncertain, and stays armed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const fake = Object.assign(new EventEmitter(), { pid: 999_999, stdout: new PassThrough(), stderr: new PassThrough() })
    // Only the fake pid answers (its group never goes away); every other call reaches the real function.
    vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => Math.abs(target) === 999_999 ? true : realKill(target, signal)) as typeof process.kill)
    const run = runCheck('x', { cwd, logDir: join(cwd, 'l'), number: 1, env: {}, spawn: () => fake as unknown as ChildProcess })
    fake.emit('exit', 0, null); fake.emit('close')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await run.result).toEqual({ kind: 'uncertain' })
    expect(run.handle.armed()).toBe(true)
  })
  it('writes feedback the agent can act on, at most 4000 characters', () => {
    const text = feedbackText({ how: 'exit 1', tail: `start${'x'.repeat(5000)}end` }, 2, 3, '.harness/loop/2.stderr.log')
    expect(text.startsWith('Check failed (exit 1), iteration 2 of 3. Fix it and end your turn. Full log: .harness/loop/2.stderr.log\n\n')).toBe(true)
    expect(text.endsWith('end')).toBe(true)
    expect(text.length).toBe(4000)
    const head = (logPath: string) => `Check failed (exit 1), iteration 1 of 1. Fix it and end your turn. Full log: ${logPath}\n\n`
    const exact = 'p'.repeat(4000 - head('').length)
    expect(feedbackText({ how: 'exit 1', tail: 'lost' }, 1, 1, exact)).toBe(head(exact))
    expect(feedbackText({ how: 'exit 1', tail: 'lost' }, 1, 1, 'p'.repeat(5000))).toBe(head('p'.repeat(5000)).slice(0, 4000))
    expect(feedbackText({ how: 'exit 1', tail: 'short' }, 1, 1, 'l')).toBe('Check failed (exit 1), iteration 1 of 1. Fix it and end your turn. Full log: l\n\nshort')
  })
})
