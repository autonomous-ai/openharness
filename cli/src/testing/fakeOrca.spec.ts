import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Every run of the computer's process readers from this spec's worker, the fake Orca's among them. One that would read
 *  every process (pgrep, pkill, a ps with no -p) is noted and never run: the person's own run on this computer. */
const reads = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>)
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const { basename } = await import('node:path')
  const spawnSync = ((file: string, args: readonly string[] = [], options?: object) => {
    const name = basename(file)
    if (['ps', 'lsof', 'pgrep', 'pkill'].includes(name) && (!file.includes('/') || /^\/(usr\/)?s?bin\//.test(file))) {
      reads.push({ file, args: [...args] })
      if (name !== 'ps' || !args.includes('-p')) return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: 1, signal: null }
    }
    return real.spawnSync(file, args, options)
  }) as typeof real.spawnSync
  return { ...real, spawnSync, default: { ...real, spawnSync } }
})

// The harness's fake Orca, run as a daemon runs it. It is outside tsconfig's rootDir (src), so it is loaded untyped, as
// dialAppEvalTierB.spec.ts loads the harness.
interface FakeOrca {
  log(): Array<{ argv: string[]; ok: boolean; at: number }>
  listing(json: object): void
  watchFocus(on: boolean): void
  endWatch(): void
  watching(): boolean
  echoing(): boolean
  focus(handle: string | null): void
}
const { FakeOrca } = await import('../../e2e/harness/fakeOrca.js' as string) as {
  FakeOrca: { install(d: { env: NodeJS.ProcessEnv }, options?: { watchFocus?: boolean }): FakeOrca }
}

// Nothing of this worker's reaches a run: the session runs inside the real Orca, whose variables and CLI it carries.
const ENV = { PATH: '/usr/bin:/bin' }
const H1 = 'term_00000000-0000-4000-8d00-000000000001'
const H2 = 'term_00000000-0000-4000-8d00-000000000002'

let dir = ''
const watches: ChildProcess[] = []
afterEach(() => {
  for (const watch of watches.splice(0)) watch.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})

/** A daemon's root in a throwaway folder, as harness/daemon.ts lays one out: bin's `orca` and `orca-ide` linked to the
 *  refusing launcher in the Orca install the harness made, with the fake installed through them. */
function installed(watchFocus: boolean): { fake: FakeOrca; bin: string; launcher: string; run(name: string, ...args: string[]): ReturnType<typeof spawnSync> } {
  dir = mkdtempSync(join(tmpdir(), 'fake-orca-'))
  const bin = join(dir, 'root', 'bin')
  const launcher = join(dir, 'root', 'orca-app', 'resources', 'bin', 'orca')
  mkdirSync(bin, { recursive: true })
  mkdirSync(dirname(launcher), { recursive: true })
  writeFileSync(launcher, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  for (const name of ['orca', 'orca-ide']) symlinkSync(launcher, join(bin, name))
  const fake = FakeOrca.install({ env: { CLAUDE_PATH: join(bin, 'claude') } }, { watchFocus })
  return { fake, bin, launcher, run: (name, ...args) => spawnSync(join(bin, name), args, { encoding: 'utf8', env: ENV }) }
}

/** A running `terminal watch-focus --json` and the lines it printed so far. */
function watch(launcher: string): { child: ChildProcess; lines: string[] } {
  const child = spawn(launcher, ['terminal', 'watch-focus', '--json'], { env: ENV, stdio: ['ignore', 'pipe', 'ignore'] })
  watches.push(child)
  const lines: string[] = []
  let text = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8')
    const ended = text.split('\n')
    text = ended.pop()!
    lines.push(...ended)
  })
  return { child, lines }
}

const focusLine = (handle: string): string => JSON.stringify({ handle })

