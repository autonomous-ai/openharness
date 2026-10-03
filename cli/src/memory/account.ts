/** Observe native login identity without retaining or returning credentials. No network or refresh. */
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { oneShotParentEnv } from '../lib/loginShellEnv.js'

export function memoryCodexHome(selected?: string | null, home = homedir(), environment = oneShotParentEnv()): string | null {
  const path = selected || environment.CODEX_HOME || join(home, '.codex')
  return isAbsolute(path) ? path : null
}

/** Only native login files select the extraction account; ambient keys cannot override it. */
export function nativeMemoryEnvironment(): NodeJS.ProcessEnv {
  const parent = oneShotParentEnv()
  // Claude's native credential lookup needs the OS login name on macOS. Omitting it reports
  // signed-out despite an existing login. Bind it to the OS user, not a caller's USER/LOGNAME.
  const username = userInfo().username
  return { PATH: parent.PATH, HOME: homedir(), USER: username, LOGNAME: username,
    TMPDIR: tmpdir(), LANG: parent.LANG || 'en_US.UTF-8', TERM: 'dumb' }
}

export async function memoryAccountIdentity(input: { engine: string; codexHome?: string | null },
  home = homedir(), environment: NodeJS.ProcessEnv = oneShotParentEnv()): Promise<string | null> {
  // These providers are not the selected native subscription supported by the initial adapter.
  if (input.engine === 'claude' && (environment.ANTHROPIC_BASE_URL || environment.ANTHROPIC_AUTH_TOKEN
    || environment.CLAUDE_CONFIG_DIR || environment.CLAUDE_CODE_OAUTH_TOKEN || environment.ANTHROPIC_API_KEY)) return null
  if (input.engine === 'codex' && (environment.CODEX_API_KEY || environment.OPENAI_API_KEY || environment.OPENAI_BASE_URL)) return null
  const codexHome = memoryCodexHome(input.codexHome, home, environment)
  const path = input.engine === 'codex' ? codexHome && join(codexHome, 'auth.json')
    : input.engine === 'claude' ? join(home, '.claude.json') : null
  if (!path) return null
  let handle
  try {
    handle = await open(path, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null
    const value: unknown = JSON.parse(await handle.readFile('utf8'))
    const record = object(value)
    const account = input.engine === 'codex' ? object(record.tokens).account_id : object(record.oauthAccount).accountUuid
    if (typeof account !== 'string' || !account) return null
    // Credential refreshes do not change this key. A login to another account in the same directory does.
    return createHash('sha256').update(JSON.stringify([input.engine, account])).digest('hex')
  } catch { return null } finally { await handle?.close().catch(() => {}) }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
