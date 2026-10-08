import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENGINE_INSTALL, engineInstallLockPath, type EngineInstallRecipe } from './engineInstall.js'
import { buildEngineLaunchArgv, shellSingleQuote } from './engineLaunch.js'
import {
  engineInstallStatusFile,
  installMissingEngines,
  warmupLockPath,
  type WarmupOptions,
  type WarmupResult,
} from './engineWarmup.js'
import type { ProcessEngine } from '../engines/types.js'

// Every case runs real shells: the daemon's own probe (an interactive shell per engine) and the pane's
// own install script, with installers that only write files into a throwaway home. Nothing here may
// reach the network or the developer's own ~/.local, ~/.opencode or npm prefix.
vi.setConfig({ testTimeout: 60_000 })

const CLI_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const roots: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
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
  return { root, home, order, logFile, installedAt, fakeInstall, recipe, recipes, lines, run, ran, preinstall }
}

const outcomes = (results: readonly WarmupResult[]) => Object.fromEntries(results.map((result) => [result.engine, result.status]))

describe('installMissingEngines', () => {
  for (const shell of ['/bin/sh', '/bin/zsh'].filter(existsSync)) {
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
      // The summary: a JSON line per engine, the same lines in the log, and the state in status.json.
      expect(f.lines.map((line) => JSON.parse(line).status)).toEqual(['installed', 'already-installed', 'installed', 'installed'])
      const log = readFileSync(f.logFile, 'utf8')
      expect(log).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[opencode\] missing; installing$/m)
      expect(log).toContain('[opencode] harness: OpenCode is missing — installing it in the background')
      expect(log).toContain('[summary] {"engine":"claude","status":"already-installed"}')
      const status = JSON.parse(readFileSync(engineInstallStatusFile(), 'utf8'))
      expect(status.finishedAt).toEqual(expect.any(String))
      expect(status.engines.opencode).toMatchObject({ status: 'installed', path: f.installedAt.opencode })
      expect(status.engines.claude).toMatchObject({ status: 'already-installed' })
      // Every lock let go.
      expect(existsSync(warmupLockPath())).toBe(false)
      expect(existsSync(engineInstallLockPath(ENGINE_INSTALL.opencode))).toBe(false)

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
    expect(existsSync(engineInstallLockPath(ENGINE_INSTALL.opencode))).toBe(false)
  })

  it('takes over an engine lock whose holder is gone', async () => {
    const f = fixture()
    const lock = engineInstallLockPath(ENGINE_INSTALL.opencode)
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'pid'), `${deadPid()}\n`)
    const outcome = await f.run({ engines: ['opencode'] })
    expect(!outcome.busy && outcome.results[0]).toMatchObject({ status: 'installed' })
    expect(f.ran()).toEqual(['opencode'])
    expect(existsSync(lock)).toBe(false)
  })

  it('waits for an install of the same engine another terminal holds, then uses what it left', async () => {
    const f = fixture()
    const lock = engineInstallLockPath(ENGINE_INSTALL.opencode)
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'pid'), `${livePid()}\n`)
    const running = f.run({ engines: ['opencode'] })
    await until(() => existsSync(f.logFile) && readFileSync(f.logFile, 'utf8').includes('waiting for it'))
    expect(readFileSync(f.logFile, 'utf8')).toContain('[opencode] harness: OpenCode is already installing in another terminal — waiting for it')
    // The other install finishes: the engine is there, and its lock let go.
    f.preinstall('opencode')
    rmSync(lock, { recursive: true })
    const outcome = await running
    expect(!outcome.busy && outcome.results[0]).toMatchObject({ status: 'installed', path: f.installedAt.opencode })
    expect(f.ran()).toEqual([])
  })

  it('exits at once while another run is going, and takes over a run lock whose holder is gone', async () => {
    const f = fixture()
    mkdirSync(warmupLockPath(), { recursive: true })
    writeFileSync(join(warmupLockPath(), 'pid'), `${process.pid}\n`)
    const started = Date.now()
    await expect(f.run()).resolves.toEqual({ busy: true, pid: process.pid })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(f.lines).toEqual([JSON.stringify({ status: 'busy', pid: process.pid })])
    expect(f.ran()).toEqual([])
    // The lock is still the other run's.
    expect(readFileSync(join(warmupLockPath(), 'pid'), 'utf8')).toBe(`${process.pid}\n`)

    writeFileSync(join(warmupLockPath(), 'pid'), `${deadPid()}\n`)
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
    expect(existsSync(engineInstallLockPath(ENGINE_INSTALL.opencode))).toBe(false)
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
    await until(() => existsSync(join(engineInstallLockPath(ENGINE_INSTALL.opencode), 'pid')))
    abort.abort('SIGTERM')
    const outcome = await running
    expect(outcome).toEqual({ busy: false, interrupted: true, results: [expect.objectContaining({ engine: 'opencode', status: 'failed', reason: 'interrupted' })] })
    expect(f.ran()).toEqual([])
    expect(existsSync(warmupLockPath())).toBe(false)
    expect(existsSync(engineInstallLockPath(ENGINE_INSTALL.opencode))).toBe(false)
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

describe('a pane whose engine is installing in the background', () => {
  // The pane's own launch, login shell and all, as tmux would start it (without a terminal, so the
  // engine's exit status is the pane's).
  for (const shell of ['/bin/sh', '/bin/zsh'].filter(existsSync)) {
    it(`waits in ${shell} for that install and starts the engine it left, without running an installer of its own`, async () => {
      const f = fixture(shell)
      const paneInstalled = join(f.root, 'pane-installer-ran')
      // The background install takes a while; the pane is created meanwhile.
      const background = f.run({ engines: ['opencode'], recipes: { opencode: f.recipe('opencode', f.fakeInstall('opencode', 'sleep 2; ')) } })
      const lock = engineInstallLockPath(ENGINE_INSTALL.opencode)
      await until(() => existsSync(join(lock, 'pid')))
      const argv = buildEngineLaunchArgv('opencode', {
        installIfMissing: f.recipe('opencode', `touch ${shellSingleQuote(paneInstalled)}`),
      }, shell, process.execPath, 'grid', null)
      const pane = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = spawn(argv[0], [...argv.slice(1), 'argument with spaces'], { stdio: ['ignore', 'pipe', 'pipe'] })
        children.push(child)
        let stdout = ''
        child.stdout!.on('data', (chunk) => { stdout += chunk })
        child.on('exit', (code) => resolve({ code, stdout }))
      })
      expect(pane.stdout).toContain('harness: OpenCode is already installing in the background — waiting for it')
      expect(pane.stdout).toContain('harness: OpenCode is installed')
      expect(pane.stdout).toContain('ENGINE_READY:argument with spaces')
      expect(pane.stdout).not.toContain('engine is missing')
      expect(pane.code).toBe(0)
      expect(existsSync(paneInstalled)).toBe(false)
      const outcome = await background
      expect(!outcome.busy && outcome.results[0]).toMatchObject({ status: 'installed' })
    })
  }

  it('takes over a lock whose holder is gone, holds it while it installs, and lets it go', async () => {
    const f = fixture()
    const lock = engineInstallLockPath(ENGINE_INSTALL.opencode)
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'pid'), `${deadPid()}\n`)
    const seen = join(f.root, 'holder-during-install')
    const argv = buildEngineLaunchArgv('opencode', {
      installIfMissing: f.recipe('opencode', `cat ${shellSingleQuote(join(lock, 'pid'))} > ${shellSingleQuote(seen)}; ${f.fakeInstall('opencode')}`),
    }, '/bin/sh', process.execPath, 'grid', null)
    const script = argv[argv.indexOf('harness-engine') - 1]
    const pane = spawnSync('/bin/sh', ['-c', script, 'harness-engine', 'opencode'], { encoding: 'utf8', timeout: 30_000 })
    expect(pane.status, pane.stdout + pane.stderr).toBe(0)
    expect(pane.stdout).toContain('engine is missing — installing it in this terminal')
    expect(pane.stdout).not.toContain('waiting for it')
    expect(readFileSync(seen, 'utf8').trim()).toBe(String(pane.pid))
    expect(existsSync(lock)).toBe(false)
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
      ['opencode', 'claude', 'codex', 'pi'].map((engine) => ({ engine, status: 'already-installed' })),
    )
  })

  it('--background returns at once and the run it started records its result', async () => {
    const f = cliFixture()
    const result = spawnSync(process.execPath, [TSX, CLI, 'engines', 'install-missing', '--background'], { env: f.env, encoding: 'utf8', timeout: 60_000 })
    expect(result.status, result.stderr).toBe(0)
    const started = JSON.parse(result.stdout.trim())
    expect(started).toMatchObject({ status: 'started', pid: expect.any(Number), log: join(f.root, 'logs', 'engine-install.log') })
    try {
      const status = join(f.home, '.harness', 'run', 'engine-install', 'status.json')
      await until(() => existsSync(status) && JSON.parse(readFileSync(status, 'utf8')).finishedAt !== null, 45_000)
      expect(JSON.parse(readFileSync(status, 'utf8')).engines.opencode).toMatchObject({ status: 'already-installed' })
      await until(() => !alive(started.pid), 10_000)
      expect(readFileSync(started.log, 'utf8')).toContain('[summary] {"engine":"pi","status":"already-installed"}')
    } finally {
      try { process.kill(-started.pid, 'SIGKILL') } catch { /* ended */ }
    }
  })
})
