import type { IncomingMessage, Server, ServerResponse } from 'http'
import { renderLoginSuccessHtml } from './loginPage.js'

/** The `utm_*` and `rid` of a sign-in, under their URL keys. See callbackAttribution. */
export type CallbackAttribution = Record<string, string>

export interface LoginCallbackParams {
  code: string
  state: string
  /** Where the sign-in came from, for `/api/auth/exchange` to record on the account. */
  attribution?: CallbackAttribution
}

/**
 * The keys auth.autonomous.ai carries back onto the callback: the `utm_*` tags and Autonomous's referral
 * id `rid`. The marketing site (autonomous.ai/harness-app, where the desktop app is downloaded) leaves
 * them in `.autonomous.ai` cookies, and the sign-in page appends them to our redirect_uri. Same keys as
 * the web client (desktop/lib/viewer/sign_in_attribution.dart) and the backend (lib/signInAttribution.ts).
 */
const ATTRIBUTION_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'rid'] as const

/**
 * The [ATTRIBUTION_KEYS] of a callback, under their URL keys, or nothing when it carries none. Empty
 * values are dropped: the site sets `utm_term=` and `utm_content=` even when the link had neither.
 * The backend filters and caps these again — the code exchange is reachable by anyone holding a code.
 */
export function callbackAttribution(params: URLSearchParams): CallbackAttribution | undefined {
  const attribution: CallbackAttribution = {}
  for (const key of ATTRIBUTION_KEYS) {
    const value = params.get(key)?.trim()
    if (value) attribution[key] = value
  }
  return Object.keys(attribution).length ? attribution : undefined
}

/** The exact message `harness login --json` maps to `code: 'TIMEOUT'` — keep the string stable. */
export const LOGIN_TIMEOUT_MESSAGE = 'SSO login timed out'

/**
 * Pulls `code`/`state`/`error` out of whatever the user pasted — the full callback URL, just its query
 * string (with or without a leading `?`), or a bare `code=...&state=...` pair with no URL shape at all.
 * `new URL(input, redirectUri)` is permissive (the base absorbs most shapes), but a bare `code=...&state=...`
 * parses as a relative PATH against that base, landing in an empty query — so a URL parse that comes up
 * empty falls back to treating the whole input as a raw query string instead. It is not infallible:
 * a mangled paste (`http://`, a space in the host) throws "Invalid URL", which inside the prompt's
 * callback would have been an uncaught exception ending the whole login — so a throw is the same as
 * an empty parse, and the prompt simply asks again.
 */
export function extractCallbackParams(input: string, redirectUri: string): {
  code: string | null
  state: string | null
  error: string | null
  attribution?: CallbackAttribution
} {
  const read = (params: URLSearchParams) => {
    const attribution = callbackAttribution(params)
    return {
      code: params.get('code'),
      state: params.get('state'),
      error: params.get('error'),
      ...(attribution ? { attribution } : {}),
    }
  }
  try {
    const viaUrl = read(new URL(input, redirectUri).searchParams)
    if (viaUrl.code || viaUrl.state || viaUrl.error) return viaUrl
  } catch { /* not a URL at all — read it as a query string below */ }
  return read(new URLSearchParams(input))
}

/**
 * The race `harness login` waits on: the browser's redirect landing on the loopback `server`, the
 * user pasting that URL back in (`manual`, a TTY over SSH), or `timeoutMs` running out.
 *
 * The timer is unref'd AND cleared on every way out — it was only ever cleared inside the request
 * handler, so a login completed by pasting left it armed and ref'd, and the process sat there for
 * the remaining five minutes after printing "✓ Signed in" (issue #112, a headless VPS). A timer whose
 * only job is to reject must never be what keeps the process alive.
 */
export function awaitLoginCallback(opts: {
  server: Server
  redirectUri: string
  manual: Promise<LoginCallbackParams> | null
  timeoutMs: number
  /** Who asked for this sign-in — it changes one sentence on the page. See renderLoginSuccessHtml. */
  entryPoint?: string
}): Promise<LoginCallbackParams> {
  const { server, redirectUri, manual, timeoutMs, entryPoint } = opts
  let timeout: NodeJS.Timeout | undefined
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', redirectUri)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')
    res.writeHead(error || !code || !state ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(error || !code || !state
      ? '<h1>Harness login failed</h1><p>You can close this window.</p>'
      : renderLoginSuccessHtml(entryPoint))
    if (error) reject(new Error(`SSO login failed: ${error}`))
    else if (code && state) {
      const attribution = callbackAttribution(url.searchParams)
      resolve({ code, state, ...(attribution ? { attribution } : {}) })
    }
  }
  // Hoisted so the handler above can settle the promise, and be removed once it has: the server
  // outlives this race (it is closed by the caller), and a late redirect must not touch a settled login.
  let resolve!: (value: LoginCallbackParams) => void
  let reject!: (reason: Error) => void
  return new Promise<LoginCallbackParams>((res, rej) => {
    resolve = res
    reject = rej
    timeout = setTimeout(() => reject(new Error(LOGIN_TIMEOUT_MESSAGE)), timeoutMs)
    timeout.unref?.()
    server.on('request', onRequest)
    manual?.then(resolve, reject)
  }).finally(() => {
    clearTimeout(timeout)
    server.off('request', onRequest)
  })
}
