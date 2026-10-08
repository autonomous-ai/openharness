import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ENGINE_INSTALL, type EngineInstallRecipe } from './engineInstall.js'
import { shellSingleQuote } from './engineLaunch.js'
import {
  agentInstallStateFile,
  installMissingAgents,
  installMissingLockDir,
  RETRY_FAILED_INSTALL_MS,
  type InstallMissingOptions,
  type InstallResult,
} from './agentInstallMissing.js'
import { agentInstallLockDir } from './agentInstall.js'
import { ownedLock } from './ownedLock.js'
import { CLI_SOURCE, TSX_CLI } from '../testing/sourceCli.js'
import type { ProcessEngine } from '../engines/types.js'

// Installers that only write into a throwaway home, and a login shell (sh) whose startup file the
// test writes. Nothing here reaches the network or the developer's own ~/.local, ~/.opencode or npm.
vi.setConfig({ testTimeout: 60_000 })

const roots: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  // A startup file that hung is the test's to clean up after (its sleep is unmistakable).
  spawnSync('pkill', ['-9', '-f', 'sleep 987'])
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fresh user: an empty home, nothing on PATH, an npm prefix of its own, sh as the login shell. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agents-missing-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  const rc = join(root, 'shrc')
  writeFileSync(rc, '')
  vi.stubEnv('HOME', home)
  vi.stubEnv('PATH', '/usr/bin:/bin')
  vi.stubEnv('SHELL', '/bin/sh')
  vi.stubEnv('ENV', rc)
  vi.stubEnv('npm_config_prefix', join(root, 'npm-global'))
  const order = join(root, 'order')
  const logFile = join(root, 'logs', 'agent-install.log')
  // Where each agent's own installer leaves it.
  const installedAt: Record<string, string> = {
    opencode: join(home, '.opencode', 'bin', 'opencode'),
    claude: join(home, '.local', 'bin', 'claude'),
    codex: join(home, '.local', 'bin', 'codex'),
    pi: join(home, '.local', 'bin', 'pi'),
  }
  const fakeInstall = (engine: string, before = '') => {
    const path = installedAt[engine]
    return `${before}mkdir -p ${shellSingleQuote(dirname(path))} && printf '#!/bin/sh\\necho READY\\n' > ${shellSingleQuote(path)} && chmod 755 ${shellSingleQuote(path)} && echo ${engine} >> ${shellSingleQuote(order)}`
  }
  /** The agent's own recipe, where it looks for its executable included, with these install lines. */
  const recipe = (engine: ProcessEngine, command: string, fallback?: string): EngineInstallRecipe => {
    const { fallback: _official, ...official } = ENGINE_INSTALL[engine]
    return { ...official, command, ...(fallback ? { fallback } : {}) }
  }
  const recipes = Object.fromEntries((['opencode', 'claude', 'codex', 'pi'] as const).map((engine) => [engine, recipe(engine, fakeInstall(engine))]))
  const lines: string[] = []
  const run = (options: InstallMissingOptions = {}) => installMissingAgents({
    recipes, logFile, runtimeNode: process.execPath, emit: (line) => lines.push(line), resolveTimeoutMs: 5_000, ...options,
  })
  const ran = (): string[] => existsSync(order) ? readFileSync(order, 'utf8').trim().split('\n') : []
  const preinstall = (engine: string, path = installedAt[engine]) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '#!/bin/sh\necho READY\n', { mode: 0o755 })
    return path
  }
  const remember = (agents: Record<string, Record<string, string>>) => {
    mkdirSync(dirname(agentInstallStateFile()), { recursive: true })
    writeFileSync(agentInstallStateFile(), JSON.stringify({ agents }))
  }
  return { root, home, rc, logFile, installedAt, fakeInstall, recipe, recipes, lines, run, ran, preinstall, remember }
}

const statuses = (results: readonly InstallResult[]) => Object.fromEntries(results.map((result) => [result.engine, result.status]))

