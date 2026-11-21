/**
 * The move of ~/.harness to the XDG folders on Linux, end to end (docs/plans/2026-11-18-linux-xdg-paths-design.md,
 * Verification): the real daemon from the bundle, a throwaway home, a private tmux server, the fake engines and the fake
 * backend (e2e/harness/). The bundle and a copy of the run's Node are laid in `~/.harness/cli` and
 * `~/.harness/runtime/node-e2e/bin`, where an install lays them, so a daemon starts from inside the old tree and must
 * start itself again from the new one.
 *
 * No override but the first daemon's. The harness gives every daemon its folders by override (e2e/harness/daemon.ts),
 * and an override inside ~/.harness holds the move, so they are taken away: the first daemon keeps only
 * `ADAPTER_DATA_DIR=~/.harness/cli/data`, the folder (and so the pane tag) a default install has, and every later start
 * finds its folders where a person's does. The harness's IsolatedDaemon starts only daemons with a data folder of its
 * own; those starts are this file's (`Start`), as a terminal, systemd or Harness OS starts one.
 *
 * Linux only: the move runs nowhere else, so on any other computer the file is skipped whole.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { HARNESS_ENTRIES, xdgRoots } from '../src/config/harnessHome.js'
import { systemdUnit, SYSTEMD_UNIT } from '../src/harnessd/platform.js'
import { BRIDGE_FILE, REAL_ENTRIES } from '../src/homeMove/bridge.js'
import { Store } from '../src/lib/connectors/store.js'
import { savedDaemonPort } from '../src/lib/daemonRecord.js'
import { LocalClient } from './harness/client.js'
import { assertHooksContained, CLI_ROOT, hooksOutside, IsolatedDaemon, listeningPort, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage } from './harness/fakeDial.js'
import { assertLocalOnly, remoteSettings } from './harness/fleet.js'
import { Outside } from './harness/outsideAgent.js'
import { forgetGroup, leaderGone, watchGroup } from './harness/reaper.js'

const run = promisify(execFile)
/** A released bundle (its notify.mjs beside it), as e2e/migration.e2e.ts takes one: the first daemon is that release's. */
const FROM = process.env.MIGRATION_FROM
/**
 * The harness's settings whose default is under the home (and the id the computer-id file holds): a person's start sets
 * none of them, and one inside ~/.harness holds the move.
 */
const OVERRIDES = ['ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'ADAPTER_COMPUTER_ID', 'ADAPTER_COMPUTER_ID_FILE', 'HARNESS_AUTH_DIR', 'DSH_DIR',
  'HARNESS_HOOK_ROUTES_DIR']
const MACHINE: FakeMachine = { machineId: 'e2e-move-machine', computerId: 'e2e-move-computer-0000-000000000001', name: 'mover', token: 'e2e-move-token' }
/** sockaddr_un's room, as lib/localSocket.ts counts it. */
const SOCKET_ROOM = 96

type Row = Record<string, any>

/** A throwaway home and the folders the move takes it between. */
interface Home {
  d: IsolatedDaemon
  home: string
  legacy: string
  data: string
  state: string
  /** The installed Node and cli.js, and the data folder: in ~/.harness, and where the move puts them. */
  old: { node: string; cli: string; dataDir: string }
  moved: { node: string; cli: string; dataDir: string }
  backend: FakeBackend | null
}

/** What each test leaves running, ended in reverse after it, whatever happened. */
const ends: Array<() => unknown> = []

/** The daemon's socket file name: one per configured port (lib/localSocket.ts). */
const socketName = (h: Home): string => `daemon-${h.d.configuredPort}.sock`
const read = (path: string): string => readFileSync(path, 'utf8')
const rootOf = (h: Home, name: string): string => ((HARNESS_ENTRIES as Record<string, string>)[name] === 'state' ? h.state : h.data)
/** The move's record, in the state root once moved and in ~/.harness before (homeMove/record.ts). */
const record = (folder: string): Row | null => { try { return JSON.parse(read(join(folder, 'home-move.json'))) as Row } catch { return null } }

/**
 * A daemon started as a person's start starts it: `__harnessd` as systemd does, or `start -f` as Harness OS does, in a
 * process group of its own that the worker's reaper ends should the worker go first.
 */
class Start {
  private said = ''
  private readonly exited: Promise<never>
  private constructor(readonly child: ChildProcess) {
    child.stdout!.on('data', (chunk: Buffer) => { this.said += chunk.toString('utf8') })
    child.stderr!.on('data', (chunk: Buffer) => { this.said += chunk.toString('utf8') })
    this.exited = new Promise<never>((_, reject) => child.once('exit', (code, signal) => reject(new Error(`the daemon exited (${signal ?? code}):\n${this.said.slice(-4000)}`))))
    this.exited.catch(() => {})
  }

