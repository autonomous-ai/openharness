/**
 * Round 40: the update path under hostile conditions, end to end on real release bundles (built from
 * this checkout at made-up versions and served from a local manifest, as in e2e/update.e2e.ts and
 * e2e/reexec.e2e.ts). It is how every fix reaches every machine, so it has to hold when the link
 * drops, the release is broken, the manifest lies, two checks race the master, agents are mid-turn,
 * the new core cannot start, the master dies mid-update and the disk fills.
 *
 * After each: the daemon runs a working build (the old one or the new one) under its master, every
 * agent is back and takes a turn, nothing half-written is left in the install for the next update to
 * trip on, and a build that failed on this machine is remembered, while one that only met a bad moment
 * (a dropped link, a full disk) is installed once the moment passes.
 *
 * The full-disk half mounts a small disk image of its own (macOS `hdiutil`), as e2e/diskfull.e2e.ts
 * does, so it is opt-in: `DISKFULL=1 npm run test:e2e -- updateHostile`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync, writeSync,
} from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { atVersion } from './harness/release.js'

const FIRST = '43.0.1'
const DISKFULL = process.env.DISKFULL === '1' && process.platform === 'darwin'
/** Passes the updater's canary (`cli.js version`), then dies on every start as a core. */
const CRASHES_AS_A_CORE = 'if(process.argv[2]==="__run")process.exit(3);'
/**
 * A core that runs as any other, until it hands over to an update: then the first interval it clears
 * throws, as a teardown step that fails does (core/updateHandoff.ts). Told by the line the handoff
 * starts with, wherever the daemon's timestamp puts it among the arguments.
 */
const TEARDOWN_THROWS = 'if(process.argv[2]==="__run"){let f=false;const l=console.log;console.log=function(...a){if(a.some((x)=>typeof x==="string"&&x.includes("[update] applying")))f=true;return l.apply(this,a)};const c=globalThis.clearInterval;globalThis.clearInterval=function(...a){if(f){f=false;throw new Error("a teardown step that throws")}return c.apply(this,a)}}'
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const count = (text: string, part: string): number => text.split(part).length - 1
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
type Row = Record<string, any>

/** One bundle built from this checkout; every release below is it at another version. */
let built = ''
let builtNotify = ''
let buildDir = ''

beforeAll(() => {
  buildDir = mkdtempSync(join(tmpdir(), 'harnessd-hostile-build-'))
  execFileSync(process.execPath, ['build-bundle.mjs'], {
    cwd: CLI_ROOT, env: { ...process.env, ADAPTER_VERSION: FIRST, BUNDLE_OUT_DIR: buildDir }, stdio: 'pipe',
  })
  built = readFileSync(join(buildDir, 'cli.js'), 'utf8')
  builtNotify = readFileSync(join(buildDir, 'notify.mjs'), 'utf8')
  // The version is baked in at build time; the others are the same bytes with it swapped.
  expect(count(built, FIRST)).toBeGreaterThanOrEqual(2)
}, 180_000)

afterAll(() => { if (buildDir) rmSync(buildDir, { recursive: true, force: true }) })

/**
 * Releases: the build at another version, with a fault put in at the top where a test needs one, and a
 * notify.mjs of its own, so an install mixed from two releases shows.
 */
class Releases {
  readonly cli = new Map<string, Buffer>()
  readonly notify = new Map<string, Buffer>()
  add(version: string, inject = ''): void {
    // In the lean bundle cli.js carries for the master and the services too (e2e/harness/release.ts).
    const source = atVersion(built, FIRST, version).replace('\n', `\n${inject}\n`)
    const file = join(buildDir, `cli-${version}.js`)
    writeFileSync(file, source)
    expect(execFileSync(process.execPath, [file, 'version'], { encoding: 'utf8' }).trim()).toBe(version)
    this.cli.set(version, Buffer.from(source))
    this.notify.set(version, Buffer.from(`${builtNotify}\n// release ${version}\n`))
  }
}

