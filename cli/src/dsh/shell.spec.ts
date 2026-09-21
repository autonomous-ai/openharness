import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ChildProcess } from 'node:child_process'

// Two switches, both off by default: `sh` makes commands run under plain `/bin/sh -c` (as when no user
// shell is known) so output is exactly the command's; `fakeChild` hands runDshCommand a scripted child.
const seams = vi.hoisted(() => ({ sh: false, fakeChild: null as null | (() => ChildProcess) }))
vi.mock('../lib/engineLaunch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/engineLaunch.js')>()
  return { ...actual, interactiveEngineShell: (shell?: string) => (seams.sh ? null : actual.interactiveEngineShell(shell)) }
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawn = ((...args: Parameters<typeof actual.spawn>) => (seams.fakeChild ? seams.fakeChild() : actual.spawn(...args))) as typeof actual.spawn
  return { ...actual, spawn, default: { ...actual, spawn } }
})

const { managedNodePath } = await import('../lib/nodeRuntime.js')
const { dshNodeFallback, dshShellArgv, isShellNoise, killProcessGroup, runDshCommand, spawnDshCommand } = await import('./shell.js')

describe('dshShellArgv', () => {
  const original = process.env.SHELL
  afterEach(() => { if (original === undefined) delete process.env.SHELL; else process.env.SHELL = original })

  it('runs a bash user\'s setup and doctor as a LOGIN shell, where .bash_profile (and nvm) live', () => {
    process.env.SHELL = '/bin/bash'
    expect(dshShellArgv('./doctor.sh')).toEqual({ path: '/bin/bash', args: ['-lic', `${dshNodeFallback()}\n./doctor.sh`] })
  })

  it('keeps zsh as it already was', () => {
    process.env.SHELL = '/bin/zsh'
    expect(dshShellArgv('./doctor.sh')).toEqual({ path: '/bin/zsh', args: ['-lic', `${dshNodeFallback()}\n./doctor.sh`] })
  })

  it('falls back to /bin/sh -c when no user shell is known', () => {
    seams.sh = true
    try {
      expect(dshShellArgv('./doctor.sh')).toEqual({ path: '/bin/sh', args: ['-c', `${dshNodeFallback()}\n./doctor.sh`] })
    } finally {
      seams.sh = false
    }
  })
})