  static begin(h: Home, node: string, args: string[], env: NodeJS.ProcessEnv): Start {
    // As the harness checks every start of its own: no hook goes outside the throwaway root.
    assertHooksContained(h.d.root, { ...env, ADAPTER_DATA_DIR: existsSync(h.moved.dataDir) ? h.moved.dataDir : h.old.dataDir })
    const start = new Start(spawn(node, args, { cwd: h.d.root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }))
    const pid = start.child.pid!
    watchGroup(pid)
    start.child.once('exit', () => leaderGone(pid))
    ends.push(async () => {
      await start.stop()
      IsolatedDaemon.killGroup(start.child)
      forgetGroup(pid)
      const outside = hooksOutside(start.said, h.d.root)
      if (outside.length) throw new Error(`a daemon of this file wrote hooks outside ${h.d.root}, to the files its log names by these hashes: ${outside.join(', ')}`)
    })
    onTestFailed(() => { console.log(`---- the daemon ${pid} ${args.join(' ')}\n${start.said.split('\n').slice(-150).join('\n')}`) })
    return start
  }

  /** Once it answers on its port and has said it is ready. */
  async ready(): Promise<this> {
    await Promise.race([this.exited, (async () => {
      await until('the daemon to answer on its port', async () => {
        const port = listeningPort(this.said)
        if (port === null) return null
        return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5_000) })).ok
      }, 90_000, 200)
      await until('the daemon to finish starting', () => /\[cli\] ready/.test(this.said), 60_000, 100)
    })()])
    return this
  }

  get pid(): number { return this.child.pid! }
  log(): string { return this.said }

  /** SIGTERM, then SIGKILL to its group after 15 s. Its panes are tmux's, outside the group, and stay. */
  async stop(): Promise<void> {
    const child = this.child
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => IsolatedDaemon.killGroup(child), 15_000)
    await exited
    clearTimeout(timer)
  }
}

/** The harness's environment for this home's daemons, with no override: what a person's shell gives a start. */
const plain = (h: Home, more: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...h.d.env, ...more }
  delete env.ADAPTER_DATA_DIR
  if (h.backend) assertLocalOnly(env, h.backend)
  return env
}

/**
 * A throwaway home. With `legacy`, the old tree an install of a release before this one leaves: the CLI (this build's,
 * or [cli]'s) in ~/.harness/cli, a copy of the run's Node in ~/.harness/runtime with current-node naming it, and the
 * computer's id; signed in, its session in ~/.harness/auth.
 */
