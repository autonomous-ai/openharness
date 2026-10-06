/**
 * The master re-executing itself on an update, on real release bundles (harnessd/reexec.ts): the core
 * stages a newer build and exits 75, and the master, before it starts a core on it, replaces itself
 * with that build in its own process. The pid stays, the core comes back on the new build under the
 * new master, and the agent at work in tmux carries on.
 *
 * A build whose master does not answer its probe is rolled back and remembered, like one whose core
 * fails. One whose master dies after it re-executed leaves its marker, and the next start (the
 * desktop app's `harness start`, or launchd's restart) rolls it back and moves onto the build before.
 * Nothing is left orphaned at any step: every core is the master's child.
 *
 * The bundles are built from this checkout at made-up versions and served from a local manifest, as in
 * e2e/update.e2e.ts, so nothing here reaches beyond the machine.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { atVersion } from './harness/release.js'
import { PROBE_COMMAND, runProbe } from '../src/harnessd/reexec.js'

const FIRST = '42.0.1'
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const count = (text: string, part: string): number => text.split(part).length - 1
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

describe('the master re-executing itself on an update', () => {
  let scratch = ''
  let server: Server | undefined
  let daemon: IsolatedDaemon | undefined
  let master: number | null = null
  let agent: Record<string, any> = {}
  const releases = new Map<string, Buffer>()
  let notify = Buffer.alloc(0)
  let offered = FIRST
  const cliDir = () => join(scratch, 'cli')
  const installed = () => readFileSync(join(cliDir(), 'cli.js'))
  const rejected = () => JSON.parse(readFileSync(join(cliDir(), 'update-rejected.json'), 'utf8')) as string[]
  const marker = () => join(daemon!.dataDir, 'harnessd-reexec.json')
  const status = async (): Promise<Record<string, any> | null> =>
    fetch(`http://127.0.0.1:${daemon!.port}/api/status`).then((response) => response.json()).catch(() => null)
  /** The build the core runs, and the one the master runs, as the daemon reports them. */
  const builds = async (): Promise<{ core: string | null; master: string | null; masterPid: number | null; reexecs: number | null }> => {
    const now = await status()
    return { core: now?.version ?? null, master: now?.harnessd?.masterVersion ?? null, masterPid: now?.harnessd?.masterPid ?? null, reexecs: now?.harnessd?.reexecs ?? null }
  }
  const on = (version: string) => until(`the core and the master to run ${version}`, async () => {
    const now = await builds()
    return now.core === version && now.master === version ? now : null
  }, 90_000, 250)

  const rows = async (client: LocalClient) =>
    (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
  /** The agent is back, the same conversation, and takes a turn: the core under the new master serves it. */
  const agentCarriesOn = async () => {
    const client = await LocalClient.connect(daemon!)
    try {
      await until('the agent to be back', async () => {
        const row = (await rows(client)).find((candidate) => candidate.id === agent.id)
        return row?.status === 'active' && row.sessionId === agent.sessionId ? row : null
      }, 60_000, 500)
      const ended = client.next((frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agent.id, 45_000, 'a turn')
      client.send('message', { agentId: agent.id, content: 'still there?' })
      await ended
    } finally { client.close() }
  }

  /**
   * Every process running a build of this machine, from the process table. Each core must be the
   * master's child: one left behind by a master that replaced itself would be an orphan holding the
   * port, re-parented to launchd or init.
   */
  const daemonProcesses = (): Array<{ pid: number; ppid: number; command: string }> =>
    execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => !!match && match[3].includes(join(cliDir(), 'cli.js')))
      .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }))
  const nothingOrphaned = async (masterPid: number) => {
    // A probe is over within the update; give one a moment to end.
    await until('only the master\'s own children', () => daemonProcesses().every((process) => process.ppid === masterPid && process.command.endsWith(' __run')), 10_000, 200)
    expect(daemonProcesses().filter((process) => process.command.endsWith(' __run'))).toHaveLength(1)
  }

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'harnessd-reexec-'))
    const out = join(scratch, 'build')
    execFileSync(process.execPath, ['build-bundle.mjs'], {
      cwd: CLI_ROOT, env: { ...process.env, ADAPTER_VERSION: FIRST, BUNDLE_OUT_DIR: out }, stdio: 'pipe',
    })
    const first = readFileSync(join(out, 'cli.js'), 'utf8')
    notify = readFileSync(join(out, 'notify.mjs'))
    expect(count(first, FIRST)).toBeGreaterThanOrEqual(2)
    const release = (version: string, inject = ''): void => {
      // The version is baked in at build time; the others are the same bytes with it swapped, and a
      // fault put in at the top where a test needs one.
      const source = atVersion(first, FIRST, version).replace('\n', `\n${inject}\n`)
      const file = join(out, `cli-${version}.js`)
      writeFileSync(file, source)
      expect(execFileSync(process.execPath, [file, 'version'], { encoding: 'utf8' }).trim()).toBe(version)
      releases.set(version, Buffer.from(source))
    }
    release(FIRST)
    release('42.0.2')
    // Passes the updater's canary (`cli.js version`), and its master does not answer its probe.
    release('42.0.3', 'if(process.argv[2]==="__harnessd-probe")process.exit(3);')
    release('42.0.4')
    // Answers its probe, and dies as soon as a master re-executes on it.
    release('42.0.5', 'if(process.argv[2]==="__harnessd"&&process.env.HARNESSD_RESUME)process.exit(4);')

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
    master = daemon.pid
    expect(await builds()).toMatchObject({ core: FIRST, master: FIRST, masterPid: master, reexecs: 0 })

    // An agent at work, whose pane lives in tmux through every swap below.
    const client = await LocalClient.connect(daemon)
    const cwd = join(daemon.projectsDir, 'reexec')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    agent = await until('the agent to bind its conversation', async () => {
      const row = (await rows(client)).find((candidate) => candidate.id === created.agent.id)
      return row?.sessionId && row.status === 'active' ? row : null
    }, 60_000, 500)
    client.close()
  })

  afterAll(async () => {
    await daemon?.close()
    await new Promise<void>((done) => server ? server.close(() => done()) : done())
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  const showLog = () => onTestFailed(() => { console.log(`---- daemon log\n${daemon?.log().split('\n').slice(-150).join('\n')}`) })

  it('replaces the master with the new build in its own process: same pid, and the core and the agent carry on', async () => {
    showLog()
    offered = '42.0.2'
    const now = await on('42.0.2')
    expect(now).toMatchObject({ masterPid: master, reexecs: 1 })
    expect(daemon!.pid).toBe(master)
    expect(IsolatedDaemon.alive(master)).toBe(true)
    expect(daemon!.log()).toContain(`[harnessd] master re-executed (pid ${master}) · now v42.0.2`)
    await until('the master to keep the update', () => daemon!.log().includes('the update stayed up — keeping it'), 30_000)
    expect(installed()).toEqual(releases.get('42.0.2'))
    expect(existsSync(marker())).toBe(false)
    await agentCarriesOn()
    await nothingOrphaned(master!)
  })

  it('rolls back a build whose master does not answer its probe, and remembers it; the master stays as it was', async () => {
    showLog()
    const from = daemon!.log().length
    offered = '42.0.3'
    await until('the rollback', () => daemon!.log().slice(from).includes('the new bundle\'s master would not start — rolled back to the previous bundle'), 90_000)
    expect(daemon!.log().slice(from)).toContain('did not answer its probe')
    expect(await on('42.0.2')).toMatchObject({ masterPid: master, reexecs: 1 })
    expect(installed()).toEqual(releases.get('42.0.2'))
    expect(rejected()).toEqual(['42.0.3'])
    expect(existsSync(join(cliDir(), 'update-pending.json'))).toBe(false)
    // A check every second: a few more of them, and the rejected build is not staged again.
    await until('the core to say it waits for a newer build', () => daemon!.log().slice(from).includes('42.0.3 was rolled back on this machine'), 30_000)
    const cores = daemon!.coresStarted()
    await sleep(4_000)
    expect(daemon!.coresStarted()).toBe(cores)
    await agentCarriesOn()
    await nothingOrphaned(master!)
  })

  it('moves on when a newer build is published', async () => {
    showLog()
    offered = '42.0.4'
    expect(await on('42.0.4')).toMatchObject({ masterPid: master, reexecs: 2 })
    await until('the master to keep the update', () => count(daemon!.log(), 'the update stayed up — keeping it') === 2, 30_000)
    expect(rejected()).toEqual(['42.0.3'])
    await agentCarriesOn()
    await nothingOrphaned(master!)
  })

  it('rolls back, at the next start, a build whose master died after re-executing on it', async () => {
    showLog()
    offered = '42.0.5'
    await until('the master that re-executed on 42.0.5 to die', () => !IsolatedDaemon.alive(master), 90_000, 200)
    expect(readFileSync(marker(), 'utf8')).toContain(`"pid":${master}`)
    expect(installed()).toEqual(releases.get('42.0.5'))
    // The core it replaced had exited for the update; nothing was left running in its name.
    expect(daemonProcesses()).toEqual([])

    // What the desktop app's `harness start`, or launchd restarting the master, would do.
    const from = daemon!.log().length
    await daemon!.start()
    const restarted = daemon!.pid!
    expect(restarted).not.toBe(master)
    expect(daemon!.log().slice(from)).toContain(`the master that re-executed on the new bundle (pid ${master}) never brought a core up — rolled back to the previous bundle`)
    expect(await on('42.0.4')).toMatchObject({ masterPid: restarted, reexecs: 1 })
    expect(installed()).toEqual(releases.get('42.0.4'))
    expect(rejected()).toEqual(['42.0.3', '42.0.5'])
    await until('the marker to be gone', () => !existsSync(marker()), 30_000)
    await agentCarriesOn()
    await nothingOrphaned(restarted)
  })
})

