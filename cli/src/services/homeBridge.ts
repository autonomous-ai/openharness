/**
 * The home bridge (docs/plans/2026-11-18-linux-xdg-paths-design.md, The bridge service). On Linux, once Harness's folder
 * moved to the XDG folders, ~/.harness is a bridge for what started before the move (homeMove/bridge.ts). This service
 * keeps in it what a link cannot give, and removes it once no process that could use an old path is left and every
 * harness's setup has run again. It runs only while bridge.json exists: one timer, a check every 10 minutes, and nothing
 * once the bridge is gone. It reads a process's owner, start time, name, executable and parent (homeMove/oldUsers.ts),
 * never its environment or command line, and tmux's panes read only. The apps ask it nothing.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { harnessRoot, harnessRoots, legacyHarnessHome } from '../config/harnessHome.js'
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { BRIDGE_FILE, readBridge, removeBridge, serveOldPaths, type Served } from '../homeMove/bridge.js'
import { oldUsers, procRows, type ProcRow } from '../homeMove/oldUsers.js'
import { readMoveRecord, writeMoveRecord, type MoveRecord } from '../homeMove/record.js'
import { connectorsDir } from '../lib/connectors/store.js'
import { savedDaemonPort } from '../lib/daemonRecord.js'
import { ENGINE_CLI_ALIASES, ENGINE_CLI_COMMANDS } from '../lib/engineBin.js'
import { HARNESS_OWNER_OPTION } from '../lib/harnessSessionLabel.js'
import { publishHookRoute } from '../lib/hookRoutes.js'
import { socketPathIn, unixSocketPath } from '../lib/localSocket.js'

/** How often it looks for a process that could still use an old path. */
export const CHECK_MS = 600_000
const TMUX_LIMIT_MS = 5_000

/** The engines Harness installs hooks for, by every name their command goes by. */
const ENGINES: ReadonlySet<string> = new Set([...Object.values(ENGINE_CLI_COMMANDS), ...Object.values(ENGINE_CLI_ALIASES).flat()].filter(Boolean))
/** Desktop's executable (an AppImage's mount's too) and the Device app's: they opened their stores and logs through the old paths. */
const APPS: ReadonlySet<string> = new Set(['harness', 'harness-device'])

export interface HomeBridgeDeps {
  platform: NodeJS.Platform
  home: string
  environment: NodeJS.ProcessEnv
  /** The daemon's socket, as this process reaches it; null where it has none. */
  socket: string | null
  rows(): ProcRow[]
  /** Every pane on tmux's default server, each its process and its tag. */
  tmux(): { status: number | null; stdout: string }
  /** The harnesses whose setup has yet to run again after the move. */
  setupsPending(): Promise<number>
  log(line: string): void
}

const IDLE = { stop: () => {}, connected: () => {} }

/** The default server is where the daemon makes its panes (homeMove/panes.ts); the daemon never inherits a TMUX naming another. */
function listPanes(): { status: number | null; stdout: string } {
  return spawnSync('tmux', ['list-panes', '-a', '-F', `#{pane_pid} #{${HARNESS_OWNER_OPTION}}`], { encoding: 'utf8', timeout: TMUX_LIMIT_MS })
}

/** Loaded at the check that asks: the Store's index module brings zod, which the edge host otherwise never loads (leanEntry.spec.ts). */
async function pendingSetups(): Promise<number> {
  return (await import('../dsh/installed.js')).setupsPending()
}

const said = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** In the core's process (no master, or `HARNESSD_SERVICES=none`): the same service, which the apps ask nothing. It lives as
 *  long as the core's process, where no link to the core comes and goes. */
export function startHomeBridgeInCore(core: CoreApi): ServiceRequests {
  startHomeBridge(core)
  return {}
}

