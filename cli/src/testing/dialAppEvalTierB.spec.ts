import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAIN } from './dialAppEval/catalog.js'
import type { App, Platform, Scenario } from './dialAppEval/types.js'

// The dial eval's tier B harness, the parts that need no daemon. It is outside tsconfig's rootDir (src), so it is loaded
// untyped, as fakeEngineUntil.spec.ts loads the harness.
const driver = await import('../../e2e/harness/appEvalDriver.js' as string) as {
  writeRecordingOpen(path: string, runs: string): void
  linksFail(path: string, apps: readonly App[]): void
  openRuns(runs: string, platform: Platform): Array<{ argv: string[]; ok: boolean }>
  tierBGaps(scenario: Scenario, platform: Platform): string[]
  writeRecordingCli(path: string, runs: string): void
  cliRuns(runs: string): Array<{ argv: string[]; ok: boolean }>
  deviceLines(log: string, from: number): { lines: string[]; next: number }
  workPaths(argv: readonly string[], projects: readonly string[]): string[]
  deskEmpty(messages: ReadonlyArray<Record<string, unknown>>): boolean
  RAISE_TOOLS: readonly string[]
  World: new (rig: unknown, scenario: Scenario, platform: Platform) => {
    plug(): Promise<void>; read(): void; forgetBefore(cut: number): void; seen(): import('./dialAppEval/types.js').Seen; close(): Promise<void>
    muxPane(key: string, pane: string | null, at?: number): void; takeMux(): void
  }
  writeRaiseFakes(bin: string): void
  raiseToolsOutside(root: string, env: NodeJS.ProcessEnv): string[]
  faceChange(last: Face | undefined, next: Omit<Face, 'at'>): boolean
  orcaCliInside(env: NodeJS.ProcessEnv, root: string, platform: NodeJS.Platform): string
  selectOf(line: string): { app: string; tty: string; raise?: boolean } | undefined
  muxCommands(runs: readonly LoggedRun[], keyOf: (pane: string, at: number) => string | undefined,
    labelOf: (tty: string) => string | undefined): import('./dialAppEval/types.js').Seen['commands']
  ownRig(rig: { polled: Map<string, number>; accounts: string[]; iterm?: object }, scenario: Scenario): boolean
  emptyFixtures(rig: { d: { root: string; env: NodeJS.ProcessEnv }; accounts: string[]; iterm?: object }): Promise<void>
}
type Face = import('./dialAppEval/types.js').Seen['faces'][number]
type LoggedRun = { argv: string[]; ok: boolean; at: number }

const herdr = await import('../../e2e/harness/herdrServer.js' as string) as {
  PrivateHerdr: { forget(config: string): Promise<void> }
}

const runLog = await import('../../e2e/harness/runLog.js' as string) as {
  recordingWrapper(real: string, dir: string, recorded: readonly string[]): string
  runLog(dir: string): LoggedRun[]
}

/** The parts of a world the fake Claude app's start reads. */
interface AppWorld { d: { root: string; env: NodeJS.ProcessEnv }; children: import('node:child_process').ChildProcess[]; onOpen(listener: unknown): void }
const claude = await import('../../e2e/harness/appEvalClaude.js' as string) as {
  linkedSocket(root: string, code: number | null, stdout: string, stderr: string): string
  typedPrompts(transcript: string): Array<{ at?: number; text: string }>
  writeWhole(file: string, text: string): void
  appOf(world: AppWorld, host?: (world: AppWorld, s: unknown) => { hints: Record<string, string> }): { process: import('node:child_process').ChildProcess }
}

const fakeOrca = await import('../../e2e/harness/fakeOrca.js' as string) as {
  FakeOrca: { install(d: { env: NodeJS.ProcessEnv }, options?: { watchFocus?: boolean }): unknown }
}

const modInbox = await import('../../e2e/harness/modInbox.js' as string) as {
  inboxPoll(d: { socketPath: string }, sessionId: string): Promise<{ status: number; body: unknown }>
}

const daemon = await import('../../e2e/harness/daemon.js' as string) as {
  IsolatedDaemon: { prototype: { servicePids(this: { output: string; pid: number | null }, name: string): number[] } }
}

let dir = ''
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** A run noted under [runs] as the recording wrapper notes one (runLog.ts): its exit, the name it was run by, then each
 *  argument, one a line, in `log/[name]`, at [at]. */
function noteIn(runs: string, name: string, lines: string[], at: number): void {
  const path = join(runs, 'log', name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''))
  utimesSync(path, new Date(at), new Date(at))
}

/** A recording open in a throwaway folder: its path and the file it notes its runs in. */
function open(): { path: string; runs: string; run(...args: string[]): number | null } {
  dir = mkdtempSync(join(tmpdir(), 'tier-b-open-'))
  const path = join(dir, 'open')
  const runs = join(dir, 'runs.log')
  driver.writeRecordingOpen(path, runs)
  return { path, runs, run: (...args) => spawnSync(path, args).status }
}

const CHATGPT_LINK = 'codex://threads/00000000-0000-4000-a000-000000007431'
const CLAUDE_LINK = 'claude://code/continue?session=local_00000000-0000-4000-9000-000000000061'

