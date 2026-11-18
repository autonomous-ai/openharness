/**
 * A page a program in a harness's pane opens — Claude Code's `/login`, `gh auth login` — opened where the person
 * is. Every engine pane's `BROWSER` is this daemon's shim (services/browserShim.ts), which asks here first
 * (`browser_open`, from a tool client on this computer). The page goes to the phone that last typed into that
 * pane; otherwise the shim opens this computer's browser, as the program would have.
 *
 * A sign-in that returns to the program at `http://localhost:PORT/callback` would land on the phone's own
 * localhost. The phone listens there itself, catches the redirect and sends it back (`browser_callback`), and it
 * is replayed here, to the program still waiting on that port. Only to a port and path a page sent to that very
 * phone named, once, while it is fresh: a wrong redirect is not harmless (Claude Code drops the whole sign-in on
 * a mismatched `state`), and a phone must not reach arbitrary ports of this computer.
 */

import type { CoreApi, ServiceRequest } from '../core/api.js'

/** Who typed into an agent's terminal last, as the terminal stream knows them. */
export interface InputSource {
  connId: string
  /** What the client said it is on `terminal_open` (`phone`, `desktop`, `web`…); null when it said nothing. */
  kind: string | null
}

export interface BrowserDeps {
  follow?: CoreApi['agents']['follow']
  /** The harness whose pane this is (`$TMUX_PANE` of the program opening the page). */
  agentOfPane: (pane: string) => string | undefined | Promise<string | undefined>
  /** A frame for one client, sealed to it when it is remote; false when it cannot be sent. */
  sendTo: (connId: string, type: string, payload: Record<string, unknown>) => boolean
  isLocal: (connId: string) => boolean
  /** Who is on a connection, the same across its reconnects (a paired phone's key). The phone's line drops
   *  while the browser covers the app, and it sends the redirect back over a new connection. */
  who: (connId: string) => string | null
  /** GET [url] on this computer; resolves with the HTTP status, and where the program sends the browser next. */
  replay: (url: string, signal: AbortSignal) => Promise<{ status: number; location: string | null }>
  now: () => number
  /** One line about what happened, for the daemon's log. Never the page or the redirect: they carry codes. */
  log: (line: string) => void
}

/** How long a phone has to sign in and send the redirect back. */
export const CALLBACK_FOR_MS = 10 * 60_000
export const CALLBACKS_MAX = 256
export const CALLBACKS_PER_PEER = 8
export const BROWSER_URL_MAX = 16_384
export const BROWSER_SOURCES_MAX = 4096
export const CALLBACK_WAIT_MS = 30_000
export const CALLBACKS_ACTIVE_MAX = 4

/** The program's own pages after its callback a replay follows, as the phone's browser would have. */
const FOLLOWED_PAGES = 3

interface Pending { agentId: string; who: string; port: string; path: string; until: number }

const LOOPBACK = new Set(['localhost', '127.0.0.1'])

/** The `http://localhost:PORT/...` a page will redirect to, when it is that kind of sign-in. */
function loopbackRedirect(page: URL): URL | null {
  try {
    const redirect = new URL(page.searchParams.get('redirect_uri') ?? '')
    return redirect.protocol === 'http:' && LOOPBACK.has(redirect.hostname) && redirect.port ? redirect : null
  } catch {
    return null
  }
}