/** What a download of cli.js meets: cut short with a length to match, a connection that dies halfway
 *  through the length it promised, one that stays open halfway through and sends nothing more, or a
 *  wait until the test lets it through. */
type Fault = 'truncate' | 'drop' | 'stall' | 'hold'

interface Offer {
  version: string
  /** Bytes served as this version's cli.js instead of its own: a release whose manifest lies about it. */
  bytes?: Buffer
  /** The sha256 the manifest names, when it is not that of the bytes served. */
  manifestSha?: string
}

/** The release channel: a manifest naming one build, and the files it names, with the faults asked for. */
class UpdateServer {
  offer: Offer
  /** What the next downloads of cli.js meet, one fault each. */
  faults: Fault[] = []
  /** Every download of a cli.js asked for, by version, in order. */
  readonly downloads: string[] = []
  private held: Array<() => void> = []
  /** Answers left open halfway, ended only when the server stops. */
  private stalled: ServerResponse[] = []
  private server: Server | null = null

  constructor(private readonly releases: Releases, first: string) { this.offer = { version: first } }

  get origin(): string { return `http://127.0.0.1:${(this.server!.address() as { port: number }).port}` }
  get holding(): number { return this.held.length }
  downloadsOf(version: string): number { return this.downloads.filter((one) => one === version).length }

  async start(): Promise<void> {
    this.server = createServer((request, response) => this.answer(request.url ?? '', response))
    await new Promise<void>((done) => this.server!.listen(0, '127.0.0.1', done))
  }

  stop(): Promise<void> {
    this.release()
    for (const response of this.stalled) response.socket?.destroy()
    return new Promise((done) => this.server ? this.server.close(() => done()) : done())
  }

  /** Every held download goes through. */
  release(): void {
    const held = this.held
    this.held = []
    for (const go of held) go()
  }

  private bytesOf(version: string): Buffer {
    return this.offer.version === version && this.offer.bytes ? this.offer.bytes : this.releases.cli.get(version)!
  }

  private answer(url: string, response: ServerResponse): void {
    if (url === '/metadata.json') {
      const { version } = this.offer
      const cli = this.bytesOf(version)
      const notify = this.releases.notify.get(version)!
      response.end(JSON.stringify({ cli: {
        version,
        cli: { url: `${this.origin}/cli-${version}.js`, sha256: this.offer.manifestSha ?? sha(cli), size: cli.length },
        notify: { url: `${this.origin}/notify-${version}.mjs`, sha256: sha(notify), size: notify.length },
      } }))
      return
    }
    const cliVersion = /^\/cli-(.+)\.js$/.exec(url)?.[1]
    if (cliVersion && this.releases.cli.has(cliVersion)) {
      this.downloads.push(cliVersion)
      const bytes = this.bytesOf(cliVersion)
      const half = bytes.subarray(0, bytes.length >> 1)
      const fault = this.faults.shift()
      if (fault === 'truncate') {
        response.setHeader('content-length', half.length)
        response.end(half)
      } else if (fault === 'drop') {
        response.setHeader('content-length', bytes.length)
        response.write(half, () => setTimeout(() => response.socket?.destroy(), 20))
      } else if (fault === 'stall') {
        response.setHeader('content-length', bytes.length)
        response.write(half)
        this.stalled.push(response)
      } else if (fault === 'hold') {
        this.held.push(() => response.end(bytes))
      } else {
        response.end(bytes)
      }
      return
    }
    const notifyVersion = /^\/notify-(.+)\.mjs$/.exec(url)?.[1]
    if (notifyVersion && this.releases.notify.has(notifyVersion)) { response.end(this.releases.notify.get(notifyVersion)); return }
    response.statusCode = 404
    response.end()
  }
}

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const started = client.next(isTurn('turn_started', agentId), 60_000, `turn_started (${content})`)
  const ended = client.next(isTurn('turn_ended', agentId), 60_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  expect((await started).payload?.userMessage).toBe(content)
  await ended
}

/** A machine with a release installed, a daemon running it under harnessd, and two agents at work. */
class Installed {
  daemon!: IsolatedDaemon
  agents: Row[] = []