describe("tier B's recording open", () => {
  it('notes each run with its exit, as the command it stands for: open on macOS, xdg-open on Linux', () => {
    const o = open()
    expect(o.run('-b', 'com.openai.codex', CHATGPT_LINK)).toBe(0)
    expect(driver.openRuns(o.runs, 'darwin')).toEqual([{ argv: ['open', '-b', 'com.openai.codex', CHATGPT_LINK], ok: true }])
    expect(driver.openRuns(o.runs, 'linux')).toEqual([{ argv: ['xdg-open', '-b', 'com.openai.codex', CHATGPT_LINK], ok: true }])
  })

  it('fails the links of an app the world says fails, on every platform, and no other app\'s', () => {
    const o = open()
    driver.linksFail(o.path, ['chatgpt'])
    expect(o.run(CHATGPT_LINK)).toBe(1)
    expect(o.run(CLAUDE_LINK)).toBe(0)
    driver.linksFail(o.path, [])
    expect(o.run(CHATGPT_LINK)).toBe(0)
    expect(driver.openRuns(o.runs, 'linux')).toEqual([
      { argv: ['xdg-open', CHATGPT_LINK], ok: false }, { argv: ['xdg-open', CLAUDE_LINK], ok: true }, { argv: ['xdg-open', CHATGPT_LINK], ok: true },
    ])
  })

  it('has noted nothing before its first run', () => {
    const o = open()
    expect(driver.openRuns(o.runs, 'darwin')).toEqual([])
  })
})

describe("tier B's recording Cursor CLI", () => {
  it('notes each run as cursor and its arguments, and exits 0', () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-cursor-'))
    const path = join(dir, 'cursor', 'cursor')
    const runs = join(dir, 'cursor-runs.log')
    expect(driver.cliRuns(runs)).toEqual([])
    driver.writeRecordingCli(path, runs)
    expect(spawnSync(path, ['/work/eval-alpha']).status).toBe(0)
    expect(spawnSync(path, ['/work/eval-beta']).status).toBe(0)
    expect(driver.cliRuns(runs)).toEqual([
      { argv: ['cursor', '/work/eval-alpha'], ok: true }, { argv: ['cursor', '/work/eval-beta'], ok: true },
    ])
  })

  it("leaves out the extension setup's runs: they open no folder", () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-cursor-'))
    const path = join(dir, 'cursor', 'cursor')
    const runs = join(dir, 'cursor-runs.log')
    driver.writeRecordingCli(path, runs)
    expect(spawnSync(path, ['--install-extension', '/tmp/harness-device.vsix', '--force']).status).toBe(0)
    expect(spawnSync(path, ['/work/eval-alpha']).status).toBe(0)
    expect(spawnSync(path, ['--uninstall-extension', 'autonomous.harness-device']).status).toBe(0)
    expect(driver.cliRuns(runs)).toEqual([{ argv: ['cursor', '/work/eval-alpha'], ok: true }])
  })
})

describe("tier B's raise on Linux", () => {
  it("finds each program Linux's raise runs in the daemon's own bin, before the computer's, and each refuses", () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-raise-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    expect([...driver.RAISE_TOOLS].sort()).toEqual(['dbus-send', 'gdbus', 'hyprctl', 'swaymsg', 'wmctrl'])
    // The computer's own folders hold none inside the root, whatever they hold.
    expect(driver.raiseToolsOutside(dir, { PATH: '/usr/bin:/bin' })).toEqual([...driver.RAISE_TOOLS])
    driver.writeRaiseFakes(bin)
    expect(driver.raiseToolsOutside(dir, { PATH: `${bin}:/usr/bin:/bin` })).toEqual([])
    for (const tool of driver.RAISE_TOOLS) expect(spawnSync(join(bin, tool), ['-l', '-p']).status).toBe(1)
  })
})

/** A file at [path] that Orca's install could have left: by its real path, the daemon takes it for Orca's CLI
 *  (devices/orcaHomes.ts). */
function launcherAt(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  return path
}

/**
 * A daemon's root in a throwaway folder, as harness/daemon.ts lays one out: bin's `orca` and `orca-ide` linked to the
 * refusing launcher in the Orca install the harness made, which is the Orca app's own too (HARNESS_ORCA_APP_BIN). Its
 * PATH ends in a computer's folder of programs outside the root (`system`), where `installed` puts a real Orca's name,
 * linked into a real Orca's install beside it, as Orca's .deb links /usr/bin/orca-ide.
 */
function daemonRoot(): { root: string; bin: string; launcher: string; system: string; env: NodeJS.ProcessEnv; installed(name: string): string } {
  dir = mkdtempSync(join(tmpdir(), 'tier-b-orca-'))
  const root = join(dir, 'root')
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const launcher = launcherAt(join(root, 'orca-app', 'resources', 'bin', 'orca'))
  for (const name of ['orca', 'orca-ide']) symlinkSync(launcher, join(bin, name))
  const system = join(dir, 'usr', 'bin')
  mkdirSync(system, { recursive: true })
  const installed = (name: string): string => {
    const real = launcherAt(join(dir, 'opt', 'Orca', 'resources', 'bin', name))
    symlinkSync(real, join(system, name))
    return real
  }
  return { root, bin, launcher, system, env: { PATH: `${bin}:${system}`, HARNESS_ORCA_APP_BIN: launcher }, installed }
}

