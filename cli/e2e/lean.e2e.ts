/**
 * harnessd's master and its services lean, on a real release bundle: Node parses all of the file a
 * process starts on, and started on the whole 4.4 MB cli.js each paid about 45 MiB for that alone. So
 * the master re-executes, same pid, on the lean bundle cli.js carries, and starts every service and the core
 * from it (src/harnessd/leanBundle.ts), the core on its own code: what it hands on still names cli.js. Every
 * service still runs in its own process and does its work, for Claude Code and Codex agents alike. A lean
 * bundle that cannot start a master is never handed the daemon, a core that cannot start from it starts
 * from cli.js, and `HARNESSD_LEAN=off` runs everything from cli.js as before.
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
import { LEAN_CORE_ENTRY, readLeanBundle } from '../src/harnessd/leanBundle.js'

type Engine = 'claude' | 'codex'
/** The processes the master runs the services in, and the services, each on its own link to the core. The
 *  experiments' start only once they are on (e2e/experiments.e2e.ts, from the run's bundle). */
const PROCESSES = ['search', 'viewers', 'edge', 'models']
const SERVICES = ['search', 'viewers', 'store', 'workspaces', 'usage', 'monitor', 'projects', 'handoff', 'recaps', 'models']

const commandOf = (pid: number): string => execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
const rssMiB = (pid: number): number => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024
const servicePids = (d: IsolatedDaemon): Map<string, number> => new Map(PROCESSES.map((name) => {
  const started = [...d.log().matchAll(new RegExp(`\\[harnessd\\] service ${name} started \\(pid (\\d+)\\)`, 'g'))]
  return [name, Number(started.at(-1)?.[1] ?? 0)]
}))
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
/** The command the daemon's hooks run, as it installed them for Claude Code in the test's home. */
const claudeHookCommand = (d: IsolatedDaemon): string => {
  const settings = JSON.parse(readFileSync(join(d.root, 'home', '.claude', 'settings.json'), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
  return settings.hooks.UserPromptSubmit![0]!.hooks[0]!.command
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** This daemon's core, by the pid it reports, and what started it. */
const coreCommand = (d: IsolatedDaemon): string => commandOf(d.corePid()!)

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

  it('re-executes the master, same pid, on the lean bundle, and runs every service and the core from it', async () => {
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
    // The core from the lean bundle too, on its own entry; to everything it hands on, its script is cli.js:
    // the hooks it installed run the notify.mjs beside it, not one beside the lean bundle.
    expect(coreCommand(d)).toMatch(new RegExp(` ${escape(join(d.dataDir, 'lean'))}/[0-9a-f]{16}/${escape(LEAN_CORE_ENTRY)} __run$`))
    expect(claudeHookCommand(d)).toContain(join(dirname(bundle), 'notify.mjs'))
    for (const [name, pid] of servicePids(d)) expect(commandOf(pid), name).toBe(`harnessd-${name}`)
    // Lean: under the cost of parsing the whole CLI, which every one of them paid before (at idle,
    // 115 to 160 MiB each), and a long way under it at that (55 to 80).
    for (const [name, pid] of [['master', master], ...servicePids(d)] as Array<[string, number]>) {
      expect(rssMiB(pid), `${name} resident MiB`).toBeLessThan(100)
    }
    // The core in it, beside its own processes, and nothing it starts runs from its folder: the panes' CLI is cli.js.
    expect(d.log()).not.toMatch(/the lean bundle runs a core only for the cli\.js/)
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
    // From cli.js: its path as the master resolved it.
    expect(d.log()).toMatch(new RegExp(`\\[harnessd\\] the lean bundle \\S+ cannot be used \\(it is gone\\): the core and the services start from \\S+cli\\.js`))
    expect(d.log()).toContain(`the lean bundle ${ours} cannot be used`)
    await agentWorks(d, 'codex')
    // The core too, the next time it starts: killed, it comes back from cli.js and its agents go on.
    process.kill(d.corePid()!, 'SIGKILL')
    await until('the core started again', () => d.coresStarted() >= 2 || null, 60_000, 200)
    await until('the core bound again', async () => (await fetch(`http://127.0.0.1:${d.port}/api/health`).then((r) => r.ok, () => false)) || null, 60_000, 250)
    expect(coreCommand(d).endsWith(`${bundle} __run`)).toBe(true)
    await agentWorks(d, 'claude')
    expect(d.log()).not.toMatch(/MODULE_NOT_FOUND|Cannot find module/)
  })

  it('starts the core from cli.js once it has died twice from the lean bundle before it beat, and the daemon works', async () => {
    // A lean core that cannot start costs two quick restarts, never the daemon: the master, the services
    // and every later core run on. Here its own module throws as it loads; the master's and the services' are whole.
    const lean = readLeanBundle(readFileSync(bundle))!
    const files = Object.fromEntries([...lean.files].map(([name, code]) => [name, code.toString('utf8')]))
    const core = Object.keys(files).find((name) => name.startsWith('core-coreProcess-'))!
    files[core] = 'throw new Error("a lean core that cannot load")\n'
    const brokenCore = join(scratch, 'broken-core', 'cli.js')
    mkdirSync(join(scratch, 'broken-core'), { recursive: true })
    writeFileSync(brokenCore, withLean(readFileSync(bundle, 'utf8'), files), { mode: 0o755 })
    const d = await fresh({ HARNESSD_INITIAL_BACKOFF_MS: '200' }, brokenCore)
    expect(d.log()).toMatch(/\[harnessd\] the core died 2 times from the lean bundle before it beat: it starts from \S+cli\.js from now on/)
    expect(d.coresStarted()).toBe(3)
    expect(coreCommand(d).endsWith(`${brokenCore} __run`)).toBe(true)
    // Still lean: the master and the services.
    expect(d.log()).toMatch(/\[harnessd\] services run from \S+, as this master does/)
    await agentWorks(d, 'codex')
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

  it('runs everything from cli.js, as before, with HARNESSD_LEAN=off, and with the lean-off file the core too', async () => {
    const d = await fresh({ HARNESSD_LEAN: 'off' })
    expect(existsSync(join(d.dataDir, 'lean'))).toBe(false)
    expect(d.log()).not.toMatch(/\[harnessd\] services run from/)
    expect(coreCommand(d).endsWith(`${bundle} __run`)).toBe(true)
    await agentWorks(d, 'codex')
    await d.close()
    daemon = undefined
    // The switch for a master launchd or systemd starts, whose environment is the unit's.
    const off = await IsolatedDaemon.create({ scriptPath: bundle })
    daemon = off
    mkdirSync(off.dataDir, { recursive: true })
    writeFileSync(join(off.dataDir, 'lean-off'), '')
    await off.start()
    expect(off.log()).toContain('lean-off is there: the master, the core and the services run from')
    expect(coreCommand(off).endsWith(`${bundle} __run`)).toBe(true)
    await agentWorks(off, 'claude')
  })

  it('never hands the daemon a lean bundle that cannot start a master: everything runs from cli.js', async () => {
    const broken = join(scratch, 'broken', 'cli.js')
    mkdirSync(join(scratch, 'broken'), { recursive: true })
    writeFileSync(broken, withLean(readFileSync(bundle, 'utf8'), { 'harnessd.mjs': 'process.exit(5)\n' }), { mode: 0o755 })
    const d = await fresh({}, broken)
    expect(d.log()).toMatch(/\[harnessd\] the lean bundle \S+ did not answer its probe \(exit 5\): the master, the core and the services run from /)
    expect(d.log()).not.toMatch(/\[harnessd\] services run from/)
    expect(coreCommand(d).endsWith(`${broken} __run`)).toBe(true)
    await agentWorks(d, 'claude')
    expect(d.coresStarted()).toBe(1)
  })
})