  constructor(readonly releases: Releases, readonly server: UpdateServer, readonly cliDir: string) {}

  async boot(first: string, dataDir?: string, env: Record<string, string> = {}): Promise<void> {
    mkdirSync(this.cliDir, { recursive: true })
    writeFileSync(join(this.cliDir, 'cli.js'), this.releases.cli.get(first)!)
    writeFileSync(join(this.cliDir, 'notify.mjs'), this.releases.notify.get(first)!)
    writeFileSync(join(this.cliDir, 'package.json'), '{"type":"module"}\n')
    const local = this.server.origin
    this.daemon = await IsolatedDaemon.create({
      scriptPath: join(this.cliDir, 'cli.js'),
      ...(dataDir ? { dataDir } : {}),
      env: {
        ADAPTER_CLI_DIR: this.cliDir,
        ADAPTER_UPDATE_DISABLE: 'false',
        ADAPTER_UPDATE_URL: `${local}/metadata.json`,
        ADAPTER_UPDATE_CHECK_MS: '1000',
        ADAPTER_UPDATE_SLOT_SEC: '-1',
        HARNESSD_UPDATE_PROBATION_MS: '6000',
        HARNESSD_INITIAL_BACKOFF_MS: '100',
        // Every other download an installed daemon looks for stays on this machine too.
        HARNESS_TUI_MANIFEST_URL: `${local}/tui/metadata.json`,
        ADAPTER_RUNTIME_METADATA_URL: `${local}/runtime/metadata.json`,
        ADAPTER_GRID_RUNTIME_METADATA_URL: `${local}/grid/metadata.json`,
        ...env,
      },
    })
    await this.daemon.start()
    expect(await this.status()).toMatchObject({ version: first, harnessd: { masterVersion: first } })
    const client = await LocalClient.connect(this.daemon)
    try {
      for (const engine of ['claude', 'codex'] as const) {
        const cwd = join(this.daemon.projectsDir, `hostile-${engine}`)
        mkdirSync(cwd, { recursive: true })
        const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
        expect(created.error, JSON.stringify(created)).toBeUndefined()
        this.agents.push(await until(`${engine} to bind its conversation`, async () => {
          const row = (await rows(client)).find((one) => one.id === created.agent.id)
          return row?.sessionId && row.status === 'active' ? row : null
        }, 90_000, 500))
      }
    } finally { client.close() }
  }

  log(): string { return this.daemon.log() }
  showLogOnFailure(): void {
    onTestFailed(() => {
      console.log(`---- daemon log\n${this.daemon?.log().split('\n').slice(-200).join('\n')}`)
      // The runner keeps only so much: UPDATE_HOSTILE_LOG=<file> keeps the daemon's whole log for reading.
      if (process.env.UPDATE_HOSTILE_LOG) writeFileSync(process.env.UPDATE_HOSTILE_LOG, this.daemon?.log() ?? '')
    })
  }

  async status(): Promise<Row | null> {
    return fetch(`http://127.0.0.1:${this.daemon.port}/api/status`).then((response) => response.json() as Promise<Row>).catch(() => null)
  }

  async version(): Promise<string | null> { return (await this.status())?.version ?? null }

  /** The core runs `version`, ready, under a master that runs one of `masters`. */
  on(version: string, masters: string[] = [version], ms = 150_000): Promise<Row> {
    return until(`the core on ${version}, ready, under a master on ${masters.join(' or ')}`, async () => {
      const now = await this.status()
      return now?.version === version && now?.harnessd?.state === 'running' && masters.includes(now?.harnessd?.masterVersion) ? now : null
    }, ms, 250)
  }

  /** Nothing is waiting to be kept or rolled back. */
  judged(ms = 90_000): Promise<true> {
    return until('the update to be kept or rolled back', () => !['update-pending.json', 'cli.js.prev', 'notify.mjs.prev'].some((name) => existsSync(join(this.cliDir, name))), ms, 250)
  }

