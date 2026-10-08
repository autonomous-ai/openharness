import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ENGINE_INSTALL,
  ENGINE_INSTALL_LOCK_MAX_AGE_S,
  ENGINE_INSTALL_PRIMARY_LIMIT_S,
  ENGINE_INSTALL_WAIT_S,
  engineInstallLockPath,
  formatEngineLockOwner,
  parseEngineLockOwner,
  type EngineInstallRecipe,
} from './engineInstall.js'
import { backgroundInstallArgv, buildEngineLaunchArgv, shellSingleQuote } from './engineLaunch.js'
import {
  RETRY_FAILED_INSTALL_MS,
  engineInstallStateFile,
  inspectLock,
  installMissingEngines,
  releaseLock,
  warmupLockPath,
  type WarmupOptions,
  type WarmupResult,
} from './engineWarmup.js'
import { processStartMarker } from './processLiveness.js'
import { launchScriptOf } from '../testing/launchScript.js'
import type { ProcessEngine } from '../engines/types.js'

// Every case runs real shells: the daemon's own probe (an interactive shell per engine) and the pane's
// own install script, with installers that only write files into a throwaway home. Nothing here may
// reach the network or the developer's own ~/.local, ~/.opencode or npm prefix.
vi.setConfig({ testTimeout: 60_000 })

const CLI_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SHELLS = ['/bin/sh', '/bin/zsh'].filter(existsSync)
const roots: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A pid that is certainly not running: a process that has already exited. */
function deadPid(): number {
  const done = spawnSync('/bin/sh', ['-c', 'exit 0'])
  return done.pid!
}

/** A live process to hold a lock, ended at teardown. */
function livePid(): number {
  const child = spawn('/bin/sh', ['-c', 'sleep 60'], { stdio: 'ignore' })
  children.push(child)
  return child.pid!
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Hold [lock] for [pid] as a pane or the background install would: its owner line. */
function hold(lock: string, pid: number, { kind = 'pane', start = processStartMarker(pid) ?? '', since = Math.floor(Date.now() / 1000) } = {}): void {
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner'), formatEngineLockOwner({ pid, since, kind, start }))
}

/** A start marker in the same form as [pid]'s but not its own: what a pid reused since looks like. */
function otherStart(pid: number): string {
  return `${(processStartMarker(pid) ?? 'ps-c:').split(':')[0]}:Thu Jan  1 00:00:00 1970`
}

/** A pane started as tmux would start it, in a session of its own (so a Ctrl-C can be sent to its group). */
function startPane(argv: readonly string[], extra: readonly string[] = []) {
  const child = spawn(argv[0], [...argv.slice(1), ...extra], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  children.push(child)
  let stdout = ''
  child.stdout!.on('data', (chunk) => { stdout += chunk })
  child.stderr!.on('data', () => { /* rc noise */ })
  const started = Date.now()
  const done = new Promise<{ code: number | null; stdout: string; seconds: number }>((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, seconds: (Date.now() - started) / 1000 }))
  })
  return { child, done, output: () => stdout }
}

/**
 * A fresh OS user with none of the four engines: an empty home, a PATH with no engine on it, and an
 * npm global prefix of its own, so the probe's `npm prefix -g` cannot find the developer's.
 */