describe('dshNodeFallback', () => {
  let dir: string
  beforeEach(() => { seams.sh = true; dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-node-'))) })
  afterEach(() => { seams.sh = false; rmSync(dir, { recursive: true, force: true }) })

  it('puts the Node this daemon runs on at the END of a PATH that has no node', async () => {
    const result = await runDshCommand('echo "$PATH"; command -v node', { cwd: dir, env: { PATH: '/usr/bin:/bin' } })
    const runtimeBin = dirname(managedNodePath())
    expect(result.lines).toEqual([`/usr/bin:/bin:${runtimeBin}`, join(runtimeBin, 'node')])
  })

  it('leaves a PATH that already has a node alone', async () => {
    const own = join(dir, 'bin')
    mkdirSync(own)
    writeFileSync(join(own, 'node'), '#!/bin/sh\n', { mode: 0o755 })
    const result = await runDshCommand('echo "$PATH"; command -v node', { cwd: dir, env: { PATH: `${own}:/usr/bin:/bin` } })
    expect(result.lines).toEqual([`${own}:/usr/bin:/bin`, join(own, 'node')])
  })

  it('is one line, run before the command, that keeps an empty PATH from starting with a colon', () => {
    const line = dshNodeFallback()
    expect(line).toContain('"${PATH:+$PATH:}"\'')
    expect(line.startsWith('if ! command -v node >/dev/null 2>&1; then PATH=')).toBe(true)
  })
})

describe('isShellNoise', () => {
  it('drops only what zsh says about zle without a terminal', () => {
    expect(isShellNoise("zsh: can't change option: zle")).toBe(true)
    expect(isShellNoise("(eval):3: can't change option: zle")).toBe(true)
    expect(isShellNoise('ok   zle is a word a doctor might print')).toBe(false)
  })
})

describe('runDshCommand', () => {
  let dir: string
  beforeEach(() => {
    seams.sh = true
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-shell-')))
  })
  afterEach(() => {
    seams.sh = false
    seams.fakeChild = null
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('collects both streams line by line, in the cwd and env it was given, CRLF and partial lines included', async () => {
    const seen: string[] = []
    const result = await runDshCommand(
      `printf 'one\\r\\ntwo\\n'; echo "where $(basename "$PWD") $HARNESS_DSH" >&2; echo "zsh: can't change option: zle"; printf 'tail'`,
      { cwd: dir, env: { HARNESS_DSH: 'acme/thing' }, onLine: (line) => seen.push(line) },
    )
    expect(result.code).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBe(false)
    expect(result.lines).toEqual(expect.arrayContaining(['one', 'two', `where ${dir.split('/').pop()} acme/thing`, 'tail']))
    expect(result.lines).toHaveLength(4)
    expect(result.lines.indexOf('one')).toBeLessThan(result.lines.indexOf('two'))
    expect(result.lines.at(-1)).toBe('tail')
    expect(seen).toEqual(result.lines)
    // and with no env or onLine at all
    expect((await runDshCommand('exit 4', { cwd: dir })).code).toBe(4)
  })

  it('says how a command ended: its exit code, or the signal that ended it', async () => {
    expect(await runDshCommand('echo bye; exit 3', { cwd: dir })).toEqual({ code: 3, signal: null, lines: ['bye'], timedOut: false })
    const killed = await runDshCommand('kill -KILL $$', { cwd: dir })
    expect(killed).toMatchObject({ code: null, signal: 'SIGKILL', timedOut: false })
  })

  it('stops a command that outlives its timeout, and everything it started', async () => {
    const started = Date.now()
    const result = await runDshCommand('sleep 30 & echo started; wait', { cwd: dir, timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(result.lines).toEqual(['started'])
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('a command that cannot start is exit 127 with the reason as its one line, never a rejection', async () => {
    const missingCwd = await runDshCommand('true', { cwd: join(dir, 'missing') })
    expect(missingCwd.code).toBe(127)
    expect(missingCwd.lines).toEqual([expect.stringMatching(/^could not start: .*ENOENT/)])
    const seen: string[] = []
    const invalid = await runDshCommand('true', { cwd: 'nul\0byte', onLine: (line) => seen.push(line) })
    expect(invalid).toMatchObject({ code: 127, signal: null, timedOut: false })
    expect(invalid.lines).toEqual([expect.stringMatching(/^could not start: /)])
    expect(seen).toEqual(invalid.lines)
  })

  it('settles once when a child reports an error and an exit both, as Node warns it may', async () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdout: new EventEmitter(), stderr: new EventEmitter() }) as unknown as ChildProcess
    seams.fakeChild = () => child
    const seen: string[] = []
    const pending = runDshCommand('anything', { cwd: dir, onLine: (line) => seen.push(line) })
    child.stdout!.emit('data', Buffer.from('partial'))
    child.emit('error', new Error('spawn EACCES'))
    child.emit('exit', 1, null)
    const result = await pending
    expect(result).toEqual({ code: 127, signal: null, lines: ['could not start: spawn EACCES', 'partial'], timedOut: false })
    expect(seen).toEqual(['could not start: spawn EACCES', 'partial'])
  })
})

describe('spawnDshCommand and killProcessGroup', () => {
  let dir: string
  beforeEach(() => {
    seams.sh = true
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-kill-')))
  })
  afterEach(() => {
    seams.sh = false
    rmSync(dir, { recursive: true, force: true })
  })

  const exited = (child: ChildProcess): Promise<[number | null, NodeJS.Signals | null]> =>
    new Promise((resolve) => child.once('exit', (code, signal) => resolve([code, signal])))

  it('SIGTERMs the whole group, and SIGKILLs what ignores it once the grace is over', async () => {
    const polite = spawnDshCommand('sleep 30', { cwd: dir })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const politeExit = exited(polite)
    killProcessGroup(polite, 5_000)
    expect(await politeExit).toEqual([null, 'SIGTERM'])

    const stubborn = spawnDshCommand(`trap '' TERM; echo ready; sleep 30`, { cwd: dir })
    await new Promise<void>((resolve) => stubborn.stdout!.once('data', () => resolve()))
    const stubbornExit = exited(stubborn)
    const started = Date.now()
    killProcessGroup(stubborn, 200)
    expect(await stubbornExit).toEqual([null, 'SIGKILL'])
    expect(Date.now() - started).toBeGreaterThanOrEqual(150)
  })

  it('does nothing without a pid, and nothing harmful for a process already gone', async () => {
    killProcessGroup(Object.assign(new EventEmitter(), { pid: undefined }) as unknown as ChildProcess)
    const gone = spawnDshCommand('exit 0', { cwd: dir })
    await exited(gone)
    expect(() => killProcessGroup(gone, 20)).not.toThrow()
    // the SIGKILL that follows the grace finds nothing either
    await new Promise((resolve) => setTimeout(resolve, 60))
  })
})
