/**
 * Where the grid's web tools are, remembered until the token behind them is due for renewal.
 *
 * One more `grid` subprocess on the seam `gridExec.ts` owns: `grid mcp config <grid> --json` prints
 * `{ server, url, authorization }`, and the daemon wants exactly one of the three. The URL is the
 * control plane's web-tools mount — a per-account address that does not change between calls — and
 * `authorization` is the SAME per-grid token `grid info --env` prints as the inference key, which
 * `gridModels.ts` reads on every retarget anyway. So the token is decoded for its `exp`, and then
 * dropped: it is never stored here, never logged, and never travels anywhere `gridLaunch.ts` does
 * not already carry it.
 *
 * ## Why a cache, and why keyed on `exp`
 *
 * `grid mcp config` renews the token when it is within [MCP_URL_RENEW_MARGIN_MS] of `exp` and
 * persists the renewal (autonomous-grid `cli/mcp_config.py`, `EXPIRY_MARGIN_SECONDS`); `info --env`
 * never renews. Nothing else on the harness path renews either, so this call is what keeps a
 * harness user's grid token alive — and re-running it inside that margin ALWAYS renews. The margin
 * here equals the CLI's own on purpose: a smaller one would re-run without renewing and re-run
 * again tomorrow; a larger one would renew earlier than the CLI would have. Outside the margin the
 * call is pure overhead, which is what the entry saves.
 *
 * An entry is only ever a URL and a deadline, in daemon memory, keyed by grid name — so a grid
 * re-minted under a new name cannot hit a stale entry — and a failure is never cached: the next
 * retarget asks again, because the condition (no sign-in, an old binary) may have been fixed since.
 *
 * ## Sign-out
 *
 * Every harness sign-out path stops the daemon (`logout`, `reset`, and `onRevoked` in `cli.ts`), so
 * the process's memory goes with it. [clearGridMcpUrlCache] exists for the one in-process path —
 * revocation — and so the contract "dropped on sign-out" is a call a test can make rather than a
 * property of process lifetime.
 *
 * The one sign-out that is NOT a harness sign-out, `harness grid logout`, is a passthrough in a
 * separate process and leaves a running daemon's entry where it is. That is harmless by
 * construction: an entry is only a URL, and the next retarget's `info --env` fails without a
 * credential, so `resolveGridTarget` answers null and no launch is built to carry it.
 */
import { gridJson, type GridResult } from './gridExec.js'

/**
 * How close to `exp` still counts as "ask again". ↔ `EXPIRY_MARGIN_SECONDS` in autonomous-grid's
 * `cli/mcp_config.py` (30 days); see the module comment for why the two must agree.
 */
export const MCP_URL_RENEW_MARGIN_MS = 30 * 24 * 60 * 60 * 1000

/** How much of `grid`'s stderr a log line carries. The reason is in its first sentence. */
const MAX_LOGGED_REASON_CHARS = 300

/** The two fields of `grid mcp config --json` read here (`server` is not). `url` is kept;
 *  `authorization` is read for `exp` and dropped. */
interface McpConfigDocument {
  url?: unknown
  authorization?: unknown
}

interface CachedMcpUrl {
  mcpUrl: string
  /** The token's `exp`, in ms. Always a real instant — an undecodable token is never cached. */
  expMs: number
}

const cache = new Map<string, CachedMcpUrl>()

/** Forget every entry. Called on the daemon's in-process sign-out path; see the module comment. */
export function clearGridMcpUrlCache(): void {
  cache.clear()
}

/**
 * The `exp` claim of the JWT in a `Bearer …` header, in ms, or null when it cannot be read.
 *
 * Offline and unverified, exactly as the grid CLI's own `credentials.token_expiry` reads it: this
 * decides only WHEN to ask again, never whether the token is trusted. `true` is excluded explicitly
 * — a boolean `exp` would otherwise read as 1, epoch 1970, and re-run forever.
 */
function tokenExpiryMs(authorization: unknown): number | null {
  if (typeof authorization !== 'string') return null
  const token = authorization.replace(/^Bearer\s+/i, '').trim()
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
    const exp = claims.exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
  } catch {
    return null
  }
}

/** An address an engine can be handed, or null. Same rule as `gridLaunch.ts`'s `urlProblem`. */
function usableMcpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? value : null
  } catch {
    return null
  }
}

/**
 * One line saying why `grid mcp config` gave no answer, for the daemon log.
 *
 * `gridExec` already turns an old or missing binary into a sentence naming the remedy, and that
 * beats argparse's `invalid choice: 'mcp'`. For a plain failure the sentence is grid's own — its
 * first line of stderr ("Not logged in", "no grid named …") — and NEVER stdout: on success stdout
 * is the document carrying the token, and a failure that somehow printed one would land it here.
 */
function failureReason(result: GridResult): string {
  if (result.code !== 'GRID_FAILED') return result.message
  return result.stderr.trim().split('\n')[0]?.slice(0, MAX_LOGGED_REASON_CHARS) || result.message
}

/**
 * The grid's web-tools MCP URL, or undefined when it cannot be obtained.
 *
 * Undefined is a degraded answer, not a failure: the caller retargets without web tools and the
 * reason is on the daemon log. Never throws. `now` is a parameter so a spec can move the clock
 * without faking timers.
 */
export async function resolveGridMcpUrl(gridName: string, now: number = Date.now()): Promise<string | undefined> {
  const cached = cache.get(gridName)
  if (cached && cached.expMs - now >= MCP_URL_RENEW_MARGIN_MS) return cached.mcpUrl

  const { value, result } = await gridJson<McpConfigDocument>(['--remote', 'mcp', 'config', gridName])
  if (result.code !== 'OK' || !value) {
    console.warn(`[grid] web tools unavailable for ${gridName} · ${failureReason(result)}`)
    return undefined
  }
  const mcpUrl = usableMcpUrl(value.url)
  if (!mcpUrl) {
    console.warn(`[grid] web tools unavailable for ${gridName} · \`grid mcp config\` printed no usable url`)
    return undefined
  }
  const expMs = tokenExpiryMs(value.authorization)
  if (expMs === null) {
    // Safe, slow, and loud: the next retarget asks again, and the log says why.
    console.warn(`[grid] web tools for ${gridName} · token expiry unreadable, not caching`)
    return mcpUrl
  }
  cache.set(gridName, { mcpUrl, expMs })
  return mcpUrl
}