function fixture(shell = '/bin/sh') {
  const root = mkdtempSync(join(tmpdir(), 'harness-warmup-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  vi.stubEnv('HOME', home)
  vi.stubEnv('PATH', '/usr/bin:/bin')
  vi.stubEnv('SHELL', shell)
  vi.stubEnv('ENV', '')
  vi.stubEnv('npm_config_prefix', join(root, 'npm-global'))
  vi.stubEnv('HARNESS_LOGS_DIR', join(root, 'logs'))
  const order = join(root, 'order')
  const logFile = join(root, 'logs', 'engine-install.log')
  // Where each engine's own installer leaves it: OpenCode's native installer in ~/.opencode/bin, npm
  // (pointed at ~/.local by the script) in ~/.local/bin.
  const installedAt: Record<string, string> = {
    opencode: join(home, '.opencode', 'bin', 'opencode'),
    claude: join(home, '.local', 'bin', 'claude'),
    codex: join(home, '.local', 'bin', 'codex'),
    pi: join(home, '.local', 'bin', 'pi'),
  }
  /** A shell line that installs [engine] as a script printing ENGINE_READY, and notes that it ran. */
  const fakeInstall = (engine: string, before = '') => {
    const path = installedAt[engine]
    return `${before}mkdir -p ${shellSingleQuote(dirname(path))} && printf '%s\\n' '#!/bin/sh' 'echo "ENGINE_READY:$*"' > ${shellSingleQuote(path)} && chmod 755 ${shellSingleQuote(path)} && printf '%s\\n' ${engine} >> ${shellSingleQuote(order)}`
  }
  /** The engine's own recipe, where it looks for the executable included, with these install lines. */
  const recipe = (engine: ProcessEngine, command: string, fallback?: string): EngineInstallRecipe => {
    const { fallback: _official, ...official } = ENGINE_INSTALL[engine]
    return { ...official, command, ...(fallback ? { fallback } : {}) }
  }
  const recipes = Object.fromEntries((['opencode', 'claude', 'codex', 'pi'] as const).map((engine) => [engine, recipe(engine, fakeInstall(engine))]))
  const lines: string[] = []
  const run = (options: WarmupOptions = {}) => installMissingEngines({
    recipes, shell, logFile, emit: (line) => lines.push(line), ...options,
  })
  const ran = (): string[] => existsSync(order) ? readFileSync(order, 'utf8').trim().split('\n') : []
  const preinstall = (engine: string) => {
    mkdirSync(dirname(installedAt[engine]), { recursive: true })
    writeFileSync(installedAt[engine], '#!/bin/sh\necho "ENGINE_READY:$*"\n', { mode: 0o755 })
  }
  /** The pane's own launch of OpenCode, installing it with [command] when missing. */
  const pane = (command: string, paneShell = shell) => buildEngineLaunchArgv('opencode', {
    installIfMissing: recipe('opencode', command),
  }, paneShell, process.execPath, 'grid', null)
  const lock = engineInstallLockPath(ENGINE_INSTALL.opencode)
  return { root, home, order, logFile, installedAt, fakeInstall, recipe, recipes, lines, run, ran, preinstall, pane, lock }
}

const outcomes = (results: readonly WarmupResult[]) => Object.fromEntries(results.map((result) => [result.engine, result.status]))

describe('installMissingEngines', () => {
  for (const shell of SHELLS) {
    it(`installs every missing engine through ${shell}, OpenCode first, and leaves one that is there alone`, async () => {
      const f = fixture(shell)
      f.preinstall('claude')
      const outcome = await f.run()
      expect(outcome.busy).toBe(false)
      if (outcome.busy) return
      expect(f.ran()).toEqual(['opencode', 'codex', 'pi'])
      expect(outcome.results.map((result) => result.engine)).toEqual(['opencode', 'claude', 'codex', 'pi'])
      expect(outcomes(outcome.results)).toEqual({ opencode: 'installed', claude: 'already-installed', codex: 'installed', pi: 'installed' })
      expect(outcome.results[0].path).toBe(f.installedAt.opencode)
      // The summary: a JSON line per engine, and the same lines in the log.
      expect(f.lines.map((line) => JSON.parse(line).status)).toEqual(['installed', 'already-installed', 'installed', 'installed'])
      const log = readFileSync(f.logFile, 'utf8')
      expect(log).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[opencode\] missing; installing$/m)
      expect(log).toContain('[opencode] harness: OpenCode is missing — installing it in the background')
      expect(log).toContain(`[summary] {"engine":"claude","status":"already-installed","path":${JSON.stringify(f.installedAt.claude)}}`)
      // Every lock let go.
      expect(existsSync(warmupLockPath())).toBe(false)
      expect(existsSync(f.lock)).toBe(false)

      // A second run finds all four and installs nothing.
      f.lines.length = 0
      const again = await f.run()
      expect(!again.busy && outcomes(again.results)).toEqual({ opencode: 'already-installed', claude: 'already-installed', codex: 'already-installed', pi: 'already-installed' })
      expect(f.ran()).toEqual(['opencode', 'codex', 'pi'])
    })
  }

  it('installs the npm fallback when the first installer leaves nothing, as a pane would', async () => {
    const f = fixture()
    const outcome = await f.run({ engines: ['opencode'], recipes: { opencode: f.recipe('opencode', 'true', f.fakeInstall('opencode')) } })
    expect(!outcome.busy && outcome.results).toEqual([expect.objectContaining({ engine: 'opencode', status: 'installed', path: f.installedAt.opencode })])
    expect(readFileSync(f.logFile, 'utf8')).toContain('trying the npm package instead')
  })

  it('reports a failed install with the reason its script gave, and goes on to the next engine', async () => {
    const f = fixture()
    const outcome = await f.run({ engines: ['opencode', 'codex'], recipes: { opencode: f.recipe('opencode', 'exit 7', 'exit 9'), codex: f.recipes.codex } })
    expect(!outcome.busy && outcome.results).toEqual([
      expect.objectContaining({ engine: 'opencode', status: 'failed', reason: 'the OpenCode install failed (exit 9)' }),
      expect.objectContaining({ engine: 'codex', status: 'installed' }),
    ])
    expect(existsSync(f.lock)).toBe(false)
  })

  it('reports an engine its probe missed but its script found as there already, not installed', async () => {
    const f = fixture()
    // On PATH, not at an install path: only the probe and the script look there.
    const bin = join(f.root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'opencode'), '#!/bin/sh\necho "ENGINE_READY:$*"\n', { mode: 0o755 })
    vi.stubEnv('PATH', `${bin}:/usr/bin:/bin`)
    const outcome = await f.run({
      engines: ['opencode'],
      probe: async () => [{ engine: 'opencode', installed: false, command: 'opencode', installable: true }],
    })
    expect(!outcome.busy && outcome.results).toEqual([{ engine: 'opencode', status: 'already-installed', path: join(bin, 'opencode') }])
    expect(f.ran()).toEqual([])
  })

  it('probes no engine it can settle without a shell', async () => {
    const f = fixture()
    for (const engine of ['opencode', 'claude', 'codex']) f.preinstall(engine)
    // pi was seen here once (state.json) and is gone now: nothing to probe either.
    mkdirSync(dirname(engineInstallStateFile()), { recursive: true })
    writeFileSync(engineInstallStateFile(), JSON.stringify({ engines: { pi: { presentAt: new Date().toISOString() } } }))
    const outcome = await f.run({ probe: async () => { throw new Error('no probe was needed') } })
    expect(!outcome.busy && outcome.results).toEqual([
      { engine: 'opencode', status: 'already-installed', path: f.installedAt.opencode },
      { engine: 'claude', status: 'already-installed', path: f.installedAt.claude },
      { engine: 'codex', status: 'already-installed', path: f.installedAt.codex },
      { engine: 'pi', status: 'skipped', reason: expect.stringContaining('removed since and not put back') },
    ])
    expect(readFileSync(f.logFile, 'utf8')).toContain('every engine settled without a probe')
  })

  it('goes on to the next engine when one install cannot even be started', async () => {
    const f = fixture()
    // A login shell that is not POSIX gets its script through a one-time launch file; with nowhere to
    // write one, building the install's argv throws.
    const launch = join(process.env.ADAPTER_DATA_DIR!, 'launch')
    rmSync(launch, { recursive: true, force: true })
    writeFileSync(launch, 'not a folder')
    try {
      const outcome = await f.run({ engines: ['opencode', 'codex'], shell: '/nonexistent/fish' })
      expect(!outcome.busy && outcome.results).toEqual([
        expect.objectContaining({ engine: 'opencode', status: 'failed', reason: expect.stringMatching(/^could not start its install: /) }),
        expect.objectContaining({ engine: 'codex', status: 'failed', reason: expect.stringMatching(/^could not start its install: /) }),
      ])
      expect(existsSync(warmupLockPath())).toBe(false)
    } finally {
      unlinkSync(launch)
    }
  })

  it('takes over an engine lock whose holder is gone', async () => {
    const f = fixture()
    hold(f.lock, deadPid(), { start: '' })
    const outcome = await f.run({ engines: ['opencode'] })
    expect(!outcome.busy && outcome.results[0]).toMatchObject({ status: 'installed' })
    expect(f.ran()).toEqual(['opencode'])
    expect(existsSync(f.lock)).toBe(false)
  })

  it('takes over a lock whose pid now runs another process, or that is old and cannot be checked', async () => {
    const f = fixture()
    const pid = livePid()
    hold(f.lock, pid, { start: otherStart(pid) })
    const first = await f.run({ engines: ['opencode'] })
    expect(!first.busy && first.results[0]).toMatchObject({ status: 'installed' })
    expect(readFileSync(f.logFile, 'utf8')).not.toContain('waiting for it')

    rmSync(f.installedAt.opencode)
    rmSync(engineInstallStateFile())
    hold(f.lock, pid, { start: '', since: Math.floor(Date.now() / 1000) - ENGINE_INSTALL_LOCK_MAX_AGE_S - 60 })
    const second = await f.run({ engines: ['opencode'] })
    expect(!second.busy && second.results[0]).toMatchObject({ status: 'installed' })
    expect(readFileSync(f.logFile, 'utf8')).not.toContain('waiting for it')
    expect(f.ran()).toEqual(['opencode', 'opencode'])
  })

  it('waits for an install however long it has run, while its holder checks out by its start', async () => {
    // A slow pane install past half an hour is still an install: a second one beside it would break it.
    const f = fixture()
    hold(f.lock, livePid(), { since: Math.floor(Date.now() / 1000) - ENGINE_INSTALL_LOCK_MAX_AGE_S - 60 })
    const running = f.run({ engines: ['opencode'] })
    await until(() => existsSync(f.logFile) && readFileSync(f.logFile, 'utf8').includes('waiting for it'))
    f.preinstall('opencode')
    rmSync(f.lock, { recursive: true })
    const outcome = await running
    expect(!outcome.busy && outcome.results[0]).toMatchObject({ status: 'already-installed' })
    expect(f.ran()).toEqual([])
  })

  it('waits for an install of the same engine another terminal holds, then reports what it left', async () => {
    const f = fixture()
    hold(f.lock, livePid())
    const running = f.run({ engines: ['opencode'] })
    await until(() => existsSync(f.logFile) && readFileSync(f.logFile, 'utf8').includes('waiting for it'))
    expect(readFileSync(f.logFile, 'utf8')).toContain('[opencode] harness: OpenCode is already installing in another terminal — waiting for it')
    // The other install finishes: the engine is there, and its lock let go. Nothing was installed here.
    f.preinstall('opencode')
    rmSync(f.lock, { recursive: true })
    const outcome = await running
    expect(!outcome.busy && outcome.results[0]).toEqual({ engine: 'opencode', status: 'already-installed', path: f.installedAt.opencode })
    expect(f.ran()).toEqual([])
  })

  it('exits at once while another run is going, and takes over a run lock whose holder is gone', async () => {
    const f = fixture()
    hold(warmupLockPath(), process.pid, { kind: 'run' })
    const started = Date.now()
    await expect(f.run()).resolves.toEqual({ busy: true, pid: process.pid })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(f.lines).toEqual([JSON.stringify({ status: 'busy', pid: process.pid })])
    expect(f.ran()).toEqual([])
    // The lock is still the other run's.
    expect(parseEngineLockOwner(readFileSync(join(warmupLockPath(), 'owner'), 'utf8'))?.pid).toBe(process.pid)

    hold(warmupLockPath(), deadPid(), { kind: 'run', start: '' })
    const outcome = await f.run({ engines: ['opencode'] })
    expect(!outcome.busy && outcome.results[0]).toMatchObject({ status: 'installed' })
    expect(existsSync(warmupLockPath())).toBe(false)
  })

  it('kills an install that runs past its time limit, its whole process group with it', async () => {
    const f = fixture()
    const sleeper = join(f.root, 'sleeper')
    const fallback = join(f.root, 'fallback-ran')
    const outcome = await f.run({
      engines: ['opencode', 'codex'],
      recipes: {
        opencode: f.recipe('opencode', `sleep 60 & printf '%s' $! > ${shellSingleQuote(sleeper)}; wait`, `touch ${shellSingleQuote(fallback)}`),
        codex: f.recipes.codex,
      },
      timeoutMs: 1_500,
      killGraceMs: 500,
    })
    expect(!outcome.busy && outcome.results).toEqual([
      expect.objectContaining({ engine: 'opencode', status: 'failed', reason: 'timed out after 2s' }),
      expect.objectContaining({ engine: 'codex', status: 'installed' }),
    ])
    const pid = Number(readFileSync(sleeper, 'utf8'))
    await until(() => !alive(pid), 5_000)
    // Killed is the end of it: the shell does not go on to the fallback, a second install.
    expect(existsSync(fallback)).toBe(false)
    expect(existsSync(f.lock)).toBe(false)
  })

  it('on a signal kills the install running, starts no other and lets go of every lock', async () => {
    const f = fixture()
    const abort = new AbortController()
    const running = f.run({
      engines: ['opencode', 'codex'],
      recipes: { opencode: f.recipe('opencode', 'sleep 60'), codex: f.recipes.codex },
      signal: abort.signal,
      killGraceMs: 500,
    })
    await until(() => existsSync(join(f.lock, 'owner')))
    abort.abort('SIGTERM')
    const outcome = await running
    expect(outcome).toEqual({ busy: false, interrupted: true, results: [expect.objectContaining({ engine: 'opencode', status: 'failed', reason: 'interrupted' })] })
    expect(f.ran()).toEqual([])
    expect(existsSync(warmupLockPath())).toBe(false)
    expect(existsSync(f.lock)).toBe(false)
    // An interrupted install says nothing about the engine: the next run tries it.
    const next = await f.run({ engines: ['opencode'] })
    expect(!next.busy && next.results[0]).toMatchObject({ status: 'installed' })
  })

  it('skips an engine whose launch path is set by hand', async () => {
    const f = fixture()
    const outcome = await f.run({
      engines: ['opencode'],
      probe: async () => [{ engine: 'opencode', installed: false, command: '/opt/custom/opencode', installable: false }],
    })
    expect(!outcome.busy && outcome.results).toEqual([expect.objectContaining({ engine: 'opencode', status: 'skipped' })])
    expect(f.ran()).toEqual([])
  })
})