  /** The install holds `version`'s own files, both of them. */
  holds(version: string): void {
    expect(sha(readFileSync(join(this.cliDir, 'cli.js'))), `cli.js is ${version}'s`).toBe(sha(this.releases.cli.get(version)!))
    expect(sha(readFileSync(join(this.cliDir, 'notify.mjs'))), `notify.mjs is ${version}'s`).toBe(sha(this.releases.notify.get(version)!))
  }

  rejected(): string[] {
    try { return JSON.parse(readFileSync(join(this.cliDir, 'update-rejected.json'), 'utf8')) as string[] } catch { return [] }
  }

  /** Whatever an update left in the install or the data folder that the next one could trip on. */
  leftovers(): string[] {
    const kept = new Set(['cli.js', 'notify.mjs', 'package.json', 'update-rejected.json'])
    const install = readdirSync(this.cliDir).filter((name) => !kept.has(name)).map((name) => `install: ${name}`)
    const data = readdirSync(this.daemon.dataDir).filter((name) => name.startsWith('harnessd-reexec.json') || name === 'adapter.spawn.lock')
      .map((name) => `data: ${name}`)
    return [...install, ...data]
  }

  /** Both agents are back on their own conversations, and each takes a turn. */
  async agentsBack(label: string): Promise<void> {
    const client = await LocalClient.connect(this.daemon)
    try {
      for (const agent of this.agents) {
        await until(`the ${agent.engine} agent back on its conversation`, async () => {
          const row = (await rows(client)).find((one) => one.id === agent.id)
          return row?.status === 'active' && row.sessionId === agent.sessionId ? row : null
        }, 90_000, 500)
        await turn(client, agent.id, `${label} (${agent.engine})`)
      }
    } finally { client.close() }
  }

  /** Every process running a build of this install, from the process table. */
  daemonProcesses(): Array<{ pid: number; ppid: number; command: string }> {
    return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => !!match && match[3].includes(join(this.cliDir, 'cli.js')))
      .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }))
  }

  /** One core, the master's child, and nothing else running this install: no orphan, no probe left. */
  async nothingOrphaned(): Promise<void> {
    const master = this.daemon.pid!
    await until('only the master\'s own core', () => this.daemonProcesses().every((one) => one.ppid === master && one.command.endsWith(' __run')), 15_000, 200)
    expect(this.daemonProcesses().filter((one) => one.command.endsWith(' __run'))).toHaveLength(1)
  }

  /** What every scenario ends in: one build installed and running under its master, every agent back,
   *  nothing in between left behind, and exactly these builds remembered as rolled back. */
  async settled(version: string, expected: { masters?: string[]; rejected: string[] }): Promise<void> {
    await this.on(version, expected.masters)
    await this.judged()
    this.holds(version)
    expect(this.leftovers()).toEqual([])
    expect(this.rejected()).toEqual(expected.rejected)
    await this.agentsBack(`settled on ${version}`)
    await this.nothingOrphaned()
  }
}

