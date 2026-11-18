import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { legacyHarnessHome, xdgRoots } from '../config/harnessHome.js'
import { harnessPaneOwner } from '../lib/harnessSessionLabel.js'
import { isBridge } from './bridge.js'
import { hasPaneOptions } from './panes.js'
import { movedPath, planMove, type MovePlan } from './plan.js'

/** Why a move waits, or did not finish. */
export type Reason = 'update-pending' | 'old-tmux' | 'pty-host' | 'target-exists' | 'no-space' | 'permission' | 'io'
/** A move that waits for a later start, or one a person's choice of place keeps off. */
export type Hold = { state: 'waiting'; reason: 'update-pending' | 'old-tmux' | 'pty-host' } | { state: 'skipped-override'; name: string }
/** The move runs with this plan, or it does not: held, or with nothing to say (null). */
export type MoveCheck = { move: true; plan: MovePlan; oldTag: string; newTag: string } | { move: false; hold: Hold | null }

export interface ConditionDeps { platform: NodeJS.Platform; home: string; env: NodeJS.ProcessEnv; hasExecve: boolean
  fs: Pick<typeof import('node:fs'), 'lstatSync' | 'readdirSync' | 'readFileSync' | 'existsSync' | 'realpathSync'>
  alive(pid: number): boolean; answers(socket: string): Promise<boolean>
  /** tmux's version (null with no tmux), and every pane's tag, read with or without pane options. */
  tmux: { version(): string | null; tags(paneOptions: boolean): string[] }; ptyHostRuns(ptyDir: string): boolean }

/**
 * Every setting whose default is under the home: config/env.ts's, and those read where they are used. And the env file's
 * own names (config/loadEnv.ts): one in ~/.harness would move away from the daemon that reads it.
 */
export const OVERRIDE_NAMES: readonly string[] = [
  'ADAPTER_DATA_DIR', 'ADAPTER_CLI_DIR', 'ADAPTER_RUNTIME_DIR', 'ADAPTER_COMPUTER_ID_FILE', 'AMP_SESSIONS_DIR', 'DSH_DIR',
  'HARNESS_AUTH_DIR', 'HARNESS_CONNECTIONS_DIR', 'HARNESS_HOOK_ROUTES_DIR', 'HARNESS_LOGS_DIR', 'HARNESS_PTY_DIR',
  'HARNESS_DEVICES_DIR', 'HARNESS_AGENT_MESSAGES_DIR', 'HARNESS_FLASHER_CACHE', 'HARNESS_ENV_FILE', 'DOTENV_CONFIG_PATH',
]

// The daemon's socket names (lib/localSocket.ts).
const SOCKET = /^daemon-\d+\.sock$/
const ANSWER_LIMIT_MS = 1_000

const NO_HOLD: MoveCheck = { move: false, hold: null }
const waiting = (reason: Extract<Hold, { state: 'waiting' }>['reason']): MoveCheck => ({ move: false, hold: { state: 'waiting', reason } })
const skipped = (name: string): MoveCheck => ({ move: false, hold: { state: 'skipped-override', name } })

