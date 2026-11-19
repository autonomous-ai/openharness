/**
 * The home bridge (docs/plans/2026-11-18-linux-xdg-paths-design.md, The bridge service). On Linux, once Harness's folder
 * moved to the XDG folders, ~/.harness is a bridge for what started before the move (homeMove/bridge.ts). This service
 * keeps in it what a link cannot give, and removes it once no process that could use an old path is left and every
 * harness's setup has run again. It runs only while bridge.json exists: a check each time the core connects and every 10
 * minutes on one timer, and nothing once the bridge is gone. It reads a process's owner, start time, name, executable and
 * parent (homeMove/oldUsers.ts), never its environment or command line, and tmux's panes read only. While a harness waits
 * to be set up again, it wakes the Store, as a tool of this computer's owner would. The apps ask it nothing.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DEFAULT_TIMEOUT_MS, openDaemon, whereFor, type Daemon } from '../agentClient/daemon.js'
import { env } from '../config/env.js'
import { harnessPath, harnessRoot, harnessRoots, legacyHarnessHome, thisComputer } from '../config/harnessHome.js'
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { bootId, BRIDGE_FILE, readBridge, removeBridge, serveOldPaths, type Served } from '../homeMove/bridge.js'
import { oldUsers, procRows, type ProcRow } from '../homeMove/oldUsers.js'
import { OWN_FILES } from '../homeMove/plan.js'
import { readMoveRecord, writeMoveRecord, type MoveRecord } from '../homeMove/record.js'
import { connectorsDir } from '../lib/connectors/store.js'
import { errorKind } from '../lib/log.js'
import { savedDaemonPort } from '../lib/daemonRecord.js'
import { HARNESS_OWNER_OPTION } from '../lib/harnessSessionLabel.js'
import { publishHookRoute } from '../lib/hookRoutes.js'
import { runtimeShortRoot, socketPathIn, unixSocketPath } from '../lib/localSocket.js'
import { tmuxFinder } from '../lib/binaryFinder.js'
import type { TmuxPathOutcome } from '../lib/tmuxOnPath.js'

/** How often it looks for a process that could still use an old path. */
export const CHECK_MS = 600_000
const TMUX_LIMIT_MS = 5_000
/** How long the Store's request waits for the core to open its line: as long as a request waits for its answer. */
export const STORE_ASK_MS = DEFAULT_TIMEOUT_MS

/**
 * The engines Harness installs hooks for (engines/hooks.ts, engines/nativeHooks.ts), by the names their processes run as.
 * Not Pi's `pi`, Amp's `amp`, Command Code's `cmd` or Cursor's and Grok's `agent`: other programs go by those, and one
 * would hold the bridge for good. A session of those that Harness started is a pane's, which counts by its pane.
 */
const ENGINES: ReadonlySet<string> = new Set([
  'claude', 'codex', 'cursor-agent', 'opencode', 'hermes', 'hermes-agent', 'command-code', 'commandcode', 'devin', 'kilo',
  'kilocode', 'grok', 'agy', 'copilot',
])
/** Desktop's executable (an AppImage's mount's too) and the Device app's: they opened their stores and logs through the old paths. */
const APPS: ReadonlySet<string> = new Set(['harness', 'harness-device'])

export interface HomeBridgeDeps {
  platform: NodeJS.Platform
  home: string
  environment: NodeJS.ProcessEnv
  /** The daemon's socket, as this process reaches it; null where it has none. */
  socket: string | null
  /** The daemon's first process, all the daemon's own processes under it: harnessd's master, this one's parent. */
  master: number
  /** This boot's id (homeMove/bridge.ts). */
  bootId(): string | null
  rows(): ProcRow[]
  /** Where tmux is, as the core finds it (lib/binaryFinder.ts tmuxFinder); it never rejects. */
  tmuxAt(): Promise<TmuxPathOutcome>
  /** Every pane on tmux's default server, each its process and its tag, as spawnSync gives the answer of [binary]. */
  tmux(binary: string): TmuxAnswer
  /** The harnesses whose setup has yet to run again after the move. */
  setupsPending(): Promise<number>
  /** Wakes the Store's process, which sets them up again as it starts. */
  askForStore(): Promise<void>
  log(line: string): void
}

type TmuxAnswer = { status: number | null; stdout: string; stderr?: string; error?: NodeJS.ErrnoException }

const IDLE = { stop: () => {}, connected: () => {} }

/** What tmux says with no server to list: none was ever started, or the last one ended (client.c). */
const NO_SERVER = /^no server running on |^error connecting to .* \(No such file or directory\)$/m