describe("tier B's Orca CLI: the one the daemon would run is inside its root", () => {
  const REFUSED = "the daemon's Orca CLI is not inside its root"
  afterEach(() => { vi.unstubAllEnvs() })

  it('orcaCliInside refuses an orca-ide first on PATH outside the root, on linux', () => {
    const r = daemonRoot()
    r.installed('orca-ide')
    // A bin with no orca-ide: Linux looks for one before any orca, and the daemon's PATH ends in the computer's folders.
    unlinkSync(join(r.bin, 'orca-ide'))
    expect(() => driver.orcaCliInside(r.env, r.root, 'linux')).toThrow(REFUSED)
    // One in bin that is not in Orca's install: the daemon passes over it to the computer's.
    writeFileSync(join(r.bin, 'orca-ide'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    expect(() => driver.orcaCliInside(r.env, r.root, 'linux')).toThrow(REFUSED)
  })

  it('it refuses an orca outside the root first on PATH', () => {
    const r = daemonRoot()
    r.installed('orca')
    const env = { ...r.env, PATH: `${r.system}:${r.bin}` }
    // On Linux the daemon takes bin's orca-ide, but whatever runs `orca` by name gets the computer's.
    for (const platform of ['linux', 'darwin'] as const) expect(() => driver.orcaCliInside(env, r.root, platform)).toThrow(REFUSED)
  })

  it("it refuses an orca in the root's bin that links to one outside it", () => {
    const r = daemonRoot()
    const real = r.installed('orca')
    unlinkSync(join(r.bin, 'orca'))
    symlinkSync(real, join(r.bin, 'orca'))
    for (const platform of ['linux', 'darwin'] as const) expect(() => driver.orcaCliInside(r.env, r.root, platform)).toThrow(REFUSED)
  })

  it('on darwin with none on PATH it refuses an app path outside the root', () => {
    const r = daemonRoot()
    const empty = join(dir, 'empty')
    mkdirSync(empty)
    const app = launcherAt(join(dir, 'Applications', 'Orca.app', 'Contents', 'Resources', 'bin', 'orca'))
    // This worker's own app path is inside the root: only the daemon's environment names the daemon's.
    vi.stubEnv('HARNESS_ORCA_APP_BIN', r.launcher)
    expect(() => driver.orcaCliInside({ PATH: empty, HARNESS_ORCA_APP_BIN: app }, r.root, 'darwin')).toThrow(REFUSED)
    expect(process.env.HARNESS_ORCA_APP_BIN).toBe(r.launcher)
    // The same daemon with its app path inside the root runs that one: none on PATH is not what was refused.
    vi.stubEnv('HARNESS_ORCA_APP_BIN', app)
    expect(driver.orcaCliInside({ PATH: empty, HARNESS_ORCA_APP_BIN: r.launcher }, r.root, 'darwin')).toBe(r.launcher)
    expect(process.env.HARNESS_ORCA_APP_BIN).toBe(app)
  })

  it("the fake installed as orca and orca-ide resolves inside the root, through Orca's launcher folder, on linux and darwin", () => {
    const r = daemonRoot()
    // A real Orca in the computer's folders, after the daemon's own, as on a developer's Linux desktop.
    r.installed('orca')
    r.installed('orca-ide')
    fakeOrca.FakeOrca.install({ env: { CLAUDE_PATH: join(r.bin, 'claude') } }, { watchFocus: true })
    expect(driver.orcaCliInside(r.env, r.root, 'linux')).toBe(join(r.bin, 'orca-ide'))
    expect(driver.orcaCliInside(r.env, r.root, 'darwin')).toBe(join(r.bin, 'orca'))
    for (const name of ['orca', 'orca-ide']) {
      expect(realpathSync(join(r.bin, name))).toBe(realpathSync(r.launcher))
      // The fake answers to either name, as an Orca with watch-focus.
      expect(spawnSync(join(r.bin, name), ['terminal', '--help'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout).toContain('watch-focus')
    }
  })
})

describe("tier B's devices' log lines", () => {
  it("deviceLines gives the devices' lines after an offset, from their tag on", () => {
    const before = '12:00:00 [device] voice · codex\n'
    const log = `${before}12:00:01 [cli] ready\n12:00:02 [device] scroll · skipped · not on screen\n12:00:03 [device] tap · mo`
    const read = driver.deviceLines(log, before.length)
    expect(read.lines).toEqual(['[device] scroll · skipped · not on screen'])
    // A line not yet ended is read once it is.
    expect(read.next).toBe(log.lastIndexOf('\n') + 1)
    expect(driver.deviceLines(`${log}ved\n`, read.next)).toEqual({ lines: ['[device] tap · moved'], next: log.length + 4 })
    expect(driver.deviceLines(log, log.length)).toEqual({ lines: [], next: log.length })
  })
})

describe("tier B's commands", () => {
  it("a command's folder under the daemon's projects is recorded as the catalog's /work/ one", () => {
    const projects = ['/tmp/htmux-eval/projects', '/private/tmp/htmux-eval/projects']
    expect(driver.workPaths(['open', '-b', 'com.todesktop.230313mzl4w4u92', '/private/tmp/htmux-eval/projects/eval-alpha'], projects))
      .toEqual(['open', '-b', 'com.todesktop.230313mzl4w4u92', '/work/eval-alpha'])
    expect(driver.workPaths(['cursor', '/tmp/htmux-eval/projects/eval-beta/src'], projects)).toEqual(['cursor', '/work/eval-beta/src'])
    // Only a folder inside the projects: one beside them, or the link of an app, is kept as it is.
    expect(driver.workPaths(['cursor', '/tmp/htmux-eval/projects-other/eval-alpha', 'cursor://file/x'], projects))
      .toEqual(['cursor', '/tmp/htmux-eval/projects-other/eval-alpha', 'cursor://file/x'])
  })

  it('a tmux run becomes a command with its panes named by key', () => {
    const keyOf = (pane: string): string | undefined => new Map([['%3', 'b'], ['w1:p2', 'a']]).get(pane)
    expect(driver.muxCommands([
      { argv: ['tmux', 'select-window', '-t', '%3', ';', 'select-pane', '-t', '%3'], ok: true, at: 1_000 },
      { argv: ['tmux', 'display-message', '-p', '-t', '%9', '#{pane_pid}|#{session_name}'], ok: false, at: 1_200 },
      { argv: ['herdr', 'agent', 'focus', 'w1:p2'], ok: true, at: 1_500 },
    ], keyOf, () => undefined)).toEqual([
      { at: 1_000, argv: ['tmux', 'select-window', '-t', 'pane:b', ';', 'select-pane', '-t', 'pane:b'], ok: true },
      { at: 1_200, argv: ['tmux', 'display-message', '-p', '-t', 'pane:other', '#{pane_pid}|#{session_name}'], ok: false },
      { at: 1_500, argv: ['herdr', 'agent', 'focus', 'pane:a'], ok: true },
    ])
  })

  it("a tmux run names a client's tty by its tab's label, tab:other for one no tab holds: no tty reaches a result", () => {
    const labelOf = (tty: string): string | undefined => new Map([['/dev/ttys004', 'w1.1.0']]).get(tty)
    expect(driver.muxCommands([
      { argv: ['tmux', 'switch-client', '-c', '/dev/ttys004', '-t', '%3'], ok: true, at: 1_000 },
      { argv: ['tmux', 'switch-client', '-c', '/dev/ttys009', '-t', '%3'], ok: true, at: 1_100 },
    ], () => 'b', labelOf).map((c) => c.argv)).toEqual([
      ['tmux', 'switch-client', '-c', 'tab:w1.1.0', '-t', 'pane:b'],
      ['tmux', 'switch-client', '-c', 'tab:other', '-t', 'pane:b'],
    ])
  })
})

describe("tier B's recording wrappers", () => {
  /** [real] behind a recording wrapper named [name] in the test's folder: its path, and the folder it notes runs in. */
  function wrapped(name: string, real: string, recorded: readonly string[]): { path: string; runs: string } {
    const path = join(dir, 'bin', name)
    const runs = join(dir, `${name}-runs`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, runLog.recordingWrapper(real, runs, recorded), { mode: 0o755 })
    return { path, runs }
  }

  it("the recording wrapper notes a recorded run's arguments (one with spaces whole) and exit, and exits with the real program's status", () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-wrapper-'))
    const tmux = wrapped('tmux', '/bin/echo', ['display-message', 'list-panes'])
    const herdr = wrapped('herdr', '/usr/bin/false', ['agent'])
    const before = Date.now()
    const shown = spawnSync(tmux.path, ['display-message', '-p', '-t', '%3', '#{pane_pid} #{session_name}'], { encoding: 'utf8' })
    expect(spawnSync(herdr.path, ['agent', 'focus', 'w1:p2']).status).toBe(1)
    const after = Date.now()
    // The real program's own output, as it ran.
    expect(shown.status).toBe(0)
    expect(shown.stdout).toBe('display-message -p -t %3 #{pane_pid} #{session_name}\n')
    const runs = [...runLog.runLog(tmux.runs), ...runLog.runLog(herdr.runs)]
    expect(runs.map(({ argv, ok }) => ({ argv, ok }))).toEqual([
      { argv: ['tmux', 'display-message', '-p', '-t', '%3', '#{pane_pid} #{session_name}'], ok: true },
      { argv: ['herdr', 'agent', 'focus', 'w1:p2'], ok: false },
    ])
    for (const { at } of runs) {
      expect(at).toBeGreaterThanOrEqual(before - 100)
      expect(at).toBeLessThanOrEqual(after + 100)
    }
  })

  it('notes a run killed on its timeout (SIGTERM) as failed, and ends the real program with it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-wrapper-'))
    const said = join(dir, 'real.pid')
    const tmux = wrapped('tmux', '/bin/sh', ['-c'])
    // The real program says its pid, whole, then hangs, as a tmux that does not answer.
    const script = `echo $$ > '${said}.tmp' && mv '${said}.tmp' '${said}' && exec sleep 60`
    const run = spawn(tmux.path, ['-c', script], { stdio: 'ignore' })
    const ended = new Promise((done) => run.once('exit', done))
    const real = await vi.waitFor(() => Number(readFileSync(said, 'utf8')), { timeout: 10_000, interval: 20 })
    let gone = false
    try {
      run.kill('SIGTERM')
      await ended
      expect(runLog.runLog(tmux.runs).map(({ argv, ok }) => ({ argv, ok }))).toEqual([{ argv: ['tmux', '-c', script], ok: false }])
      // Waited for by the wrapper, so gone by its end.
      expect(() => process.kill(real, 0)).toThrow()
      gone = true
    } finally {
      // Only while it may still be the sleep: once gone, its pid may be another process's.
      if (!gone) try { process.kill(real, 'SIGKILL') } catch { /* gone */ }
    }
  })

  it('a run it does not record execs the real program and notes nothing', () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-wrapper-'))
    const tmux = wrapped('tmux', '/bin/sh', ['list-panes'])
    // Exec'd in the wrapper's place: the real program's parent is this worker, not the wrapper.
    const ran = spawnSync(tmux.path, ['-c', 'echo $PPID'], { encoding: 'utf8' })
    expect(ran.status).toBe(0)
    expect(ran.stdout.trim()).toBe(String(process.pid))
    expect(runLog.runLog(tmux.runs)).toEqual([])
  })

  it('runLog reads each run at its mtime, and skips a note not yet moved in', () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-runs-'))
    const at = Date.parse('2026-11-23T10:00:00.000Z')
    noteIn(dir, 'run.b2Xk9q', ['0', 'tmux', 'select-window', '-t', '%3', ';', 'select-pane', '-t', '%3'], at + 2_000)
    noteIn(dir, 'run.a7Pq2z', ['1', 'herdr', 'agent', 'focus', 'w1:p2'], at + 1_000)
    // Still being written aside: it is moved in whole, or not read.
    noteIn(dir, '.c3Rt8w', ['0', 'tmux'], at + 3_000)
    expect(runLog.runLog(dir)).toEqual([
      { argv: ['herdr', 'agent', 'focus', 'w1:p2'], ok: false, at: at + 1_000 },
      { argv: ['tmux', 'select-window', '-t', '%3', ';', 'select-pane', '-t', '%3'], ok: true, at: at + 2_000 },
    ])
  })
})