export function startHomeBridge(core: CoreApi, given: Partial<HomeBridgeDeps> = {}): { stop(): void; connected(): void } {
  const deps: HomeBridgeDeps = {
    platform: process.platform, home: homedir(), environment: process.env, socket: unixSocketPath(core.dataDir, env.PORT),
    rows: procRows, tmux: listPanes, setupsPending: pendingSetups, log: console.log, ...given,
  }
  // Nothing moves off Linux, and with no bridge.json there is no bridge to keep.
  if (deps.platform !== 'linux') return IDLE
  const look = { env: deps.environment, exists: existsSync }
  const stateRoot = harnessRoot('state', deps.home, 'linux', look)
  const bridge = readBridge(stateRoot)
  if (!bridge) return IDLE
  const roots = harnessRoots(deps.home, 'linux', look)
  const unlinkedSaid = new Set<string>()
  let running = true

  /** The route record, a hard link where an old client looks for a socket, and the shim's files: made again as the core starts again with a new socket. */
  const serve = (): void => {
    if (!running) return
    const connections = connectorsDir(deps.environment)
    const sockets = [[bridge.oldDataDir, deps.socket], [join(bridge.oldHome, 'connections'), socketPathIn(connections, 'bridge.sock', deps.home)]] as const
    const served: Served = {
      routes: { dataDir: core.dataDir, port: savedDaemonPort(core.dataDir, env.PORT) },
      sockets: sockets.flatMap(([oldFolder, path]) => (path ? [{ oldFolder, folder: dirname(path), name: basename(path) }] : [])),
      files: [{ from: join(connections, 'mcp-shim.mjs'), name: 'mcp-shim.mjs' }],
    }
    const unlinked = serveOldPaths(bridge, served, publishHookRoute).filter((name) => !unlinkedSaid.has(name))
    if (!unlinked.length) return
    for (const name of unlinked) unlinkedSaid.add(name)
    deps.log(`home bridge: ${unlinked.join(', ')} could not be linked where an old client looks for it`)
  }

  /** The processes of the panes the move retagged: they carry the new tag. A pane made since started after the move, and does not count. */
  const panePids = (): number[] => {
    const { status, stdout } = deps.tmux()
    // A tmux that is missing, or has no server, has no pane.
    if (status !== 0) return []
    return stdout.split('\n').flatMap((line) => {
      const [pid, tag] = line.split(' ')
      return tag === bridge.newTag ? [Number(pid)] : []
    })
  }

  /** The move's record, written only when its state or count changed (homeMove/record.ts). */
  const note = (state: MoveRecord['state'], oldProcesses: number): void => {
    const record = readMoveRecord(deps.home, deps.environment)
    if (record) writeMoveRecord(stateRoot, { ...record, state, oldProcesses, at: Date.now() })
  }

  const check = async (): Promise<void> => {
    try {
      const count = oldUsers(bridge, deps.rows(), { uid: process.getuid!(), self: process.pid, roots, engines: ENGINES, apps: APPS, panePids: panePids() })
      note('bridged', count)
      // A harness set up before the move runs from the old paths until its setup has run again. One whose setup failed is
      // marked needs-setup, and holds nothing.
      if (count > 0 || await deps.setupsPending() > 0) return
      const outcome = removeBridge(bridge, stateRoot)
      // The record before bridge.json: a crash between the two leaves a bridge.json, and the next start finishes.
      note('moved', 0)
      rmSync(join(stateRoot, BRIDGE_FILE), { force: true })
      deps.log(outcome === 'removed' ? 'home bridge: removed' : `home bridge: removed · ${legacyHarnessHome('~', 'linux')} holds something else, so it stays`)
      stop()
    } catch (error) {
      // /proc with no boot time, a file it could not remove: the bridge stays until a check gets through.
      deps.log(`home bridge: a check failed: ${said(error)} · tried again in 10 minutes`)
    }
  }

  serve()
  const timer = setInterval(() => void check(), CHECK_MS)
  timer.unref()
  const stop = (): void => {
    running = false
    clearInterval(timer)
  }
  void check()
  return { stop, connected: serve }
}
