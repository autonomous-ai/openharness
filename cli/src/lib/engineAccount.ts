/**
 * Is this machine's Claude Code or Codex signed in, and when was it last used?
 *
 * The New Harness box opened on OpenCode for everyone, so a person who installed Harness to run
 * the Claude Code or Codex they already pay for started their first harness on a free model they
 * never chose (fresh macOS VM, 2026-10-08). With these two answers the box can open on the agent
 * the person already uses.
 *
 * Harness never reads a Claude or ChatGPT login (anh Dee, 2026-11-07; loginReads.spec.ts): the CLI that
 * owns the login says whether it is signed in, `claude auth status --json` (its `loggedIn`) and `codex
 * login status` (exit 0 when signed in), under the caller's environment, CLAUDE_CONFIG_DIR and CODEX_HOME
 * included. A CLI that is not there, does not answer in time or answers what this cannot read answers
 * null, unknown, rather than "signed out". Their output is never logged: it can name the account.
 *
 * "Last used" is the newest session folder the engine itself made: Claude Code's project folders
 * under `projects/`, and Codex's `sessions/YYYY/MM/DD` day folder. A file the engine rewrites on
 * every launch (`~/.claude.json`, which Harness's own folder trust writes too) would not say which
 * engine the person works in.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEngine } from '../engines/types.js'
import { resolveBinaryOnPath } from './binaryOnPath.js'
import { engineBin } from './engineBin.js'
import { warmLoginShellEnvironment } from './loginShellEnv.js'
import { windowsEngineArgv } from './windows/launch.js'

export interface EngineAccount {
  /** True when the engine says it is signed in; false when it says it is not; null when this machine cannot say. */
  readonly signedIn: boolean | null
  /** Milliseconds since the epoch of the engine's latest session activity, or null. */
  readonly lastUsedAt: number | null
}

/** What a status command answered, or null when it could not run (not installed, timed out). */
type EngineStatus = { code: number; stdout: string } | null
/** Runs `claude` or `codex` with [args] under [env]; injected by specs. */
export type EngineStatusRun = (engine: 'claude' | 'codex', args: readonly string[], env: NodeJS.ProcessEnv) => Promise<EngineStatus>

export interface EngineAccountDeps {
  home?: string
  env?: NodeJS.ProcessEnv
  run?: EngineStatusRun
  /** False: whether it is signed in only, without the session folders' scan (`lastUsedAt` null). The gateway's
   *  first-launch count asks this, once per installation (gateway/productUsage.ts). */
  lastUsed?: boolean
}

const STATUS_TIMEOUT_MS = 5_000

const mtime = (path: string) => stat(path).then(info => info.mtimeMs, () => null)
const readJson = (path: string) => readFile(path, 'utf8').then(text => JSON.parse(text) as Record<string, unknown>).catch(() => null)

/** The engine's own CLI, found on [env]'s PATH (or its *_PATH override), run without a window and killed at the timeout. */
const runEngineStatus: EngineStatusRun = (engine, args, env) => new Promise(resolve => {
  const file = resolveBinaryOnPath(engineBin(engine), env)
  if (!file) { resolve(null); return }
  let argv: string[]
  // Windows: an npm shim's script under node, never the shim through cmd.exe (lib/windows/launch.ts).
  try { argv = windowsEngineArgv(engine, [file, ...args], { environment: env }) } catch { resolve(null); return }
  const child = execFile(argv[0]!, argv.slice(1), {
    env, encoding: 'utf8', timeout: STATUS_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true,
  }, (error, stdout) => {
    if (!error) { resolve({ code: 0, stdout }); return }
    // A number is the CLI's own exit code; anything else (not found, killed at the timeout) is no answer.
    resolve(typeof error.code === 'number' && !error.killed ? { code: error.code, stdout } : null)
  })
  child.stdin?.end()
})