describe("tier B's watch", () => {
  it('selectOf reads a watch select line, with and without raise, and nothing else', () => {
    expect(driver.selectOf('{"select":{"app":"iterm","tty":"/dev/ttys012","raise":true}}')).toEqual({ app: 'iterm', tty: '/dev/ttys012', raise: true })
    expect(driver.selectOf('{"select":{"app":"iterm","tty":"/dev/ttys012"}}')).toEqual({ app: 'iterm', tty: '/dev/ttys012' })
    for (const line of ['{"front":"com.googlecode.iterm2"}', '{"dial":{"fw":"0.1.0"}}', '{"select":{"app":"iterm"}}',
      '{"select":{"app":"iterm","tty":"/dev/ttys012","raise":"yes"}}', '{"select":"iterm"}', '{"select":null}', 'null', '{"select', '']) {
      expect(driver.selectOf(line)).toBeUndefined()
    }
  })
})

describe("tier B's start", () => {
  const welcome = { t: 'welcome' }
  const list = (...ids: string[]): Array<Record<string, unknown>> => [{ t: 'agents.begin' }, ...ids.map((id) => ({ t: 'agent', id })), { t: 'agents.end' }]
  const apps = (...counts: Array<[string, number]>): Record<string, unknown> =>
    ({ t: 'apps', shown: '', apps: counts.map(([id, count]) => ({ id, name: id, count, waiting: 0 })) })

  it('goes on once the dial was welcomed, shown an empty list, and told no app has a row', () => {
    expect(driver.deskEmpty([welcome, apps(), ...list()])).toBe(true)
  })

  it("waits while another app's page still has a row of an earlier scenario, though the list shown is empty", () => {
    expect(driver.deskEmpty([welcome, apps(['vscode', 2]), ...list()])).toBe(false)
    expect(driver.deskEmpty([welcome, apps(['vscode', 2]), ...list(), apps()])).toBe(true)
  })

  it('waits for a welcome, an empty list and a word of the apps', () => {
    expect(driver.deskEmpty([apps(), ...list()])).toBe(false)
    expect(driver.deskEmpty([welcome, apps(), ...list('a')])).toBe(false)
    expect(driver.deskEmpty([welcome, ...list()])).toBe(false)
  })
})