/**
 * A released master and this one, each over the other's core (protocol.ts only grows). Run when
 * MIGRATION_FROM names a released bundle, as in e2e/migration.e2e.ts.
 *
 * An older master cannot re-execute: after an update it supervises the newer core until it is
 * restarted, as every machine will once this ships. A newer master that finds the older bundle back on
 * disk does not re-execute on it either: the older bundle does not know the probe, and is never run as
 * a master to find out. Its core runs under the newer master. A release that answers the probe must
 * re-execute in both directions, with the same pid and the version of the bundle now on disk.
 */
const RELEASED = process.env.MIGRATION_FROM
describe.skipIf(!RELEASED)('a released master and this one, each over the other\'s core', () => {
  const NEXT = '0.99.0'
  let scratch = ''
  let server: Server | undefined
  let daemon: IsolatedDaemon | undefined
  let offered: 'released' | 'next' = 'released'
  let releasedVersion = ''
  let releasedCanReexec = false
  const bundles = new Map<'released' | 'next', { cli: Buffer; notify: Buffer; version: string }>()
  const cliDir = () => join(scratch, 'cli')
  const status = async (): Promise<Record<string, any> | null> =>
    fetch(`http://127.0.0.1:${daemon!.port}/api/status`).then((response) => response.json()).catch(() => null)

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'harnessd-reexec-compat-'))
    const out = join(scratch, 'build')
    execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT, env: { ...process.env, ADAPTER_VERSION: NEXT, BUNDLE_OUT_DIR: out }, stdio: 'pipe' })
    bundles.set('next', { cli: readFileSync(join(out, 'cli.js')), notify: readFileSync(join(out, 'notify.mjs')), version: NEXT })
    releasedVersion = execFileSync(process.execPath, [RELEASED!, 'version'], { encoding: 'utf8' }).trim()
    bundles.set('released', { cli: readFileSync(RELEASED!), notify: readFileSync(join(dirname(RELEASED!), 'notify.mjs')), version: releasedVersion })
    server = createServer((request, response) => {
      const origin = `http://127.0.0.1:${(server!.address() as { port: number }).port}`
      const bundle = bundles.get(offered)!
      if (request.url === '/metadata.json') {
        response.end(JSON.stringify({ cli: {
          version: bundle.version,
          cli: { url: `${origin}/cli.js`, sha256: sha(bundle.cli), size: bundle.cli.length },
          notify: { url: `${origin}/notify.mjs`, sha256: sha(bundle.notify), size: bundle.notify.length },
        } }))
        return
      }
      if (request.url === '/cli.js') { response.end(bundle.cli); return }
      if (request.url === '/notify.mjs') { response.end(bundle.notify); return }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    mkdirSync(cliDir())
    writeFileSync(join(cliDir(), 'cli.js'), bundles.get('released')!.cli)
    writeFileSync(join(cliDir(), 'notify.mjs'), bundles.get('released')!.notify)
    writeFileSync(join(cliDir(), 'package.json'), '{"type":"module"}\n')
    daemon = await IsolatedDaemon.create({
      scriptPath: join(cliDir(), 'cli.js'),
      env: {
        ADAPTER_CLI_DIR: cliDir(), ADAPTER_UPDATE_DISABLE: 'false', ADAPTER_UPDATE_URL: `${local}/metadata.json`,
        ADAPTER_UPDATE_CHECK_MS: '1000', ADAPTER_UPDATE_SLOT_SEC: '-1', HARNESSD_UPDATE_PROBATION_MS: '3000', HARNESSD_INITIAL_BACKOFF_MS: '100',
        HARNESS_TUI_MANIFEST_URL: `${local}/tui/metadata.json`, ADAPTER_RUNTIME_METADATA_URL: `${local}/runtime/metadata.json`,
        ADAPTER_GRID_RUNTIME_METADATA_URL: `${local}/grid/metadata.json`,
      },
    })
    // Found by QA on a quiet machine: 0.3.60 re-executes, but this fixture assumed every published
    // release predated it. Probe the actual bundle; a timeout or broken probe must not select the old
    // expectations and hide a regression. Old releases explicitly reject the private command.
    const probe = await runProbe(process.execPath, [join(cliDir(), 'cli.js'), PROBE_COMMAND], daemon.env).result
    if (!probe.ok) expect(probe.detail).toBe(`Unknown command: ${PROBE_COMMAND}`)
    releasedCanReexec = probe.ok
    await daemon.start()
  })

  afterAll(async () => {
    await daemon?.close()
    await new Promise<void>((done) => server ? server.close(() => done()) : done())
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('a released master adopts the update, re-executing when supported, and restarts on the new build', async () => {
    onTestFailed(() => { console.log(`---- daemon log\n${daemon?.log().split('\n').slice(-120).join('\n')}`) })
    const master = daemon!.pid
    expect((await status())?.version).toBe(releasedVersion)
    offered = 'next'
    const now = await until('the newer core under the released master', async () => {
      const current = await status()
      return current?.version === NEXT ? current : null
    }, 90_000, 250)
    expect(now.harnessd.masterPid).toBe(master)
    if (releasedCanReexec) {
      expect(now.harnessd).toMatchObject({ masterVersion: NEXT, reexecs: 1 })
      expect(daemon!.log()).toContain(`now v${NEXT}`)
    } else {
      expect(now.harnessd.masterVersion).toBeUndefined()
      expect(daemon!.log()).not.toContain('re-executing')
    }
    await until('the released master to keep the update', () => daemon!.log().includes('the update stayed up — keeping it'), 30_000)
    await daemon!.restart()
    expect((await status())?.harnessd).toMatchObject({ masterVersion: NEXT, masterPid: daemon!.pid })
  })

  it('this master returns to the released bundle, re-executing only when it answers the probe', async () => {
    onTestFailed(() => { console.log(`---- daemon log\n${daemon?.log().split('\n').slice(-120).join('\n')}`) })
    offered = 'released'   // not newer: the older core's updater leaves it alone
    const master = daemon!.pid
    const from = daemon!.log().length
    writeFileSync(join(cliDir(), 'cli.js'), bundles.get('released')!.cli)
    process.kill((await status())!.corePid as number, 'SIGKILL')
    const now = await until('the older core under this master', async () => {
      const current = await status()
      return current?.version === releasedVersion ? current : null
    }, 60_000, 250)
    expect(now.harnessd).toMatchObject({
      masterVersion: releasedCanReexec ? releasedVersion : NEXT,
      masterPid: master,
      reexecs: releasedCanReexec ? 1 : 0,
    })
    expect(daemon!.log().slice(from)).toContain(releasedCanReexec
      ? `now v${releasedVersion}`
      : 'did not answer its probe (Unknown command: __harnessd-probe) — keeping this master')
  })
})
