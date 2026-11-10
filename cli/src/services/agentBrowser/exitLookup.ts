/**
 * Where a proxy's traffic comes out: its exit address and that address's time zone, asked of an address-lookup
 * service through the proxy alone, with its login (spec § Proxy, Test). The Browser settings' Test shows it, and an
 * Auto time zone is that zone. Prior art: ai-assitant-sanbox `electron/browser/chrome-engine/pool.ts:67-134`, which
 * spoke HTTP proxies only; HTTPS and SOCKS5 are new here.
 *
 * The service is ip-api.com, the prior art's, over plain HTTP: its free tier serves no HTTPS. It is called only through
 * the person's own proxy and is sent nothing from Harness but the request itself.
 */
import { isIP, connect as netConnect } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'
import { socks5Connect } from '../../../assets/browser/socks5.mjs'
import type { BrowserSettings } from './settings.js'

export type Proxy = NonNullable<BrowserSettings['proxy']>
export type ProxyTest = { ok: true; address: string; timeZone: string } | { ok: false }

const LOOKUP_HOST = 'ip-api.com'
const LOOKUP_PATH = '/json/?fields=status,timezone,query'
export const EXIT_LOOKUP_URL = `http://${LOOKUP_HOST}${LOOKUP_PATH}`
const TIMEOUT_MS = 15_000
// The answer is a few dozen bytes; anything this long is not it.
const MAX_ANSWER = 64 * 1024

export interface ExitLookupDeps {
  /** Opens the connection to the proxy itself: TLS to an HTTPS proxy. */
  connect?: (proxy: Proxy) => Duplex
}

function openProxy(proxy: Proxy): Duplex {
  if (proxy.scheme !== 'https') return netConnect({ host: proxy.host, port: proxy.port })
  // A host given by its address is no server name.
  return tlsConnect({ host: proxy.host, port: proxy.port, ...(isIP(proxy.host) ? {} : { servername: proxy.host }) })
}

/** HTTP/1.0, so the answer comes whole, never chunked, and ends with the connection. */
function request(proxy: Proxy): string {
  if (proxy.scheme === 'socks5') return `GET ${LOOKUP_PATH} HTTP/1.0\r\nHost: ${LOOKUP_HOST}\r\nConnection: close\r\n\r\n`
  const login = proxy.username || proxy.password
    ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n` : ''
  return `GET ${EXIT_LOOKUP_URL} HTTP/1.0\r\nHost: ${LOOKUP_HOST}\r\n${login}Connection: close\r\n\r\n`
}

function validZone(zone: unknown): zone is string {
  if (typeof zone !== 'string') return false
  try {
    // Intl takes offsets such as +07:00 as well; a browser's TZ needs a named zone.
    return !/^[+-]/.test(new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone)
  } catch {
    return false
  }
}

function answerOf(raw: Buffer): ProxyTest {
  const text = raw.toString('utf8')
  const split = text.indexOf('\r\n\r\n')
  if (split < 0 || !/^HTTP\/1\.[01] 200 /.test(text)) return { ok: false }
  let body: { status?: unknown; timezone?: unknown; query?: unknown }
  try {
    body = JSON.parse(text.slice(split + 4)) as typeof body
  } catch {
    return { ok: false }
  }
  if (body.status !== 'success' || typeof body.query !== 'string' || !isIP(body.query) || !validZone(body.timezone)) return { ok: false }
  return { ok: true, address: body.query, timeZone: body.timezone }
}

/** Never throws, and never says why: the reason could carry the proxy's own words back, and the person acts the same. */
export function testProxy(proxy: Proxy, deps: ExitLookupDeps = {}): Promise<ProxyTest> {
  return new Promise((resolve) => {
    const socket = (deps.connect ?? openProxy)(proxy)
    let settled = false
    const settle = (answer: ProxyTest) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(answer)
    }
    const timer = setTimeout(() => settle({ ok: false }), TIMEOUT_MS)
    const chunks: Buffer[] = []
    let length = 0
    socket.on('error', () => settle({ ok: false }))
    const read = () => {
      socket.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > MAX_ANSWER) return settle({ ok: false })
        chunks.push(chunk)
      })
      socket.on('end', () => settle(answerOf(Buffer.concat(chunks))))
      socket.on('close', () => settle({ ok: false }))
      socket.write(request(proxy))
    }
    if (proxy.scheme !== 'socks5') return read()
    socks5Connect(socket, { host: LOOKUP_HOST, port: 80, username: proxy.username, password: proxy.password })
      .then(read, () => settle({ ok: false }))
  })
}

/** An Auto time zone behind a proxy: the exit's zone, or null when it cannot be looked up. */
export async function exitZone(proxy: Proxy, deps: ExitLookupDeps = {}): Promise<string | null> {
  const answer = await testProxy(proxy, deps)
  return answer.ok ? answer.timeZone : null
}