describe('what a run remembers', () => {
  it('never puts back an engine the person removed, whoever had installed it', async () => {
    const f = fixture()
    f.preinstall('claude')
    const first = await f.run({ engines: ['opencode', 'claude'] })
    expect(!first.busy && outcomes(first.results)).toEqual({ opencode: 'installed', claude: 'already-installed' })
    rmSync(f.installedAt.opencode)
    rmSync(f.installedAt.claude)
    const second = await f.run({ engines: ['opencode', 'claude'] })
    expect(!second.busy && second.results).toEqual([
      { engine: 'opencode', status: 'skipped', reason: expect.stringContaining('removed since and not put back') },
      { engine: 'claude', status: 'skipped', reason: expect.stringContaining('removed since and not put back') },
    ])
    expect(f.ran()).toEqual(['opencode'])
  })

  it('does not try a failed install again for a day', async () => {
    const f = fixture()
    const failing = { opencode: f.recipe('opencode', 'exit 7') }
    const first = await f.run({ engines: ['opencode'], recipes: failing })
    expect(!first.busy && first.results[0]).toMatchObject({ status: 'failed' })
    const second = await f.run({ engines: ['opencode'] })
    expect(!second.busy && second.results[0]).toEqual({ engine: 'opencode', status: 'skipped', reason: expect.stringContaining('tried again a day after') })
    expect(f.ran()).toEqual([])
    const nextDay = await f.run({ engines: ['opencode'], now: () => Date.now() + RETRY_FAILED_INSTALL_MS + 60_000 })
    expect(!nextDay.busy && nextDay.results[0]).toMatchObject({ status: 'installed' })
    expect(JSON.parse(readFileSync(engineInstallStateFile(), 'utf8')).engines.opencode).toEqual({
      presentAt: expect.any(String), installedAt: expect.any(String),
    })
  })
})

