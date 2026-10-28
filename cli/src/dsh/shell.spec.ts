import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ChildProcess } from 'node:child_process'

// Two switches, both off by default: `sh` makes commands run under plain `/bin/sh -c` (as when no user
// shell is known) so output is exactly the command's; `fakeChild` hands runDshCommand a scripted child.
const seams = vi.hoisted(() => ({ sh: false, noFiles: false, files: null as Set<string> | null, fakeChild: null as null | (() => ChildProcess) }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: (path: Parameters<typeof actual.existsSync>[0]) => seams.noFiles ? false : seams.files ? seams.files.has(String(path)) : actual.existsSync(path) }
})
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
const { dshNodeFallback, dshShellArgv, isKilledJobReport, isShellNoise, killProcessGroup, runDshCommand, spawnDshCommand } = await import('./shell.js')
const nativeWindows = process.platform === 'win32'

describe('dshShellArgv', () => {
  beforeEach(() => { vi.spyOn(process, 'platform', 'get').mockReturnValue('linux') })
  afterEach(() => { vi.restoreAllMocks() })
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

describe.skipIf(nativeWindows)('dshNodeFallback (POSIX paths)', () => {
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

  it('drops what bash says without a terminal, as Linux CI saw it', () => {
    expect(isShellNoise('bash: cannot set terminal process group (-1): Inappropriate ioctl for device')).toBe(true)
    expect(isShellNoise('bash: no job control in this shell')).toBe(true)
    expect(isShellNoise('/usr/bin/bash: no job control in this shell')).toBe(true)
    expect(isShellNoise('logout')).toBe(true)
    expect(isShellNoise('  ok   bash: no job control in this shell')).toBe(false)
    expect(isShellNoise('logout failed')).toBe(false)
  })
})

describe.skipIf(nativeWindows)('runDshCommand (POSIX signals)', () => {
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

  it('does not take the shell\'s report of the job its stop ended for the command\'s output', async () => {
    // The shell outlives its job here on purpose: it ignores SIGTERM, so it is in `wait` when the job the stop
    // ended dies, and reports it, as it did under load when the job's death reached it first.
    const report = '/bin/sh: line 1: 31849 Terminated: 15          sleep 30'
    const result = await runDshCommand(`echo started; trap 'echo "${report}" >&2; printf "${report}" >&2; exit 0' TERM; sleep 30 & wait`, { cwd: dir, timeoutMs: 300 })
    expect(result.timedOut).toBe(true)
    expect(result.lines).toEqual(['started'])
    // Before a stop, the same words are the command's own.
    expect((await runDshCommand(`echo "${report}"`, { cwd: dir })).lines).toEqual([report])
  })

  it('knows the shell\'s report of a job a signal ended, as bash words it on macOS and Linux', () => {
    expect(isKilledJobReport('/bin/sh: line 1: 31849 Terminated: 15          sleep 30')).toBe(true)
    expect(isKilledJobReport('bash: line 1: 10678 Terminated: 15          ( sleep 0.2; kill -TERM $$ )')).toBe(true)
    expect(isKilledJobReport('bash: line 1:  4242 Terminated              sleep 30')).toBe(true)
    expect(isKilledJobReport('bash: line 3: 86178 Killed: 9               sleep 30')).toBe(true)
    expect(isKilledJobReport('Terminated: 15')).toBe(false)
    expect(isKilledJobReport('sh: line 1: 12 Segmentation fault: 11  ./tool')).toBe(false)
    expect(isKilledJobReport('started')).toBe(false)
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

describe.skipIf(nativeWindows)('spawnDshCommand and killProcessGroup (POSIX process groups)', () => {
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

describe('Windows DSH shell resolution', () => {
  let dir: string
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-win-')))
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('SHELL', '/bin/bash')
    vi.stubEnv('ProgramFiles', dir)
    vi.stubEnv('ProgramFiles(x86)', dir)
    vi.stubEnv('LOCALAPPDATA', dir)
    vi.stubEnv('PATH', '')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    seams.files = null
    rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(!nativeWindows)('preserves setup, doctor and init scripts as one login-shell argument', () => {
    // Native Windows fixture; the integration below covers execution with real Git Bash.
    const bash = join(dir, 'Git', 'bin', 'bash.exe')
    mkdirSync(join(dir, 'Git', 'bin'), { recursive: true })
    writeFileSync(bash, '')
    for (const script of ['./setup.sh "two words"', './doctor.sh', './init.sh "$PWD"']) {
      expect(dshShellArgv(script)).toEqual({
  path: bash,
  args: [
    '-lic',
    `unalias node 2>/dev/null || true\n${dshNodeFallback()}\n${script}`,
  ],
})
    }
    vi.stubEnv('SHELL', bash)
    expect(dshShellArgv('true').path).toBe(bash)
  })

  it.skipIf(!nativeWindows)('finds a custom Git installation from PATH and ignores a missing SHELL', () => {
    const bin = join(dir, 'custom Git', 'bin')
    const cmd = join(dir, 'custom Git', 'cmd')
    mkdirSync(bin, { recursive: true })
    mkdirSync(cmd, { recursive: true })
    writeFileSync(join(bin, 'bash.exe'), '')
    writeFileSync(join(cmd, 'git.exe'), '')
    vi.stubEnv('SHELL', join(dir, 'missing', 'bash.exe'))
    vi.stubEnv('PATH', cmd)
    // Explicitly prevent the machine's default install from winning this fixture.
    seams.files = new Set([join(cmd, 'git.exe'), join(bin, 'bash.exe')])
    expect(dshShellArgv('true').path).toBe(join(bin, 'bash.exe'))
  })

  it('converts the managed Node directory for Bash without replacing an existing node', () => {
    const prelude = dshNodeFallback()
    expect(prelude).toContain('if ! command -v node >/dev/null 2>&1; then')
    expect(prelude).toContain('PATH="${PATH:+$PATH:}$(cygpath -u -- ')
    expect(prelude).toContain('export PATH; fi')
  })
})

describe.skipIf(!nativeWindows)('Windows Git Bash execution', () => {
  let dir: string
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-bash-'))) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it.each(['setup', 'doctor', 'workspace init'])('executes an isolated %s hook with arguments, cwd, env and Node', async (name) => {
    const script = `test "$HOOK_VALUE" = 'two words' || exit 8; test -d "$PWD" || exit 9; node -e 'console.log(process.argv[1])' '${name}'; printf 'tail' >&2`
    const seen: string[] = []
    const result = await runDshCommand(script, { cwd: dir, env: { HOOK_VALUE: 'two words' }, onLine: (line) => seen.push(line), timeoutMs: 10000 })
    expect(result).toMatchObject({ code: 0, timedOut: false })
    expect(result.lines).toEqual(expect.arrayContaining([name, 'tail']))
    expect(seen).toEqual(result.lines)
  }, 15000)

  it('returns resolution failures through the existing exit-127 contract', async () => {
    // Standard Git installation may still be present: explicitly make candidate checks fail.
    seams.noFiles = true
    try {
      expect(() => dshShellArgv('true')).toThrow('Git Bash')
      const seen: string[] = []
      const result = await runDshCommand('true', { cwd: dir, onLine: (line) => seen.push(line) })
      expect(result).toMatchObject({ code: 127, signal: null, timedOut: false })
      expect(result.lines).toEqual([expect.stringContaining('Git Bash')])
      expect(seen).toEqual(result.lines)
    } finally {
      seams.noFiles = false
      vi.restoreAllMocks()
    }
  })
})
