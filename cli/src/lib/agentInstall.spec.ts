import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { agentInstallExitCode, agentInstallLockDir, installAgent, type AgentInstallOptions } from './agentInstall.js'
import type { EngineInstallRecipe } from './engineInstall.js'
import { shellSingleQuote } from './engineLaunch.js'
import { ownedLock } from './ownedLock.js'
import { CLI_SOURCE, TSX_CLI } from '../testing/sourceCli.js'

// Real installers, as `/bin/sh -c` children in groups of their own, that only write into a throwaway
// home. Nothing here reaches the network or the developer's own ~/.local or ~/.harness.
vi.setConfig({ testTimeout: 60_000 })

const roots: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const child of children.splice(0)) if (child.exitCode === null) try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** A throwaway home, and an agent that installs by writing itself into it. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-install-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  vi.stubEnv('HOME', home)
  vi.stubEnv('PATH', '/usr/bin:/bin')
  const ran = join(root, 'ran')
  const at = (name: string) => join(home, '.fake', 'bin', name)
  /** A line that installs [name] as a script printing READY, and notes that it ran. */
  const installs = (name: string, before = '') =>
    `${before}mkdir -p ${shellSingleQuote(dirname(at(name)))} && printf '#!/bin/sh\\necho READY\\n' > ${shellSingleQuote(at(name))} && chmod 755 ${shellSingleQuote(at(name))} && echo ${name} >> ${shellSingleQuote(ran)}`
  const recipe = (name: string, command: string, fallback?: string): EngineInstallRecipe => ({
    command, ...(fallback ? { fallback } : {}), source: 'test fixture',
    executable: { names: [name], homeRelativePaths: [join('.fake', 'bin', name)] },
  })
  const said: string[] = []
  const output: string[] = []
  const install = (name: string, overrides: Partial<AgentInstallOptions> = {}) => installAgent({
    engine: name,
    recipe: recipe(name, installs(name)),
    command: name,
    mode: 'background',
    say: (line) => said.push(line),
    output: (line) => output.push(line),
    ...overrides,
  })
  const ranList = (): string[] => existsSync(ran) ? readFileSync(ran, 'utf8').trim().split('\n') : []
  return { root, home, at, installs, recipe, said, output, install, ran: ranList }
}

/** Hold the install lock from another process, as a pane installing an agent would. */
function holdLock(fields: Record<string, unknown>): ChildProcess {
  const lockDir = agentInstallLockDir()
  const script = `import { ownedLock } from ${JSON.stringify(new URL('./ownedLock.ts', import.meta.url).pathname)}
const lock = ownedLock({ dir: ${JSON.stringify(lockDir)}, parent: ${JSON.stringify(dirname(lockDir))}, label: 'agent install lock', ownerlessStaleMs: 5000 })
const token = lock.tryCreate(${JSON.stringify(fields)})
process.stdout.write(token ? 'held\\n' : 'not held\\n')
process.on('SIGTERM', () => { lock.releaseOwnedBy(token); process.exit(0) })
setInterval(() => {}, 1000)
`
  const file = join(dirname(dirname(lockDir)), `hold-${Date.now()}.mts`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, script)
  // Its own group: tsx runs the script in a child of its own, and teardown ends both.
  const child = spawn(process.execPath, [TSX_CLI, file], { stdio: ['ignore', 'pipe', 'ignore'], env: process.env, detached: true })
  children.push(child)
  return child
}

const heldBy = (child: ChildProcess): Promise<void> => new Promise((resolve) => {
  child.stdout!.on('data', (chunk) => { if (String(chunk).includes('held')) resolve() })
})