const byId = (id: string): Scenario => MAIN.find((s) => s.id === id)!

describe("tier B's world at its start", () => {
  const welcome = { t: 'welcome' }
  const list = (...ids: string[]): Array<Record<string, unknown>> => [{ t: 'agents.begin' }, ...ids.map((id) => ({ t: 'agent', id })), { t: 'agents.end' }]
  const apps = (shown: string, ...counts: Array<[string, number]>): Record<string, unknown> =>
    ({ t: 'apps', shown, apps: counts.map(([id, count]) => ({ id, name: id, count, waiting: 0 })) })

  it("holds nothing the dial was sent before the desk was found empty but the push that emptied it, and what came after", async () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-world-'))
    const dial = { messages: [] as Array<Record<string, unknown>>, arrivedAt: [] as number[] }
    const hear = (...messages: Array<Record<string, unknown>>): void => {
      for (const m of messages) { dial.messages.push(m); dial.arrivedAt.push(Date.now()) }
    }
    const rig = { d: { log: () => '' }, desk: { plug: async () => dial }, runs: join(dir, 'runs.log'), cursorRuns: join(dir, 'cursor-runs.log'), projects: [] }
    const world = new driver.World(rig, byId('V11'), 'darwin')
    try {
      await world.plug()
      // The last scenario's rows, still on the daemon as this one's dial comes, under ids every scenario shares.
      hear(welcome, apps('vscode', ['vscode', 2]), ...list('a', 'other'))
      world.read()
      hear(apps('vscode'), ...list())
      world.forgetBefore(dial.messages.length)
      // This scenario's first list, during its start: it stays.
      hear(apps('vscode', ['vscode', 1]), ...list('b'))
      world.read()
      const seen = world.seen()
      expect(seen.frames.map((f) => f.message)).toEqual([apps('vscode'), ...list(), apps('vscode', ['vscode', 1]), ...list('b')])
      expect(seen.faces.map((f) => f.tiles)).toEqual([[], ['b']])
    } finally {
      await world.close()
    }
  })
})

describe("tier B's reset", () => {
  it("empties the fake Claude Code's process records and herdr's saved layout, and keeps herdr's config", async () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-reset-'))
    const home = join(dir, 'home')
    const herdrConfig = join(home, '.config', 'herdr')
    const files = {
      record: join(dir, 'claude', 'sessions', '123.json'), layout: join(herdrConfig, 'session.json'),
      snapshot: join(herdrConfig, 'session-snapshots', 'session-1.json'), history: join(herdrConfig, 'session-history.json'),
      config: join(herdrConfig, 'config.toml'),
    }
    for (const file of Object.values(files)) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '{}')
    }
    const env = { HOME: home, CLAUDE_PROJECTS_DIR: join(dir, 'claude', 'projects'), CODEX_HOME: join(home, '.codex') }
    await driver.emptyFixtures({ d: { root: dir, env }, accounts: [], iterm: {} })
    expect([files.record, files.layout, files.snapshot, files.history].filter((file) => existsSync(file))).toEqual([])
    expect(existsSync(join(herdrConfig, 'session-snapshots'))).toBe(false)
    expect(existsSync(files.config)).toBe(true)
  })

  it("refuses to forget herdr's layout while a server answers on its socket, and forgets it past a socket nobody answers", async () => {
    // The socket's path fits sun_path whatever TMPDIR is.
    dir = mkdtempSync('/tmp/hf-')
    const socket = join(dir, 'herdr', 'herdr.sock')
    const layout = join(dir, 'herdr', 'session.json')
    mkdirSync(dirname(socket))
    writeFileSync(layout, '{}')
    const server = createServer()
    await new Promise<void>((done) => server.listen(socket, done))
    try {
      await expect(herdr.PrivateHerdr.forget(dir)).rejects.toThrow(/still runs/)
      expect(existsSync(layout)).toBe(true)
    } finally {
      await new Promise((done) => server.close(done))
    }
    // A server killed leaves its socket behind.
    spawnSync(process.execPath, ['-e', "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))", socket])
    expect(existsSync(socket)).toBe(true)
    await herdr.PrivateHerdr.forget(dir)
    expect(existsSync(layout)).toBe(false)
  })
})

