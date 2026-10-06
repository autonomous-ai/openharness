/**
 * A self-update of a core that runs with no master, on real release bundles: what this build's core does
 * when an older release's own handoff started it (it spawned `cli.js __run`, e2e/migration.e2e.ts), or
 * `HARNESS_NO_MASTER=1` asked for it. It hands the machine to harnessd's master on the staged bundle,
 * which judges the update as it judges every one: a build whose core crashes is rolled back, remembered
 * and the master re-executed onto the build before; a good one is kept. A build whose master cannot
 * start is refused before anything is let go, and this build goes on under a master of its own. Before,
 * the core spawned a core like itself and judged it, and the successor had no master either. The same
 * holds for an update staged while such a core is still starting, or is in safe mode, as the boot
 * handoff hands it over (core/main.ts `bootHandoff`).
 *
 * The bundles are built from this checkout at made-up versions and served from a local manifest, as in
 * e2e/update.e2e.ts, so nothing here reaches beyond the machine.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { atVersion } from './harness/release.js'

const FIRST = '44.0.1'
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
type Row = Record<string, any>

describe('a self-update of a core with no master', () => {
  let scratch = ''
  let server: Server | undefined
  let daemon: IsolatedDaemon | undefined
  const releases = new Map<string, Buffer>()
  let notify = Buffer.alloc(0)
  let offered = FIRST
  const cliDir = () => join(scratch, 'cli')
  const installed = () => readFileSync(join(cliDir(), 'cli.js'))
  const rejected = () => JSON.parse(readFileSync(join(cliDir(), 'update-rejected.json'), 'utf8')) as string[]
  const status = async (): Promise<Row | null> =>
    fetch(`http://127.0.0.1:${daemon!.port}/api/status`).then((response) => response.json() as Promise<Row>).catch(() => null)
  /** What the master this test never started writes: the daemon's log file. */
  const masterLog = (): string => { try { return readFileSync(join(daemon!.dataDir, 'harness.log'), 'utf8') } catch { return '' } }
  /** The pids answering on the daemon's port: whatever runs it now. */
  const listeners = (): number[] => {
    try {
      return execFileSync('lsof', ['-n', '-P', '-t', `-iTCP:${daemon!.port}`, '-sTCP:LISTEN']).toString().trim().split('\n').filter(Boolean).map(Number)
    } catch { return [] }
  }
  const parentOf = (pid: number): number => Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
  const rows = async (client: LocalClient): Promise<Row[]> =>
    (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
  const turn = async (client: LocalClient, agentId: string, content: string) => {
    const ended = client.next((frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId, 60_000, `turn_ended (${content})`)
    client.send('message', { agentId, content })
    await ended
  }
  /** The master the core handed the machine to, once its core on `version` answers. */
  const underMaster = (version: string) => until(`the machine to run ${version} under a master`, async () => {
    const now = await status()
    return now?.version === version && now.harnessd?.masterPid && IsolatedDaemon.alive(now.harnessd.masterPid) ? now : null
  }, 120_000, 250)
  let master: number | null = null

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
      if (dies.length) source = source.replace('\n', `\nif(${JSON.stringify(dies)}.includes(process.argv[2]))process.exit(3);\n`)
      releases.set(version, Buffer.from(source))
    }
    release(FIRST)
    // Starts a master, whose core dies on every start.
    release('44.0.2', ['__run'])
    // Whose master cannot start at all: it does not answer its probe.
    release('44.0.3', ['__harnessd', '__harnessd-probe'])
    release('44.0.4')
    release('44.0.5', ['__harnessd', '__harnessd-probe'])
    release('44.0.6')

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
    const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    mkdirSync(cliDir())
    writeFileSync(join(cliDir(), 'cli.js'), releases.get(FIRST)!)
    writeFileSync(join(cliDir(), 'notify.mjs'), notify)
    writeFileSync(join(cliDir(), 'package.json'), '{"type":"module"}\n')
    daemon = await IsolatedDaemon.create({
      scriptPath: join(cliDir(), 'cli.js'),
      // A core on its own, as an older release's handoff, or HARNESS_NO_MASTER=1, starts it.
      noMaster: true,
      env: {
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
      },
    })
    await daemon.start()
    expect((await status())?.version).toBe(FIRST)
    expect((await status())?.harnessd).toBeFalsy()
  }, 300_000)

  afterAll(async () => {
    // The master this core handed the machine to is no child of the test's: it goes first, with its core.
    if (master && IsolatedDaemon.alive(master)) {
      process.kill(master, 'SIGTERM')
      await until('the master to stop', () => !IsolatedDaemon.alive(master) || null, 15_000, 100).catch(() => { try { process.kill(master!, 'SIGKILL') } catch { /* gone */ } })
    }
    for (const pid of listeners()) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    await daemon?.close()
    await new Promise<void>((done) => server ? server.close(() => done()) : done())
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

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
  /** One daemon: the core this test started has left, and the one on the port is the master's child. */
  const oneDaemon = async (under: number) => {
    await until('the core this test started to have left', () => !IsolatedDaemon.alive(daemon!.pid) || null, 30_000, 250)
    const cores = await until('one core on the port', () => { const now = listeners(); return now.length === 1 ? now : null }, 30_000, 250)
    expect(parentOf(cores[0])).toBe(under)
  }

  it('hands each update to a master, which judges it; refuses one whose master cannot start; agents go on', async () => {
    const d = daemon!
    onTestFailed(() => { console.log(`---- the core's log\n${d.log().split('\n').slice(-60).join('\n')}\n---- the daemon's log file\n${masterLog().split('\n').slice(-120).join('\n')}`) })
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

    // A build whose core crashes: the core on its own stages it and hands the machine to a master on it,
    // which finds the update unjudged, puts its first core on probation, rolls it back when it crashes and
    // re-executes onto the build before.
    offered = '44.0.2'
    await until('the core to hand 44.0.2 to a master', () => d.log().includes('handing 44.0.2 to a harnessd master, which judges it') || null, 90_000, 250)
    await until('the master to roll it back', () => masterLog().includes('the updated core failed (code 3) — rolled back') || null, 90_000, 250)
    master = (await underMaster(FIRST)).harnessd.masterPid
    expect(master).not.toBe(d.pid)
    expect(installed()).toEqual(releases.get(FIRST))
    expect(rejected()).toEqual(['44.0.2'])
    expect(existsSync(join(cliDir(), 'update-pending.json'))).toBe(false)
    await oneDaemon(master!)
    await goesOn(agent, `back on ${FIRST}, under the master`)

    // On its own again (an older release's handoff, HARNESS_NO_MASTER=1), and a build whose master cannot
    // start: refused before anything is let go, and this build goes on under a master of its own.
    process.kill(master!, 'SIGTERM')
    await until('the master to stop', () => (!IsolatedDaemon.alive(master) && listeners().length === 0) || null, 30_000, 250)
    await d.start()
    expect((await status())?.harnessd).toBeFalsy()
    const from = d.log().length
    const masterFrom = masterLog().length
    offered = '44.0.3'
    await until('the core to refuse 44.0.3', () => d.log().slice(from).includes('44.0.3\'s master did not answer its probe') || null, 90_000, 250)
    master = (await underMaster(FIRST)).harnessd.masterPid
    expect(rejected()).toEqual(['44.0.2', '44.0.3'])
    expect(installed()).toEqual(releases.get(FIRST))
    await oneDaemon(master!)
    // Its master started on this build, with nothing to judge: 44.0.3 never ran.
    expect(masterLog().slice(masterFrom)).not.toContain('on probation')
    await goesOn(agent, `on ${FIRST}, under a master of its own`)

    // A good build: now the master's to apply, re-executing on it in its own process, and to keep.
    offered = '44.0.4'
    await underMaster('44.0.4')
    await until('the master to keep it', () => masterLog().includes('the update stayed up — keeping it') || null, 60_000, 250)
    expect((await status())?.harnessd.masterPid).toBe(master)
    expect(installed()).toEqual(releases.get('44.0.4'))
    expect(rejected()).toEqual(['44.0.2', '44.0.3'])
    await goesOn(agent, 'on 44.0.4, kept')

    // The boot handoff: a core on its own in safe mode (its start-up threw; only its updater runs) hands an
    // update over without finishing start-up. A build whose master cannot start is rolled back first, and
    // this build's master starts, out of safe mode: the safe mode was the core's, not the master's to keep.
    const inSafeMode = async () => {
      process.kill(master!, 'SIGTERM')
      await until('the master to stop', () => (!IsolatedDaemon.alive(master) && listeners().length === 0) || null, 30_000, 250)
      d.env.HARNESSD_SAFE_MODE = 'an e2e start-up that failed'
      await d.start({ ready: 'none' })
      await until('the core to be in safe mode', async () => (await status())?.safeMode === true || null, 60_000, 250)
      delete d.env.HARNESSD_SAFE_MODE
    }
    await inSafeMode()
    offered = '44.0.5'
    await until('the boot handoff to refuse 44.0.5', () => d.log().includes('44.0.5\'s master did not answer its probe') || null, 90_000, 250)
    master = (await underMaster('44.0.4')).harnessd.masterPid
    expect(rejected()).toEqual(['44.0.2', '44.0.3', '44.0.5'])
    expect(installed()).toEqual(releases.get('44.0.4'))
    await oneDaemon(master!)
    expect((await status())?.safeMode).toBeFalsy()
    await goesOn(agent, 'on 44.0.4, out of safe mode under a master')

    // …and a good build, which the master judges on its first core and keeps.
    await inSafeMode()
    const keptBefore = masterLog().split('the update stayed up — keeping it').length
    offered = '44.0.6'
    await until('the boot handoff to hand 44.0.6 over', () => d.log().includes('44.0.6 staged during start-up — handing off to harnessd\'s master') || null, 90_000, 250)
    master = (await underMaster('44.0.6')).harnessd.masterPid
    await until('the master to keep it', () => masterLog().split('the update stayed up — keeping it').length > keptBefore || null, 60_000, 250)
    expect(installed()).toEqual(releases.get('44.0.6'))
    await oneDaemon(master!)
    await goesOn(agent, 'on 44.0.6, kept')
  }, 900_000)
})
