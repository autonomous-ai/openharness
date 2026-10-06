/**
 * harnessd's master and its services lean, on a real release bundle: Node parses all of the file a
 * process starts on, and started on the whole 4.4 MB cli.js each paid about 45 MiB for that alone. So
 * the master re-executes, same pid, on the lean bundle cli.js carries, and starts every service from it
 * (src/harnessd/leanBundle.ts); the core runs from cli.js as always. Every service still runs in its own
 * process and does its work, for Claude Code and Codex agents alike. A lean bundle that cannot start a
 * master is never handed the daemon, and `HARNESSD_LEAN=off` runs everything from cli.js as before.
 *
 * The bundle is built from this checkout (the run's own with `E2E_BUNDLE=1`).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { withLean } from './harness/release.js'
import { readLeanBundle } from '../src/harnessd/leanBundle.js'

type Engine = 'claude' | 'codex'
/** The processes the master runs the services in, and the services, each on its own link to the core. The
 *  experiments' start only once they are on (e2e/experiments.e2e.ts, from the run's bundle). */
const PROCESSES = ['search', 'viewers', 'edge', 'models']
const SERVICES = ['search', 'viewers', 'store', 'workspaces', 'usage', 'monitor', 'projects', 'models']

const commandOf = (pid: number): string => execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
const rssMiB = (pid: number): number => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024
const servicePids = (d: IsolatedDaemon): Map<string, number> => new Map(PROCESSES.map((name) => {
  const started = [...d.log().matchAll(new RegExp(`\\[harnessd\\] service ${name} started \\(pid (\\d+)\\)`, 'g'))]
  return [name, Number(started.at(-1)?.[1] ?? 0)]
}))
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId

