/**
 * The machine owner's Claude and ChatGPT subscriptions, as the guest subscription relay spends them
 * (`subscriptionRelay.ts`, docs/plans/2026-10-19-guest-machine-sharing-plan.md).
 *
 * The owner's sign-in is read where the vendor's CLI keeps it (`agentCredentials.ts`) and, when its
 * access token has expired, refreshed and **written back to the same store** — the Keychain item it
 * came from, or the file, its mode kept — so the owner's own `claude` and `codex` keep working with
 * the rotated refresh token. Refreshes are single-flight in this process and serialised across
 * processes with a lock file, and every refresh first re-reads the store: when the owner's CLI (or
 * another daemon) has refreshed in the meantime, that token is used and nothing is spent.
 *
 * ⚠️ Nothing here ever logs, returns in an error, or puts in a child's argv a token: the Keychain
 * write goes through `security -i` on stdin, hex-encoded, so another local user's `ps` never sees it.
 *
 * ⚠️ Undocumented vendor contracts, see the constants below for what was verified and what is
 * assumed.
 */
import { execFile, spawn } from 'node:child_process'
import { open, rename, stat, unlink, mkdir, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  asRecord,
  CLAUDE_KEYCHAIN_SERVICE,
  claudeCredentialsPath,
  codexAuthPath,
  jwtClaims,
  parseJson,
  readClaudeStored,
  readText,
  stringField,
  type ClaudeCredentialSource,
} from './agentCredentials.js'

const execFileAsync = promisify(execFile)

/**
 * Claude Code's OAuth refresh. **Verified** against the Claude Code 2.1.283 binary on the author's
 * machine (2026-10-19): `TOKEN_URL: "https://platform.claude.com/v1/oauth/token"` and
 * `CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e"` in its prod OAuth config. **Assumed** (not
 * read from the bundle): the body is the standard JSON `{grant_type, refresh_token, client_id}` and
 * the answer `{access_token, refresh_token?, expires_in}`.
 */
export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/**
 * Codex's (ChatGPT sign-in) OAuth refresh. **Assumed, not verified** on this machine: the token URL,
 * the public client id and the scope are those the open-source Codex CLI is documented to use. Kept
 * behind constants so a change is one edit.
 */
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_REFRESH_SCOPE = 'openid profile email'

export type SubscriptionProvider = 'claude' | 'codex'

/** One owner sign-in, as the relay spends it. */
export interface OwnerCredential {
  provider: SubscriptionProvider
  accessToken: string
  /** Epoch ms, or null when the store does not say. */
  expiresAt: number | null
  /** Codex: the ChatGPT account the backend scopes requests to. */
  accountId: string | null
}

export interface OwnerSubscriptions {
  /** The owner's current sign-in for [provider], or null when the owner is not signed in. */
  read(provider: SubscriptionProvider): Promise<OwnerCredential | null>
  /**
   * A fresh sign-in, given the one that just failed or expired. Returns another process's newer
   * token when there is one, else refreshes and writes back. Null when there is no sign-in to
   * refresh or the vendor refused (the caller answers as it would without a sign-in).
   */
  refresh(provider: SubscriptionProvider, stale: OwnerCredential | null): Promise<OwnerCredential | null>
}

/** What a Keychain write needs: the item's account attribute and the secret, never in argv. */
export interface KeychainWriter {
  /** The `acct` attribute of the existing item, so the write replaces it rather than adding one. */
  account(): Promise<string | null>
  write(account: string, secret: string): Promise<void>
}

export interface OwnerSubscriptionDeps {
  home?: string
  platform?: NodeJS.Platform
  readKeychain?: () => Promise<string | null>
  keychain?: KeychainWriter
  fetchImpl?: typeof fetch
  now?: () => number
  /** Where the cross-process refresh lock lives. */
  lockDir?: string
  tokenUrls?: Partial<Record<SubscriptionProvider, string>>
}

/** A token that expires within this long is refreshed before it is spent. */
export const EXPIRY_SKEW_MS = 60_000
const REFRESH_TIMEOUT_MS = 15_000
const LOCK_WAIT_MS = 20_000
const LOCK_STALE_MS = 30_000

/** An error that is safe to show: it never carries a token or a vendor body. */
export class OwnerSubscriptionError extends Error {}