/** The default server is where the daemon makes its panes (homeMove/panes.ts); the daemon never inherits a TMUX naming another. */
function listPanes(binary: string): TmuxAnswer {
  return spawnSync(binary, ['list-panes', '-a', '-F', `#{pane_pid} #{${HARNESS_OWNER_OPTION}}`], { encoding: 'utf8', timeout: TMUX_LIMIT_MS })
}

/** Loaded at the first check, which only a bridge brings: the Store's index module brings zod, which the edge host otherwise
 *  never loads (leanEntry.spec.ts). */
async function pendingSetups(): Promise<number> {
  return (await import('../dsh/installed.js')).setupsPending()
}

/**
 * The Store sets each harness up again as its process starts (dsh/setupAgain.ts), and in the master its process starts at
 * a request (core/viewersWake.ts). Asked as a tool of this computer's owner asks (agentClient/daemon.ts), with the lightest
 * request the Store answers: an update naming no harness, which it refuses at once, with no catalog fetched and nothing
 * changed (services/store.ts).
 */
export async function askForStore(open: () => Promise<Daemon> = () => openDaemon(whereFor(undefined))): Promise<void> {
  // The request has its own limit, the line's opening none: one that never opens would hold every check after it.
  const opening = open()
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error('the core did not open a line in time')), STORE_ASK_MS) })
  let daemon: Daemon
  try {
    daemon = await Promise.race([opening, late])
  } catch (error) {
    // A line that opens after all is closed at once.
    opening.then((line) => line.close(), () => {})
    throw error
  } finally {
    clearTimeout(timer)
  }
  try {
    await daemon.request('dsh_update', {})
  } finally {
    daemon.close()
  }
}

/**
 * In the core's process (no master, or `HARNESSD_SERVICES=none`): the same service, which the apps ask nothing. The core is
 * the daemon's first process here, and there from its start, so it checks at once; and so is the Store, which it never
 * wakes: in this process, or named outright and started with the master's others (harnessd/services.ts). It lives as long
 * as the core's process, where no link to the core comes and goes. [given] is the tests'.
 */
export function startHomeBridgeInCore(core: CoreApi, given: Partial<HomeBridgeDeps> = {}): ServiceRequests {
  startHomeBridge(core, { master: process.pid, askForStore: async () => {}, ...given }).connected()
  return {}
}