async function machine(options: { legacy?: boolean; signedIn?: boolean; cli?: string } = {}): Promise<Home> {
  const backend = options.signedIn ? await FakeBackend.start() : null
  if (backend) {
    backend.addMachine(MACHINE)
    ends.push(() => backend.close())
  }
  const d = await IsolatedDaemon.create({ env: backend ? remoteSettings(backend) : {} })
  ends.push(() => d.close())
  onTestFailed(() => { console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-60).join('\n')}`) })
  for (const name of OVERRIDES) delete d.env[name]
  const home = d.env.HOME!
  const legacy = join(home, '.harness')
  const { data, state } = xdgRoots(home, d.env)
  const h: Home = {
    d, home, legacy, data, state, backend,
    old: { node: join(legacy, 'runtime', 'node-e2e', 'bin', 'node'), cli: join(legacy, 'cli', 'cli.js'), dataDir: join(legacy, 'cli', 'data') },
    moved: { node: join(state, 'runtime', 'node-e2e', 'bin', 'node'), cli: join(data, 'cli', 'cli.js'), dataDir: join(data, 'cli', 'data') },
  }
  if (!options.legacy) return h
  // A copy, not a link: Node names itself by its real path, and the daemon must find its own in the old tree.
  mkdirSync(dirname(h.old.node), { recursive: true })
  copyFileSync(process.env.E2E_NODE_PATH!, h.old.node)
  chmodSync(h.old.node, 0o755)
  writeFileSync(join(legacy, 'runtime', 'current-node'), `${h.old.node}\n`, { mode: 0o600 })
  layBuild(dirname(h.old.cli), options.cli ?? bundle)
  writeFileSync(join(legacy, 'computer-id'), `${MACHINE.computerId}\n`, { mode: 0o600 })
  if (backend) {
    mkdirSync(join(legacy, 'auth'), { recursive: true, mode: 0o700 })
    // As `harness login` leaves a computer (e2e/harness/fleet.ts signIn), where the old tree keeps it.
    writeFileSync(join(legacy, 'auth', 'session.json'), JSON.stringify({
      version: 1, accessToken: MACHINE.token, autonomousEnv: 'prod', computerId: MACHINE.computerId,
      machineId: MACHINE.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 })
  }
  return h
}

/** [cli] and the notify.mjs beside it in [dir], as an install lays a build (and as `install.sh` writes, a package.json). */
function layBuild(dir: string, cli: string): void {
  mkdirSync(dir, { recursive: true })
  copyFileSync(cli, join(dir, 'cli.js'))
  copyFileSync(join(dirname(cli), 'notify.mjs'), join(dir, 'notify.mjs'))
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
}

/** The first daemon: whole on ~/.harness, held there by the override a default install's data folder has. */
async function first(h: Home, options: { ready?: 'port' } = {}): Promise<void> {
  h.d.env.ADAPTER_DATA_DIR = h.old.dataDir
  h.d.options.node = h.old.node
  h.d.options.scriptPath = h.old.cli
  await h.d.start(options)
}

/** The first daemon gone, its panes left to tmux, and the override with it. */
async function stopFirst(h: Home): Promise<void> {
  await h.d.stop()
  delete h.d.env.ADAPTER_DATA_DIR
}

/** A start with no override, from the old tree: the one that moves. */
const moving = (h: Home, more: Record<string, string> = {}): Promise<Start> =>
  Start.begin(h, h.old.node, [h.old.cli, '__harnessd'], plain(h, more)).ready()
/** A later start, from where the move put the build. */
const again = (h: Home, more: Record<string, string> = {}): Promise<Start> =>
  Start.begin(h, h.moved.node, [h.moved.cli, '__harnessd'], plain(h, more)).ready()

/**
 * A client of a daemon this file started, as the desktop app reaches it: its socket, and the machine it serves (signed
 * out, its computer's id, in the data root the rule reads).
 */
function client(h: Home, socket = join(h.moved.dataDir, socketName(h))): Promise<LocalClient> {
  const computerId = read(join(existsSync(h.data) ? h.data : h.legacy, 'computer-id')).trim()
  const daemon: Pick<IsolatedDaemon, 'socketPath' | 'computerId'> = { socketPath: socket, computerId }
  return LocalClient.connect(daemon as IsolatedDaemon, h.backend ? { machineId: MACHINE.machineId } : {})
}

/** A client of the first daemon: its computer is the one the old tree's computer-id names. */
const firstClient = (h: Home): Promise<LocalClient> => LocalClient.connect(h.d, { machineId: h.backend ? MACHINE.machineId : MACHINE.computerId })

const rows = async (c: LocalClient): Promise<Row[]> => (await c.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents

/** An agent in a pane, created as the desktop creates one, once it has bound its conversation. */
async function create(h: Home, c: LocalClient, engine: 'claude' | 'codex', folder: string): Promise<Row> {
  const cwd = join(h.d.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  // Asked until a released build has wired its handlers too (it answers before it has).
  const created = await until(`${folder} to be created`, async () => {
    const answer = await c.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
    return answer.error ? null : answer
  }, 60_000, 1_000)
  return until(`${folder} to bind its conversation`, async () => {
    const agent = (await rows(c)).find((one) => one.id === created.agent.id)
    return agent?.sessionId && agent.status === 'active' && agent.tmuxPane ? agent : null
  }, 60_000, 500)
}

/** An agent at work: created, and through a first turn, so its conversation is on disk. */
async function working(h: Home, c: LocalClient, engine: 'claude' | 'codex', folder: string): Promise<Row> {
  const agent = await create(h, c, engine, folder)
  await c.turn(agent.id, `at work before the move (${engine})`)
  return agent
}

/** Each agent back on its conversation: its pane adopted under its old id. */
async function adopted(c: LocalClient, agents: Row[]): Promise<void> {
  for (const agent of agents) {
    await until(`${agent.engine} ${agent.id.slice(0, 8)} to be adopted`, async () => {
      const now = (await rows(c)).find((one) => one.id === agent.id)
      return now?.status === 'active' && now.sessionId === agent.sessionId && now.tmuxPane === agent.tmuxPane ? now : null
    }, 60_000, 500)
  }
}

/** An agent ended as the desktop ends one (asked again while the daemon says to), once its pane is gone. */
async function end(h: Home, c: LocalClient, agent: Row): Promise<void> {
  let answer: Row = {}
  await until(`${agent.engine} to be deleted`, async () => {
    answer = await c.request('agent_delete', { agentId: agent.id }, 60_000)
    if (answer.error && !answer.retryable) throw new Error(`the delete was refused: ${JSON.stringify(answer)}`)
    return !answer.error || null
  }, 60_000, 1_000).catch((error: Error) => { throw new Error(`${error.message}; its last answer: ${JSON.stringify(answer)}`) })
  // The last pane takes tmux's server with it.
  const panes = () => h.d.tmux.run('list-panes', '-a', '-F', '#{pane_id}').catch(() => '')
  await until(`${agent.engine}'s pane to go`, async () => !(await panes()).split('\n').includes(agent.tmuxPane), 30_000, 200)
}

/** The process [pid] runs a Node of [tree]'s runtime: its own, or the copy under the daemon's name beside it. */
const runsFrom = (pid: number, tree: string): void => {
  expect(readlinkSync(`/proc/${pid}/exe`).startsWith(`${join(tree, 'runtime', 'node-e2e')}/`), `${pid} runs ${readlinkSync(`/proc/${pid}/exe`)}`).toBe(true)
}

