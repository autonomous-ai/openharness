/**
 * This machine's agent-account usage — Claude's and Codex's rate limits — read with THIS machine's
 * own credentials, for a client that cannot read them itself.
 *
 * The desktop app reads the account on the computer it runs on directly. A remote machine may be
 * signed in to a DIFFERENT account, and a rate limit belongs to an account rather than to a
 * computer, so the only honest way to show that one is to ask the machine that holds it. This is the
 * answer to `usage_read`.
 *
 * **The credential never leaves this machine.** The vendor is called from here, and what goes back
 * over the encrypted relay is the vendor's answer, an opaque account key and an optional email
 * for display. Never the token or raw account id. Clients redact email metadata from logs.
 *
 * **Deliberately a thin proxy, not a parser.** The body is returned as the vendor sent it, and the
 * client interprets it with the SAME code that interprets its own local reading
 * (`autonomous-harness-desktop/lib/usage/*_usage_source.dart`). Parsing it here would put the
 * window-naming rules — "five_hour" is "Session", Codex derives its labels from
 * `limit_window_seconds`, Fable has been spelled three ways — in two languages, and the two copies
 * would drift the first time either vendor renamed a field.
 *
 * ⚠️ **Both endpoints are undocumented**, on exactly the terms the desktop app uses them: they are
 * what `claude /usage` and the Codex CLI ask, the Claude one answers only a token minted for Claude
 * Code (hence the beta header and the CLI's own user agent), and either can change without notice.
 * Every failure here is an `outcome`, never a throw — the reply must go back either way.
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import {
  asRecord,
  claudeProfilePath,
  codexAuthPath,
  jwtClaims,
  parseJson,
  readClaudeStored,
  readText,
  stringField,
} from './agentCredentials.js'

export type UsageProviderId = 'claude' | 'codex'

/**
 * How far the question got. `answered` means the vendor was asked and replied — WHATEVER it
 * replied, a 401 included; the client decides what a status means, because it already does for
 * its own reading.
 */
export type UsageOutcome = 'answered' | 'signedOut' | 'unreachable'

export interface AccountUsageReading {
  provider: UsageProviderId
  /**
   * `accountKey(provider, id)`, or null when this machine cannot name the account it is signed in
   * as. The client compares these to show one figure per ACCOUNT rather than one per machine.
   */
  account: string | null
  /** Display label only; account identity and deduplication still use `account`. */
  email?: string
  outcome: UsageOutcome
  httpStatus?: number
  body?: unknown
  /** Why there is no answer, when this side knows better than a status code can say. */
  message?: string
}

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/** Under the client's own 10s request timeout, so a slow vendor still produces a reply. */
const FETCH_TIMEOUT_MS = 8_000

/**
 * An account, as the wire names it: the first 16 hex characters of sha256(`<provider>:<id>`).
 *
 * Hashed rather than sent raw because the reply is LOGGED — the desktop writes every RPC answer to
 * `~/.harness/logs` — and a raw account id has no business there. Email display metadata is separate
 * and redacted by clients; equality uses this stable key rather than a display label.
 *
 * ⚠️ **A cross-language contract.** The desktop computes the same key for its own account
 * (`lib/usage/usage_account_key.dart`) and the two must agree byte for byte, or every remote reading
 * would look like a different account. Both test suites pin the same vector for that reason.
 */
export function accountKey(provider: UsageProviderId, accountId: string): string {
  return createHash('sha256').update(`${provider}:${accountId}`).digest('hex').slice(0, 16)
}

/** Everything that reaches outside this function, so a spec never touches a real home, keychain or
 *  network. Production passes nothing. */
export interface AccountUsageDeps {
  home?: string
  platform?: NodeJS.Platform
  fetchImpl?: typeof fetch
  readKeychain?: () => Promise<string | null>
  now?: () => number
}

/** Both accounts, asked at once — one being slow says nothing about the other. */
export async function readAccountUsage(deps: AccountUsageDeps = {}): Promise<AccountUsageReading[]> {
  return Promise.all([readClaude(deps), readCodex(deps)])
}

async function readClaude(deps: AccountUsageDeps): Promise<AccountUsageReading> {
  const home = deps.home ?? homedir()
  // The Keychain first and the file second (`agentCredentials.ts`).
  const stored = (await readClaudeStored(deps))?.raw ?? null
  const oauth = asRecord(asRecord(parseJson(stored))?.claudeAiOauth)
  const token = stringField(oauth?.accessToken)
  // The account lives beside the token rather than in it: `~/.claude.json` is where Claude Code
  // records who it is signed in as, on every platform.
  const profile = asRecord(asRecord(parseJson(await readText(claudeProfilePath(home))))?.oauthAccount)
  const accountId = stringField(profile?.accountUuid)
  const email = emailField(profile?.emailAddress)
  const account = accountId ? accountKey('claude', accountId) : null
  if (!token) return { provider: 'claude', account, outcome: 'signedOut' }

  // Spent as a sign-in rather than as a round trip: nothing here refreshes a token Claude Code owns,
  // so the request could only fail. The sentence is the desktop's own, word for word.
  const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : null
  if (expiresAt !== null && expiresAt < (deps.now ?? Date.now)()) {
    return {
      provider: 'claude',
      account,
      outcome: 'signedOut',
      message: 'Claude session expired — run claude to sign in again',
    }
  }
  return ask('claude', account, CLAUDE_USAGE_URL, {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': 'claude-code/2.1.0',
  }, deps, email)
}

async function readCodex(deps: AccountUsageDeps): Promise<AccountUsageReading> {
  const home = deps.home ?? homedir()
  const tokens = asRecord(asRecord(parseJson(await readText(codexAuthPath(home))))?.tokens)
  const token = stringField(tokens?.access_token)
  const accountId = stringField(tokens?.account_id)
  const account = accountId ? accountKey('codex', accountId) : null
  const email = tokenEmail(tokens?.id_token)
  if (!token) return { provider: 'codex', account, outcome: 'signedOut' }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  // The account the backend scopes the reading to — the same id the key above is made from.
  if (accountId) headers['ChatGPT-Account-Id'] = accountId
  return ask('codex', account, CODEX_USAGE_URL, headers, deps, email)
}

async function ask(
  provider: UsageProviderId,
  account: string | null,
  url: string,
  headers: Record<string, string>,
  deps: AccountUsageDeps,
  email: string | null,
): Promise<AccountUsageReading> {
  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    const text = await response.text()
    return { provider, account, ...(email ? { email } : {}), outcome: 'answered', httpStatus: response.status, body: parseJson(text) }
  } catch {
    // No detail on purpose: a network error's message can carry the URL, and the client already
    // knows which vendor it asked.
    return { provider, account, outcome: 'unreachable' }
  }
}

function emailField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** ID-token claims supply a display label only, never an authentication decision. */
function tokenEmail(value: unknown): string | null {
  return emailField(jwtClaims(value)?.email)
}
