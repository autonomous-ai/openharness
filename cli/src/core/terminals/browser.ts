/**
 * A page a program in a harness's pane opens — Claude Code's `/login`, `gh auth login` — opened where the person
 * is. Every engine pane's `BROWSER` is this daemon's shim (lib/browserShim.ts), which asks here first
 * (`browser_open`, from a tool client on this computer). The page goes to the phone that last typed into that
 * pane; otherwise the shim opens this computer's browser, as the program would have.
 *
 * A sign-in that returns to the program at `http://localhost:PORT/callback` would land on the phone's own
 * localhost. The phone listens there itself, catches the redirect and sends it back (`browser_callback`), and it
 * is replayed here, to the program still waiting on that port. Only to a port and path a page sent to that very
 * phone named, once, while it is fresh: a wrong redirect is not harmless (Claude Code drops the whole sign-in on
 * a mismatched `state`), and a phone must not reach arbitrary ports of this computer.
 */

/** Who typed into an agent's terminal last, as the terminal stream knows them. */
export interface InputSource {
  connId: string
  /** What the client said it is on `terminal_open` (`phone`, `desktop`, `web`…); null when it said nothing. */
  kind: string | null
}

export interface BrowserDeps {
  /** The harness whose pane this is (`$TMUX_PANE` of the program opening the page). */
  agentOfPane: (pane: string) => string | undefined
  /** A frame for one client, sealed to it when it is remote; false when it cannot be sent. */
  sendTo: (connId: string, type: string, payload: Record<string, unknown>) => boolean
  isLocal: (connId: string) => boolean
  /** Who is on a connection, the same across its reconnects (a paired phone's key). The phone's line drops
   *  while the browser covers the app, and it sends the redirect back over a new connection. */
  who: (connId: string) => string
  /** GET [url] on this computer; resolves with the HTTP status, and where the program sends the browser next. */
  replay: (url: string) => Promise<{ status: number; location: string | null }>
  now: () => number
  /** One line about what happened, for the daemon's log. Never the page or the redirect: they carry codes. */
  log: (line: string) => void
}

/** How long a phone has to sign in and send the redirect back. */
export const CALLBACK_FOR_MS = 10 * 60_000

/** The program's own pages after its callback a replay follows, as the phone's browser would have. */
const FOLLOWED_PAGES = 3

interface Pending { who: string, port: string, path: string, until: number }

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

  /** The terminal stream's `onInput`: keystrokes a person typed, and from where. */
  const typed = (agentId: string, source: InputSource): void => { lastInput.set(agentId, source) }

  /** `browser_open` {pane, url}: whether a phone took the page. False tells the shim to open it here. */
  const open = (payload: Record<string, unknown>): Record<string, unknown> => {
    const agentId = typeof payload.pane === 'string' ? deps.agentOfPane(payload.pane) : undefined
    const source = agentId ? lastInput.get(agentId) : undefined
    let page: URL
    try { page = new URL(String(payload.url ?? '')) } catch { return { handled: false } }
    if (!agentId || !source || source.kind !== 'phone' || deps.isLocal(source.connId)) return { handled: false }
    if (page.protocol !== 'https:' && page.protocol !== 'http:') return { handled: false }
    if (!deps.sendTo(source.connId, 'browser_open', { agentId, url: page.href })) {
      deps.log(`[browser] ${agentId} page not sent to the phone; opening it here`)
      return { handled: false }
    }
    const redirect = loopbackRedirect(page)
    if (redirect) pending.push({ who: deps.who(source.connId), port: redirect.port, path: redirect.pathname, until: deps.now() + CALLBACK_FOR_MS })
    deps.log(`[browser] ${agentId} page sent to the phone${redirect ? `, waiting for its sign-in on port ${redirect.port}` : ''}`)
    return { handled: true }
  }

  /** `browser_callback` {url} from [connId]: the redirect the phone caught, replayed to the waiting program. */
  const callback = async (payload: Record<string, unknown>, connId: string): Promise<Record<string, unknown>> => {
    let caught: URL
    try { caught = new URL(String(payload.url ?? '')) } catch { return { error: 'BAD_URL' } }
    const now = deps.now()
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.until < now) pending.splice(i, 1)
    const who = deps.who(connId)
    const at = pending.findIndex((entry) => entry.who === who && entry.port === caught.port && entry.path === caught.pathname)
    if (caught.protocol !== 'http:' || !LOOPBACK.has(caught.hostname) || at === -1) {
      deps.log(`[browser] a sign-in on port ${caught.port || '?'} was refused: no page sent to that phone waits there`)
      return { error: 'NOT_EXPECTED' }
    }
    pending.splice(at, 1)
    let url = `http://127.0.0.1:${caught.port}${caught.pathname}${caught.search}`
    let answer: { status: number; location: string | null }
    try {
      answer = await deps.replay(url)
      deps.log(`[browser] sign-in handed to the program on port ${caught.port}: HTTP ${answer.status}`)
    } catch (error) {
      deps.log(`[browser] sign-in not handed to the program on port ${caught.port}: ${error instanceof Error ? error.message : String(error)}`)
      return { error: 'NOT_DELIVERED' }
    }
    const { status } = answer
    // A program that finishes on a page of its own sends the browser there and waits for it: Codex's callback answers 302
    // to its `/success`, and its sign-in stayed open until a browser came (the MSI, 2026-11-06). Followed as the phone's
    // browser would, only on that same port of this computer; a page elsewhere is the browser's, and none is opened here.
    try {
      for (let page = 0; page < FOLLOWED_PAGES && answer.status >= 300 && answer.status < 400 && answer.location; page++) {
        const next = new URL(answer.location, url)
        if (next.protocol !== 'http:' || !LOOPBACK.has(next.hostname) || next.port !== caught.port) break
        url = `http://127.0.0.1:${next.port}${next.pathname}${next.search}`
        answer = await deps.replay(url)
        deps.log(`[browser] the program's next page on port ${caught.port}: HTTP ${answer.status}`)
      }
    } catch (error) {
      // The sign-in is the program's already: only its own page after it is missed.
      deps.log(`[browser] the program's next page on port ${caught.port} not opened: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { ok: status < 400, status }
  }

  return { typed, open, callback }
}

export type Browser = ReturnType<typeof createBrowser>
