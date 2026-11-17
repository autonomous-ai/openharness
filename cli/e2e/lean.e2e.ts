/**
 * harnessd's master and its services lean, on a real release bundle: Node parses all of the file a
 * process starts on, and started on the whole 4.4 MB cli.js each paid about 45 MiB for that alone. So
 * the master re-executes, same pid, on the lean bundle cli.js carries, and starts every service and the core
 * from it (src/harnessd/leanBundle.ts), the core on its own code: what it hands on still names cli.js. Every
 * service still runs in its own process and does its work, for Claude Code and Codex agents alike. A lean
 * bundle that cannot start a master is never handed the daemon, a core that cannot start from it starts
 * from its frozen full CLI, and `HARNESSD_LEAN=off` keeps the master on cli.js while children use frozen full code.
 *
 * The bundle is built from this checkout (the run's own with `E2E_BUNDLE=1`).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { buildWithLean } from './harness/release.js'
import { LEAN_CORE_ENTRY, readLeanBundle } from '../src/harnessd/leanBundle.js'

type Engine = 'claude' | 'codex'
/** The processes the master runs the services in, and the services, each on its own link to the core. The
 *  experiments' start only once they are on (e2e/experiments.e2e.ts, from the run's bundle). The viewers' starts
 *  on demand: each fresh fixture asks for the Store through dsh_list before checking its process
 *  (core/viewersWake.ts, e2e/viewersOnDemand.e2e.ts). */
const PROCESSES = ['search', 'viewers', 'edge', 'models']
const SERVICES = ['search', 'viewers', 'store', 'workspaces', 'usage', 'monitor', 'projects', 'handoff', 'recaps', 'models']

const commandOf = (pid: number): string => execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
const rssMiB = (pid: number): number => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024
const servicePids = (d: IsolatedDaemon): Map<string, number> => new Map(PROCESSES.map((name) => {
  const started = [...d.log().matchAll(new RegExp(`\\[harnessd\\] service ${name} started \\(pid (\\d+)\\)`, 'g'))]
  return [name, Number(started.at(-1)?.[1] ?? 0)]
}))
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
/** The command the daemon's hooks run, once it has installed them for Claude Code in the test's home: it does that after it
 *  is ready, so the settings may not be there yet. */