describe('installMissingAgents', () => {
  it('installs every missing agent, OpenCode first, one at a time, and leaves one that is there alone', async () => {
    const f = fixture()
    f.preinstall('claude')
    const outcome = await f.run()
    expect(outcome.busy).toBe(false)
    if (outcome.busy) return
    expect(outcome.results.map((result) => result.engine)).toEqual(['opencode', 'claude', 'codex', 'pi'])
    expect(statuses(outcome.results)).toEqual({ opencode: 'installed', claude: 'already-installed', codex: 'installed', pi: 'installed' })
    expect(f.ran()).toEqual(['opencode', 'codex', 'pi'])
    expect(outcome.results[0]).toMatchObject({ path: f.installedAt.opencode })
    expect(outcome.results[1]).toEqual({ engine: 'claude', status: 'already-installed', path: f.installedAt.claude })
    expect(f.lines.map((line) => JSON.parse(line).status)).toEqual(['installed', 'already-installed', 'installed', 'installed'])
    const log = readFileSync(f.logFile, 'utf8')
    expect(log).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[opencode\] harness: OpenCode is missing — installing it in the background$/m)
    expect(log).toContain(`[summary] {"engine":"claude","status":"already-installed","path":${JSON.stringify(f.installedAt.claude)}}`)
    expect(existsSync(agentInstallLockDir())).toBe(false)
    expect(existsSync(installMissingLockDir())).toBe(false)

    // A second run finds all four and installs nothing.
    const again = await f.run()
    expect(!again.busy && statuses(again.results)).toEqual({ opencode: 'already-installed', claude: 'already-installed', codex: 'already-installed', pi: 'already-installed' })
    expect(f.ran()).toEqual(['opencode', 'codex', 'pi'])
  })

  it('finds an agent the person installed outside its install paths in their login shell, and installs nothing', async () => {
    const f = fixture()
    const bin = join(f.root, 'their-bin')
    const theirs = f.preinstall('codex', join(bin, 'codex'))
    writeFileSync(f.rc, `PATH=${shellSingleQuote(bin)}:$PATH; export PATH\n`)
    const outcome = await f.run({ engines: ['codex'] })
    expect(!outcome.busy && outcome.results).toEqual([{ engine: 'codex', status: 'already-installed', path: theirs }])
    expect(f.ran()).toEqual([])
  })

  it('does not put back an agent the person removed, and says so only when it is gone', async () => {
    const f = fixture()
    f.remember({ opencode: { presentAt: '2026-10-01T00:00:00.000Z' }, codex: { presentAt: '2026-10-01T00:00:00.000Z' } })
    // Codex moved somewhere only their shell knows: there, not removed.
    const bin = join(f.root, 'their-bin')
    const codex = f.preinstall('codex', join(bin, 'codex'))
    writeFileSync(f.rc, `PATH=${shellSingleQuote(bin)}:$PATH; export PATH\n`)
    const outcome = await f.run({ engines: ['opencode', 'codex'] })
    expect(!outcome.busy && outcome.results).toEqual([
      { engine: 'opencode', status: 'skipped', reason: expect.stringContaining('removed since, so it is not put back') },
      { engine: 'codex', status: 'already-installed', path: codex },
    ])
    expect(f.ran()).toEqual([])
  })

  it('holds a failed install back for a day, and does not count an interrupted one', async () => {
    const f = fixture()
    const failing = { opencode: f.recipe('opencode', 'exit 7') }
    const first = await f.run({ engines: ['opencode'], recipes: failing })
    expect(!first.busy && first.results[0]).toMatchObject({ status: 'failed', reason: 'the OpenCode install failed (exit 7)' })
    const second = await f.run({ engines: ['opencode'] })
    expect(!second.busy && second.results[0]).toMatchObject({ status: 'skipped', reason: expect.stringContaining('tried again a day after') })
    expect(f.ran()).toEqual([])
    const nextDay = await f.run({ engines: ['opencode'], now: () => Date.now() + RETRY_FAILED_INSTALL_MS + 60_000 })
    expect(!nextDay.busy && nextDay.results[0]).toMatchObject({ status: 'installed' })

    // Interrupted: not held back.
    rmSync(f.installedAt.opencode)
    rmSync(agentInstallStateFile())
    const abort = new AbortController()
    const running = f.run({ engines: ['opencode'], recipes: { opencode: f.recipe('opencode', 'sleep 30') }, signal: abort.signal })
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    abort.abort('SIGTERM')
    const interrupted = await running
    expect(!interrupted.busy && interrupted.results[0]).toMatchObject({ status: 'failed', reason: 'interrupted' })
    expect(interrupted.busy || interrupted.interrupted).toBe(true)
    const after = await f.run({ engines: ['opencode'] })
    expect(!after.busy && after.results[0]).toMatchObject({ status: 'installed' })
  })

  it('bounds the login shell it asks: a startup file that hangs costs its timeout, not the run', async () => {
    const f = fixture()
    f.remember({ opencode: { presentAt: '2026-10-01T00:00:00.000Z' } })
    writeFileSync(f.rc, 'sleep 987\n')
    const started = Date.now()
    const outcome = await f.run({ engines: ['opencode'], resolveTimeoutMs: 1_000 })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(!outcome.busy && outcome.results[0]).toMatchObject({ status: 'skipped' })
    expect(existsSync(installMissingLockDir())).toBe(false)
  })

  it('ends at once while another run holds its lock, takes over one whose holder is gone, and never runs unlocked', async () => {
    const f = fixture()
    const lock = ownedLock({ dir: installMissingLockDir(), parent: dirname(installMissingLockDir()), label: 'agents install-missing lock', ownerlessStaleMs: 5_000 })
    // Held by this live process, as another run would.
    const token = lock.tryCreate({ purpose: 'install-missing' })!
    await expect(f.run()).resolves.toEqual({ busy: true, pid: process.pid })
    expect(f.lines).toEqual([JSON.stringify({ status: 'busy', pid: process.pid })])
    expect(f.ran()).toEqual([])
    lock.releaseOwnedBy(token)

    // Something at the lock's path that is not its lock: never taken as free.
    mkdirSync(installMissingLockDir(), { mode: 0o755 })
    chmodSync(installMissingLockDir(), 0o755)
    await expect(f.run({ engines: ['opencode'] })).resolves.toEqual({ busy: true, pid: null })
    rmSync(installMissingLockDir(), { recursive: true })

    // A holder that is gone: taken over.
    expect(lock.tryCreate({})).toEqual(expect.any(String))
    const owner = join(installMissingLockDir(), 'owner.json')
    const record = JSON.parse(readFileSync(owner, 'utf8'))
    rmSync(owner)
    writeFileSync(owner, JSON.stringify({ ...record, pid: spawnSync(process.execPath, ['-e', '0']).pid }), { mode: 0o600 })
    const outcome = await f.run({ engines: ['opencode'] })
    expect(!outcome.busy && outcome.results[0]).toMatchObject({ status: 'installed' })
  })
})

