/**
 * A core with no master, on real release bundles. The updater is the master's, in a process of its own
 * (services/updaterProcess.ts), and the core never downloads a build, so a core with no master gets no
 * update by itself:
 *
 * - one an older release's own handoff started (it spawns `cli.js __run`, judges it and leaves:
 *   e2e/harness/olderReleaseHandoff.mjs) hands the machine to a master on its build once that release has
 *   gone. The master's updater then updates it, and the master judges each build: one whose core crashes
 *   is rolled back and remembered, a good one kept. Before, such a core ran its own updater and handed each
 *   update to a core like itself, which again had no master;
 * - one `HARNESS_NO_MASTER=1` asked for runs without updates, as asked.
 *
 * The bundles are built from this checkout at made-up versions and served from a local manifest, as in
 * e2e/update.e2e.ts, so nothing here reaches beyond the machine.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { atVersion, withFault } from './harness/release.js'

const FIRST = '44.0.1'
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
type Row = Record<string, any>

describe('a core with no master', () => {
  let scratch = ''
  let server: Server | undefined
  let daemon: IsolatedDaemon | undefined
  let master: number | null = null
  const releases = new Map<string, Buffer>()
  let notify = Buffer.alloc(0)
  let offered = FIRST
  let local = ''
  const cliDir = () => join(scratch, 'cli')
  const installed = () => readFileSync(join(cliDir(), 'cli.js'))
  const rejected = () => JSON.parse(readFileSync(join(cliDir(), 'update-rejected.json'), 'utf8')) as string[]
  const status = async (): Promise<Row | null> =>
    fetch(`http://127.0.0.1:${daemon!.port}/api/status`).then((response) => response.json() as Promise<Row>).catch(() => null)
  /** The pids answering on the daemon's port: whatever runs it now. */
  const listeners = (): number[] => {
    try {
      return execFileSync('lsof', ['-n', '-P', '-t', `-iTCP:${daemon!.port}`, '-sTCP:LISTEN']).toString().trim().split('\n').filter(Boolean).map(Number)
    } catch { return [] }
  }
  /** What the daemon has said: what this test's process printed, and the log file the master the core
   *  started writes to (core/main.ts `startMasterHere`). */
  const logs = (): string => {
    let file = ''
    try { file = readFileSync(join(daemon!.dataDir, 'harness.log'), 'utf8') } catch { /* none yet */ }
    return `${daemon!.log()}\n${file}`
  }
  const parentOf = (pid: number): number => Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
  const rows = async (client: LocalClient): Promise<Row[]> =>
    (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
  const turn = async (client: LocalClient, agentId: string, content: string) => {
    const ended = client.next((frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId, 60_000, `turn_ended (${content})`)
    client.send('message', { agentId, content })
    await ended
  }
  /** The agent, on its conversation, taking a turn: proof it came through. */
  const goesOn = async (agent: Row, content: string) => {
    const client = await LocalClient.connect(daemon!)
    await until('the agent back on its conversation', async () => {
      const row = (await rows(client)).find((one) => one.id === agent.id)
      return row?.status === 'active' && row.sessionId === agent.sessionId ? row : null
    }, 60_000, 500)
    await turn(client, agent.id, content)
    client.close()
  }
  /** The master running the machine, once its core on `version` answers. */
  const underMaster = (version: string) => until(`the machine to run ${version} under a master`, async () => {
    const now = await status()
    return now?.version === version && now.harnessd?.masterPid && IsolatedDaemon.alive(now.harnessd.masterPid) ? now : null
  }, 120_000, 250)
  const environment = () => ({
    ADAPTER_CLI_DIR: cliDir(),
    ADAPTER_UPDATE_DISABLE: 'false',
    ADAPTER_UPDATE_URL: `${local}/metadata.json`,
    ADAPTER_UPDATE_CHECK_MS: '1000',
    ADAPTER_UPDATE_SLOT_SEC: '-1',
    HARNESSD_UPDATE_PROBATION_MS: '3000',
    HARNESSD_INITIAL_BACKOFF_MS: '100',
    HARNESS_TUI_MANIFEST_URL: `${local}/tui/metadata.json`,
    ADAPTER_RUNTIME_METADATA_URL: `${local}/runtime/metadata.json`,
    ADAPTER_GRID_RUNTIME_METADATA_URL: `${local}/grid/metadata.json`,
  })
  const install = (version: string) => {
    rmSync(cliDir(), { recursive: true, force: true })
    mkdirSync(cliDir())
    writeFileSync(join(cliDir(), 'cli.js'), releases.get(version)!)
    writeFileSync(join(cliDir(), 'notify.mjs'), notify)
    writeFileSync(join(cliDir(), 'package.json'), '{"type":"module"}\n')
  }

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'harnessd-update-alone-'))
    const out = join(scratch, 'build')
    execFileSync(process.execPath, ['build-bundle.mjs'], {
      cwd: CLI_ROOT, env: { ...process.env, ADAPTER_VERSION: FIRST, BUNDLE_OUT_DIR: out }, stdio: 'pipe',
    })
    const first = readFileSync(join(out, 'cli.js'), 'utf8')
    notify = readFileSync(join(out, 'notify.mjs'))
    /** A release; `dies` names the commands it dies on (exit 3), after the updater's canary (`cli.js version`). */
    const release = (version: string, dies: string[] = []): void => {
      let source = atVersion(first, FIRST, version)
      if (dies.length) source = withFault(source, `if(${JSON.stringify(dies)}.includes(process.argv[2]))process.exit(3);`)
      releases.set(version, Buffer.from(source))
    }
    release(FIRST)
    // Starts a master, whose core dies on every start.
    release('44.0.2', ['__run'])
    release('44.0.3')

    server = createServer((request, response) => {
      const url = request.url ?? ''
      const origin = `http://127.0.0.1:${(server!.address() as { port: number }).port}`
      if (url === '/metadata.json') {
        const cli = releases.get(offered)!
        response.end(JSON.stringify({ cli: {
          version: offered,
          cli: { url: `${origin}/cli-${offered}.js`, sha256: sha(cli), size: cli.length },
          notify: { url: `${origin}/notify.mjs`, sha256: sha(notify), size: notify.length },
        } }))
        return
      }
      const asked = /^\/cli-(.+)\.js$/.exec(url)?.[1]
      if (asked && releases.has(asked)) { response.end(releases.get(asked)); return }
      if (url === '/notify.mjs') { response.end(notify); return }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    local = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }, 300_000)

  afterEach(async () => {
    // A master the core handed the machine to is no child of the test's: it goes first, with its core.
    if (master && IsolatedDaemon.alive(master)) {
      process.kill(master, 'SIGTERM')
      await until('the master to stop', () => !IsolatedDaemon.alive(master) || null, 15_000, 100).catch(() => { try { process.kill(master!, 'SIGKILL') } catch { /* gone */ } })
    }
    master = null
    for (const pid of listeners()) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    await daemon?.close()
    daemon = undefined
  })
  afterAll(async () => {
    await new Promise<void>((done) => server ? server.close(() => done()) : done())
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('one an older release started hands itself to a master once the release has gone, whose updater updates it', async () => {
    offered = FIRST
    install(FIRST)
    const mayLeave = join(scratch, 'release-may-leave')
    rmSync(mayLeave, { force: true })
    const d = await IsolatedDaemon.create({ scriptPath: join(cliDir(), 'cli.js'), noMaster: true, env: environment() })
    daemon = d
    ;(d.options as { launch?: string[] }).launch = [join(CLI_ROOT, 'e2e/harness/olderReleaseHandoff.mjs'), join(cliDir(), 'cli.js'), join(d.dataDir, 'adapter.pid'), mayLeave]
    onTestFailed(() => { console.log(`---- daemon log\n${logs().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    expect((await status())?.harnessd).toBeFalsy()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'alone')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until('the agent to bind', async () => {
      const row = (await rows(client)).find((one) => one.id === created.agent.id)
      return row?.sessionId && row.status === 'active' ? row : null
    }, 60_000, 500)
    await turn(client, agent.id, `on ${FIRST}, on its own`)
    client.close()

    // The release that started it is still judging it: it stays put meanwhile, and runs no updater.
    const before = await status()
    await sleep(3_000)
    expect((await status())?.pid).toBe(before?.pid)
    expect(d.log()).not.toContain('[update] self-update on')

    // The release leaves: the core hands the machine to a master on this build.
    writeFileSync(mayLeave, '')
    await until('the core to hand over', () => d.log().includes(`handing ${FIRST} to a harnessd master, which runs the updater`) || null, 60_000, 250)
    master = (await underMaster(FIRST)).harnessd.masterPid
    const cores = await until('one core on the port', () => { const now = listeners(); return now.length === 1 ? now : null }, 60_000, 250)
    expect(parentOf(cores[0])).toBe(master)
    await goesOn(agent, `on ${FIRST}, under a master`)

    // The master's updater: a build whose core crashes is rolled back and remembered, a good one is kept.
    offered = '44.0.2'
    await until('the master to roll 44.0.2 back', () => logs().includes('the updated core failed (code 3) — rolled back') || null, 120_000, 250)
    await underMaster(FIRST)
    expect(rejected()).toEqual(['44.0.2'])
    expect(installed()).toEqual(releases.get(FIRST))
    offered = '44.0.3'
    await underMaster('44.0.3')
    await until('the master to keep it', () => logs().includes('the update stayed up — keeping it') || null, 60_000, 250)
    expect((await status())?.harnessd.masterPid).toBe(master)
    expect(installed()).toEqual(releases.get('44.0.3'))
    await goesOn(agent, 'on 44.0.3, kept')
  }, 600_000)

  it('one HARNESS_NO_MASTER=1 asked for runs without updates', async () => {
    offered = '44.0.3'
    install(FIRST)
    const d = await IsolatedDaemon.create({ scriptPath: join(cliDir(), 'cli.js'), noMaster: true, env: { ...environment(), HARNESS_NO_MASTER: '1' } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-80).join('\n')}`) })
    await d.start()
    // A check a second, for five: nothing downloaded, nothing staged, the same core.
    const pid = (await status())?.pid
    await sleep(5_000)
    expect(await status()).toMatchObject({ version: FIRST, pid })
    expect(installed()).toEqual(releases.get(FIRST))
    expect(d.log()).not.toMatch(/\[update\] (newer build available|staged)/)
  }, 300_000)
})