describe.skipIf(process.platform === 'win32')("the harness's fake Orca", () => {
  it('each run is noted with its arguments, exit and time, a text with spaces one argument', () => {
    const { fake, run } = installed(false)
    const before = Date.now()
    expect(run('orca-ide', 'terminal', 'send', '--terminal', H1, '--text=run the tests', '--enter', '--json').status).toBe(0)
    expect(run('orca', 'terminal', 'list', '--json', '--include-visual-layouts').status).toBe(1)
    const after = Date.now()
    const log = fake.log()
    expect(log.map(({ argv, ok }) => ({ argv, ok }))).toEqual([
      { argv: ['orca-ide', 'terminal', 'send', '--terminal', H1, '--text=run the tests', '--enter', '--json'], ok: true },
      { argv: ['orca', 'terminal', 'list', '--json', '--include-visual-layouts'], ok: false },
    ])
    // Its time is the file's: the kernel's clock, a tick behind the process's at most.
    for (const { at } of log) {
      expect(at).toBeGreaterThanOrEqual(before - 100)
      expect(at).toBeLessThanOrEqual(after + 100)
    }
    expect(log[0]!.at).toBeLessThanOrEqual(log[1]!.at)
  })

  it('terminal list prints the listing written', () => {
    const { fake, run } = installed(false)
    const listing = { id: 'eval', ok: true, result: { terminals: [{ handle: H1, title: 'Eval tests' }], visualLayouts: [], totalCount: 1, truncated: false } }
    fake.listing(listing)
    const listed = run('orca', 'terminal', 'list', '--json', '--include-visual-layouts')
    expect(listed.status).toBe(0)
    expect(JSON.parse(String(listed.stdout))).toEqual(listing)
  })

  it("a switch that exits 0 is echoed as a focus line 1.5 s after it, inside the devices' 2 s echo window, and returns at once", async () => {
    const { launcher, run } = installed(true)
    const w = watch(launcher)
    const echoed: number[] = []
    w.child.stdout!.on('data', () => { echoed.push(Date.now()) })
    const asked = Date.now()
    expect(run('orca', 'terminal', 'switch', '--terminal', H1, '--json').status).toBe(0)
    // The echo is Orca's, later: the switch's own run waits for none of it.
    expect(Date.now() - asked).toBeLessThan(1_500)
    await vi.waitFor(() => expect(w.lines).toEqual([focusLine(H1)]), { timeout: 10_000, interval: 20 })
    expect(echoed[0]! - asked).toBeGreaterThanOrEqual(1_500)
  })

  it('watchFocus(false) drops watch-focus from the help and moves the launcher\'s mtime', () => {
    const { fake, bin, launcher, run } = installed(true)
    expect(String(run('orca-ide', 'terminal', '--help').stdout)).toContain('watch-focus')
    const before = statSync(launcher).mtimeMs
    fake.watchFocus(false)
    const help = run('orca-ide', 'terminal', '--help')
    expect(help.status).toBe(0)
    expect(String(help.stdout)).toContain('Commands:')
    expect(String(help.stdout)).not.toContain('watch-focus')
    expect(run('orca', 'terminal', 'watch-focus', '--json').status).toBe(1)
    expect(statSync(launcher).mtimeMs).toBeGreaterThan(before)
    // Still Orca's launcher under both names, as an Orca update leaves it.
    for (const name of ['orca', 'orca-ide']) expect(realpathSync(join(bin, name))).toBe(realpathSync(launcher))
  })

  it("a watch after endWatch prints no focus told before it, as Orca's after its quit: that terminal went with it", async () => {
    const { fake, launcher } = installed(true)
    fake.focus(H1)
    fake.endWatch()
    const w = watch(launcher)
    // Running, so it has printed what it starts with before the next line is told.
    await vi.waitFor(() => expect(fake.watching()).toBe(true), { timeout: 10_000, interval: 20 })
    fake.focus(H2)
    await vi.waitFor(() => expect(w.lines).toContain(focusLine(H2)), { timeout: 10_000, interval: 20 })
    expect(w.lines).toEqual([focusLine(H2)])
  })

  it("a switch's echo still to come at endWatch is never told, as Orca's quit takes the pane with it", async () => {
    const { fake, launcher, run } = installed(true)
    expect(run('orca', 'terminal', 'switch', '--terminal', H1, '--json').status).toBe(0)
    expect(fake.echoing()).toBe(true)
    fake.endWatch()
    const w = watch(launcher)
    await vi.waitFor(() => expect(fake.watching()).toBe(true), { timeout: 10_000, interval: 20 })
    // No echo of that switch's is left: ended by endWatch, as its run noted it.
    await vi.waitFor(() => expect(fake.echoing()).toBe(false), { timeout: 10_000, interval: 20 })
    fake.focus(H2)
    await vi.waitFor(() => expect(w.lines).toContain(focusLine(H2)), { timeout: 10_000, interval: 20 })
    expect(w.lines).toEqual([focusLine(H2)])
  })

  it('endWatch ends a running watch-focus', async () => {
    const { fake, launcher } = installed(true)
    const w = watch(launcher)
    const ended = new Promise((resolve) => w.child.once('exit', resolve))
    fake.focus(H1)
    await vi.waitFor(() => expect(w.lines).toEqual([focusLine(H1)]), { timeout: 10_000, interval: 20 })
    fake.endWatch()
    await ended
  })

  it('tells and ends its watches and echoes by the pid and start time each noted, asking nothing of another process', async () => {
    const { fake, launcher, run } = installed(true)
    const w = watch(launcher)
    const ended = new Promise((resolve) => w.child.once('exit', resolve))
    fake.focus(H1)
    await vi.waitFor(() => expect(w.lines).toEqual([focusLine(H1)]), { timeout: 10_000, interval: 20 })
    reads.length = 0
    expect(fake.watching()).toBe(true)
    expect(run('orca', 'terminal', 'switch', '--terminal', H2, '--json').status).toBe(0)
    fake.endWatch()
    await ended
    expect(fake.watching()).toBe(false)
    // A watch's own process is the one its run started (the script execs its tail): asked of by its pid.
    expect(reads.some(({ args }) => args[args.indexOf('-p') + 1]!.split(',').map(Number).includes(w.child.pid!))).toBe(true)
    expect(reads.filter(({ file, args }) => basename(file) !== 'ps' || !args.includes('-p') || args[args.indexOf('-o') + 1] !== 'pid=,lstart='))
      .toEqual([])
  })
})