const claudeHookCommand = (d: IsolatedDaemon): Promise<string> => until('Claude Code\'s hooks to be installed', () => {
  const settings = JSON.parse(readFileSync(join(d.root, 'home', '.claude', 'settings.json'), 'utf8')) as { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
  return settings.hooks?.UserPromptSubmit?.[0]?.hooks[0]?.command ?? null
}, 30_000, 100)
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** This daemon's core, by the pid it reports, and what started it. */
const coreCommand = (d: IsolatedDaemon): string => commandOf(d.corePid()!)
/** The actual admitted child image, separate from the original image executing the master. */
const childCohort = (d: IsolatedDaemon) => {
  const core = / (\S+\.mjs) __run$/.exec(coreCommand(d))?.[1]
  expect(core, 'the core uses an owned execution artifact').toBeDefined()
  const folder = dirname(core!)
  expect(folder).toMatch(new RegExp(`^${escape(join(d.dataDir, 'lean'))}/[0-9a-f]{16}$`))
  const full = join(folder, 'cohort-cli.mjs')
  expect(existsSync(full), 'the same cohort has its immutable full fallback').toBe(true)
  return { folder, core: core!, service: join(folder, 'harnessd.mjs'), full, claim: join(folder, `.claim-${d.pid}`) }
}

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
    // Grid in use here, so that models' process starts with the others and is held lean too (core/modelsWake.ts).
    mkdirSync(join(d.dataDir, 'local-models'), { recursive: true })
    writeFileSync(join(d.dataDir, 'local-models', 'operations.json'), '[]')
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    try {
      const list = await client.request('dsh_list', {}, 60_000)
      expect(list.error, JSON.stringify(list)).toBeUndefined()
      expect(Array.isArray(list.dsh)).toBe(true)
    } finally { client.close() }
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
    // Its log says what it runs on: the lean bundle, written into the data folder, which only a master
    // running on it says it shares with the services. Its command line says the same.
    const lean = /\[harnessd\] master runs from (\S+)/.exec(d.log())?.[1]
    expect(lean, 'the master re-executed on the lean bundle').toMatch(/[\\/]lean[\\/][0-9a-f]{16}[\\/]harnessd\.mjs$/)
    expect(lean!.startsWith(join(d.dataDir, 'lean'))).toBe(true)
    expect(existsSync(lean!)).toBe(true)
    // The same process `harness start` started: re-executed in place.
    const master = d.pid!
    expect(commandOf(master).endsWith(` ${lean} __harnessd`), 'the master runs on the lean bundle').toBe(true)
    // The core from the lean bundle too, on its own entry; to everything it hands on, its script is cli.js:
    // the hooks it installed run the notify.mjs beside it, not one beside the lean bundle.
    expect(coreCommand(d)).toMatch(new RegExp(` ${escape(join(d.dataDir, 'lean'))}/[0-9a-f]{16}/${escape(LEAN_CORE_ENTRY)} __run$`))
    const cohort = childCohort(d)
    expect(cohort.folder).not.toBe(dirname(lean!))
    expect(readFileSync(cohort.full).equals(readFileSync(bundle))).toBe(true)
    expect(await claudeHookCommand(d)).toContain(join(dirname(bundle), 'notify.mjs'))
    // A service's lines are stamped, as the core's and the master's are in the log they share.
    for (const name of SERVICES) {
      await until(`${name} to say it is connected`, () => new RegExp(`\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d\\.\\d{3} \\[service ${name}\\] connected to the core`).test(d.log()) || null, 30_000, 200)
    }
    for (const [name, pid] of servicePids(d)) expect(commandOf(pid).includes(` ${cohort.service} __service `), `${name} runs from the admitted lean cohort`).toBe(true)
    // Lean: under the cost of parsing the whole CLI, which every one of them paid before (at idle,
    // 115 to 160 MiB each), and a long way under it at that (55 to 80).
    for (const [name, pid] of [['master', master], ...servicePids(d)] as Array<[string, number]>) {
      expect(rssMiB(pid), `${name} resident MiB`).toBeLessThan(100)
    }
    // The core in it, beside its own processes, and nothing it starts runs from its folder: the panes' CLI is cli.js.
    expect(d.log()).not.toMatch(/the lean bundle runs a core only for the cli\.js/)
    await agentWorks(d, 'claude')
    await agentWorks(d, 'codex')
    expect(d.coresStarted()).toBe(1)
    expect(d.log()).not.toMatch(/service \w+ (exited|ended)/)
    // The master claims the folder it runs from while it lives, and gives the claim up as it stops.
    const claim = join(dirname(lean!), `.claim-${master}`)
    expect(existsSync(claim)).toBe(true)
    expect(existsSync(cohort.claim)).toBe(true)
    await d.stop()
    expect(existsSync(claim)).toBe(false)
    expect(existsSync(cohort.claim)).toBe(false)
  })

  it('starts from the same frozen full CLI once a child lean entry is gone, and sessions keep working', async () => {
    // A master lives for weeks; its lean folder, gone (someone tidying up), failed every restart of every
    // service with MODULE_NOT_FOUND until the master itself restarted. The lean bundle is only ever an
    // optimisation.
    const d = await fresh()
    // Core readiness deliberately precedes service readiness. This case removes a RUNNING
    // bundle, not one a freshly spawned service is still importing for the first time.
    await until('the services to finish importing the test bundle',
      () => SERVICES.every(name => d.log().includes(`[service ${name}] connected to the core`)) || null, 30_000, 100)
    const masterEntry = /\[harnessd\] master runs from (\S+)/.exec(d.log())![1]
    const cohort = childCohort(d)
    rmSync(cohort.service)
    expect(existsSync(masterEntry)).toBe(true)
    expect(existsSync(cohort.full)).toBe(true)
    const search = servicePids(d).get('search')!
    const restarts = (): number => [...d.log().matchAll(/\[harnessd\] service search started/g)].length
    const before = restarts()
    process.kill(search, 'SIGKILL')
    await until('search started again', () => restarts() > before || null, 60_000, 200)
    expect(d.log()).toContain(`the lean bundle ${cohort.service} cannot be used (it is gone): the core and the services start from ${cohort.full}`)
    expect(commandOf(servicePids(d).get('search')!).includes(` ${cohort.full} __service `)).toBe(true)
    await agentWorks(d, 'codex')
    // The core too, the next time it starts: killed, it comes back from cli.js and its agents go on.
    process.kill(d.corePid()!, 'SIGKILL')
    await until('the core started again', () => d.coresStarted() >= 2 || null, 60_000, 200)
    await until('the core bound again', async () => (await fetch(`http://127.0.0.1:${d.port}/api/health`).then((r) => r.ok, () => false)) || null, 60_000, 250)
    expect(coreCommand(d).endsWith(`${cohort.full} __run`)).toBe(true)
    await agentWorks(d, 'claude')
    expect(d.log()).not.toMatch(/MODULE_NOT_FOUND|Cannot find module/)
  })

  it('starts the core from its frozen full CLI after two early lean deaths, and the daemon works', async () => {
    // A lean core that cannot start costs two quick restarts, never the daemon: the master, the services
    // and every later core run on. Here its own module throws as it loads; the master's and the services' are whole.
    const lean = readLeanBundle(readFileSync(bundle))!
    const files = Object.fromEntries([...lean.files].map(([name, code]) => [name, code.toString('utf8')]))
    const core = Object.keys(files).find((name) => name.startsWith('core-coreProcess-'))!
    files[core] = 'throw new Error("a lean core that cannot load")\n'
    const brokenCore = buildWithLean(join(scratch, 'broken-core'), bundle, files)
    const d = await fresh({ HARNESSD_INITIAL_BACKOFF_MS: '200' }, brokenCore)
    const cohort = childCohort(d)
    expect(d.log()).toContain(`the core died 2 times from the lean bundle before it beat: it starts from ${cohort.full} from now on`)
    expect(d.coresStarted()).toBe(3)
    expect(coreCommand(d).endsWith(`${cohort.full} __run`)).toBe(true)
    expect(readFileSync(cohort.full).equals(readFileSync(brokenCore))).toBe(true)
    // Still lean: the master and the services.
    expect(d.log()).toMatch(/\[harnessd\] master runs from \S+\/harnessd\.mjs/)
    await agentWorks(d, 'codex')
  })

  it('keeps a master\'s lean bundle while it lives: another build\'s master on the same data folder leaves it, and its services still restart', async () => {
    // Two builds on one computer can share a data folder, and a master restarts its services from its
    // lean bundle for as long as it lives. The other master writes its own bundle and clears the folder
    // of the ones no live master claims, then leaves: a daemon is already serving.
    const d = await fresh()
    const ours = /\[harnessd\] master runs from (\S+)/.exec(d.log())![1]
    const cohort = childCohort(d)
    const lean = readLeanBundle(readFileSync(bundle))!
    const files = Object.fromEntries([...lean.files].map(([name, code]) => [name, code.toString('utf8')]))
    files['harnessd.mjs'] += '\n// another build\n'
    const other = buildWithLean(join(scratch, 'other'), bundle, files)
    const second = await IsolatedDaemon.create({ beside: d, dataDir: d.dataDir, port: d.configuredPort, scriptPath: other })
    try {
      await second.start({ ready: 'none' })
      const secondPid = second.pid!
      await until('the other master to leave', () => second.child === null || null, 90_000, 250)
      const otherMaster = /\[harnessd\] master runs from (\S+)/.exec(second.log())![1]
      expect(otherMaster).toMatch(/\/harnessd\.mjs$/)
      expect(existsSync(ours), 'the running master\'s lean bundle').toBe(true)
      expect(existsSync(join(dirname(ours), `.claim-${d.pid}`))).toBe(true)
      expect(existsSync(cohort.claim)).toBe(true)
      expect(existsSync(cohort.service)).toBe(true)
      const otherCohorts = readdirSync(join(d.dataDir, 'lean')).filter(folder => {
        const full = join(d.dataDir, 'lean', folder, 'cohort-cli.mjs')
        return existsSync(full) && readFileSync(full).equals(readFileSync(other))
      })
      expect(otherCohorts).toHaveLength(1)
      expect(existsSync(join(dirname(otherMaster), `.claim-${secondPid}`))).toBe(false)
      expect(existsSync(join(d.dataDir, 'lean', otherCohorts[0]!, `.claim-${secondPid}`))).toBe(false)
    } finally { await second.close() }
    // Its services come back from it: search, killed outright, is started again and finds a turn.
    const [, search] = [...servicePids(d)].find(([name]) => name === 'search')!
    const restarts = (): number => [...d.log().matchAll(/\[harnessd\] service search started/g)].length
    const before = restarts()
    process.kill(search, 'SIGKILL')
    await until('search started again', () => restarts() > before || null, 60_000, 200)
    expect(commandOf(servicePids(d).get('search')!).includes(` ${cohort.service} __service `)).toBe(true)
    await agentWorks(d, 'claude')
    expect(d.coresStarted()).toBe(1)
  })

  it('keeps children on frozen full code with HARNESSD_LEAN=off and the lean-off file', async () => {
    const d = await fresh({ HARNESSD_LEAN: 'off' })
    const cohort = childCohort(d)
    expect(commandOf(d.pid!).endsWith(`${bundle} __harnessd`)).toBe(true)
    expect(coreCommand(d).endsWith(`${cohort.full} __run`)).toBe(true)
    for (const [name, pid] of servicePids(d)) expect(commandOf(pid).includes(` ${cohort.full} __service `), name).toBe(true)
    await agentWorks(d, 'codex')
    await d.close()
    daemon = undefined
    // The switch for a master launchd or systemd starts, whose environment is the unit's.
    const off = await IsolatedDaemon.create({ scriptPath: bundle })
    daemon = off
    mkdirSync(off.dataDir, { recursive: true })
    writeFileSync(join(off.dataDir, 'lean-off'), '')
    await off.start()
    expect(off.log()).toContain('lean-off is there: the master runs from')
    expect(coreCommand(off).endsWith(`${childCohort(off).full} __run`)).toBe(true)
    await agentWorks(off, 'claude')
  })

  it('runs engines with the core-side optional readers gone from the bundle', async () => {
    // Default observations belong to the workers. Removing the compatibility copies must not make
    // a core load them or prevent native launch and plugin installation.
    const lean = readLeanBundle(readFileSync(bundle))!
    const files = Object.fromEntries([...lean.files].map(([name, code]) => [name, code.toString('utf8')]))
    for (const module of ['legacyScreen', 'hooks']) {
      const chunk = Object.keys(files).filter((name) => name.startsWith(`core-${module}-`))
      expect(chunk, module).toHaveLength(1)
      delete files[chunk[0]!]
    }
    // And Amp's own code (engines/amp/inProcess.ts), the one engine module that holds its thread export.
    const amp = Object.keys(files).filter((name) => name.startsWith('core-inProcess-') && files[name]!.includes('AMP_DISABLE_PLUGINS'))
    expect(amp).toHaveLength(1)
    delete files[amp[0]!]
    const without = buildWithLean(join(scratch, 'without-others'), bundle, files)
    // The stand-in stays the selected engine while readiness is durably published. Executing sleep
    // replaced that owner between the first process observation and its required refresh.
    const standIn = (name: string, version: string): string => {
      const path = join(scratch, 'without-others', name)
      writeFileSync(path, `#!${process.env.E2E_NODE_PATH}
if (process.argv.includes('--version') || process.argv.includes('--help')) {
  console.log(${JSON.stringify(version)}); process.exit(0);
}
console.log(${JSON.stringify(`${name} stand-in`)});
process.stdin.resume();
`, { mode: 0o755 })
      return path
    }
    const d = await fresh({ AMP_PATH: standIn('amp', '0.0.0'), OPENCODE_PATH: standIn('opencode', 'opencode v2.0.18') }, without)
    // The core runs from the lean bundle that lacks them, Claude Code's and Codex's hooks installed, and nothing
    // asked for either as it started.
    expect(coreCommand(d)).toMatch(new RegExp(` ${escape(join(d.dataDir, 'lean'))}/[0-9a-f]{16}/${escape(LEAN_CORE_ENTRY)} __run$`))
    expect(await claudeHookCommand(d)).toContain(join(dirname(without), 'notify.mjs'))
    const unavailable = (module: string): number => d.log().match(new RegExp(`\\[engine ${module}\\] unavailable · `, 'g'))?.length ?? 0
    expect(unavailable('screens')).toBe(0)
    expect(unavailable('hooks')).toBe(0)
    expect(unavailable('amp')).toBe(0)
    const client = await LocalClient.connect(d)
    try {
      const cwd = (name: string): string => { const path = join(d.projectsDir, name); mkdirSync(path, { recursive: true }); return path }
      const created = await client.request('agent_create', { engine: 'amp', cwd: cwd('lean-amp') }, 90_000)
      expect(created.error, JSON.stringify(created)).toBeUndefined()
      await client.waitFor(frame => frame.type === 'agent_synced' && frame.payload?.agent?.id === created.agent.id
        && frame.payload?.agent?.launch?.state === 'ready', 30_000, 'Amp readiness published')
      // Mandatory launch and plugin installation do not depend on the optional reader copies.
      // Losing the lazy hooks module cannot prevent an OpenCode launch. Ask needs no probed flag here.
      const launched = await client.request('agent_create', { engine: 'opencode', cwd: cwd('lean-opencode'), permissionMode: 'ask', bypassPermission: false }, 90_000)
      expect(launched.error, JSON.stringify(launched)).toBeUndefined()
      expect(launched.agent.engine).toBe('opencode')
      await client.waitFor(frame => frame.type === 'agent_synced' && frame.payload?.agent?.id === launched.agent.id
        && frame.payload?.agent?.launch?.state === 'ready', 30_000, 'OpenCode readiness published')
      // The reader starts for a read, not for an unbound native launch.
      const history = await client.request('session_get', { sessionId: launched.agent.id, limit: 10 }, 30_000)
      expect(history.error, JSON.stringify(history)).toBeUndefined()
      expect(history.engine).toBe('opencode')
      expect(Array.isArray(history.events)).toBe(true)
      expect(d.log()).toContain('[services] engine-others connected')
      expect(unavailable('hooks')).toBe(0)
    } finally { client.close() }
    await agentWorks(d, 'claude')
    await agentWorks(d, 'codex')
    // The default path never tries the missing core-side implementations.
    expect(unavailable('screens')).toBe(0)
    expect(unavailable('hooks')).toBe(0)
    expect(unavailable('amp')).toBe(0)
    expect(d.coresStarted()).toBe(1)
  })

  it('keeps the master on canonical CLI after a failed lean probe, with admitted frozen full children', async () => {
    const broken = buildWithLean(join(scratch, 'broken'), bundle, { 'harnessd.mjs': 'process.exit(5)\n' })
    const d = await fresh({}, broken)
    expect(d.log()).toMatch(/\[harnessd\] the lean bundle \S+ did not answer its probe \(exit 5\): the master runs from /)
    expect(commandOf(d.pid!).endsWith(`${broken} __harnessd`)).toBe(true)
    expect(coreCommand(d).endsWith(`${childCohort(d).full} __run`)).toBe(true)
    await agentWorks(d, 'claude')
    expect(d.coresStarted()).toBe(1)
  })
})