describe('installAgent', () => {
  it('installs, then lets the lock go', async () => {
    const f = fixture()
    const report = await f.install('fake-agent')
    expect(report).toMatchObject({ outcome: 'installed', path: f.at('fake-agent') })
    expect(agentInstallExitCode(report)).toBe(0)
    expect(f.ran()).toEqual(['fake-agent'])
    expect(f.said).toContain('harness: fake-agent is missing — installing it in the background')
    expect(existsSync(agentInstallLockDir())).toBe(false)
  })

  it('waits for another install, saying so, and installs nothing if that one left the agent', async () => {
    const f = fixture()
    const holder = holdLock({ purpose: 'background', engine: 'fake-agent', name: 'fake-agent' })
    await heldBy(holder)
    const running = f.install('fake-agent')
    await until(() => f.said.some((line) => line.includes('waiting for it')))
    expect(f.said).toContain('harness: fake-agent is already installing in the background — waiting for it')
    // That install finishes: the agent is there, and the lock let go.
    mkdirSync(dirname(f.at('fake-agent')), { recursive: true })
    writeFileSync(f.at('fake-agent'), '#!/bin/sh\necho READY\n', { mode: 0o755 })
    holder.kill('SIGTERM')
    const report = await running
    expect(report).toMatchObject({ outcome: 'found', path: f.at('fake-agent') })
    expect(f.said).toContain('harness: fake-agent is installed')
    expect(f.ran()).toEqual([])
  })

  it('serializes two different agents on the one lock: npm installs share one prefix', async () => {
    const f = fixture()
    const first = f.install('agent-one', { recipe: f.recipe('agent-one', f.installs('agent-one', 'sleep 2; ')) })
    await until(() => existsSync(join(agentInstallLockDir(), 'owner.json')))
    const second = f.install('agent-two')
    const [one, two] = await Promise.all([first, second])
    expect(one.outcome).toBe('installed')
    expect(two.outcome).toBe('installed')
    // The second started only after the first had finished.
    expect(f.ran()).toEqual(['agent-one', 'agent-two'])
    expect(f.said).toContain('harness: agent-one is installing in the background; agent-two installs after it — waiting')
  })

  // A first harness's OpenCode waited 30 s behind the background's Claude Code, Codex and Pi installs
  // although OpenCode was already in place (fresh macOS VM, 2026-10-08).
  it('stops waiting behind another agent\'s install once this agent is in place', async () => {
    const f = fixture()
    const holder = holdLock({ purpose: 'background', engine: 'other-agent', name: 'Other' })
    await heldBy(holder)
    const running = f.install('fake-agent', { mode: 'pane' })
    await until(() => f.said.some((line) => line.includes('installs after it')))
    mkdirSync(dirname(f.at('fake-agent')), { recursive: true })
    writeFileSync(f.at('fake-agent'), '#!/bin/sh\necho READY\n', { mode: 0o755 })
    const report = await running
    expect(report).toMatchObject({ outcome: 'found', path: f.at('fake-agent') })
    expect(f.ran()).toEqual([])
    expect(existsSync(join(agentInstallLockDir(), 'owner.json')), 'the holder still has it').toBe(true)
  })

  it('keeps waiting while the holder installs this same agent, even once its executable appears', async () => {
    const f = fixture()
    const holder = holdLock({ purpose: 'background', engine: 'fake-agent', name: 'fake-agent' })
    await heldBy(holder)
    let settled = false
    const running = f.install('fake-agent', { mode: 'pane' }).finally(() => { settled = true })
    await until(() => f.said.some((line) => line.includes('waiting for it')))
    mkdirSync(dirname(f.at('fake-agent')), { recursive: true })
    writeFileSync(f.at('fake-agent'), '#!/bin/sh\necho READY\n', { mode: 0o755 })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(settled, 'npm links the executable before it is done').toBe(false)
    holder.kill('SIGTERM')
    expect(await running).toMatchObject({ outcome: 'found' })
  })

  it('reports progress while it waits, and gives up past its wait without installing', async () => {
    const f = fixture()
    const holder = holdLock({ purpose: 'pane', engine: 'fake-agent', name: 'fake-agent' })
    await heldBy(holder)
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    const realNow = Date.now
    let skew = 0
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
    const running = f.install('fake-agent', { mode: 'pane', waitMs: 40_000 })
    await until(() => f.said.some((line) => line.includes('waiting for it')))
    skew = 16_000
    await until(() => f.said.some((line) => line.startsWith('harness: still waiting for that install')))
    skew = 41_000
    const report = await running
    vi.useRealTimers()
    expect(report.outcome).toBe('busy')
    expect(agentInstallExitCode(report)).toBe(75)
    expect(f.said).toContain('harness: fake-agent is already installing in another terminal — waiting for it (Ctrl-C stops waiting)')
    expect(f.said.at(-1)).toBe('harness: fake-agent was still installing in another terminal after 40s, so this agent was not started. Create it again once that install finishes.')
    expect(f.ran()).toEqual([])
  })

  it('stops waiting on a signal, and says so', async () => {
    const f = fixture()
    const holder = holdLock({ purpose: 'background', engine: 'fake-agent', name: 'fake-agent' })
    await heldBy(holder)
    const abort = new AbortController()
    const running = f.install('fake-agent', { mode: 'pane', signal: abort.signal })
    await until(() => f.said.some((line) => line.includes('waiting for it')))
    abort.abort('SIGINT')
    const report = await running
    expect(report.outcome).toBe('interrupted')
    expect(agentInstallExitCode(report)).toBe(130)
    expect(f.said.at(-1)).toBe('harness: stopped waiting, so the agent was not started.')
    expect(f.ran()).toEqual([])
  })

  it('runs the fallback when the first line leaves nothing, and never after one ended with Ctrl-C (130)', async () => {
    const f = fixture()
    const fallback = await f.install('fake-agent', { recipe: f.recipe('fake-agent', 'true', f.installs('fake-agent')) })
    expect(fallback.outcome).toBe('installed')
    expect(f.said).toContain('harness: that install did not finish; trying the npm package instead')

    rmSync(f.at('fake-agent'))
    f.said.length = 0
    const ctrlC = await f.install('fake-agent', { recipe: f.recipe('fake-agent', 'exit 130', f.installs('fake-agent')) })
    expect(ctrlC).toMatchObject({ outcome: 'failed', status: 130 })
    expect(agentInstallExitCode(ctrlC)).toBe(1)
    expect(f.said).not.toContain('harness: that install did not finish; trying the npm package instead')
    expect(f.ran()).toEqual(['fake-agent'])
  })

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`on ${signal} stops the installer and everything it started, and runs no fallback`, async () => {
      const f = fixture()
      const sleeper = join(f.root, 'sleeper')
      const abort = new AbortController()
      const running = f.install('fake-agent', {
        recipe: f.recipe('fake-agent', `sh -c 'sleep 1000 & echo $! > ${sleeper}; wait'`, f.installs('fake-agent')),
        signal: abort.signal,
      })
      await until(() => existsSync(sleeper) && readFileSync(sleeper, 'utf8').trim() !== '')
      const pid = Number(readFileSync(sleeper, 'utf8'))
      abort.abort(signal)
      const report = await running
      expect(report.outcome).toBe('interrupted')
      await until(() => !alive(pid), 7_000)
      expect(f.ran()).toEqual([])
      expect(existsSync(agentInstallLockDir())).toBe(false)
    })
  }

  it('stops a first line that makes no progress and runs the fallback; one that keeps writing runs on', async () => {
    const f = fixture()
    const stalled = await f.install('fake-agent', { recipe: f.recipe('fake-agent', 'sleep 1000', f.installs('fake-agent')), stallMs: 2_000 })
    expect(stalled.outcome).toBe('installed')
    expect(f.said).toContain('harness: that install made no progress for 2s, so it was stopped')
    expect(f.said).toContain('harness: that install did not finish; trying the npm package instead')

    rmSync(f.at('fake-agent'))
    f.said.length = 0
    // A download at 2 Mbit/s takes minutes, writing all the while: not a stall.
    const slow = `for i in 1 2 3 4 5; do printf x >> "$TMPDIR/download"; sleep 1; done; ${f.installs('fake-agent')}`
    const started = Date.now()
    const report = await f.install('fake-agent', { recipe: f.recipe('fake-agent', slow, 'exit 9'), stallMs: 2_000 })
    expect(report.outcome).toBe('installed')
    expect(Date.now() - started).toBeGreaterThan(4_500)
    expect(f.said.join('\n')).not.toContain('made no progress')
    expect(f.said.join('\n')).not.toContain('trying the npm package instead')
  })

  it('takes over a lock whose holder is gone', async () => {
    const f = fixture()
    const lock = ownedLock({ dir: agentInstallLockDir(), parent: dirname(agentInstallLockDir()), label: 'agent install lock', ownerlessStaleMs: 5_000 })
    mkdirSync(dirname(agentInstallLockDir()), { recursive: true, mode: 0o700 })
    expect(lock.tryCreate({})).toEqual(expect.any(String))
    // Rewritten as a process that has since exited.
    const owner = join(agentInstallLockDir(), 'owner.json')
    const record = JSON.parse(readFileSync(owner, 'utf8'))
    rmSync(owner)
    writeFileSync(owner, JSON.stringify({ ...record, pid: spawnSync(process.execPath, ['-e', '0']).pid }), { mode: 0o600, flag: 'wx' })
    const report = await f.install('fake-agent')
    expect(report.outcome).toBe('installed')
  })
})

