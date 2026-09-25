/**
 * A fake grid relay on loopback that RECORDS every request it receives — method, path and headers — for
 * specs that must prove what the daemon sent a grid (grid-reads-without-waking). It is the spy: a spec
 * reads what arrived rather than recomputing what the code under test meant to send.
 *
 * Answers are keyed by the full request path (`/g/<grid id>/relay/v1/grid/overview`); a function answer
 * is asked on every request, so a grid can change between one read and the next.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http'

export interface RelayRequest { method: string; path: string; headers: IncomingHttpHeaders }
export interface RelayAnswer { status: number; body?: unknown; delayMs?: number }

export interface FakeRelay {
  /** `http://127.0.0.1:<port>` — a grid's address is `<base>/g/<grid id>`. */
  base: string
  /** Every request received, oldest first. */
  seen: RelayRequest[]
  /** Answer `path` with `value` (or with what `value()` says at the time) from now on. */
  answer: (path: string, value: RelayAnswer | (() => RelayAnswer)) => void
  close: () => Promise<void>
}

export async function startFakeRelay(): Promise<FakeRelay> {
  const seen: RelayRequest[] = []
  const answers = new Map<string, RelayAnswer | (() => RelayAnswer)>()
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers })
    const planned = answers.get(req.url ?? '')
    const found = (typeof planned === 'function' ? planned() : planned) ?? { status: 404, body: { detail: 'Not Found' } }
    const timer = setTimeout(() => {
      res.writeHead(found.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(found.body ?? {}))
    }, found.delayMs ?? 0)
    // A held answer is let go when the spec closes the relay, rather than holding the close open.
    res.on('close', () => clearTimeout(timer))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    base,
    seen,
    answer: (path, value) => { answers.set(path, value) },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
