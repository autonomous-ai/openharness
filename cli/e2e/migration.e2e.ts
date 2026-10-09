/**
 * Upgrading a machine from a released build, for Claude Code and Codex — what every installed machine
 * does when a release ships. A daemon of the released build (`MIGRATION_FROM`, its bundled `cli.js` with
 * its `notify.mjs` beside it) runs with agents at work, finds this checkout's build in its update manifest,
 * and hands over to it the way that release hands over. Then the next start (a reboot, the desktop app)
 * brings this build's master up over the same agents again.
 *
 * A release with harnessd runs as `harness start` runs it: its master, and the core as the master's child.
 * Since #925 the master's updater, in a process of its own, downloads, verifies and stages the build, and
 * the master has the core hand over and starts the new one, re-executing itself on the new bundle first
 * when the release can (harnessd/reexec.ts). A master from before #925 leaves the updater to its core, and
 * a core under a master too old to run one runs it beside itself (core/updaterBeside.ts). The core never
 * downloads a build, so a release's core started on its own, with no master, is never updated: this test
 * ran 0.3.67 that way and timed out waiting for the update (2026-10-08).
 *
 * A release from before harnessd has no master: it spawns the new `cli.js __run` and exits, and once it
 * has gone, the core it left hands the machine to a master, which runs the updater (core/updateHandoff.ts).
 *
 * Skipped unless MIGRATION_FROM names a bundle, so CI neither downloads nor builds old releases. Before a
 * release, take the published one: its manifest,
 * https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/cli/metadata.json, names `cli.js` and
 * `notify.mjs` with their sha256. Download both into one folder, check them (`shasum -a 256`), and run
 * `MIGRATION_FROM=<folder>/cli.js E2E_BUNDLE=1 npm run test:e2e -- migration`. Or build a release tag's
 * bundle (`node build-bundle.mjs` in a checkout of it).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { PROBE_COMMAND, runProbe } from '../src/harnessd/reexec.js'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

const FROM = process.env.MIGRATION_FROM
const NEXT = '0.99.0'
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
type Row = Record<string, any>

describe.skipIf(!FROM)('upgrading a machine from a released build', () => {
  let scratch = ''
  let server: Server | undefined
  let daemon: IsolatedDaemon | undefined
  let offered: 'from' | 'next' = 'from'
  let fromVersion = ''
  /** The release runs under harnessd's master (`__harnessd` is in its bundle). */
  let fromHasMaster = false
  /** Its master answers the probe a master asks before re-executing on a bundle. */
  let fromCanReexec = false
  const bundles = new Map<'from' | 'next', { cli: Buffer; notify: Buffer; version: string }>()
  const cliDir = () => join(scratch, 'cli')
  const status = async (): Promise<Row | null> =>
    fetch(`http://127.0.0.1:${daemon!.port}/api/status`).then((response) => response.json() as Promise<Row>).catch(() => null)
  const rows = async (client: LocalClient): Promise<Row[]> =>
    (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
  const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
  const turn = async (client: LocalClient, agentId: string, content: string) => {
    const ended = client.next(isTurn('turn_ended', agentId), 60_000, `turn_ended (${content})`)
    client.send('message', { agentId, content })
    await ended
  }
  /** Each agent back on its conversation, and a turn answered there. */
  const carryOn = async (agents: Row[], where: string) => {
    const client = await LocalClient.connect(daemon!)
    try {
      for (const agent of agents) {
        await until(`${agent.engine} back ${where}`, async () => {
          const now = (await rows(client)).find((one) => one.id === agent.id)
          return now?.status === 'active' && now.sessionId === agent.sessionId ? now : null
        }, 60_000, 500)
        await turn(client, agent.id, `${where} (${agent.engine})`)
      }
    } finally { client.close() }
  }
  /** The pids answering on the daemon's port, from the process table: whatever is running it now. */
  const listeners = (): number[] => {
    try {
      return execFileSync('lsof', ['-n', '-P', '-t', `-iTCP:${daemon!.port}`, '-sTCP:LISTEN']).toString().trim().split('\n').filter(Boolean).map(Number)
    } catch { return [] }
  }
  /** Every process running a build from this install: the master, its core and its services. */
  const daemonProcesses = (): Array<{ pid: number; ppid: number; command: string }> =>
    execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      // The core and the services from the lean bundle in the data folder, or from cli.js.
      .filter((match): match is RegExpExecArray => !!match && (match[3].includes(join(cliDir(), 'cli.js')) || (!!daemon && match[3].includes(join(daemon.dataDir, 'lean')))))
      .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }))
  /** The master a core with no master started, if it is running: no child of the test's. */
  const handedTo = async (): Promise<number | null> => {
    const pid = (await status())?.harnessd?.masterPid
    return typeof pid === 'number' && pid !== daemon!.pid && IsolatedDaemon.alive(pid) ? pid : null
  }

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'harnessd-migration-'))
    const out = join(scratch, 'build')
    execFileSync(process.execPath, ['build-bundle.mjs'], {
      cwd: CLI_ROOT, env: { ...process.env, ADAPTER_VERSION: NEXT, BUNDLE_OUT_DIR: out }, stdio: 'pipe',
    })
    bundles.set('next', { cli: readFileSync(join(out, 'cli.js')), notify: readFileSync(join(out, 'notify.mjs')), version: NEXT })
    fromVersion = execFileSync(process.execPath, [FROM!, 'version'], { encoding: 'utf8' }).trim()
    const fromCli = readFileSync(FROM!)
    bundles.set('from', { cli: fromCli, notify: readFileSync(join(dirname(FROM!), 'notify.mjs')), version: fromVersion })
    fromHasMaster = fromCli.includes('__harnessd')

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
      // As `harness start` runs that release: under its master, or, before harnessd, its core on its own.
      noMaster: !fromHasMaster,
      env: {
        ADAPTER_CLI_DIR: cliDir(),
        ADAPTER_UPDATE_DISABLE: 'false',
        ADAPTER_UPDATE_URL: `${local}/metadata.json`,
        ADAPTER_UPDATE_CHECK_MS: '1000',
        ADAPTER_UPDATE_SLOT_SEC: '-1',
        HARNESSD_UPDATE_PROBATION_MS: '6000',
        HARNESSD_INITIAL_BACKOFF_MS: '100',
        HARNESS_TUI_MANIFEST_URL: `${local}/tui/metadata.json`,
        ADAPTER_RUNTIME_METADATA_URL: `${local}/runtime/metadata.json`,
        ADAPTER_GRID_RUNTIME_METADATA_URL: `${local}/grid/metadata.json`,
      },
    })
    if (fromHasMaster) {
      // Asked of the bundle itself, as reexec.e2e.ts does: a timeout or a broken probe must fail here, not
      // pass as a release from before re-executing. Those reject the private command by name.
      const probe = await runProbe(process.execPath, [join(cliDir(), 'cli.js'), PROBE_COMMAND], daemon.env).result
      if (!probe.ok) expect(probe.detail).toBe(`Unknown command: ${PROBE_COMMAND}`)
      fromCanReexec = probe.ok
    }
    // A released build may say nothing when it is ready, and has no request gate: its port is the sign.
    await daemon.start({ ready: 'port' })
    expect((await status())?.version).toBe(fromVersion)
    if (fromHasMaster) expect((await status())?.harnessd?.masterPid).toBe(daemon.pid)
  }, 300_000)

  afterAll(async () => {
    // Whatever runs the port now — a master a core with no master started included — goes with the test.
    const master = daemon ? await handedTo() : null
    if (master) { try { process.kill(master, 'SIGTERM') } catch { /* gone */ } }
    for (const pid of listeners()) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    await daemon?.close()
    await new Promise<void>((done) => server ? server.close(() => done()) : done())
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('agents at work on the released build come through its update, then through this master\'s first start', async () => {
    const d = daemon!
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    const client = await LocalClient.connect(d)
    const agents: Row[] = []
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
    client.close()

    // The release ships: the released build finds it, stages it and hands over.
    const updateFrom = d.log().length
    offered = 'next'
    const updated = await until(`the machine to run ${NEXT}`, async () => {
      const now = await status()
      return now?.version === NEXT ? now : null
    }, 150_000, 500)
    let master = d.pid!
    if (fromHasMaster) {
      // The release's master stays the process `harness start` started: it re-executed on the new bundle
      // in place, or, from before that, supervises the new core as it is until its next start.
      expect(updated.harnessd?.masterPid).toBe(master)
      if (fromCanReexec) {
        expect(updated.harnessd).toMatchObject({ masterVersion: NEXT, reexecs: 1 })
        expect(d.log().slice(updateFrom)).toContain(`master re-executed (pid ${master}) · now v${NEXT}`)
      }
      // Judged on probation and kept: the new bundle is installed, and nothing is left staged.
      await until('the master to keep the update', () => d.log().slice(updateFrom).includes('the update stayed up — keeping it') || null, 60_000, 250)
      expect(readFileSync(join(cliDir(), 'cli.js'))).toEqual(bundles.get('next')!.cli)
      expect(existsSync(join(cliDir(), 'update-pending.json'))).toBe(false)
    } else {
      // Once the released build has gone, the core it left with no master hands the machine to one, which
      // runs the updater: a second restart, seconds after the first, as any update's is.
      master = await until('the handed-over core to hand the machine to a master', () => handedTo(), 120_000, 500)
    }
    await carryOn(agents, `on ${NEXT}, after the update`)
    // One core, the master's child: none left from the release, none orphaned by a master that re-executed.
    const cores = await until('one core on this install', () => {
      const now = daemonProcesses().filter((one) => one.command.endsWith(' __run'))
      return now.length === 1 ? now : null
    }, 90_000, 500)
    expect(cores[0].ppid).toBe(master)

    // The next `harness start` (a reboot, the desktop app) starts the new build as harnessd: master and core.
    // A release with no master may still have its own process about, waiting on its successor; it goes too.
    await d.stop()
    if (!fromHasMaster) process.kill(master, 'SIGTERM')
    for (const pid of listeners()) process.kill(pid, 'SIGTERM')
    await until('the daemon to stop', () => (listeners().length === 0 && !IsolatedDaemon.alive(master)) || null, 30_000, 250)
    ;(d.options as { noMaster?: boolean }).noMaster = false
    await d.start()
    expect(await status()).toMatchObject({ version: NEXT, harnessd: { masterVersion: NEXT, masterPid: d.pid, reexecs: 0 } })
    await carryOn(agents, `on ${NEXT}, under this master`)
  }, 600_000)
})