export function createBrowser(deps: BrowserDeps) {
  const lastInput = new Map<string, InputSource>()
  const pending: Pending[] = []
  const active = new Map<AbortController, string>()
  let stopped = false

  const expire = (): void => {
    const now = deps.now()
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.until < now) pending.splice(i, 1)
  }

  /** The terminal stream's `onInput`: keystrokes a person typed, and from where. */
  const typed = (agentId: string, source: InputSource): void => {
    if (stopped || agentId.length > 128 || source.connId.length > 256) return
    // A local/non-phone input revokes routing; it needs no retained source of its own.
    if (source.kind !== 'phone' || deps.isLocal(source.connId)) { lastInput.delete(agentId); return }
    if (!lastInput.has(agentId) && lastInput.size >= BROWSER_SOURCES_MAX) {
      deps.log('[browser] SOURCE_LIMIT')
      return
    }
    lastInput.set(agentId, { ...source })
  }

  /** `browser_open` {pane, url}: whether a phone took the page. False tells the shim to open it here. */
  const open = async (payload: Record<string, unknown>, closed?: AbortSignal): Promise<Record<string, unknown>> => {
    if (stopped || closed?.aborted || typeof payload.pane !== 'string' || payload.pane.length > 256
      || typeof payload.url !== 'string' || payload.url.length > BROWSER_URL_MAX) return { handled: false }
    let page: URL
    try { page = new URL(payload.url) } catch { return { handled: false } }
    if (page.href.length > BROWSER_URL_MAX || page.protocol !== 'https:' && page.protocol !== 'http:') return { handled: false }
    let agentId: string | undefined
    try { agentId = await deps.agentOfPane(payload.pane) } catch {
      deps.log('[browser] PANE_UNAVAILABLE')
      return { handled: false }
    }
    const source = agentId ? lastInput.get(agentId) : undefined
    if (stopped || closed?.aborted || !agentId || !source) return { handled: false }
    const who = deps.who(source.connId)
    if (!who || who.length > 256) return { handled: false }
    expire()
    const redirect = loopbackRedirect(page)
    if (redirect && (pending.length >= CALLBACKS_MAX || pending.filter(entry => entry.who === who).length >= CALLBACKS_PER_PEER)) {
      deps.log('[browser] CALLBACK_LIMIT')
      return { handled: false }
    }
    const expected = redirect ? { agentId, who, port: redirect.port, path: redirect.pathname, until: deps.now() + CALLBACK_FOR_MS } : null
    if (expected) pending.push(expected)
    if (!deps.sendTo(source.connId, 'browser_open', { agentId, url: page.href })) {
      const at = expected ? pending.indexOf(expected) : -1
      if (at !== -1) pending.splice(at, 1)
      deps.log('[browser] PAGE_NOT_SENT')
      return { handled: false }
    }
    deps.log('[browser] PAGE_SENT')
    return { handled: true }
  }

  /** `browser_callback` {url} from [connId]: the redirect the phone caught, replayed to the waiting program. */
  const callback = async (payload: Record<string, unknown>, connId: string, closed?: AbortSignal): Promise<Record<string, unknown>> => {
    if (stopped || closed?.aborted) return { error: 'NOT_EXPECTED' }
    if (typeof payload.url !== 'string' || payload.url.length > BROWSER_URL_MAX) return { error: 'BAD_URL' }
    let caught: URL
    try { caught = new URL(payload.url) } catch { return { error: 'BAD_URL' } }
    if (caught.href.length > BROWSER_URL_MAX) return { error: 'BAD_URL' }
    expire()
    const who = deps.who(connId)
    const at = pending.findIndex((entry) => entry.who === who && entry.port === caught.port && entry.path === caught.pathname)
    if (caught.protocol !== 'http:' || !LOOPBACK.has(caught.hostname) || at === -1) {
      deps.log('[browser] CALLBACK_NOT_EXPECTED')
      return { error: 'NOT_EXPECTED' }
    }
    if (active.size >= CALLBACKS_ACTIVE_MAX) {
      deps.log('[browser] CALLBACK_BUSY')
      return { error: 'NOT_DELIVERED' }
    }
    const expected = pending.splice(at, 1)[0]!
    const abort = new AbortController()
    active.set(abort, expected.agentId)
    const ended = (): void => { abort.abort() }
    closed?.addEventListener('abort', ended, { once: true })
    const timer = setTimeout(ended, CALLBACK_WAIT_MS)
    timer.unref?.()
    const replay = (url: string) => {
      if (abort.signal.aborted || stopped || deps.who(connId) !== who) throw new Error('CALLBACK_REVOKED')
      return deps.replay(url, abort.signal)
    }
    try {
      let url = `http://127.0.0.1:${caught.port}${caught.pathname}${caught.search}`
      let answer: { status: number; location: string | null }
      try {
        answer = await replay(url)
        deps.log('[browser] CALLBACK_DELIVERED')
      } catch {
        deps.log('[browser] CALLBACK_NOT_DELIVERED')
        return { error: 'NOT_DELIVERED' }
      }
      const { status } = answer
      // A program that finishes on a page of its own sends the browser there and waits for it: Codex's callback answers 302
      // to its `/success`, and its sign-in stayed open until a browser came (the MSI, 2026-11-06). Followed as the phone's
      // browser would, only on that same port of this computer; a page elsewhere is the browser's, and none is opened here.
      try {
        for (let page = 0; page < FOLLOWED_PAGES && answer.status >= 300 && answer.status < 400 && answer.location; page++) {
          const next = new URL(answer.location, url)
          if (next.href.length > BROWSER_URL_MAX) throw new Error('CALLBACK_PAGE_TOO_LARGE')
          if (next.protocol !== 'http:' || !LOOPBACK.has(next.hostname) || next.port !== caught.port) break
          url = `http://127.0.0.1:${next.port}${next.pathname}${next.search}`
          answer = await replay(url)
          deps.log('[browser] CALLBACK_PAGE_DELIVERED')
        }
      } catch {
        // The sign-in is the program's already: only its own page after it is missed.
        deps.log('[browser] CALLBACK_PAGE_NOT_DELIVERED')
      }
      return { ok: status < 400, status }
    } finally {
      clearTimeout(timer)
      closed?.removeEventListener('abort', ended)
      active.delete(abort)
    }
  }

  const ended = (agentId: string): void => {
    lastInput.delete(agentId)
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.agentId === agentId) pending.splice(i, 1)
    for (const [abort, agent] of active) if (agent === agentId) abort.abort()
  }
  const unfollow = deps.follow?.(event => {
    if (event.kind === 'input' && event.source) typed(event.agentId, { connId: event.source.connection, kind: event.source.clientKind })
    else if (event.kind === 'ended' || event.kind === 'purged' || event.kind === 'stopped') ended(event.agentId)
    else if (event.kind === 'taken') ended(event.from)
  })
  const request: ServiceRequest = (frame, asker, closed) => {
    const payload = frame.payload && typeof frame.payload === 'object' && !Array.isArray(frame.payload) ? frame.payload as Record<string, unknown> : {}
    if (frame.frame === 'browser_open') {
      if (!asker.local) return { error: 'LOCAL_ONLY' }
      return open(payload, closed)
    }
    if (frame.frame === 'browser_callback') {
      if (!asker.owner || asker.guest !== undefined) return { error: 'OWNER_REQUIRED' }
      return callback(payload, asker.connection ?? '', closed)
    }
    return { error: 'UNKNOWN_REQUEST' }
  }
  return { typed, open, callback, request, ended,
    stop: (): void => {
      unfollow?.()
      stopped = true
      lastInput.clear()
      pending.length = 0
      for (const abort of active.keys()) abort.abort()
    },
  }
}

export type Browser = ReturnType<typeof createBrowser>