/** Every entry of ~/.harness a link to its new place, or one of the bridge's two real folders; nothing else. */
function expectBridge(h: Home): void {
  for (const name of readdirSync(h.legacy)) {
    const entry = lstatSync(join(h.legacy, name))
    if ((REAL_ENTRIES as readonly string[]).includes(name)) expect(entry.isDirectory(), `${name} is one of the bridge's real folders`).toBe(true)
    else expect(entry.isSymbolicLink() && readlinkSync(join(h.legacy, name)), `${name} links to its new place`).toBe(join(rootOf(h, name), name))
  }
}

/** The harnesses whose setup has yet to run again after the move (dsh/installed.ts setupsPending). */
const pendingSetups = (h: Home): string[] => {
  try { return (JSON.parse(read(join(h.data, 'dsh', 'installed.json'))) as Row[]).filter((entry) => entry.setup === 'pending').map((entry) => entry.id) } catch { return [] }
}

/**
 * Every harness set up again after the move, as the Store does on its own: the bridge waits for them, and a start's
 * check is the one that sees it (the next is 10 minutes later).
 */
async function setUpAgain(h: Home): Promise<void> {
  await until('every harness set up again after the move', () => pendingSetups(h).length === 0 || null, 60_000, 200)
    .catch((error: Error) => { throw new Error(`${error.message}; still pending: ${JSON.stringify(pendingSetups(h))}`) })
}

/** The bridge gone at a start: ~/.harness, bridge.json, and the record says moved. */
async function bridgeGone(h: Home, s: Start): Promise<void> {
  await until('the bridge to go', () => !existsSync(h.legacy) && !existsSync(join(h.state, BRIDGE_FILE)) || null, 30_000, 200)
    .catch((error: Error) => {
      throw new Error(`${error.message}; the record: ${JSON.stringify(record(h.state))}; setups pending: ${JSON.stringify(pendingSetups(h))}`)
    })
  expect(record(h.state)).toMatchObject({ state: 'moved', oldProcesses: 0 })
  expect(s.log()).toContain('home bridge: removed')
}

let bundle = ''
let bundleDir: string | null = null