describe('an update under hostile conditions', () => {
  const releases = new Releases()
  let server: UpdateServer
  let scratch = ''
  let machine: Installed

  beforeAll(async () => {
    for (let patch = 1; patch <= 15; patch++) {
      releases.add(`43.0.${patch}`, patch === 10 || patch === 11 ? CRASHES_AS_A_CORE : patch === 14 ? TEARDOWN_THROWS : '')
    }
    scratch = mkdtempSync(join(tmpdir(), 'harnessd-hostile-'))
    server = new UpdateServer(releases, FIRST)
    await server.start()
    machine = new Installed(releases, server, join(scratch, 'cli'))
    // A link that sends nothing for two seconds is given up on (lib/selfUpdate.ts TransferLimits).
    await machine.boot(FIRST, undefined, { ADAPTER_UPDATE_IDLE_MS: '2000' })
  }, 300_000)

  afterAll(async () => {
    await machine?.daemon?.close()
    await server?.stop()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('a link that drops mid-download: nothing is written, and the build lands once the link holds', async () => {
    machine.showLogOnFailure()
    const from = machine.log().length
    server.faults = ['drop', 'drop', 'drop']
    server.offer = { version: '43.0.2' }
    await until('three downloads dropped halfway', () => server.downloadsOf('43.0.2') >= 3, 90_000)
    expect(await machine.version()).toBe(FIRST)
    machine.holds(FIRST)
    await machine.settled('43.0.2', { rejected: [] })
    expect(machine.log().slice(from)).toContain('[update] check failed (will retry)')
  }, 300_000)

  it('a download cut short is refused, and the whole build lands', async () => {
    machine.showLogOnFailure()
    const from = machine.log().length
    server.faults = ['truncate', 'truncate']
    server.offer = { version: '43.0.3' }
    await until('two downloads cut short', () => server.downloadsOf('43.0.3') >= 2, 90_000)
    expect(await machine.version()).toBe('43.0.2')
    await machine.settled('43.0.3', { rejected: [] })
    expect(machine.log().slice(from)).toContain('sha256 mismatch')
  }, 300_000)

  /** A build that cannot be installed must cost one download now and then, not one at every check. */
  const refusedQuietly = async (version: string): Promise<void> => {
    const cores = machine.daemon.coresStarted()
    await until(`a download of ${version}`, () => server.downloadsOf(version) >= 1, 90_000)
    await sleep(12_000)
    expect(machine.daemon.coresStarted(), 'no restart for a build that cannot be installed').toBe(cores)
    expect(await machine.version()).toBe('43.0.3')
    machine.holds('43.0.3')
    expect(machine.leftovers()).toEqual([])
    expect(server.downloadsOf(version), 'a check a second, and only a handful of downloads').toBeLessThanOrEqual(5)
  }

  it('a release published broken (its manifest names the cut-short bytes) fails its canary, is never staged, and is not downloaded at every check', async () => {
    machine.showLogOnFailure()
    const whole = releases.cli.get('43.0.4')!
    server.offer = { version: '43.0.4', bytes: whole.subarray(0, whole.length >> 1) }
    await refusedQuietly('43.0.4')
  }, 300_000)

  it('a manifest whose hash lies is refused, without a download at every check', async () => {
    machine.showLogOnFailure()
    server.offer = { version: '43.0.5', manifestSha: sha(Buffer.from('not what is served')) }
    await refusedQuietly('43.0.5')
  }, 300_000)

  it('a manifest whose version lies (it names the bytes of the build running) does not restart the daemon over and over', async () => {
    machine.showLogOnFailure()
    server.offer = { version: '43.0.6', bytes: releases.cli.get('43.0.3') }
    await refusedQuietly('43.0.6')
  }, 300_000)

  it('a newer build published while the last is on probation: two checks race the master, and the newest is kept, nothing rejected', async () => {
    machine.showLogOnFailure()
    const from = machine.log().length
    server.offer = { version: '43.0.7' }
    await until('the core on 43.0.7', async () => (await machine.version()) === '43.0.7', 150_000, 100)
    // Its probation has six seconds to run, and its updater checks every second.
    expect(existsSync(join(machine.cliDir, 'update-pending.json'))).toBe(true)
    server.offer = { version: '43.0.8' }
    await machine.settled('43.0.8', { rejected: [] })
    expect(machine.log().slice(from)).toContain('[harnessd] the updated core staged a newer build before it was kept')
    expect(machine.log().slice(from)).not.toContain('the updated core failed')
  }, 300_000)

  it('an update while both agents are mid-turn: their turns finish, both are back, and the next turns work', async () => {
    machine.showLogOnFailure()
    const client = await LocalClient.connect(machine.daemon)
    for (const agent of machine.agents) {
      const started = client.next(isTurn('turn_started', agent.id), 60_000, `the long turn of ${agent.engine}`)
      client.send('message', { agentId: agent.id, content: '!slow 15000' })
      await started
    }
    server.offer = { version: '43.0.9' }
    await machine.on('43.0.9')
    client.close()
    // The turns were running in their panes through the swap; the core on the new build reads how they end.
    const after = await LocalClient.connect(machine.daemon)
    try {
      for (const agent of machine.agents) {
        const ended = after.frames.find(isTurn('turn_ended', agent.id)) ?? await after.waitFor(isTurn('turn_ended', agent.id), 120_000, `the long turn of ${agent.engine} to end`)
        expect(ended).toBeTruthy()
      }
      const now = await rows(after)
      for (const agent of machine.agents) expect(now.find((one) => one.id === agent.id)?.activity?.state, `${agent.engine} is not left working`).not.toBe('working')
    } finally { after.close() }
    await machine.settled('43.0.9', { rejected: [] })
  }, 300_000)

  it('a build whose master answers its probe but whose core crashes at start is rolled back and remembered, and the master goes back with it', async () => {
    machine.showLogOnFailure()
    const from = machine.log().length
    server.offer = { version: '43.0.10' }
    await until('the rollback', () => machine.log().slice(from).includes('the updated core failed (code 3) — rolled back'), 150_000)
    expect(machine.log().slice(from)).toContain(`master re-executed (pid ${machine.daemon.pid}) · now v43.0.10`)
    await machine.settled('43.0.9', { rejected: ['43.0.10'] })
    const cores = machine.daemon.coresStarted()
    await sleep(5_000)
    expect(machine.daemon.coresStarted()).toBe(cores)
    expect(server.downloadsOf('43.0.10')).toBe(1)
  }, 300_000)

  it('the master killed mid-update, as a power cut would: the next start judges the build it finds staged, and rolls back one whose core crashes', async () => {
    machine.showLogOnFailure()
    const from = machine.log().length
    server.offer = { version: '43.0.11' }
    await until('the core to stage 43.0.11', () => machine.log().slice(from).includes('[update] staged 43.0.11'), 90_000)
    const core = machine.daemon.corePid()
    await machine.daemon.kill()
    await until('the core it was running to be gone', () => !IsolatedDaemon.alive(core), 30_000, 100)
    machine.holds('43.0.11')
    // What launchd restarting the master, or the desktop app's `harness start`, does.
    const restart = machine.log().length
    await machine.daemon.start()
    await machine.settled('43.0.9', { rejected: ['43.0.10', '43.0.11'] })
    expect(machine.log().slice(restart)).toContain('[harnessd] the bundle on disk is 43.0.11, an update no master kept or rolled back — its first core is on probation')
    expect(machine.log().slice(restart)).toContain('the updated core failed (code 3) — rolled back')
  }, 300_000)

  it('moves on when a newer build is published', async () => {
    machine.showLogOnFailure()
    server.offer = { version: '43.0.12' }
    await machine.settled('43.0.12', { rejected: ['43.0.10', '43.0.11'] })
  }, 300_000)

  it('a link that stalls halfway without dropping is given up on, and the build lands at the next check', async () => {
    machine.showLogOnFailure()
    const from = machine.log().length
    server.faults = ['stall']
    server.offer = { version: '43.0.13' }
    // Before, the check waited out undici's five-minute body timeout, every later check skipped meanwhile.
    await until('the stalled download to be given up', () => machine.log().slice(from).includes('cli-43.0.13.js sent nothing for 2000 ms'), 60_000)
    await machine.settled('43.0.13', { rejected: ['43.0.10', '43.0.11'] })
    expect(server.downloadsOf('43.0.13')).toBe(2)
  }, 300_000)

  it('a core whose teardown throws as it hands over still hands over, and the new build is kept', async () => {
    machine.showLogOnFailure()
    server.offer = { version: '43.0.14' }
    await machine.settled('43.0.14', { rejected: ['43.0.10', '43.0.11'] })
    // 43.0.14's own handoff is the one that throws. Before, the core stayed on it, half torn down, with
    // 43.0.15 staged and never judged.
    const from = machine.log().length
    server.offer = { version: '43.0.15' }
    await machine.settled('43.0.15', { rejected: ['43.0.10', '43.0.11'] })
    expect(machine.log().slice(from)).toMatch(/\[update\] [^\n]* did not let go \(a teardown step that throws\) — handing over all the same/)
    expect(machine.log().slice(from)).not.toContain('restart failed — staying on current build')
  }, 300_000)
})

describe.skipIf(!DISKFULL)('an update on a disk that fills', () => {
  const releases = new Releases()
  let server: UpdateServer
  let scratch = ''
  let volume = ''
  let machine: Installed
  const filler = () => join(volume, 'filler')
  const lock = () => join(machine.daemon.dataDir, 'adapter.spawn.lock')

  /** Writes until the volume refuses. */
  const fill = (): void => {
    const fd = openSync(filler(), 'a')
    const chunk = Buffer.alloc(1024 * 1024, 7)
    try { for (;;) writeSync(fd, chunk) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOSPC') throw error } finally { closeSync(fd) }
    // The last blocks a metadata write may still find: take those too.
    const tail = openSync(join(volume, 'filler-tail'), 'a')
    try { for (;;) writeSync(tail, Buffer.alloc(4096, 7)) } catch { /* full */ } finally { closeSync(tail) }
  }
  /** Gives back this much room. */
  const room = (bytes: number): void => {
    rmSync(join(volume, 'filler-tail'), { force: true })
    truncateSync(filler(), Math.max(0, statSync(filler()).size - bytes))
  }
  const unfill = (): void => {
    rmSync(filler(), { force: true })
    rmSync(join(volume, 'filler-tail'), { force: true })
  }
  /** Holds the daemon spawn lock as a `harness start` would: the updater waits for it with its build verified. */
  const holdLock = (): void => {
    mkdirSync(lock(), { mode: 0o700 })
    writeFileSync(join(lock(), 'owner.json'), JSON.stringify({ pid: process.pid, startMarker: '', token: 'e2e-update-hostile', purpose: 'start', since: Date.now() }), { mode: 0o600 })
  }
  const releaseLock = (): void => { rmSync(lock(), { recursive: true, force: true }) }

  beforeAll(async () => {
    for (let patch = 1; patch <= 5; patch++) releases.add(`44.0.${patch}`, patch === 5 ? CRASHES_AS_A_CORE : '')
    // Short names: the daemon's socket lives in the data folder, and a Unix socket's path has a
    // 104-byte limit on macOS that a long temporary folder alone nearly uses up.
    scratch = mkdtempSync(join(tmpdir(), 'hu-'))
    volume = join(scratch, 'v')
    mkdirSync(volume)
    const image = join(scratch, 'u.dmg')
    execFileSync('hdiutil', ['create', '-size', '96m', '-fs', 'HFS+', '-volname', 'hutest', '-type', 'UDIF', image], { stdio: 'pipe' })
    execFileSync('hdiutil', ['attach', image, '-mountpoint', volume, '-nobrowse', '-noverify', '-noautoopen'], { stdio: 'pipe' })
    server = new UpdateServer(releases, '44.0.1')
    await server.start()
    machine = new Installed(releases, server, join(volume, 'c'))
    const data = join(volume, 'd')
    mkdirSync(data)
    await machine.boot('44.0.1', data)
  }, 300_000)

  // A scenario that fails part way must not leave the next one a full disk or a held lock.
  afterEach(() => {
    try { unfill() } catch { /* not mounted */ }
    if (machine?.daemon) { try { if (readFileSync(join(lock(), 'owner.json'), 'utf8').includes('e2e-update-hostile')) releaseLock() } catch { /* not held */ } }
  })

  afterAll(async () => {
    try { unfill() } catch { /* not mounted */ }
    if (process.env.UPDATE_HOSTILE_LOG && machine?.daemon) writeFileSync(process.env.UPDATE_HOSTILE_LOG, machine.daemon.log())
    await machine?.daemon?.close()
    await server?.stop()
    if (volume) { try { execFileSync('hdiutil', ['detach', volume, '-force'], { stdio: 'pipe' }) } catch { /* already gone */ } }
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('the disk fills while the build downloads: the canary cannot be written, nothing is left, the agents keep working, and the build lands once there is room', async () => {
    machine.showLogOnFailure()
    const from = machine.log().length
    server.faults = ['hold']
    server.offer = { version: '44.0.2' }
    await until('the download to be under way', () => server.holding === 1, 90_000)
    fill()
    server.release()
    await until('the canary to fail on the full disk', () => /\[update\][^\n]*canary/.test(machine.log().slice(from)), 60_000)
    await sleep(3_000)
    expect(await machine.version()).toBe('44.0.1')
    machine.holds('44.0.1')
    expect(machine.leftovers()).toEqual([])
    await machine.agentsBack('while the disk is full')
    unfill()
    await machine.settled('44.0.2', { rejected: [] })
  }, 400_000)

  it('the disk fills between the canary and the swap: the install is left as it was, the spawn lock is not left behind, and the build lands once there is room', async () => {
    machine.showLogOnFailure()
    const from = machine.log().length
    holdLock()
    server.offer = { version: '44.0.3' }
    await until('the updater to wait for the lock with the build verified', () => machine.log().slice(from).includes('[update] waiting — the daemon is'), 90_000)
    fill()
    releaseLock()
    await until('a swap to fail on the full disk', () => count(machine.log().slice(from), '[update] check failed') >= 1, 60_000)
    // Room for the lock and part of one copy of the bundle, not all of it.
    room(3 * 1024 * 1024)
    const second = machine.log().length
    await until('another swap to fail', () => count(machine.log().slice(second), '[update] check failed') >= 1, 60_000)
    await until('the updater to let go of the lock', () => !existsSync(lock()), 30_000, 50)
    // Held again, so nothing is mid-write while the install is looked at.
    holdLock()
    try {
      machine.holds('44.0.2')
      expect(machine.leftovers().filter((one) => one !== 'data: adapter.spawn.lock')).toEqual([])
    } finally { releaseLock() }
    unfill()
    await machine.settled('44.0.3', { rejected: [] })
  }, 400_000)

  it('the disk fills just after the swap: the new build cannot start for want of room, which is no verdict on it, and it is kept once there is room', async () => {
    machine.showLogOnFailure()
    const from = machine.log().length
    const master = machine.daemon.pid
    server.offer = { version: '44.0.4' }
    await until('the core to stage 44.0.4', () => machine.log().slice(from).includes('[update] staged 44.0.4'), 90_000, 50)
    fill()
    // A core cannot claim its socket on a full disk (listen ENOSPC), so the core on the new bundle starts in
    // safe mode. The build before would too: the master keeps the update on trial and tries again,
    // backing off. Before, it rolled back (the rollback freeing the room the build before needed) and
    // remembered a good build as bad.
    await until('the master to try the new bundle again for want of room', () => count(machine.log().slice(from), 'had no room to start') >= 2, 150_000, 100)
    expect(machine.log().slice(from)).toContain('could not start on the new bundle for want of room on the disk (listen ENOSPC')
    expect(machine.log().slice(from)).not.toContain('the updated core failed')
    expect(IsolatedDaemon.alive(master), 'the master outlives a full disk in the middle of an update').toBe(true)
    machine.holds('44.0.4')
    unfill()
    await machine.settled('44.0.4', { masters: ['44.0.3', '44.0.4'], rejected: [] })
    expect(machine.log().slice(from)).toContain('the update stayed up — keeping it')
    expect(machine.daemon.pid).toBe(master)
  }, 400_000)

  it('a build that crashes on a full disk is rolled back and remembered, and never staged again', async () => {
    machine.showLogOnFailure()
    const from = machine.log().length
    const before = (await machine.version())!
    const rejectedBefore = machine.rejected()
    server.offer = { version: '44.0.5' }
    await until('the core to stage 44.0.5', () => machine.log().slice(from).includes('[update] staged 44.0.5'), 90_000, 50)
    fill()
    await until('the rollback', () => machine.log().slice(from).includes('the updated core failed (code 3) — rolled back'), 150_000)
    await until(`the core back on ${before}`, async () => (await machine.version()) === before, 150_000, 250)
    unfill()
    await machine.settled(before, { masters: ['44.0.3', '44.0.4'], rejected: [...rejectedBefore, '44.0.5'] })
    await sleep(5_000)
    expect(server.downloadsOf('44.0.5')).toBe(1)
  }, 400_000)
})