describe("tier B's tmux and herdr runs", () => {
  /** A daemon's rig as a world reads it, another app's or, with its tmux and herdr runs' folders, iTerm2's. */
  const rigs = (): { other: object; iterm: { iterm: { tmuxRuns: string; herdrRuns: string } } } => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-mux-'))
    const other = { d: { log: () => '' }, runs: join(dir, 'runs.log'), cursorRuns: join(dir, 'cursor-runs.log'), projects: [] }
    return { other, iterm: { ...other, iterm: { tmuxRuns: join(dir, 'tmux-runs'), herdrRuns: join(dir, 'herdr-runs') } } }
  }
  const iterm: Scenario = {
    id: 'EVAL', app: 'iterm', title: 'Eval tmux', dims: ['D3'], platforms: ['darwin'], tiers: ['b'], heldOut: false,
    sessions: [{ key: 'a', app: 'iterm', id: '00000000-0000-4000-8e00-00000000000a', title: 'Eval alpha', cwd: '/work/eval-a', ageMs: 0,
      place: 'tmux', window: 'w1', tab: 1, split: 0 }],
    steps: [], checks: [], probes: [],
  }

  it("an iTerm2 world's commands hold its daemon's tmux and herdr runs, each pane named by its session; another app's daemon notes none", async () => {
    const { other, iterm: rig } = rigs()
    const worlds = [new driver.World(other, byId('V11'), 'darwin'), new driver.World(rig, iterm, 'darwin')]
    try {
      // The devices' runs and the core's, after both worlds began.
      const at = Date.now() + 1_000
      noteIn(rig.iterm.tmuxRuns, 'run.t1', ['0', 'tmux', 'select-window', '-t', '%3', ';', 'select-pane', '-t', '%3'], at)
      noteIn(rig.iterm.tmuxRuns, 'run.t2', ['0', 'tmux', 'list-panes', '-a', '-F', '#{pane_id}'], at + 100)
      noteIn(rig.iterm.herdrRuns, 'run.h1', ['0', 'herdr', 'agent', 'focus', 'w1:p2'], at + 200)
      const [vscode, itermWorld] = worlds
      itermWorld!.muxPane('a', '%3')
      for (const world of worlds) world.takeMux()
      expect(vscode!.seen().commands).toEqual([])
      expect(itermWorld!.seen().commands.map(({ argv, ok }) => ({ argv, ok }))).toEqual([
        { argv: ['tmux', 'select-window', '-t', 'pane:a', ';', 'select-pane', '-t', 'pane:a'], ok: true },
        { argv: ['tmux', 'list-panes', '-a', '-F', '#{pane_id}'], ok: true },
        { argv: ['herdr', 'agent', 'focus', 'pane:other'], ok: true },
      ])
    } finally {
      for (const world of worlds) await world.close()
    }
  })

  it("names a pane id herdr gives again after its restart by the session that held it at each run, and none between", async () => {
    const { iterm: rig } = rigs()
    const world = new driver.World(rig, { ...iterm, sessions: [...iterm.sessions, { ...iterm.sessions[0]!, key: 'b', place: 'herdr' }] }, 'darwin')
    try {
      const at = Date.now() + 1_000
      // a's pane, closed as herdr stopped; b's, the same id on the new server.
      world.muxPane('a', 'w1:p1', at)
      world.muxPane('a', null, at + 200)
      world.muxPane('b', 'w1:p1', at + 400)
      noteIn(rig.iterm.herdrRuns, 'run.h1', ['0', 'herdr', 'agent', 'focus', 'w1:p1'], at + 100)
      noteIn(rig.iterm.herdrRuns, 'run.h2', ['0', 'herdr', 'agent', 'focus', 'w1:p1'], at + 300)
      noteIn(rig.iterm.herdrRuns, 'run.h3', ['0', 'herdr', 'agent', 'focus', 'w1:p1'], at + 500)
      world.takeMux()
      expect(world.seen().commands.map(({ argv }) => argv[3])).toEqual(['pane:a', 'pane:other', 'pane:b'])
    } finally {
      await world.close()
    }
  })
})

describe("tier B's daemons", () => {
  /** A daemon's rig as ownRig reads it: no poll counted, no Orca account; with [iterm], iTerm2's tmux and herdr kit. */
  const rig = (iterm: boolean): Parameters<typeof driver.ownRig>[0] => ({ polled: new Map(), accounts: [], ...(iterm ? { iterm: {} } : {}) })

  it("gives an iTerm2 scenario a daemon of its own after another app's, and another app's after iTerm2's: only iTerm2's has its tmux and herdr", () => {
    expect(driver.ownRig(rig(false), byId('I1'))).toBe(true)
    expect(driver.ownRig(rig(true), byId('V11'))).toBe(true)
    expect(driver.ownRig(rig(true), byId('I2'))).toBe(false)
    expect(driver.ownRig(rig(false), byId('V11'))).toBe(false)
  })
})