describe('harnessd\'s master and services lean', () => {
  let scratch = ''
  let bundle = ''
  let daemon: IsolatedDaemon | undefined
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'harnessd-lean-'))
    bundle = process.env.E2E_BUNDLE_PATH ?? join(scratch, 'build', 'cli.js')
    if (!process.env.E2E_BUNDLE_PATH) {
      execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT, env: { ...process.env, BUNDLE_OUT_DIR: join(scratch, 'build') }, stdio: 'pipe' })
    }
  }, 120_000)
  afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })
  afterEach(async () => { await daemon?.close(); daemon = undefined })
  const fresh = async (env: Record<string, string> = {}, scriptPath = bundle) => {
    const d = await IsolatedDaemon.create({ scriptPath, env })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    await until('every service process', () => PROCESSES.every((name) => new RegExp(`service ${name} started`).test(d.log())) || null, 60_000, 200)
    return d
  }
  async function agentWorks(d: IsolatedDaemon, engine: Engine): Promise<void> {
    const client = await LocalClient.connect(d)
    try {
      const cwd = join(d.projectsDir, `lean-${engine}`)
      mkdirSync(cwd, { recursive: true })
      const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
      expect(created.error, JSON.stringify(created)).toBeUndefined()
      const agent = await until(`the ${engine} agent to bind`, async () => {
        const rows = (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents
        const row = rows.find((one) => one.id === created.agent.id)
        return row?.sessionId && row.status === 'active' ? row : null
      }, 60_000, 500)
      const word = `lean${engine}${Date.now().toString(36)}`
      const ended = client.next(isTurn('turn_ended', agent.id), 45_000, 'turn_ended')
      client.send('message', { agentId: agent.id, content: `remember ${word}` })
      await ended
      // Search, in its own process from the lean bundle, indexes the turn and finds it.
      await until('search to find the turn', async () =>
        JSON.stringify(await client.request('session_search', { query: word }, 30_000)).includes(agent.sessionId) || null, 30_000, 500)
    } finally { client.close() }
  }

  it('re-executes the master, same pid, on the lean bundle, and runs every service from it; the core from cli.js', async () => {
    const d = await fresh()
    // The master titles itself `harnessd`, so its log says what it runs on: the lean bundle, written
    // into the data folder, which only a master running on it says it shares with the services.
    const lean = /\[harnessd\] services run from (\S+), as this master does/.exec(d.log())?.[1]
    expect(lean, 'the master re-executed on the lean bundle').toMatch(/[\\/]lean[\\/][0-9a-f]{16}[\\/]harnessd\.mjs$/)
    expect(lean!.startsWith(join(d.dataDir, 'lean'))).toBe(true)
    expect(existsSync(lean!)).toBe(true)
    // The same process `harness start` started: re-executed in place.
    const master = d.pid!
    expect(commandOf(master)).toBe('harnessd')
    expect(commandOf(d.corePid()!)).toContain(`${bundle} __run`)
    for (const [name, pid] of servicePids(d)) expect(commandOf(pid), name).toBe(`harnessd-${name}`)
    // Lean: under the cost of parsing the whole CLI, which every one of them paid before (at idle,
    // 115 to 160 MiB each), and a long way under it at that (55 to 80).
    for (const [name, pid] of [['master', master], ...servicePids(d)] as Array<[string, number]>) {
      expect(rssMiB(pid), `${name} resident MiB`).toBeLessThan(100)
    }
    // A service's lines are stamped, as the core's and the master's are in the log they share.
    for (const name of SERVICES) {
      await until(`${name} to say it is connected`, () => new RegExp(`\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d\\.\\d{3} \\[service ${name}\\] connected to the core`).test(d.log()) || null, 30_000, 200)
    }
    await agentWorks(d, 'claude')
    await agentWorks(d, 'codex')
    expect(d.coresStarted()).toBe(1)
    expect(d.log()).not.toMatch(/service \w+ (exited|ended)/)
    // The master claims the folder it runs from while it lives, and gives the claim up as it stops.
    const claim = join(dirname(lean!), `.claim-${master}`)
    expect(existsSync(claim)).toBe(true)
    await d.stop()
    expect(existsSync(claim)).toBe(false)
  })

  it('starts a service from cli.js once the lean bundle is gone from under its master, and the service works', async () => {
    // A master lives for weeks; its lean folder, gone (someone tidying up), failed every restart of every
    // service with MODULE_NOT_FOUND until the master itself restarted. The lean bundle is only ever an
    // optimisation.
    const d = await fresh()
    const ours = /\[harnessd\] services run from (\S+), as this master does/.exec(d.log())![1]
    rmSync(dirname(ours), { recursive: true })
    const search = servicePids(d).get('search')!
    const restarts = (): number => [...d.log().matchAll(/\[harnessd\] service search started/g)].length
    const before = restarts()
    process.kill(search, 'SIGKILL')
    await until('search started again', () => restarts() > before || null, 60_000, 200)
    // From cli.js, as the core: its path as the master resolved it.
    expect(d.log()).toMatch(new RegExp(`\\[harnessd\\] the lean bundle \\S+ cannot be used \\(it is gone\\): services start from \\S+cli\\.js`))
    expect(d.log()).toContain(`the lean bundle ${ours} cannot be used`)
    await agentWorks(d, 'codex')
    expect(d.log()).not.toMatch(/MODULE_NOT_FOUND|Cannot find module/)
    expect(d.coresStarted()).toBe(1)
  })

  it('keeps a master\'s lean bundle while it lives: another build\'s master on the same data folder leaves it, and its services still restart', async () => {
    // Two builds on one computer can share a data folder, and a master restarts its services from its
    // lean bundle for as long as it lives. The other master writes its own bundle and clears the folder
    // of the ones no live master claims, then leaves: a daemon is already serving.
    const d = await fresh()
    const ours = /\[harnessd\] services run from (\S+), as this master does/.exec(d.log())![1]
    const lean = readLeanBundle(readFileSync(bundle))!
    const files = Object.fromEntries([...lean.files].map(([name, code]) => [name, code.toString('utf8')]))
    files['harnessd.mjs'] += '\n// another build\n'
    const other = join(scratch, 'other', 'cli.js')
    mkdirSync(join(scratch, 'other'), { recursive: true })
    writeFileSync(other, withLean(readFileSync(bundle, 'utf8'), files), { mode: 0o755 })
    const second = await IsolatedDaemon.create({ beside: d, dataDir: d.dataDir, port: d.port, scriptPath: other })
    try {
      await second.start({ ready: 'none' })
      await until('the other master to leave', () => second.child === null || null, 90_000, 250)
      expect(second.log()).toMatch(/\[harnessd\] services run from \S+, as this master does/)
      expect(existsSync(ours), 'the running master\'s lean bundle').toBe(true)
    } finally { await second.close() }
    // Its services come back from it: search, killed outright, is started again and finds a turn.
    const [, search] = [...servicePids(d)].find(([name]) => name === 'search')!
    const restarts = (): number => [...d.log().matchAll(/\[harnessd\] service search started/g)].length
    const before = restarts()
    process.kill(search, 'SIGKILL')
    await until('search started again', () => restarts() > before || null, 60_000, 200)
    await agentWorks(d, 'claude')
    expect(d.coresStarted()).toBe(1)
  })

  it('runs everything from cli.js, as before, with HARNESSD_LEAN=off', async () => {
    const d = await fresh({ HARNESSD_LEAN: 'off' })
    expect(existsSync(join(d.dataDir, 'lean'))).toBe(false)
    expect(d.log()).not.toMatch(/\[harnessd\] services run from/)
    await agentWorks(d, 'codex')
  })

  it('never hands the daemon a lean bundle that cannot start a master: everything runs from cli.js', async () => {
    const broken = join(scratch, 'broken', 'cli.js')
    mkdirSync(join(scratch, 'broken'), { recursive: true })
    writeFileSync(broken, withLean(readFileSync(bundle, 'utf8'), { 'harnessd.mjs': 'process.exit(5)\n' }), { mode: 0o755 })
    const d = await fresh({}, broken)
    expect(d.log()).toMatch(/\[harnessd\] the lean bundle \S+ did not answer its probe \(exit 5\): the master and the services run from /)
    expect(d.log()).not.toMatch(/\[harnessd\] services run from/)
    await agentWorks(d, 'claude')
    expect(d.coresStarted()).toBe(1)
  })
})