export function startHomeBridge(core: CoreApi, given: Partial<HomeBridgeDeps> = {}): { stop(): void; connected(): void } {
  const deps: HomeBridgeDeps = {
    platform: process.platform, home: homedir(), environment: process.env, socket: unixSocketPath(core.dataDir, env.PORT),
    // The master's PATH, this process's, may hold no tmux: it runs the one the core finds, so the core's server.
    master: process.ppid, bootId, rows: procRows, tmuxAt: tmuxFinder(), tmux: listPanes, setupsPending: pendingSetups, askForStore,
    log: console.log, ...given,
  }
  // Nothing moves off Linux, and with no bridge.json there is no bridge to keep.
  if (deps.platform !== 'linux') return IDLE
  const look = thisComputer(deps.environment)
  const stateRoot = harnessRoot('state', deps.home, 'linux', look)
  const bridge = readBridge(stateRoot)
  if (!bridge) return IDLE
  // The folder it names is the one the service writes into and empties: only ~/.harness is the move's.
  if (bridge.oldHome !== legacyHarnessHome(deps.home, 'linux')) {
    deps.log(`home bridge: ${BRIDGE_FILE} names a folder other than ${legacyHarnessHome('~', 'linux')} · nothing is served or removed`)
    return IDLE
  }
  const roots = harnessRoots(deps.home, 'linux', look)
  const connections = connectorsDir(deps.environment)
  // A connections folder a setting keeps elsewhere was there before the move too, where an old client still finds it.
  const connectionsMoved = resolve(connections) === harnessPath('connections', deps.home, 'linux', look)
  const unlinkedSaid = new Set<string>()
  let running = true
  let checking = false
  /** The last failure's kind said, until a check gets through. */
  let failure: string | null = null

  /** The route record, a hard link where an old client looks for a socket, and the shim's files: made again at each check,
   *  as the core and the connections bridge make their sockets again whenever they start. */
  const serve = (): void => {
    const sockets: [oldFolder: string, path: string | null][] = [[bridge.oldDataDir, deps.socket]]
    if (connectionsMoved) sockets.push([join(bridge.oldHome, 'connections'), socketPathIn(connections, 'bridge.sock', deps.home)])
    const served: Served = {
      routes: { dataDir: core.dataDir, port: savedDaemonPort(core.dataDir, env.PORT) },
      sockets: sockets.flatMap(([oldFolder, path]) => (path ? [{ oldFolder, folder: dirname(path), name: basename(path) }] : [])),
      files: connectionsMoved ? [{ from: join(connections, 'mcp-shim.mjs'), name: 'mcp-shim.mjs' }] : [],
      runtime: runtimeShortRoot(deps.environment),
    }
    const unlinked = serveOldPaths(bridge, served, publishHookRoute).filter((name) => !unlinkedSaid.has(name))
    if (!unlinked.length) return
    for (const name of unlinked) unlinkedSaid.add(name)
    deps.log(`home bridge: ${unlinked.join(', ')} could not be linked where an old client looks for it`)
  }

  /** The processes of the panes the move retagged: they carry the new tag. A pane made since started after the move, and does not count. */
  const panePids = async (): Promise<number[]> => {
    const found = await deps.tmuxAt()
    // No tmux found is a tmux not installed: no pane.
    if (found.state === 'absent') return []
    const { status, stdout, stderr = '', error } = deps.tmux(found.state === 'adopted' ? found.path : 'tmux')
    if (status !== 0) {
      // A tmux that is missing, or has no server, has no pane. Any other failure, a timeout or another version's server,
      // says nothing of them: the check is tried again.
      if (error?.code === 'ENOENT' || NO_SERVER.test(stderr)) return []
      throw new Error(`tmux could not list its panes: ${error?.code ?? (stderr.trim().split('\n')[0] || `status ${status}`)}`)
    }
    return stdout.split('\n').flatMap((line) => {
      const [pid, tag] = line.split(' ')
      return tag === bridge.newTag ? [Number(pid)] : []
    })
  }

  /** The move's record, written only when its state or count changed (homeMove/record.ts). A failed move's says so until a
   *  start finishes the move: only its count changes. */
  const note = (state: MoveRecord['state'], oldProcesses: number): void => {
    const record = readMoveRecord(deps.home, deps.environment)
    if (record) writeMoveRecord(stateRoot, { ...record, state: record.state === 'failed' ? record.state : state, oldProcesses, at: Date.now() })
  }

  /** Who still uses the bridge, and the harnesses to set up again: once neither is left, the bridge goes. */
  const removeWhenUnused = async (): Promise<void> => {
    const boot = deps.bootId()
    // Without it no start time can be placed before or after the move.
    if (!boot) throw new Error('/proc gives no boot id')
    const facts = { uid: process.getuid!(), master: deps.master, bootId: boot, roots, engines: ENGINES, apps: APPS, panePids: await panePids() }
    const count = oldUsers(bridge, deps.rows(), facts)
    note('bridged', count)
    // A harness set up before the move runs from the old paths until its setup has run again, which the Store does as it
    // starts: woken now, while old users run too, so the setups do not wait for them. One whose setup failed is marked
    // needs-setup, and holds nothing.
    const pending = await deps.setupsPending()
    if (pending > 0) await deps.askForStore()
    if (count > 0 || pending > 0) return
    // A move a start has yet to finish keeps its journal in ~/.harness (homeMove/plan.ts), and finishes through the links.
    if (existsSync(join(bridge.oldHome, OWN_FILES.journal))) return
    const outcome = removeBridge(bridge, stateRoot, runtimeShortRoot(deps.environment))
    // The record before bridge.json: a crash between the two leaves a bridge.json, and the next start finishes.
    note('moved', 0)
    rmSync(join(stateRoot, BRIDGE_FILE), { force: true })
    deps.log(outcome === 'removed' ? 'home bridge: removed' : `home bridge: removed · ${legacyHarnessHome('~', 'linux')} holds something else, so it stays`)
    stop()
  }

  const check = async (): Promise<void> => {
    if (!running) return
    // One at a time: a connection while a check waits on the Store serves the old paths again, and leaves the rest to it.
    const again = checking
    checking = true
    try {
      serve()
      if (again) return
      await removeWhenUnused()
      failure = null
    } catch (error) {
      // /proc with no boot id, a file it could not remove: the bridge stays until a check gets through. Said once while it
      // lasts, not every 10 minutes.
      const kind = errorKind(error)
      if (kind !== failure) deps.log(`home bridge: a check failed: ${kind} · tried again in 10 minutes`)
      failure = kind
    } finally {
      if (!again) checking = false
    }
  }

  const timer = setInterval(() => void check(), CHECK_MS)
  timer.unref()
  const stop = (): void => {
    running = false
    clearInterval(timer)
  }
  // Before the core connects there is no socket to link: the first check waits for it.
  return { stop, connected: () => void check() }
}
