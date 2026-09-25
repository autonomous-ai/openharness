import type { IncomingMessage, Server, ServerResponse } from 'http'
import { renderLoginSuccessHtml } from './loginPage.js'

export interface LoginCallbackParams { code: string; state: string }

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
} {
  const read = (params: URLSearchParams) => ({
    code: params.get('code'),
    state: params.get('state'),
    error: params.get('error'),
  })
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
    else if (code && state) resolve({ code, state })
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