export function createOwnerSubscriptions(deps: OwnerSubscriptionDeps = {}): OwnerSubscriptions {
  const home = deps.home ?? homedir()
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetchImpl ?? fetch
  const lockDir = deps.lockDir ?? join(home, '.harness', 'cli', 'data', 'locks')
  const keychain = deps.keychain ?? securityKeychain()
  const readDeps = { home, platform: deps.platform, readKeychain: deps.readKeychain }
  const inFlight = new Map<SubscriptionProvider, Promise<OwnerCredential | null>>()

  const read = async (provider: SubscriptionProvider): Promise<OwnerCredential | null> =>
    provider === 'claude' ? (await readClaude(readDeps))?.credential ?? null : (await readCodex(home))?.credential ?? null

  const refreshNow = async (provider: SubscriptionProvider, stale: OwnerCredential | null): Promise<OwnerCredential | null> => {
    const release = await acquireLock(join(lockDir, `${provider}-refresh.lock`))
    try {
      // Someone else may have refreshed while this one waited: theirs wins, nothing is spent.
      const current = await read(provider)
      if (!current) return null
      if (current.accessToken !== stale?.accessToken && !expired(current, now())) return current
      return provider === 'claude' ? await refreshClaude() : await refreshCodex()
    } finally {
      await release()
    }
  }

  const refreshClaude = async (): Promise<OwnerCredential | null> => {
    const stored = await readClaude(readDeps)
    const refreshToken = stringField(stored?.oauth.refreshToken)
    if (!stored || !refreshToken) return null
    const answer = await postToken(fetchImpl, deps.tokenUrls?.claude ?? CLAUDE_TOKEN_URL, {
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID,
    })
    if (!answer) return null
    const accessToken = stringField(answer.access_token)
    if (!accessToken) return null
    const expiresIn = typeof answer.expires_in === 'number' ? answer.expires_in : null
    const oauth = {
      ...stored.oauth,
      accessToken,
      refreshToken: stringField(answer.refresh_token) ?? refreshToken,
      ...(expiresIn !== null ? { expiresAt: now() + expiresIn * 1000 } : {}),
    }
    const root = JSON.stringify({ ...stored.root, claudeAiOauth: oauth })
    if (stored.source === 'keychain') {
      const account = (await keychain.account()) ?? userInfo().username
      await keychain.write(account, root)
    } else {
      await writeKeepingMode(claudeCredentialsPath(home), root)
    }
    return claudeCredential(oauth)
  }

  const refreshCodex = async (): Promise<OwnerCredential | null> => {
    const stored = await readCodex(home)
    const refreshToken = stringField(stored?.tokens.refresh_token)
    if (!stored || !refreshToken) return null
    const answer = await postToken(fetchImpl, deps.tokenUrls?.codex ?? CODEX_TOKEN_URL, {
      client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken, scope: CODEX_REFRESH_SCOPE,
    })
    const accessToken = stringField(answer?.access_token)
    if (!answer || !accessToken) return null
    const tokens = {
      ...stored.tokens,
      access_token: accessToken,
      refresh_token: stringField(answer.refresh_token) ?? refreshToken,
      ...(stringField(answer.id_token) ? { id_token: answer.id_token } : {}),
    }
    await writeKeepingMode(codexAuthPath(home), JSON.stringify({
      ...stored.root, tokens, last_refresh: new Date(now()).toISOString(),
    }, null, 2))
    return codexCredential(tokens)
  }

  return {
    read,
    refresh(provider, stale) {
      const running = inFlight.get(provider)
      if (running) return running
      const attempt = refreshNow(provider, stale).finally(() => inFlight.delete(provider))
      inFlight.set(provider, attempt)
      return attempt
    },
  }
}

/** Whether [credential] is spent or about to be. */
export function expired(credential: OwnerCredential, at: number): boolean {
  return credential.expiresAt !== null && credential.expiresAt <= at + EXPIRY_SKEW_MS
}

interface StoredClaude {
  root: Record<string, unknown>
  oauth: Record<string, unknown>
  source: ClaudeCredentialSource
  credential: OwnerCredential
}