describe('harness agents install-missing', () => {
  /** A home with all four agents at their install paths: nothing to probe, nothing to install. */
  function cliFixture() {
    const f = fixture()
    for (const engine of ['opencode', 'claude', 'codex', 'pi']) f.preinstall(engine)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: f.home,
      PATH: '/usr/bin:/bin',
      ADAPTER_DATA_DIR: join(f.root, 'data'),
      ADAPTER_RUNTIME_DIR: join(f.root, 'runtime'),
      HARNESS_AUTH_DIR: join(f.root, 'auth'),
      HARNESS_LOGS_DIR: join(f.root, 'logs'),
      ADAPTER_COMPUTER_ID_FILE: join(f.root, 'computer-id'),
    }
    return { ...f, env }
  }

  it('prints a JSON line per agent', () => {
    const f = cliFixture()
    const result = spawnSync(process.execPath, [TSX_CLI, CLI_SOURCE, 'agents', 'install-missing'], { env: f.env, encoding: 'utf8', timeout: 60_000 })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split('\n').map((line) => JSON.parse(line))).toEqual(
      ['opencode', 'claude', 'codex', 'pi'].map((engine) => ({ engine, status: 'already-installed', path: f.installedAt[engine] })),
    )
  })

  it('--background returns at once and the run it started records its result in the logs folder', async () => {
    const f = cliFixture()
    const result = spawnSync(process.execPath, [TSX_CLI, CLI_SOURCE, 'agents', 'install-missing', '--background'], { env: f.env, encoding: 'utf8', timeout: 60_000 })
    expect(result.status, result.stderr).toBe(0)
    const started = JSON.parse(result.stdout.trim())
    expect(started).toMatchObject({ status: 'started', pid: expect.any(Number), log: f.logFile })
    try {
      const deadline = Date.now() + 45_000
      while (!(existsSync(f.logFile) && readFileSync(f.logFile, 'utf8').includes('[install-missing] done'))) {
        if (Date.now() > deadline) throw new Error('the background run did not finish')
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      expect(readFileSync(f.logFile, 'utf8')).toContain(`[summary] {"engine":"pi","status":"already-installed","path":${JSON.stringify(f.installedAt.pi)}}`)
    } finally {
      try { process.kill(-started.pid, 'SIGKILL') } catch { /* ended */ }
    }
  })

  it('refuses an agent it does not know, and an unknown subcommand', () => {
    const f = cliFixture()
    const unknown = spawnSync(process.execPath, [TSX_CLI, CLI_SOURCE, 'agents', 'install', 'no-such-agent'], { env: f.env, encoding: 'utf8', timeout: 60_000 })
    expect(unknown.status).toBe(2)
    expect(unknown.stderr).toContain('no-such-agent is not an agent Harness can install')
    const usage = spawnSync(process.execPath, [TSX_CLI, CLI_SOURCE, 'agents', 'frobnicate'], { env: f.env, encoding: 'utf8', timeout: 60_000 })
    expect(usage.status).toBe(2)
    expect(usage.stderr).toContain('harness agents install-missing')
  })
})