describe.runIf(process.platform === 'linux')('the move of ~/.harness to the XDG folders', () => {
  beforeAll(() => {
    // The run's bundle (E2E_BUNDLE=1), else one built for this file, as it ships.
    if (process.env.E2E_BUNDLE_PATH) { bundle = process.env.E2E_BUNDLE_PATH; return }
    bundleDir = mkdtempSync(join(tmpdir(), 'harness-home-move-'))
    return run(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT, env: { ...process.env, BUNDLE_OUT_DIR: bundleDir } })
      .then(() => { bundle = join(bundleDir!, 'cli.js') })
  }, 300_000)
  afterAll(() => { if (bundleDir) rmSync(bundleDir, { recursive: true, force: true }) })
  afterEach(async () => {
    let failure: unknown = null
    for (const ending of ends.splice(0).reverse()) {
      try { await ending() } catch (error) { failure ??= error }
    }
    if (failure) throw failure
  })

  it('a fresh home writes nothing to ~/.harness', async () => {
    const h = await machine()
    const s = await Start.begin(h, process.env.E2E_NODE_PATH!, [bundle, '__harnessd'], plain(h)).ready()
    // Reached at its socket in the data root's data folder, and its hook route in the state root.
    const c = await client(h)
    const agent = await create(h, c, 'claude', 'fresh')
    await c.turn(agent.id, 'on a fresh home')
    c.close()
    expect(readdirSync(join(h.state, 'hook-routes')).length).toBeGreaterThan(0)
    await s.stop()
    expect(existsSync(h.legacy)).toBe(false)
  })

  /** The upgrade, with every agent at work: in a pane each engine, and Claude Code outside any pane, seen on a dial. */
  async function upgrade(h: Home, released: boolean): Promise<void> {
    const dials = join(h.d.root, 'dials.json')
    writeFileSync(dials, '[]')
    h.d.env.CABLE_DISABLE = 'false'
    h.d.env.HARNESSD_TEST_DIAL_PORT = dials
    await first(h, released ? { ready: 'port' } : {})
    await until('the first daemon to sign in', () => h.backend!.nodeUp(MACHINE.machineId), 60_000, 200)
    const c = await firstClient(h)
    const agents = [await working(h, c, 'claude', 'old-claude'), await working(h, c, 'codex', 'old-codex')]
    c.close()
    // Its conversation on disk, so the devices' scan finds it once a dial is plugged in.
    const outside = await Outside.start(h.d, 'old-outside', { TERM_PROGRAM: 'ghostty' })
    ends.push(() => outside.close())
    outside.type('at work before the move, outside any pane')
    await until('its Stop hook to run', () => outside.ran(h.d, 'Stop'), 30_000, 100)
    if (!released) expect(read(join(h.old.dataDir, 'harness.log'))).toContain('home move: skipped-override · ADAPTER_DATA_DIR names a folder inside ~/.harness; unset it to move')
    await stopFirst(h)
    const before = readdirSync(h.legacy).filter((name) => name !== 'home-move.json')
    const bytes = { id: readFileSync(join(h.legacy, 'computer-id')), session: readFileSync(join(h.legacy, 'auth', 'session.json')) }
    // This build installed over the release, as an update or an install leaves it.
    if (released) layBuild(dirname(h.old.cli), bundle)

    const s = await moving(h)
    expect(read(join(h.moved.dataDir, 'harness.log'))).toContain(`home move: moved · data ${h.data} · state ${h.state}`)
    for (const name of before) expect(existsSync(join(rootOf(h, name), name)), `${name} in its root`).toBe(true)
    expectBridge(h)
    expect(readFileSync(join(h.data, 'computer-id'))).toEqual(bytes.id)
    expect(readFileSync(join(h.data, 'auth', 'session.json'))).toEqual(bytes.session)
    await until('the moved daemon to sign in', () => h.backend!.nodeUp(MACHINE.machineId), 60_000, 200)
    // The process that moved started itself again from the new paths: same pid, the state root's Node.
    runsFrom(s.pid, h.state)

    const moved = await client(h)
    await adopted(moved, agents)
    // Each turn ends through the hook command its engine read as it started, before the move: the old paths.
    for (const agent of agents) await moved.turn(agent.id, `after the move (${agent.engine})`)
    const desk = new Desk(dials)
    ends.push(() => desk.close())
    const dial = await desk.plug('E2E-MOVE', 'e2:e0:00:00:00:0b')
    await until('the agent outside any pane on the dial', () => dial.messages.some((m) => m.t === 'agent' && m.id === outside.id) || null, 45_000, 100)
    const since = dial.messages.length
    outside.type('after the move, outside any pane')
    await dial.next((m: DialMessage) => m.t === 'turn.done' && m.agentId === outside.id, 45_000, 'the outside agent\'s turn, through its old hook', since)

    // New agents get the new paths, and Codex's are recorded as reviewed: it asks nothing.
    const fresh = [await create(h, moved, 'claude', 'new-claude'), await create(h, moved, 'codex', 'new-codex')]
    for (const agent of fresh) await moved.turn(agent.id, `a new ${agent.engine}`)
    expect(s.log()).toContain("recorded Harness's own Codex hooks as reviewed")
    const codexHooks = read(join(h.d.env.CODEX_HOME!, 'hooks.json'))
    expect(codexHooks).toContain(join(h.data, 'cli', 'notify.mjs'))
    expect(codexHooks).not.toContain(`${h.legacy}/`)
    moved.close()
    // Nothing is in the bridge but what its service puts in its two real folders: the route record, and hard links to
    // the connections bridge's socket and the shim.
    expectBridge(h)
    for (const name of readdirSync(join(h.legacy, 'hook-routes'))) {
      expect(JSON.parse(read(join(h.legacy, 'hook-routes', name))), name).toMatchObject({ dataDir: h.moved.dataDir })
    }
    for (const name of readdirSync(join(h.legacy, 'connections'))) {
      expect(['bridge.sock', 'mcp-shim.mjs'], name).toContain(name)
      expect(statSync(join(h.legacy, 'connections', name)).ino, `${name} is a hard link`).toBe(statSync(join(h.data, 'connections', name)).ino)
    }

    // While the daemon is down an old agent starts a new conversation: its hook writes it into the registry offline,
    // through the bridge, into the new data folder.
    await s.stop()
    const claude = agents[0]
    const hooks = (h.d.hookLog().match(/SessionStart\(clear\)/g) ?? []).length
    await h.d.tmux.run('send-keys', '-t', claude.tmuxPane, '!clear', 'Enter')
    const cleared = await until('its SessionStart(clear) hook to run', () => {
      const ran = [...h.d.hookLog().matchAll(/SessionStart\(clear\) session=(\S+) ran/g)]
      return ran.length > hooks ? ran.at(-1)![1] : null
    }, 30_000, 100)
    expect(read(join(h.moved.dataDir, 'registry.json'))).toContain(cleared)
    expectBridge(h)
  }

  it('an upgrade with agents at work', async () => {
    await upgrade(await machine({ legacy: true, signedIn: true }), false)
  })

  it.runIf(!!FROM)('from a released build', async () => {
    await upgrade(await machine({ legacy: true, signedIn: true, cli: FROM }), true)
  })

  it('the bridge goes when the old agents end', async () => {
    const h = await machine({ legacy: true })
    await first(h)
    let c = await firstClient(h)
    const agents = [await working(h, c, 'claude', 'old-claude'), await working(h, c, 'codex', 'old-codex')]
    c.close()
    // A shell the person had open before the move, outside Harness's panes, like the test's own: it holds nothing.
    const shell = spawn('/bin/sh', ['-c', 'while :; do sleep 1; done'], { stdio: 'ignore' })
    ends.push(() => { shell.kill('SIGKILL') })
    await stopFirst(h)

    let s = await moving(h)
    const atMove = await until('the bridge service to count the old processes', () => record(h.state)?.oldProcesses || null, 30_000, 200)
    c = await client(h)
    await adopted(c, agents)
    // One old agent left: at the next start the bridge stays, with fewer old processes.
    await end(h, c, agents[0])
    c.close()
    await s.stop()
    s = await again(h)
    const left = await until('the bridge service to count again', () => {
      const now = record(h.state)?.oldProcesses
      return now !== undefined && now < atMove ? now : null
    }, 30_000, 200)
    expect(left).toBeGreaterThan(0)
    expect(existsSync(join(h.state, BRIDGE_FILE))).toBe(true)
    expectBridge(h)
    // The last one ends: the next start removes the bridge, though the shell older than the move still runs.
    c = await client(h)
    await end(h, c, agents[1])
    c.close()
    await setUpAgain(h)
    await s.stop()
    s = await again(h)
    await bridgeGone(h, s)
    expect(shell.exitCode).toBeNull()
  })

  it("a connection's shim from before the move still answers", async () => {
    const h = await machine({ legacy: true })
    // A connection's MCP server, on this machine: it answers an initialize with its name.
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
      request.on('end', () => {
        const { id } = JSON.parse(body) as { id: number }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'e2e-mcp', version: '1' } } }))
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    ends.push(() => new Promise<void>((done) => server.close(() => done())))
    // Connected before the move, as `harness connections` leaves one in the old tree's vault.
    const folder = join(h.legacy, 'connections')
    const vault = new Store(folder)
    mkdirSync(vault.root, { recursive: true, mode: 0o700 })
    vault.save('e2e-mcp', { label: 'E2E MCP', source: 'custom', mcp_entry: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, headers: {} } })
    await first(h)
    await until('the connections bridge\'s socket and shim', () => existsSync(join(folder, 'bridge.sock')) && existsSync(join(folder, 'mcp-shim.mjs')), 30_000, 200)
    // An agent's MCP client runs the shim on the old tree's Node, with the old socket path, for as long as the agent lives.
    const shim = spawn(h.old.node, [join(folder, 'mcp-shim.mjs'), '--socket', join(folder, 'bridge.sock'), 'e2e-mcp'], { env: plain(h), stdio: ['pipe', 'pipe', 'pipe'] })
    ends.push(() => { shim.kill('SIGKILL') })
    let said = ''
    shim.stdout!.on('data', (chunk: Buffer) => { said += chunk.toString('utf8') })
    /** The shim's answer to an initialize: the connection's own, through the bridge. */
    const answer = async (id: number): Promise<Row> => {
      shim.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } })}\n`)
      return until(`the shim's answer ${id}`, () => said.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Row).find((message) => message.id === id), 30_000, 100)
    }
    expect(await answer(1)).toMatchObject({ result: { serverInfo: { name: 'e2e-mcp' } } })
    await stopFirst(h)
    await moving(h)
    // The old path, in the bridge's real folder, is the socket the connections service listens on now.
    await until('the bridge to link the connections service\'s socket into its real folder', () => {
      try { return statSync(join(folder, 'bridge.sock')).ino === statSync(join(h.data, 'connections', 'bridge.sock')).ino } catch { return false }
    }, 30_000, 200)
    expect(await answer(2)).toMatchObject({ result: { serverInfo: { name: 'e2e-mcp' } } })
  })

  it('harnesses are set up again, and the bridge waits for them', async () => {
    const h = await machine({ legacy: true })
    const env = plain(h)
    const where = join(h.d.root, 'where-one')
    const gate = join(h.d.root, 'one-may-finish')
    const passes = join(h.d.root, 'two-passes')
    /** A package in a git repository of its own, installed from it (not linked). */
    const repo = async (name: string, setup: string): Promise<string> => {
      const dir = join(h.d.root, 'packages', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'harness.json'), JSON.stringify({ spec: 1, id: `e2e/${name}`, name, engine: 'claude', toolchain: { setup: 'sh setup.sh' } }))
      writeFileSync(join(dir, 'setup.sh'), setup)
      const git = (...args: string[]) => run('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args], { cwd: dir, env })
      await git('init', '-q')
      await git('add', '.')
      await git('commit', '-qm', name)
      return dir
    }
    // Set up again away from ~/.harness, it waits for the test's word: the bridge must wait for it.
    const one = await repo('one', `case "$HARNESS_DSH_DIR" in "$HOME"/.harness/*) ;; *) while [ ! -e '${gate}' ]; do sleep 0.1; done ;; esac
printf %s "$HARNESS_DSH_DIR" > '${where}'
`)
    // Set up again away from ~/.harness, it fails, until the test lets it pass.
    const two = await repo('two', `case "$HARNESS_DSH_DIR" in "$HOME"/.harness/*) exit 0 ;; esac
[ -e '${passes}' ] || { echo 'set up away from ~/.harness' >&2; exit 1; }
`)
    const harness = (cli: { node: string; cli: string }, ...args: string[]) => run(cli.node, [cli.cli, ...args], { cwd: h.d.root, env })
    for (const dir of [one, two]) await harness(h.old, 'dsh', 'install', dir)
    expect(read(where)).toBe(join(h.legacy, 'dsh', 'e2e', 'one'))

    let s = await moving(h)
    const list = async () => (await harness(h.moved, 'dsh', 'list')).stdout
    const row = (text: string, id: string) => text.split('\n').find((line) => line.trimStart().startsWith(`${id} `)) ?? ''
    await until('the second to need setup', async () => row(await list(), 'e2e/two').endsWith('· needs setup') || null, 60_000, 500)
    // The first is still setting up: this start's check left the bridge.
    expect(existsSync(join(h.state, BRIDGE_FILE))).toBe(true)
    expectBridge(h)
    writeFileSync(gate, '')
    await until('the first set up again at its new folder', () => existsSync(where) && read(where) === join(h.data, 'dsh', 'e2e', 'one') || null, 60_000, 200)
    await until('the first\'s mark to go', () => {
      const index = JSON.parse(read(join(h.data, 'dsh', 'installed.json'))) as Row[]
      return index.find((entry) => entry.id === 'e2e/one')?.setup === undefined || null
    }, 30_000, 200)
    await s.stop()
    s = await again(h)
    await bridgeGone(h, s)

    // An update sets up again the one that needs it, once its setup can pass.
    writeFileSync(passes, '')
    await harness(h.moved, 'dsh', 'update', 'e2e/two')
    expect(row(await list(), 'e2e/two')).not.toContain('needs setup')
  })

  /**
   * With default folders a socket's short folder is longer than its place beside the data folder, so only a data root
   * longer than the home sends the daemon's socket there (lib/localSocket.ts). An old hook still looks beside the old
   * data folder, and reaches the daemon through the bridge's link to the socket in the short folder.
   */
  it('a home too long for a socket beside the data folder', async () => {
    const h = await machine({ legacy: true })
    // The shortest data root whose data folder has no room for the socket beside it.
    let base = join(h.home, 'l')
    while (Buffer.byteLength(join(base, 'harness', 'cli', 'data', socketName(h))) <= SOCKET_ROOM) base += 'l'
    h.d.env.XDG_DATA_HOME = base
    h.data = xdgRoots(h.home, h.d.env).data
    h.moved = { ...h.moved, cli: join(h.data, 'cli', 'cli.js'), dataDir: join(h.data, 'cli', 'data') }
    // The short folder in the state root, named by the data folder's hash (lib/localSocket.ts shortSocketFolder), worked
    // out here: that module resolves the roots by this worker's environment, not the daemon's.
    const short = join(h.state, 's', createHash('sha256').update(h.moved.dataDir).digest('hex').slice(0, 16), socketName(h))
    expect(Buffer.byteLength(short), 'the short folder has room for the socket').toBeLessThanOrEqual(SOCKET_ROOM)
    await first(h)
    const c = await firstClient(h)
    const agent = await working(h, c, 'claude', 'old-claude')
    c.close()
    await stopFirst(h)

    await moving(h)
    const moved = await client(h, short)
    await adopted(moved, [agent])
    const old = join(h.old.dataDir, socketName(h))
    await until('the bridge to link the socket where the old hook looks', () => {
      try { return statSync(old).ino === statSync(short).ino } catch { return false }
    }, 30_000, 200)
    await moved.turn(agent.id, 'after the move, on a long home')
    moved.close()
  })

  it('with no master', async () => {
    const h = await machine({ legacy: true })
    await first(h)
    let c = await firstClient(h)
    const agent = await working(h, c, 'claude', 'old-claude')
    c.close()
    await stopFirst(h)
    // As Harness OS runs it: `harness start -f` with the core alone. A start keeps only an allowlist of its shell's
    // environment, so the harness's settings go in the env file, as a person's would.
    const file = join(h.d.root, 'no-master.env')
    const { startEnvFile } = await import('../src/testing/startEnvFile.js')
    writeFileSync(file, startEnvFile(plain(h), Object.keys(plain(h))))
    const env = plain(h, { HARNESS_NO_MASTER: '1', HARNESS_ENV_FILE: file })
    let s = await Start.begin(h, h.old.node, [h.old.cli, 'start', '-f'], env).ready()
    expect(read(join(h.moved.dataDir, 'harness.log'))).toContain(`home move: moved · data ${h.data} · state ${h.state}`)
    runsFrom(s.pid, h.state)
    expectBridge(h)
    c = await client(h)
    await adopted(c, [agent])
    await c.turn(agent.id, 'after the move, with no master')
    // The bridge service runs in the core's own process: it keeps the bridge while the old agent lives, and removes it
    // at the start after the agent ends.
    expect(existsSync(join(h.state, BRIDGE_FILE))).toBe(true)
    await end(h, c, agent)
    c.close()
    await setUpAgain(h)
    await s.stop()
    s = await Start.begin(h, h.moved.node, [h.moved.cli, 'start', '-f'], env).ready()
    await bridgeGone(h, s)
  })

  it('a unit harness service install wrote is rewritten and reloaded', async () => {
    const h = await machine({ legacy: true })
    // launchctl, systemctl and loginctl are the suite's fakes (e2e/harness/fakePlatform.mjs), first on PATH: systemd
    // here runs the master from the unit, with the test's environment, as e2e/cli.e2e.ts has it.
    const fakes = join(h.d.root, 'platform-bin')
    mkdirSync(fakes)
    const fake = pathToFileURL(join(CLI_ROOT, 'e2e', 'harness', 'fakePlatform.mjs')).href
    for (const name of ['launchctl', 'systemctl', 'loginctl']) {
      writeFileSync(join(fakes, name), `#!${process.execPath}\nimport(${JSON.stringify(fake)}).then((m) => m.run(${JSON.stringify(name)}))\n`, { mode: 0o755 })
    }
    const file = join(h.d.root, 'start.env')
    const { startEnvFile } = await import('../src/testing/startEnvFile.js')
    writeFileSync(file, startEnvFile(plain(h), Object.keys(plain(h))))
    const env = plain(h, { PATH: `${fakes}:${h.d.env.PATH}`, XDG_CONFIG_HOME: join(h.home, '.config'), HARNESSD_TEST_PLATFORM: 'systemd', HARNESS_ENV_FILE: file })
    writeFileSync(join(fakes, 'config.json'), JSON.stringify({ mode: 'platform', baseEnv: env }))
    const calls = (): string[][] => read(join(fakes, 'calls.jsonl')).trim().split('\n').map((line) => JSON.parse(line) as string[])
    const master = (): number | null => { try { return (JSON.parse(read(join(fakes, 'state.json'))) as { pid: number | null }).pid } catch { return null } }
    // Stopped as a person stops it, through systemd; whatever is left of it then goes.
    ends.push(async () => {
      await run(h.moved.node, [h.moved.cli, 'stop'], { cwd: h.d.root, env }).catch(() => {})
      const pid = master()
      if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    })
    // The unit `harness service install` writes for the old tree, and the reload it runs.
    const unit = join(h.home, '.config', 'systemd', 'user', SYSTEMD_UNIT)
    mkdirSync(dirname(unit), { recursive: true })
    writeFileSync(unit, systemdUnit({ nodePath: h.old.node, scriptPath: h.old.cli, logFile: join(h.old.dataDir, 'harness.log'), home: h.home, env: { HARNESS_ENV_FILE: file } }))
    await run(join(fakes, 'systemctl'), ['--user', 'daemon-reload'], { env })
    const reloads = calls().length

    const started = await run(h.old.node, [h.old.cli, 'start'], { cwd: h.d.root, env })
    expect(started.stdout).toMatch(/supervisor +systemd/)
    const text = read(unit)
    const line = (key: string): string => text.split('\n').find((each) => each.startsWith(`${key}=`)) ?? ''
    expect(line('ExecStart')).toContain(h.moved.node)
    expect(line('ExecStart')).toContain(h.moved.cli)
    expect(line('StandardOutput')).toContain(join(h.moved.dataDir, 'harness.log'))
    expect(text).not.toContain(`${h.legacy}/`)
    expect(calls().slice(reloads)).toContainEqual(['systemctl', '--user', 'daemon-reload'])
    expect(calls().slice(reloads)).toContainEqual(['systemctl', '--user', 'start', SYSTEMD_UNIT])
    // systemd runs the master from the unit as it is now: the new tree's Node.
    const pid = await until('systemd to run the master', master, 30_000, 200)
    runsFrom(pid, h.state)
    const port = savedDaemonPort(h.moved.dataDir, h.d.configuredPort)
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true)
  })

  it('a move that fails rolls back and the daemon serves ~/.harness', async () => {
    const h = await machine({ legacy: true })
    // The state base cannot be written: the move fails before it changes anything it cannot undo.
    const base = dirname(h.state)
    mkdirSync(base, { recursive: true })
    chmodSync(base, 0o555)
    ends.push(() => chmodSync(base, 0o755))
    const tree = readdirSync(h.legacy).sort()
    const s = await moving(h)
    expect(read(join(h.old.dataDir, 'harness.log'))).toContain('home move: failed permission · ~/.harness is as it was')
    expect(record(h.legacy)).toMatchObject({ state: 'failed', reason: 'permission' })
    expect(existsSync(h.data)).toBe(false)
    expect(readdirSync(h.legacy).filter((name) => name !== 'home-move.json').sort()).toEqual(expect.arrayContaining(tree))
    for (const name of readdirSync(h.legacy)) expect(lstatSync(join(h.legacy, name)).isSymbolicLink(), name).toBe(false)
    // It did not start again: it runs from ~/.harness, and serves it.
    runsFrom(s.pid, h.legacy)
    const c = await client(h, join(h.old.dataDir, socketName(h)))
    await create(h, c, 'claude', 'on-the-old-tree')
    c.close()
  })
})