async function readClaude(deps: { home: string; platform?: NodeJS.Platform; readKeychain?: () => Promise<string | null> }): Promise<StoredClaude | null> {
  const stored = await readClaudeStored(deps)
  const root = asRecord(parseJson(stored?.raw ?? null))
  const oauth = asRecord(root?.claudeAiOauth)
  if (!stored || !root || !oauth || !stringField(oauth.accessToken)) return null
  return { root, oauth, source: stored.source, credential: claudeCredential(oauth) }
}

function claudeCredential(oauth: Record<string, unknown>): OwnerCredential {
  return {
    provider: 'claude',
    accessToken: String(oauth.accessToken),
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    accountId: null,
  }
}

interface StoredCodex {
  root: Record<string, unknown>
  tokens: Record<string, unknown>
  credential: OwnerCredential
}

async function readCodex(home: string): Promise<StoredCodex | null> {
  const root = asRecord(parseJson(await readText(codexAuthPath(home))))
  const tokens = asRecord(root?.tokens)
  if (!root || !tokens || !stringField(tokens.access_token)) return null
  return { root, tokens, credential: codexCredential(tokens) }
}

function codexCredential(tokens: Record<string, unknown>): OwnerCredential {
  // auth.json keeps no expiry of its own; the access token is a JWT that does.
  const exp = jwtClaims(tokens.access_token)?.exp
  return {
    provider: 'codex',
    accessToken: String(tokens.access_token),
    expiresAt: typeof exp === 'number' ? exp * 1000 : null,
    accountId: stringField(tokens.account_id),
  }
}

/** The vendor's token answer, or null when it refused or could not be reached. Never throws a
 *  message that could carry the refresh token or the vendor's body. */
async function postToken(fetchImpl: typeof fetch, url: string, body: Record<string, string>): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    })
    if (!response.ok) return null
    return asRecord(parseJson(await response.text()))
  } catch {
    return null
  }
}

/** Atomic replace in the same directory, keeping the file's mode (0600 when it had none). */
async function writeKeepingMode(path: string, content: string): Promise<void> {
  let mode = 0o600
  try { mode = (await stat(path)).mode & 0o777 } catch { /* a new file: 0600 */ }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, content, { mode })
    await rename(temporary, path)
  } catch {
    await unlink(temporary).catch(() => {})
    throw new OwnerSubscriptionError(`Could not save the refreshed sign-in to ${path}.`)
  }
}

/**
 * An exclusive lock file. A lock older than LOCK_STALE_MS is a crashed holder's and is taken over;
 * one held longer than LOCK_WAIT_MS by a live holder is waited out no further (the refresh then
 * runs anyway: a second refresh is wasteful, never wrong, because each re-reads the store first).
 */
async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.close()
      return async () => { await unlink(path).catch(() => {}) }
    } catch {
      try {
        const age = Date.now() - (await stat(path)).mtimeMs
        if (age > LOCK_STALE_MS) { await unlink(path).catch(() => {}); continue }
      } catch { continue }
      if (Date.now() > deadline) return async () => {}
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

/**
 * The login Keychain through `security`. The secret is written with `security -i`, which reads its
 * commands from stdin, hex-encoded (`-X`), so it is neither in argv (visible to every local user's
 * `ps`) nor in need of shell quoting.
 */
export function securityKeychain(): KeychainWriter {
  return {
    async account() {
      try {
        // Attributes only — no `-w`, so the secret is not printed.
        const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE], { timeout: 5_000 })
        const match = /"acct"<blob>="([^"]*)"/.exec(stdout)
        return match?.[1] || null
      } catch {
        return null
      }
    },
    write(account, secret) {
      return new Promise((resolve, reject) => {
        const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] })
        const quoted = (value: string): string => `"${value.replace(/(["\\])/g, '\\$1')}"`
        const hex = Buffer.from(secret, 'utf8').toString('hex')
        child.on('error', () => reject(new OwnerSubscriptionError('Could not save the refreshed sign-in to the Keychain.')))
        child.on('close', (code) => code === 0
          ? resolve()
          : reject(new OwnerSubscriptionError('Could not save the refreshed sign-in to the Keychain.')))
        child.stdin.end(`add-generic-password -U -s ${quoted(CLAUDE_KEYCHAIN_SERVICE)} -a ${quoted(account)} -X ${hex}\n`)
      })
    },
  }
}