describe('the lock, from Node', () => {
  it('holds only for the process that took it, and ages out only a holder it cannot check', () => {
    const f = fixture()
    const old = Math.floor(Date.now() / 1000) - ENGINE_INSTALL_LOCK_MAX_AGE_S - 60
    hold(f.lock, process.pid)
    expect(inspectLock(f.lock)).toMatchObject({ state: 'held', owner: { pid: process.pid } })
    hold(f.lock, process.pid, { start: otherStart(process.pid) })
    expect(inspectLock(f.lock).state).toBe('stale')
    hold(f.lock, process.pid, { since: old })
    expect(inspectLock(f.lock).state).toBe('held')
    hold(f.lock, process.pid, { start: '', since: old })
    expect(inspectLock(f.lock).state).toBe('stale')
    hold(f.lock, process.pid, { start: '' })
    expect(inspectLock(f.lock).state).toBe('held')
    hold(f.lock, deadPid(), { start: '' })
    expect(inspectLock(f.lock).state).toBe('stale')
  })

  it('is let go only by its holder, never while it has no owner line yet', () => {
    const f = fixture()
    const start = processStartMarker(process.pid) ?? ''
    mkdirSync(f.lock, { recursive: true })
    releaseLock(f.lock, { pid: process.pid, start })
    expect(existsSync(f.lock)).toBe(true)
    hold(f.lock, process.pid, { start: otherStart(process.pid) })
    releaseLock(f.lock, { pid: process.pid, start })
    expect(existsSync(f.lock)).toBe(true)
    hold(f.lock, process.pid + 1, { start })
    releaseLock(f.lock, { pid: process.pid, start })
    expect(existsSync(f.lock)).toBe(true)
    hold(f.lock, process.pid)
    releaseLock(f.lock, { pid: process.pid, start })
    expect(existsSync(f.lock)).toBe(false)
  })
})

