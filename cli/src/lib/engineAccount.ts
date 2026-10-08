/**
 * Is this machine's Claude Code or Codex signed in, and when was it last used?
 *
 * The New Harness box opened on OpenCode for everyone, so a person who installed Harness to run
 * the Claude Code or Codex they already pay for started their first harness on a free model they
 * never chose (fresh macOS VM, 2026-10-08). With these two answers the box can open on the agent
 * the person already uses.
 *
 * Only presence is read, never a secret: the credential file is stat'ed or parsed for the presence
 * of a token, and the macOS Keychain item is looked up without `-w`, which prints its attributes
 * and not its password. "Last used" is the newest change to the engine's own session folder.
 */
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEngine } from '../engines/types.js'

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

/** `security find-generic-password -s <service>` without `-w`: attributes only, never the secret. */
function keychainHas(service: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile('security', ['find-generic-password', '-s', service], { timeout: 3000 }, error => resolve(!error))
  })
}

function newest(...times: (number | null)[]): number | null {
  const known = times.filter((time): time is number => time !== null)
  return known.length ? Math.max(...known) : null
}

/** Claude Code and Codex only; every other engine answers unknown. */
export async function engineAccount(engine: AgentEngine, deps: EngineAccountDeps = {}): Promise<EngineAccount> {
  const home = deps.home ?? homedir()
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  if (engine === 'claude') {
    const dir = env.CLAUDE_CONFIG_DIR || join(home, '.claude')
    const signedIn = Boolean(env.ANTHROPIC_API_KEY)
      || await exists(join(dir, '.credentials.json'))
      // Claude Code 2.1 keeps its OAuth token in the Keychain on macOS (`Claude Code-credentials`).
      || (platform === 'darwin' && await (deps.keychainHas ?? keychainHas)('Claude Code-credentials'))
    return { signedIn, lastUsedAt: newest(await mtime(join(dir, 'projects')), await mtime(join(home, '.claude.json'))) }
  }
  if (engine === 'codex') {
    const dir = env.CODEX_HOME || join(home, '.codex')
    let signedIn = Boolean(env.OPENAI_API_KEY)
    if (!signedIn) {
      try {
        const auth = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as Record<string, unknown>
        const tokens = auth.tokens as Record<string, unknown> | null | undefined
        signedIn = Boolean(auth.OPENAI_API_KEY) || Boolean(tokens && (tokens.access_token || tokens.refresh_token))
      } catch { signedIn = false }
    }
    return { signedIn, lastUsedAt: await mtime(join(dir, 'sessions')) }
  }
  return { signedIn: null, lastUsedAt: null }
}