/** Whether this start moves ~/.harness to the XDG roots. The first condition that holds decides. */
export async function checkMove(deps: ConditionDeps): Promise<MoveCheck> {
  const { fs, home } = deps
  const legacy = legacyHarnessHome(home, 'linux')
  if (deps.platform !== 'linux' || !fs.existsSync(legacy)) return NO_HOLD
  const env = withEnvFile(deps)
  if (fs.existsSync(xdgRoots(home, env).data)) return NO_HOLD
  // A person who linked ~/.harness chose its place: nothing under it is read. Its name is the one a person reads.
  if (fs.lstatSync(legacy).isSymbolicLink()) return skipped(legacyHarnessHome('~', 'linux'))
  if (isBridge(legacy)) return NO_HOLD
  // The process that moved starts itself again from the new paths: one that cannot would run on the old ones.
  if (!deps.hasExecve) return NO_HOLD
  const dataDir = env.ADAPTER_DATA_DIR || join(legacy, 'cli', 'data')
  // A start that finds a daemon starts nothing.
  if (await daemonRuns(deps, legacy, dataDir)) return NO_HOLD
  // A rollback would run the previous build against moved folders.
  if (fs.existsSync(join(env.ADAPTER_CLI_DIR || join(legacy, 'cli'), 'update-pending.json'))) return waiting('update-pending')
  const realLegacy = fs.realpathSync(legacy)
  const override = OVERRIDE_NAMES.find((name) => {
    const value = env[name]
    return !!value && (inside(legacy, resolve(value)) || inside(realLegacy, realPath(deps, resolve(value))))
  })
  if (override) return skipped(override)
  // Before 3.0 a pane's tag is in its start command, which nothing can change.
  const oldTag = harnessPaneOwner(dataDir)
  if (!hasPaneOptions(deps.tmux.version()) && deps.tmux.tags(false).includes(oldTag)) return waiting('old-tmux')
  // A PTY host keeps its panes' tags inside it.
  if (deps.ptyHostRuns(env.HARNESS_PTY_DIR || join(legacy, 'pty'))) return waiting('pty-host')
  const plan = planMove(home, env, fs.readdirSync(legacy))
  // The data folder as it really is: one a link keeps out of the tree stays where it is, and keeps its tag.
  const newTag = harnessPaneOwner(movedPath({ ...plan, legacy: realLegacy }, realPath(deps, resolve(dataDir))))
  return { move: true, plan, oldTag, newTag }
}

/** The environment the daemon runs with: config/loadEnv.ts reads its file after the move would run, and a name set already wins. */
export function withEnvFile({ fs, env }: Pick<ConditionDeps, 'fs' | 'env'>): NodeJS.ProcessEnv {
  const file = env.HARNESS_ENV_FILE?.trim() || env.DOTENV_CONFIG_PATH?.trim()
  return file ? { ...parseEnv(fs.readFileSync(resolve(file), 'utf8')), ...env } : env
}

/** A live pid in adapter.pid, a spawn lock whose owner lives, or a socket that answers within a second, asked once each. */
async function daemonRuns(deps: ConditionDeps, legacy: string, dataDir: string): Promise<boolean> {
  const live = (pid: unknown): boolean => Number.isSafeInteger(pid) && (pid as number) > 0 && deps.alive(pid as number)
  if (live(Number(readText(deps, join(dataDir, 'adapter.pid'))?.trim()))) return true
  if (live(lockOwner(readText(deps, join(dataDir, 'adapter.spawn.lock', 'owner.json'))))) return true
  // A data folder too long for a socket keeps it in its short folder (lib/localSocket.ts), under ~/.harness until the move.
  const short = join(legacy, 's', createHash('sha256').update(dataDir).digest('hex').slice(0, 16))
  for (const folder of [dataDir, short]) {
    for (const name of list(deps, folder)) {
      if (SOCKET.test(name) && await withinLimit(deps.answers(join(folder, name)))) return true
    }
  }
  return false
}

function lockOwner(text: string | null): unknown {
  try { return (JSON.parse(text ?? '') as { pid?: unknown } | null)?.pid } catch { return null }
}

function readText({ fs }: ConditionDeps, path: string): string | null {
  try { return fs.readFileSync(path, 'utf8') } catch { return null }
}

function list({ fs }: ConditionDeps, folder: string): string[] {
  try { return fs.readdirSync(folder) } catch { return [] }
}

// A socket that has not answered in a second is taken for a stale one: a daemon that lives was found by its pid first.
async function withinLimit(answer: Promise<boolean>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<boolean>((done) => { timer = setTimeout(done, ANSWER_LIMIT_MS, false) })
  try { return await Promise.race([answer, late]) } finally { clearTimeout(timer) }
}

function inside(root: string, path: string): boolean {
  const rest = relative(root, path)
  return rest !== '..' && !rest.startsWith('../') && !isAbsolute(rest)
}

/** [path] with its links resolved, a tail not made yet kept as written. */
function realPath({ fs }: ConditionDeps, path: string): string {
  const missing: string[] = []
  for (let at = path; ; at = dirname(at)) {
    try { return join(fs.realpathSync(at), ...missing.reverse()) } catch { /* not there yet: one level up */ }
    if (dirname(at) === at) return path
    missing.push(basename(at))
  }
}