describe("tier B's devices restart", () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it("finds the devices' new pid by each process's pid and parent alone, never a command line", () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-pids-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const asked = join(dir, 'asked')
    // The ps a daemon's pid wait runs, first on this worker's PATH: it notes what it was asked, and prints the master
    // 100's devices 101 and search 103, and 102, a logged pid another process took since.
    writeFileSync(join(bin, 'ps'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${asked}'\nprintf '  101   100\\n  102     1\\n  103   100\\n'\n`, { mode: 0o755 })
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    const log = '[harnessd] service devices started (pid 102)\n[harnessd] service devices started (pid 101)\n[harnessd] service search started (pid 103)\n'
    const pids = daemon.IsolatedDaemon.prototype.servicePids.call({ output: log, pid: 100 }, 'devices')
    expect(readFileSync(asked, 'utf8').split('\n').filter(Boolean)).toEqual(['-A', '-o', 'pid=,ppid='])
    expect(pids).toEqual([101])
  })
})

describe("tier B's faces", () => {
  const shown: Omit<Face, 'at'> = { page: 'orca', tiles: ['a', 'b'], active: 'a', refused: 0 }
  const face: Face = { at: 100, ...shown }

  it('faceChange is true for a change of page, tiles, the face or refused alone, and false for none', () => {
    expect(driver.faceChange(undefined, shown)).toBe(true)
    expect(driver.faceChange(face, { ...shown })).toBe(false)
    expect(driver.faceChange(face, { ...shown, tiles: [...shown.tiles] })).toBe(false)
    expect(driver.faceChange(face, { ...shown, page: 'claude' })).toBe(true)
    expect(driver.faceChange(face, { ...shown, tiles: ['a'] })).toBe(true)
    expect(driver.faceChange(face, { ...shown, active: 'b' })).toBe(true)
    expect(driver.faceChange(face, { ...shown, refused: 1 })).toBe(true)
  })
})

describe("tier B's gaps", () => {
  it('leaves out on Linux an open check whose link fails: the fallback there is the raise, which no fake records', () => {
    expect(driver.tierBGaps(byId('X5'), 'linux')).toEqual([expect.stringContaining('raise')])
    expect(driver.tierBGaps(byId('X5'), 'darwin')).toEqual([])
    expect(driver.tierBGaps(byId('X4'), 'linux')).toEqual([])
  })

  it('refuses a world it does not build: no ChatGPT app installed, a Claude Code that asks a question', () => {
    expect(() => driver.tierBGaps({ ...byId('X4'), world: { chatgptInstalled: false } }, 'darwin')).toThrow('no ChatGPT app')
    const c7 = byId('C7')
    const question = { ...c7, steps: c7.steps.map((step) => step.kind === 'hook' && step.event === 'needs-input' ? { ...step, asks: 'question' as const } : step) }
    expect(() => driver.tierBGaps(question, 'darwin')).toThrow('question')
    expect(driver.tierBGaps(c7, 'darwin')).toEqual([])
  })

  it("leaves out on Linux an open check on an editor's terminal row, and not on a panel or Cursor's agent, nor on macOS", () => {
    const tapped = (app: App, place?: 'terminal' | 'panel' | 'agent'): Scenario => ({
      id: 'EVAL', app, title: 'Eval tap', dims: ['D2'], platforms: ['darwin', 'linux'], tiers: ['b'], heldOut: false,
      sessions: [{ key: 'a', app, id: '00000000-0000-4000-a000-00000000e001', title: 'Eval alpha', cwd: '/work/eval-alpha', ageMs: 0,
        ...(place ? { place } : {}) }],
      steps: [{ kind: 'tap', session: 'a' }], checks: [{ id: 'EVAL.open', dim: 'D2', kind: 'open', session: 'a', link: false }], probes: [],
    })
    expect(driver.tierBGaps(tapped('vscode'), 'linux')).toEqual([expect.stringContaining("Linux's raise")])
    expect(driver.tierBGaps(tapped('cursor', 'terminal'), 'linux')).toEqual([expect.stringContaining("Linux's raise")])
    expect(driver.tierBGaps(tapped('vscode', 'panel'), 'linux')).toEqual([])
    expect(driver.tierBGaps(tapped('cursor', 'agent'), 'linux')).toEqual([])
    expect(driver.tierBGaps(tapped('vscode'), 'darwin')).toEqual([])
    expect(driver.tierBGaps(tapped('claude'), 'linux')).toEqual([])
  })

  it("keeps on Linux an open check on a Cursor terminal row whose window closed before the tap: the recorded Cursor CLI opens its folder (U12)", () => {
    const u12 = byId('U12')
    expect(driver.tierBGaps(u12, 'linux')).toEqual([])
    // Its window open again before the tap, or no window closed: the raise brings Cursor.
    const reopened = { ...u12, steps: u12.steps.flatMap((step) => step.label === 'tap' ? [{ kind: 'editor.window' as const, window: 'w1', active: 'a', focused: true }, step] : [step]) }
    expect(driver.tierBGaps(reopened, 'linux')).toEqual([expect.stringContaining("Linux's raise")])
    expect(driver.tierBGaps({ ...u12, steps: u12.steps.filter((step) => step.kind !== 'editor.close') }, 'linux'))
      .toEqual([expect.stringContaining("Linux's raise")])
    // VS Code has no folder row: its terminal row's tap brings VS Code by the raise, window or none.
    const vscode = { ...u12, app: 'vscode' as const, sessions: u12.sessions.map((s) => ({ ...s, app: 'vscode' as const })) }
    expect(driver.tierBGaps(vscode, 'linux')).toEqual([expect.stringContaining("Linux's raise")])
  })
})