describe('harness agents install, as a pane runs it', () => {
  it('Ctrl-C stops the installer and its group, exits 130, and lets the lock go', async () => {
    const f = fixture()
    const sleeper = join(f.root, 'sleeper')
    const recipe = f.recipe('fake-agent', `sh -c 'sleep 1000 & echo $! > ${sleeper}; wait'`, f.installs('fake-agent'))
    // As the pane would: the CLI, a foreground job in a process group the terminal's Ctrl-C reaches.
    const child = spawn(process.execPath, [TSX_CLI, CLI_SOURCE, 'agents', 'install', 'fake-agent', '--pane', '--command=fake-agent', `--recipe=${JSON.stringify(recipe)}`], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: f.home },
    })
    children.push(child)
    let stdout = ''
    child.stdout!.on('data', (chunk) => { stdout += chunk })
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
    await until(() => existsSync(sleeper) && readFileSync(sleeper, 'utf8').trim() !== '', 30_000)
    const pid = Number(readFileSync(sleeper, 'utf8'))
    process.kill(-child.pid!, 'SIGINT')
    // tsx passes the signal on and exits as its child did.
    expect(await exited).toBe(130)
    await until(() => !alive(pid), 7_000)
    expect(stdout).toContain('harness: engine is missing — installing it in this terminal')
    expect(stdout).toContain('harness: the install was stopped, so the agent was not started.')
    expect(stdout).not.toContain('trying the npm package instead')
    expect(existsSync(agentInstallLockDir())).toBe(false)
  })
})