describe('a pane whose engine is installing elsewhere', () => {
  // The pane's own launch, login shell and all, as tmux would start it (without a terminal, so the
  // engine's exit status is the pane's).
  for (const shell of SHELLS) {
    it(`waits in ${shell} for the background install and starts the engine it left, without an installer of its own`, async () => {
      const f = fixture(shell)
      const paneInstalled = join(f.root, 'pane-installer-ran')
      // The background install takes a while; the pane is created meanwhile.
      const background = f.run({ engines: ['opencode'], recipes: { opencode: f.recipe('opencode', f.fakeInstall('opencode', 'sleep 2; ')) } })
      await until(() => existsSync(join(f.lock, 'owner')))
      const pane = await startPane(f.pane(`touch ${shellSingleQuote(paneInstalled)}`), ['argument with spaces']).done
      expect(pane.stdout).toContain('harness: OpenCode is already installing in the background — waiting for it (Ctrl-C stops waiting)')
      expect(pane.stdout).toContain('harness: OpenCode is installed')
      expect(pane.stdout).toContain('ENGINE_READY:argument with spaces')
      expect(pane.stdout).not.toContain('engine is missing')
      expect(pane.code).toBe(0)
      expect(existsSync(paneInstalled)).toBe(false)
      const outcome = await background
      expect(!outcome.busy && outcome.results[0]).toMatchObject({ status: 'installed' })
    })

    it(`in ${shell}, waits for an install still running even when the executable is already there`, async () => {
      // npm links the executable before the package's postinstall: found mid-install, it can fail.
      const f = fixture(shell)
      f.preinstall('opencode')
      hold(f.lock, livePid(), { kind: 'background' })
      const pane = startPane(f.pane('exit 9'), ['now'])
      await until(() => pane.output().includes('waiting for it'))
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(pane.output()).not.toContain('ENGINE_READY')
      rmSync(f.lock, { recursive: true })
      const done = await pane.done
      expect(done.code).toBe(0)
      expect(done.stdout.indexOf('waiting for it')).toBeLessThan(done.stdout.indexOf('ENGINE_READY:now'))
    })

    it(`in ${shell}, a person's rc aliases do not change the lock`, async () => {
      // Prezto aliases mkdir to `mkdir -p`, which made every pane's mkdir of the lock succeed. The rest
      // would each break the lock their own way: a numbered owner line, a wrong start marker, a holder
      // always alive or never waited for.
      const f = fixture(shell)
      const aliases = "alias mkdir='mkdir -p'\nalias cat='cat -n'\nalias ps='echo nope'\nalias awk=false\nalias kill=true\nalias date='echo 0'\nalias sleep=false\n"
      const rc = join(f.root, 'rc')
      mkdirSync(rc)
      writeFileSync(join(rc, '.zshrc'), aliases)
      writeFileSync(join(rc, 'env.sh'), aliases)
      vi.stubEnv('ZDOTDIR', rc)
      vi.stubEnv('ENV', join(rc, 'env.sh'))
      const paneInstalled = join(f.root, 'pane-installer-ran')
      hold(f.lock, livePid(), { kind: 'background' })
      const pane = startPane(f.pane(`touch ${shellSingleQuote(paneInstalled)}`), ['aliased'])
      await until(() => pane.output().includes('waiting for it'))
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(existsSync(paneInstalled)).toBe(false)
      expect(pane.output()).not.toContain('stopped waiting')
      f.preinstall('opencode')
      rmSync(f.lock, { recursive: true })
      const done = await pane.done
      expect(done.stdout).toContain('ENGINE_READY:aliased')
      expect(done.code).toBe(0)
      expect(existsSync(paneInstalled)).toBe(false)
    })

    it(`in ${shell}, a person's rc aliases do not let a pane take a lock someone holds`, () => {
      // The race the whole-pane case above cannot time: the lock is taken by someone else between
      // the pane's wait and its own take. The pane's functions, then one take, under those aliases.
      const f = fixture(shell)
      const rc = join(f.root, 'rc')
      mkdirSync(rc)
      writeFileSync(join(rc, '.zshrc'), "alias mkdir='mkdir -p'\n")
      writeFileSync(join(rc, 'env.sh'), "alias mkdir='mkdir -p'\n")
      vi.stubEnv('ZDOTDIR', rc)
      vi.stubEnv('ENV', join(rc, 'env.sh'))
      const holder = livePid()
      hold(f.lock, holder, { kind: 'background' })
      const script = launchScriptOf(f.pane('true'))
      const functions = script.slice(0, script.indexOf('\nharness_lock_await\n'))
      const take = spawnSync(shell, ['-ic', `${functions}\nif harness_lock_take; then echo TOOK; else echo BUSY; fi`, 'harness-engine', 'opencode'], {
        encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(take.stdout.trim()).toBe('BUSY')
      expect(parseEngineLockOwner(readFileSync(join(f.lock, 'owner'), 'utf8'))?.pid).toBe(holder)
    })

    it(`in ${shell}, Ctrl-C stops the wait, and the pane says so without installing`, async () => {
      const f = fixture(shell)
      const paneInstalled = join(f.root, 'pane-installer-ran')
      const holder = livePid()
      hold(f.lock, holder, { kind: 'background' })
      const pane = startPane(f.pane(`touch ${shellSingleQuote(paneInstalled)}`))
      await until(() => pane.output().includes('waiting for it'))
      process.kill(-pane.child.pid!, 'SIGINT')
      const done = await pane.done
      expect(done.code).toBe(130)
      expect(done.stdout).toContain('harness: stopped waiting, so the agent was not started. The OpenCode install goes on; create the agent again once it finishes.')
      expect(existsSync(paneInstalled)).toBe(false)
      expect(parseEngineLockOwner(readFileSync(join(f.lock, 'owner'), 'utf8'))?.pid).toBe(holder)
    })

    it(`in ${shell}, takes the lock as itself and lets it go after installing`, async () => {
      const f = fixture(shell)
      hold(f.lock, deadPid(), { start: '' })
      const seen = join(f.root, 'owner-during-install')
      // The installer copies the owner line, then gives the test a moment to read the pane's own start.
      const pane = startPane(f.pane(`cat ${shellSingleQuote(join(f.lock, 'owner'))} > ${shellSingleQuote(seen)}; sleep 1; ${f.fakeInstall('opencode')}`))
      await until(() => existsSync(seen) && readFileSync(seen, 'utf8').length > 0)
      const marker = processStartMarker(pane.child.pid!)
      const done = await pane.done
      expect(done.code, done.stdout).toBe(0)
      expect(done.stdout).toContain('engine is missing — installing it in this terminal')
      expect(done.stdout).not.toContain('waiting for it')
      // The line the shell wrote is the one Node writes: the same pid, kind and start marker.
      expect(parseEngineLockOwner(readFileSync(seen, 'utf8'))).toEqual({ pid: pane.child.pid, since: expect.any(Number), kind: 'pane', start: marker })
      expect(existsSync(f.lock)).toBe(false)
    })
  }

  it('counts a lock with no owner line yet per folder: a new one is not removed for the last one\'s looks', async () => {
    const f = fixture()
    const paneInstalled = join(f.root, 'pane-installer-ran')
    mkdirSync(f.lock, { recursive: true })
    const pane = startPane(f.pane(`touch ${shellSingleQuote(paneInstalled)}`))
    await until(() => pane.output().includes('waiting for it'))
    await new Promise((resolve) => setTimeout(resolve, 6_000))
    // Another holder's folder, between its mkdir and its owner line: six looks at the first do not
    // count. Made before the first goes, so it cannot be given the first one's inode back.
    mkdirSync(`${f.lock}.next`)
    rmSync(f.lock, { recursive: true })
    renameSync(`${f.lock}.next`, f.lock)
    await new Promise((resolve) => setTimeout(resolve, 6_000))
    expect(existsSync(f.lock)).toBe(true)
    expect(existsSync(paneInstalled)).toBe(false)
    f.preinstall('opencode')
    rmSync(f.lock, { recursive: true })
    const done = await pane.done
    expect(done.code).toBe(0)
    expect(existsSync(paneInstalled)).toBe(false)
  }, 60_000)

  for (const shell of SHELLS) {
    /** The pane's lock functions in [shell], then [probe], against the lock as the test left it. */
    const lockProbe = (f: ReturnType<typeof fixture>, probe: string) => {
      const script = launchScriptOf(f.pane('true', shell))
      const functions = script.slice(0, script.indexOf('\nharness_lock_await\n'))
      return spawnSync(shell, ['-c', `${functions}\n${probe}`, 'harness-engine', 'opencode'], { encoding: 'utf8', timeout: 20_000 })
    }

    it(`in ${shell}, never goes on without the lock while one can be made, however it is contested`, () => {
      const f = fixture(shell)
      const take = 'if harness_lock_take; then echo "TAKEN:$harness_lock_held"; else echo WAIT; fi'
      // A lock let go between a failed mkdir and the look reads the same as this: no folder, no mkdir.
      mkdirSync(dirname(f.lock), { recursive: true })
      writeFileSync(f.lock, 'in the way')
      expect(lockProbe(f, take).stdout.trim()).toBe('WAIT')
      rmSync(f.lock)
      expect(lockProbe(f, take).stdout.trim()).toBe('TAKEN:1')
    })

    it(`in ${shell}, goes on without a lock only where none can be made`, () => {
      const f = fixture(shell)
      const dir = dirname(f.lock)
      mkdirSync(dir, { recursive: true })
      chmodSync(dir, 0o555)
      try {
        expect(lockProbe(f, 'if harness_lock_take; then echo "TAKEN:$harness_lock_held"; else echo WAIT; fi').stdout.trim()).toBe('TAKEN:')
      } finally {
        chmodSync(dir, 0o755)
      }
    })

    it(`in ${shell}, does not remove a stale lock that changed hands while it was looked at`, () => {
      const f = fixture(shell)
      hold(f.lock, deadPid(), { start: '' })
      const fresh = `${livePid()} 1 pane x`
      // The holder is judged gone, and in that moment a new one takes the folder over.
      const probe = `harness_lock_live() { printf '%s\\n' ${shellSingleQuote(fresh)} > ${shellSingleQuote(join(f.lock, 'owner'))}; return 1; }\n`
        + 'if harness_lock_busy; then echo BUSY; else echo FREE; fi'
      expect(lockProbe(f, probe).stdout.trim()).toBe('BUSY')
      expect(readFileSync(join(f.lock, 'owner'), 'utf8').trim()).toBe(fresh)
    })

    it(`in ${shell}, stops a first installer that stalls, its whole tree, and runs the fallback`, async () => {
      const f = fixture(shell)
      const rc = join(f.root, 'rc')
      mkdirSync(rc)
      writeFileSync(join(rc, '.zshrc'), '')
      vi.stubEnv('ZDOTDIR', rc)
      const sleeper = join(f.root, 'sleeper')
      // A download accepted and then stalled: never exits, and has a child of its own.
      const stalled = `sh -c 'sleep 1000 & printf "%s" $! > ${sleeper}; wait'`
      const argv = buildEngineLaunchArgv('opencode', {
        installIfMissing: f.recipe('opencode', stalled, f.fakeInstall('opencode')),
      }, shell, process.execPath, 'grid', null)
      const script = launchScriptOf(argv)
      const limit = `harness_primary_limit=${ENGINE_INSTALL_PRIMARY_LIMIT_S}`
      expect(script).toContain(limit)
      // The limit is two minutes; the same script with it at two seconds, in an interactive shell as a pane's is.
      const pane = await startPane([shell, '-ic', script.replace(limit, 'harness_primary_limit=2'), 'harness-engine', 'opencode', 'after the stall']).done
      expect(pane.stdout).toContain('harness: that install ran for 2s without finishing, so it was stopped')
      expect(pane.stdout).toContain('trying the npm package instead')
      expect(pane.stdout).toContain('ENGINE_READY:after the stall')
      expect(pane.code).toBe(0)
      expect(pane.seconds).toBeLessThan(20)
      await until(() => !alive(Number(readFileSync(sleeper, 'utf8'))), 5_000)
      expect(f.ran()).toEqual(['opencode'])
    })
  }

  it('in the background too, a stalled first installer gives way to the fallback before the run\'s own limit', async () => {
    const f = fixture()
    const recipe = f.recipe('opencode', 'sleep 1000', f.fakeInstall('opencode'))
    const script = launchScriptOf(backgroundInstallArgv('opencode', recipe, '/bin/sh'))
    const limit = `harness_primary_limit=${ENGINE_INSTALL_PRIMARY_LIMIT_S}`
    expect(script).toContain(limit)
    const run = await startPane(['/bin/sh', '-ic', script.replace(limit, 'harness_primary_limit=2'), 'harness-engine-install', 'opencode']).done
    expect(run.stdout).toContain('that install ran for 2s without finishing, so it was stopped')
    expect(run.stdout).toContain(`harness-engine-installed: ${f.installedAt.opencode}`)
    expect(run.code).toBe(0)
  })

  it('gives up past its wait with a line saying why, without installing, and says it is still waiting meanwhile', async () => {
    const f = fixture()
    const paneInstalled = join(f.root, 'pane-installer-ran')
    hold(f.lock, livePid(), { kind: 'background' })
    // The wait is five minutes; this runs the same script with it at three seconds and a line a second.
    const script = launchScriptOf(f.pane(`touch ${shellSingleQuote(paneInstalled)}`))
    const waitCheck = `[ "$harness_lock_waits" -ge ${ENGINE_INSTALL_WAIT_S} ]`
    expect(script).toContain(waitCheck)
    expect(script).toContain('$((harness_lock_waits % 15))')
    const short = script.replace(waitCheck, '[ "$harness_lock_waits" -ge 3 ]').replace('$((harness_lock_waits % 15))', '$((harness_lock_waits % 1))')
    const pane = await startPane(['/bin/sh', '-c', short, 'harness-engine', 'opencode']).done
    expect(pane.code).toBe(1)
    expect(pane.stdout).toContain('harness: still waiting for the OpenCode install (1s)')
    expect(pane.stdout).toContain(`harness: OpenCode is still installing in the background after ${ENGINE_INSTALL_WAIT_S}s, so this agent was not started.`)
    expect(existsSync(paneInstalled)).toBe(false)
    expect(existsSync(join(f.lock, 'owner'))).toBe(true)
  })
})

describe('harness engines install-missing', () => {
  const TSX = join(CLI_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const CLI = join(CLI_ROOT, 'src', 'cli.ts')

  /** A home with all four engines, so a run probes and installs nothing: no network, whatever the recipes say. */
  function cliFixture() {
    const f = fixture()
    for (const engine of ['opencode', 'claude', 'codex', 'pi']) f.preinstall(engine)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: f.home,
      PATH: '/usr/bin:/bin',
      SHELL: '/bin/sh',
      ADAPTER_DATA_DIR: join(f.root, 'data'),
      ADAPTER_RUNTIME_DIR: join(f.root, 'runtime'),
      HARNESS_AUTH_DIR: join(f.root, 'auth'),
      ADAPTER_COMPUTER_ID_FILE: join(f.root, 'computer-id'),
    }
    return { ...f, env }
  }

  it('prints a JSON line per engine', () => {
    const f = cliFixture()
    const result = spawnSync(process.execPath, [TSX, CLI, 'engines', 'install-missing'], { env: f.env, encoding: 'utf8', timeout: 60_000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual(
      ['opencode', 'claude', 'codex', 'pi'].map((engine) => ({ engine, status: 'already-installed', path: f.installedAt[engine] })),
    )
  })

  it('--background returns at once and the run it started records its result', async () => {
    const f = cliFixture()
    const result = spawnSync(process.execPath, [TSX, CLI, 'engines', 'install-missing', '--background'], { env: f.env, encoding: 'utf8', timeout: 60_000 })
    expect(result.status, result.stderr).toBe(0)
    const started = JSON.parse(result.stdout.trim())
    expect(started).toMatchObject({ status: 'started', pid: expect.any(Number), log: join(f.root, 'logs', 'engine-install.log') })
    try {
      await until(() => existsSync(started.log) && readFileSync(started.log, 'utf8').includes('[install-missing] done'), 45_000)
      await until(() => !alive(started.pid), 10_000)
      expect(readFileSync(started.log, 'utf8')).toContain(`[summary] {"engine":"pi","status":"already-installed","path":${JSON.stringify(f.installedAt.pi)}}`)
    } finally {
      try { process.kill(-started.pid, 'SIGKILL') } catch { /* ended */ }
    }
  })
})
