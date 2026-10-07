/**
 * Upgrading a machine from a released build, for Claude Code and Codex — what every installed machine
 * does when a release ships. A daemon of the released build (`MIGRATION_FROM`, its bundled `cli.js`)
 * runs with agents at work, finds this checkout's build in its update manifest, and hands over to it
 * the way that release hands over: it spawns the new `cli.js __run` and exits. The new core comes up
 * on its own, with no master, keeps every agent and its conversation, and once that release has gone it
 * hands the machine to harnessd's master, which runs the updater (core/updateHandoff.ts). Then the next
 * start brings up the master over the same agents again.
 *
 * Skipped unless MIGRATION_FROM names a bundle, so CI does not build old releases. Before a release:
 * build the last released tag's bundle (`node build-bundle.mjs` in a checkout of it) and run
 * `MIGRATION_FROM=<that>/dist/cli.js npm run test:e2e -- migration`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

const FROM = process.env.MIGRATION_FROM
const NEXT = '0.99.0'
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

describe.skipIf(!FROM)('upgrading a machine from a released build', () => {
  let scratch = ''
  let server: Server | undefined
  let daemon: IsolatedDaemon | undefined
  let offered: 'from' | 'next' = 'from'
  let fromVersion = ''
  const bundles = new Map<'from' | 'next', { cli: Buffer; notify: Buffer; version: string }>()
  const cliDir = () => join(scratch, 'cli')
  const health = async (): Promise<Record<string, any> | null> =>
    fetch(`http://127.0.0.1:${daemon!.port}/api/health`).then((response) => response.json()).catch(() => null)
  const rows = async (client: LocalClient) =>
    (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
  const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
  const turn = async (client: LocalClient, agentId: string, content: string) => {
    const ended = client.next(isTurn('turn_ended', agentId), 60_000, `turn_ended (${content})`)
    client.send('message', { agentId, content })
    await ended
  }
  /** The pids answering on the daemon's port, from the process table: whatever is running it now. */
  const listeners = (): number[] => {
    try {
      return execFileSync('lsof', ['-n', '-P', '-t', `-iTCP:${daemon!.port}`, '-sTCP:LISTEN']).toString().trim().split('\n').filter(Boolean).map(Number)
    } catch { return [] }
  }

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'harnessd-migration-'))
    const out = join(scratch, 'build')
    execFileSync(process.execPath, ['build-bundle.mjs'], {
      cwd: CLI_ROOT, env: { ...process.env, ADAPTER_VERSION: NEXT, BUNDLE_OUT_DIR: out }, stdio: 'pipe',
    })
    bundles.set('next', { cli: readFileSync(join(out, 'cli.js')), notify: readFileSync(join(out, 'notify.mjs')), version: NEXT })
    fromVersion = execFileSync(process.execPath, [FROM!, 'version'], { encoding: 'utf8' }).trim()
    bundles.set('from', { cli: readFileSync(FROM!), notify: readFileSync(join(dirname(FROM!), 'notify.mjs')), version: fromVersion })

    server = createServer((request, response) => {
      const url = request.url ?? ''
      const origin = `http://127.0.0.1:${(server!.address() as { port: number }).port}`
      const bundle = bundles.get(offered)!
      if (url === '/metadata.json') {
        response.end(JSON.stringify({ cli: {
          version: bundle.version,
          cli: { url: `${origin}/cli-${offered}.js`, sha256: sha(bundle.cli), size: bundle.cli.length },
          notify: { url: `${origin}/notify-${offered}.mjs`, sha256: sha(bundle.notify), size: bundle.notify.length },
        } }))
        return
      }
      const asked = /^\/(cli|notify)-(from|next)\.(js|mjs)$/.exec(url)
      if (asked) { response.end(bundles.get(asked[2] as 'from' | 'next')![asked[1] as 'cli' | 'notify']); return }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    mkdirSync(cliDir())
    copyFileSync(FROM!, join(cliDir(), 'cli.js'))
    copyFileSync(join(dirname(FROM!), 'notify.mjs'), join(cliDir(), 'notify.mjs'))
    writeFileSync(join(cliDir(), 'package.json'), '{"type":"module"}\n')
    daemon = await IsolatedDaemon.create({
      scriptPath: join(cliDir(), 'cli.js'),
      // As the released build runs: `harness start` spawned `__run` itself; it had no master.
      noMaster: true,
      env: {
        ADAPTER_CLI_DIR: cliDir(),
        ADAPTER_UPDATE_DISABLE: 'false',
        ADAPTER_UPDATE_URL: `${local}/metadata.json`,
        ADAPTER_UPDATE_CHECK_MS: '1000',
        ADAPTER_UPDATE_SLOT_SEC: '-1',
        HARNESS_TUI_MANIFEST_URL: `${local}/tui/metadata.json`,
        ADAPTER_RUNTIME_METADATA_URL: `${local}/runtime/metadata.json`,
        ADAPTER_GRID_RUNTIME_METADATA_URL: `${local}/grid/metadata.json`,
      },
    })
    // A released build may say nothing when it is ready, and has no request gate: its port is the sign.
    await daemon.start({ ready: 'port' })
    expect((await health())?.version).toBe(fromVersion)
  }, 300_000)

  /** The master the handed-over core started, if it is running: no child of the test's. */
  const handedTo = async (): Promise<number | null> => {
    const status = await fetch(`http://127.0.0.1:${daemon!.port}/api/status`).then((response) => response.json() as Promise<Record<string, any>>).catch(() => null)
    const pid = status?.harnessd?.masterPid
    return typeof pid === 'number' && pid !== daemon!.pid && IsolatedDaemon.alive(pid) ? pid : null
  }

  afterAll(async () => {
    // Whatever runs the port now — a master the handed-over core started included — goes with the test.
    const master = daemon ? await handedTo() : null
    if (master) { try { process.kill(master, 'SIGTERM') } catch { /* gone */ } }
    for (const pid of listeners()) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    await daemon?.close()
    await new Promise<void>((done) => server ? server.close(() => done()) : done())
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('agents at work on the released build come through its update, then through the master\'s first start', async () => {
    const d = daemon!
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    let client = await LocalClient.connect(d)
    const agents: Array<Record<string, any>> = []
    for (const engine of ['claude', 'codex'] as const) {
      const cwd = join(d.projectsDir, `migrating-${engine}`)
      mkdirSync(cwd, { recursive: true })
      // Asked until the released build has finished wiring its handlers (it answers before it has).
      const created = await until(`${fromVersion} to create a ${engine} agent`, async () => {
        const answer = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
        return answer.error ? null : answer
      }, 60_000, 1_000)
      agents.push(await until(`${engine} to bind on ${fromVersion}`, async () => {
        const agent = (await rows(client)).find((one) => one.id === created.agent.id)
        return agent?.sessionId && agent.status === 'active' ? agent : null
      }, 60_000, 500))
    }
    for (const agent of agents) await turn(client, agent.id, `on ${fromVersion}`)

    // The release ships: the released build finds it, stages it and hands over.
    offered = 'next'
    await until(`the machine to run ${NEXT}`, async () => (await health())?.version === NEXT || null, 120_000, 500)
    client.close()

    // Once the released build has gone, the core it left with no master hands the machine to one, which
    // runs the updater: a second restart, seconds after the first, as any update's is. The agents go on.
    const master = await until('the handed-over core to hand the machine to a master', () => handedTo(), 120_000, 500)
    client = await LocalClient.connect(d)
    for (const agent of agents) {
      await until(`${agent.id.slice(0, 8)} back under the master the core started`, async () => {
        const now = (await rows(client)).find((one) => one.id === agent.id)
        return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
      }, 60_000, 500)
      await turn(client, agent.id, `on ${NEXT}, under the master the core started`)
    }
    client.close()

    // The next `harness start` (a reboot, the desktop app) starts the new build as harnessd: master and core.
    // The released build's own process may still be about, waiting on its successor; it goes first.
    await d.stop()
    process.kill(master, 'SIGTERM')
    for (const pid of listeners()) process.kill(pid, 'SIGTERM')
    await until('the daemon to stop', () => (listeners().length === 0 && !IsolatedDaemon.alive(master)) || null, 30_000, 250)
    ;(d.options as { noMaster?: boolean }).noMaster = false
    await d.start()
    expect((await health())?.version).toBe(NEXT)
    expect(d.coresStarted()).toBe(1)
    client = await LocalClient.connect(d)
    for (const agent of agents) {
      await until(`${agent.id.slice(0, 8)} back under the master`, async () => {
        const now = (await rows(client)).find((one) => one.id === agent.id)
        return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
      }, 60_000, 500)
      await turn(client, agent.id, `on ${NEXT}, under the master`)
    }
    client.close()
  }, 600_000)
})
