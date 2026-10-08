/**
 * Is this machine's Claude Code or Codex signed in, and when was it last used?
 *
 * The New Harness box opened on OpenCode for everyone, so a person who installed Harness to run
 * the Claude Code or Codex they already pay for started their first harness on a free model they
 * never chose (fresh macOS VM, 2026-10-08). With these two answers the box can open on the agent
 * the person already uses.
 *
 * Only presence is read, never a secret: credential files are stat'ed or parsed for the presence of
 * a token, and the macOS Keychain item is looked up without `-w`, which prints its attributes and
 * not its password. What cannot be read from here (a Codex that keeps its tokens in the OS keyring)
 * answers null, unknown, rather than "signed out".
 *
 * "Last used" is the newest session folder the engine itself made: Claude Code's project folders
 * under `projects/`, and Codex's `sessions/YYYY/MM/DD` day folder. A file the engine rewrites on
 * every launch (`~/.claude.json`, which Harness's own folder trust writes too) would not say which
 * engine the person works in.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEngine } from '../engines/types.js'
import { warmLoginShellEnvironment } from './loginShellEnv.js'

export interface EngineAccount {
  /** True when a credential is there; false when none is; null when this machine cannot say. */
  readonly signedIn: boolean | null
  /** Milliseconds since the epoch of the engine's latest session activity, or null. */
  readonly lastUsedAt: number | null
}

export interface EngineAccountDeps {
  home?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Whether a macOS Keychain generic-password item with this service exists. */
  keychainHas?: (service: string) => Promise<boolean>
}

const exists = (path: string) => stat(path).then(() => true, () => false)
const mtime = (path: string) => stat(path).then(info => info.mtimeMs, () => null)
const readJson = (path: string) => readFile(path, 'utf8').then(text => JSON.parse(text) as Record<string, unknown>).catch(() => null)

/** `security find-generic-password -s <service>` without `-w`: attributes only, never the secret. */
function keychainHas(service: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile('security', ['find-generic-password', '-s', service], { timeout: 3000 }, error => resolve(!error))
  })
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

/** Claude Code and Codex only; every other engine answers unknown. */
export async function engineAccount(engine: AgentEngine, deps: EngineAccountDeps = {}): Promise<EngineAccount> {
  const home = deps.home ?? homedir()
  // A daemon the app or launchd started never read the person's shell profile: a key or a config
  // folder exported in ~/.zshrc is seen through the login shell's environment, captured once per
  // process (loginShellEnv.ts), with the daemon's own on top.
  const env = deps.env ?? { ...await warmLoginShellEnvironment(), ...process.env }
  const platform = deps.platform ?? process.platform
  if (engine === 'claude') {
    const custom = env.CLAUDE_CONFIG_DIR
    const dir = custom || join(home, '.claude')
    const lastUsedAt = await newestChild(join(dir, 'projects'))
    if (CLAUDE_ENV.some(name => Boolean(env[name]))) return { signedIn: true, lastUsedAt }
    if (await exists(join(dir, '.credentials.json'))) return { signedIn: true, lastUsedAt }
    if (typeof (await readJson(join(dir, 'settings.json')))?.apiKeyHelper === 'string') return { signedIn: true, lastUsedAt }
    if (platform === 'darwin') {
      // Claude Code 2.1 keeps its OAuth token in the Keychain, under a service named for a custom
      // config folder when CLAUDE_CONFIG_DIR is set (`-<sha256(dir)[0..8]>`).
      const service = 'Claude Code-credentials'
        + (custom ? `-${createHash('sha256').update(custom).digest('hex').slice(0, 8)}` : '')
      if (await (deps.keychainHas ?? keychainHas)(service)) return { signedIn: true, lastUsedAt }
    }
    return { signedIn: false, lastUsedAt }
  }
  if (engine === 'codex') {
    const dir = env.CODEX_HOME || join(home, '.codex')
    const lastUsedAt = await newestDay(join(dir, 'sessions'))
    if (env.OPENAI_API_KEY) return { signedIn: true, lastUsedAt }
    const auth = await readJson(join(dir, 'auth.json'))
    const tokens = auth?.tokens as Record<string, unknown> | null | undefined
    if (auth && (auth.OPENAI_API_KEY || (tokens && (tokens.access_token || tokens.refresh_token)))) {
      return { signedIn: true, lastUsedAt }
    }
    // Codex can keep its credentials in the OS keyring instead of auth.json; that is not ours to read.
    const config = await readFile(join(dir, 'config.toml'), 'utf8').catch(() => '')
    if (/^\s*cli_auth_credentials_store\s*=\s*"(keyring|auto)"/m.test(config)) return { signedIn: null, lastUsedAt }
    return { signedIn: false, lastUsedAt }
  }
  return { signedIn: null, lastUsedAt: null }
}