/** What Claude Code or Codex itself says of its sign-in under [env]: true, false, or null when it cannot say. */
async function cliSignedIn(engine: 'claude' | 'codex', env: NodeJS.ProcessEnv, run: EngineStatusRun = runEngineStatus): Promise<boolean | null> {
  if (engine === 'codex') {
    const status = await run('codex', ['login', 'status'], env)
    return status ? status.code === 0 : null
  }
  const status = await run('claude', ['auth', 'status', '--json'], env)
  try {
    const loggedIn = (JSON.parse(status?.stdout ?? '') as { loggedIn?: unknown }).loggedIn
    return typeof loggedIn === 'boolean' ? loggedIn : null
  } catch {
    return null
  }
}

/** The newest mtime among `dir`'s subfolders (one level), or null. Stat'ed together: a heavy
 *  Claude Code user has thousands of project folders. */
async function newestChild(dir: string): Promise<number | null> {
  const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory())
  const times = await Promise.all(entries.map(entry => mtime(join(dir, entry.name))))
  return times.reduce<number | null>((newest, at) => at !== null && (newest === null || at > newest) ? at : newest, null)
}

/** Codex's newest `sessions/YYYY/MM/DD` folder's mtime: the names sort as dates. */
async function newestDay(sessions: string): Promise<number | null> {
  let dir = sessions
  for (let depth = 0; depth < 3; depth++) {
    const names = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(entry => entry.name)
      .sort()
    const last = names.at(-1)
    if (!last) return depth === 0 ? null : mtime(dir)
    dir = join(dir, last)
  }
  return mtime(dir)
}

const CLAUDE_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']

/**
 * Whether an API saved here (Models ▸ APIs) sends its key as `Authorization: Bearer`, by the checked read every launch
 * holds the file to (./apiConnectionMetadata.ts): a file that read refuses has none.
 *
 * That read brings zod, loaded here only where an API was ever saved. The New dialog's probe asks this in the edge host
 * (services/engineProbe.ts), whose services share one process that otherwise holds none (leanEntry.spec.ts).
 */
async function savedBearerApi(dataDir: string): Promise<boolean> {
  if (!existsSync(join(dataDir, 'api-connections', 'connections.json'))) return false
  try {
    const { readApiConnectionStore } = await import('./apiConnectionMetadata.js')
    return readApiConnectionStore(dataDir).connections.some((row) => row.authHeader.toLowerCase() === 'authorization' && row.authPrefix.toLowerCase() === 'bearer')
  } catch { return false }
}

/** Claude Code and Codex only; every other engine answers unknown. */
export async function engineAccount(engine: AgentEngine, deps: EngineAccountDeps = {}): Promise<EngineAccount> {
  const home = deps.home ?? homedir()
  // A daemon the app or launchd started never read the person's shell profile: a key or a config
  // folder exported in ~/.zshrc is seen through the login shell's environment, captured once per
  // process (loginShellEnv.ts), with the daemon's own on top.
  const env = deps.env ?? { ...await warmLoginShellEnvironment(), ...process.env }
  // A model API saved on this computer (Models ▸ APIs) serves Claude Code without a
  // subscription, so the machine can run Claude Code on it (headless run, 2026-11-03: a working OpenRouter key saved,
  // and the account read "not signed in").
  const savedApi = await savedBearerApi(env.ADAPTER_DATA_DIR || join(home, '.harness', 'cli', 'data'))
  if (engine === 'claude') {
    const dir = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
    const lastUsedAt = deps.lastUsed === false ? null : await newestChild(join(dir, 'projects'))
    if (CLAUDE_ENV.some(name => Boolean(env[name]))) return { signedIn: true, lastUsedAt }
    if (savedApi) return { signedIn: true, lastUsedAt }
    if (typeof (await readJson(join(dir, 'settings.json')))?.apiKeyHelper === 'string') return { signedIn: true, lastUsedAt }
    return { signedIn: await cliSignedIn('claude', env, deps.run), lastUsedAt }
  }
  if (engine === 'codex') {
    const dir = env.CODEX_HOME || join(home, '.codex')
    const lastUsedAt = deps.lastUsed === false ? null : await newestDay(join(dir, 'sessions'))
    if (env.OPENAI_API_KEY) return { signedIn: true, lastUsedAt }
    return { signedIn: await cliSignedIn('codex', env, deps.run), lastUsedAt }
  }
  return { signedIn: null, lastUsedAt: null }
}