describe("tier B's Claude mod: the socket its link names", () => {
  const root = '/tmp/htmux-eval'
  const named = (path: string): string => JSON.stringify({ devicesSocket: path })

  it('is the one the link named inside the daemon\'s root', () => {
    expect(claude.linkedSocket(root, 0, named(`${root}/data/devices.sock`), '')).toBe(`${root}/data/devices.sock`)
  })

  it('is refused outside the root, so the attach reaches no other daemon\'s devices', () => {
    expect(() => claude.linkedSocket(root, 0, named('/tmp/htmux-other/data/devices.sock'), '')).toThrow("outside the daemon's root")
    expect(() => claude.linkedSocket(root, 0, named('data/devices.sock'), '')).toThrow("outside the daemon's root")
  })

  it('says what the link printed on its stderr when it named none', () => {
    expect(() => claude.linkedSocket(root, 1, '', 'no devices process\n')).toThrow('no devices process')
    expect(() => claude.linkedSocket(root, 0, 'not json', '')).toThrow("named no devices' socket")
  })
})

describe("tier B's fake Claude app", () => {
  it('is one per world, started by the host that asked first: another host asking for it throws', () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-app-'))
    const world: AppWorld = { d: { root: dir, env: { PATH: process.env.PATH } }, children: [], onOpen: () => {} }
    const editor = (): { hints: Record<string, string> } => ({ hints: { TERM_PROGRAM: 'vscode' } })
    const other = (): { hints: Record<string, string> } => ({ hints: {} })
    try {
      const app = claude.appOf(world, editor)
      expect(claude.appOf(world, editor)).toBe(app)
      expect(() => claude.appOf(world, other)).toThrow('another host')
    } finally {
      for (const child of world.children) child.kill('SIGKILL')
    }
  })
})

describe("tier B's Claude sessions: the words typed into one", () => {
  const row = (type: string, content: unknown, timestamp?: string): string =>
    JSON.stringify({ type, ...(timestamp ? { timestamp } : {}), message: { role: type, content } })

  it('are each prompt its transcript took that no step typed, at the time its own row says', () => {
    const transcript = [
      row('user', '!until eval-turn-3', '2026-11-21T10:00:00.000Z'),
      row('assistant', [{ type: 'text', text: 'answer' }], '2026-11-21T10:00:01.000Z'),
      row('user', 'Eval words for alpha.', '2026-11-21T10:00:05.250Z'),
      row('user', [{ type: 'tool_result', tool_use_id: 'call', content: 'ran' }], '2026-11-21T10:00:06.000Z'),
      '{"half a row',
    ].join('\n')
    expect(claude.typedPrompts(transcript)).toEqual([{ at: Date.parse('2026-11-21T10:00:05.250Z'), text: 'Eval words for alpha.' }])
  })

  it('has no time for a prompt whose row names none', () => {
    expect(claude.typedPrompts(row('user', 'Eval words.'))).toEqual([{ text: 'Eval words.' }])
  })
})

/**
 * A reader in a thread of its own, as the fake Claude Code polls for its release file: it spins on file `i` until it
 * is there and reads it at once. The writer writes file `i` only once the reader spins on it.
 */
const READER = `
const { readFileSync } = require('node:fs')
const { workerData: { dir, count, turn } } = require('node:worker_threads')
const at = new Int32Array(turn)
let empty = 0
for (let i = 0; i < count; i++) {
  Atomics.store(at, 0, i + 1)
  Atomics.notify(at, 0)
  for (;;) {
    let text
    try { text = readFileSync(dir + '/eval-turn-' + i + '.release', 'utf8') } catch { continue }
    if (text === '') empty++
    break
  }
}
require('node:worker_threads').parentPort.postMessage(empty)
`

describe("tier B's Claude sessions: a turn's release file", () => {
  it('is never seen empty by a reader that looks the moment it is there, so its turn answers with its text', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-release-'))
    const count = 300
    const turn = new SharedArrayBuffer(4)
    const at = new Int32Array(turn)
    const reader = new Worker(READER, { eval: true, workerData: { dir, count, turn } })
    const empty = new Promise<number>((resolve, reject) => { reader.once('message', resolve); reader.once('error', reject) })
    for (let i = 0; i < count; i++) {
      while (Atomics.load(at, 0) !== i + 1) Atomics.wait(at, 0, Atomics.load(at, 0), 1_000)
      claude.writeWhole(join(dir, `eval-turn-${i}.release`), 'Eval answer one.')
    }
    expect(await empty).toBe(0)
  }, 30_000)
})

describe("the Claude mod's inbox poll", () => {
  let server: Server | undefined
  afterEach(() => { server?.close() })

  /** A daemon's socket in a throwaway folder that answers every poll with [answer]. */
  async function daemon(answer: (res: import('node:http').ServerResponse) => void): Promise<{ socketPath: string }> {
    dir = mkdtempSync(join(tmpdir(), 'tier-b-inbox-'))
    const socketPath = join(dir, 'daemon.sock')
    server = createServer((_req, res) => answer(res))
    await new Promise<void>((done) => server!.listen(socketPath, done))
    return { socketPath }
  }

  it('is answered with the JSON the daemon sent', async () => {
    const d = await daemon((res) => res.end(JSON.stringify({ text: 'Eval words.' })))
    expect(await modInbox.inboxPoll(d, 'eval')).toEqual({ status: 200, body: { text: 'Eval words.' } })
  })

  it('fails, never throws past its caller, on an answer that is not JSON', async () => {
    const d = await daemon((res) => res.end('not json'))
    await expect(modInbox.inboxPoll(d, 'eval')).rejects.toThrow(SyntaxError)
  })

  it('fails on an answer cut short', async () => {
    const d = await daemon((res) => { res.writeHead(200, { 'content-length': '100' }); res.write('{"te'); setTimeout(() => res.socket?.destroy(), 20) })
    await expect(modInbox.inboxPoll(d, 'eval')).rejects.toThrow()
  })
})
