/**
 * The browser's proxy inside its container: Chrome is pointed at http://127.0.0.1:3128, and this relay adds the
 * person's proxy login to every request it forwards, since Chrome cannot take a proxy's login on its command line.
 * CONNECT tunnels and absolute-form plain HTTP, to an HTTP or HTTPS proxy with Proxy-Authorization, or through a SOCKS5
 * username/password handshake that sends the host name (socks5.mjs), so DNS leaves through the proxy too. Ported from
 * ai-assitant-sanbox `electron/browser/proxy-relay.ts`, which had no SOCKS5.
 *
 * Fail closed: the relay connects to the proxy and to nothing else. An unreachable proxy or a refused login is a 502
 * for the page, never a direct connection.
 *
 * Run by entrypoint.sh: it reads the proxy from the Podman secret, makes one start probe through it, and listens only
 * when the probe passed, so the entrypoint knows by the port alone (no port is exit code 4, `proxy_failed`). The
 * password is in that file and this process only, and is never logged.
 */
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { socks5Connect } from './socks5.mjs'

const RELAY_PORT = 3128
const SECRET = '/run/secrets/harness-proxy'
const LOOKUP = new URL('http://ip-api.com/json/?fields=status,timezone,query')
const CONNECT_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 15_000
const MAX_CONNECT_RESPONSE_BYTES = 64 * 1024
const BAD_GATEWAY = 'HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nproxy relay: the proxy cannot be used'

const loginOf = (up) => up.username || up.password
  ? { 'proxy-authorization': `Basic ${Buffer.from(`${up.username}:${up.password}`).toString('base64')}` } : {}

// URL keeps an IPv6 host in brackets; SOCKS5 takes it bare.
const bare = (host) => host.replace(/^\[(.*)\]$/, '$1')

/**
 * A socket to the proxy, connected, and through SOCKS5 already tunnelled to `target`. The only place the relay opens a
 * connection. Its timeout stays armed until the caller has the tunnel or the request on it.
 */
async function dial(up, target) {
  const socket = up.scheme === 'https'
    ? tls.connect({ host: up.host, port: up.port, ...(net.isIP(up.host) ? {} : { servername: up.host }) })
    : net.connect({ host: up.host, port: up.port })
  // Each user of the socket handles its failure; this one keeps a late error, after they let go, from ending the relay.
  socket.on('error', () => socket.destroy())
  socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(new Error('the proxy did not answer')))
  try {
    await once(socket, up.scheme === 'https' ? 'secureConnect' : 'connect')
    if (up.scheme === 'socks5') await socks5Connect(socket, { ...target, username: up.username, password: up.password })
  } catch (error) {
    socket.destroy()
    throw error
  }
  return socket
}

/** Reads an HTTP proxy's answer to CONNECT; what follows the head stays in the socket for the tunnel. */
function connectAnswer(socket) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0)
    const done = (error, status) => {
      socket.off('data', onData)
      socket.off('close', onClose)
      if (error) reject(error)
      else resolve(status)
    }
    const onClose = () => done(new Error('the proxy closed the connection'))
    const onData = (chunk) => {
      data = Buffer.concat([data, chunk])
      const end = data.indexOf('\r\n\r\n')
      if (end < 0) return data.length > MAX_CONNECT_RESPONSE_BYTES ? done(new Error('the proxy answered too much')) : undefined
      socket.pause()
      if (data.length > end + 4) socket.unshift(data.subarray(end + 4))
      done(null, Number(/^HTTP\/1\.[01] (\d{3})/.exec(data.subarray(0, end).toString('latin1'))?.[1]))
    }
    socket.on('data', onData)
    socket.on('close', onClose)
  })
}

async function tunnel(up, authority) {
  const target = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority)
  if (!target) throw new Error('not a host and port')
  const socket = await dial(up, { host: bare(target[1]), port: Number(target[2]) })
  if (up.scheme !== 'socks5') {
    const login = loginOf(up)['proxy-authorization']
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${login ? `Proxy-Authorization: ${login}\r\n` : ''}\r\n`)
    const status = await connectAnswer(socket).catch((error) => { socket.destroy(); throw error })
    if (status !== 200) {
      socket.destroy()
      throw new Error(status === 407 ? 'the proxy refused the login' : 'the proxy refused the tunnel')
    }
  }
  socket.setTimeout(0)
  return socket
}

/** A plain HTTP request for `url` through the proxy: to an HTTP proxy in absolute form, through SOCKS5 to the site. */
function viaProxy(up, url, method, headers) {
  const socks = up.scheme === 'socks5'
  return http.request({
    method,
    path: socks ? url.pathname + url.search : url.href,
    headers: socks ? headers : { ...headers, ...loginOf(up) },
    createConnection: (_options, done) => {
      dial(up, { host: bare(url.hostname), port: Number(url.port) || 80 })
        .then((socket) => { socket.setTimeout(0); done(null, socket) }, done)
    },
  })
}

/** The relay's server, not yet listening. */
export function createRelay(up) {
  const server = http.createServer((req, res) => {
    let url = null
    try { url = new URL(req.url ?? '') } catch { /* answered below */ }
    if (url?.protocol !== 'http:') return void res.writeHead(400, { 'content-type': 'text/plain' }).end('proxy relay: absolute http URL required')
    const headers = { ...req.headers }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    const upReq = viaProxy(up, url, req.method, headers)
    upReq.on('response', (upRes) => {
      // A refused login is the relay's failure, not the site's answer.
      if (upRes.statusCode === 407 && up.scheme !== 'socks5') {
        upRes.resume()
        return void res.writeHead(502, { 'content-type': 'text/plain' }).end('proxy relay: the proxy refused the login')
      }
      res.writeHead(upRes.statusCode ?? 502, upRes.rawHeaders)
      upRes.on('error', () => res.destroy())
      upRes.pipe(res)
    })
    upReq.on('error', () => {
      if (res.headersSent) res.destroy()
      else res.writeHead(502, { 'content-type': 'text/plain' }).end('proxy relay: the proxy cannot be used')
    })
    req.on('error', () => upReq.destroy())
    res.on('error', () => upReq.destroy())
    req.pipe(upReq)
  })

  // The server stops handling a connection's errors once it turns into a tunnel; this covers it from the start.
  server.on('connection', (socket) => socket.on('error', () => socket.destroy()))

  server.on('connect', (req, client, head) => {
    tunnel(up, req.url ?? '').then((upstream) => {
      if (client.destroyed) return void upstream.destroy()
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
      upstream.on('close', () => client.destroy())
      client.on('close', () => upstream.destroy())
    }, () => client.end(BAD_GATEWAY))
  })
  return server
}

/**
 * The start probe: one request to the exit lookup through the proxy. Any answer that came back through it passes,
 * whatever the lookup service itself said, so that service being down never looks like a broken proxy. Rejects when
 * the proxy cannot be reached, refuses the login, or does not answer.
 */
export function probe(up) {
  return new Promise((resolve, reject) => {
    const req = viaProxy(up, LOOKUP, 'GET', { host: LOOKUP.host, connection: 'close' })
    const timer = setTimeout(() => req.destroy(new Error('the proxy did not answer')), PROBE_TIMEOUT_MS)
    req.on('response', (res) => {
      clearTimeout(timer)
      res.resume()
      req.destroy()
      if (res.statusCode === 407 && up.scheme !== 'socks5') reject(new Error('the proxy refused the login'))
      else resolve()
    })
    req.on('error', (error) => {
      clearTimeout(timer)
      // A SOCKS5 proxy that could not reach the lookup service answered for it.
      if (error.reply !== undefined) resolve()
      else reject(error)
    })
    req.end()
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let up
  try {
    up = JSON.parse(readFileSync(SECRET, 'utf8'))
  } catch {
    // Never the parser's message: it quotes the file, password and all.
    console.error('proxy relay: the proxy secret cannot be read')
    process.exit(1)
  }
  probe(up).then(() => {
    const server = createRelay(up)
    server.on('error', (error) => {
      console.error(`proxy relay: ${error.message}`)
      process.exit(1)
    })
    server.listen(RELAY_PORT, '127.0.0.1')
  }, (error) => {
    console.error(`proxy relay: the proxy cannot be used: ${error.message}`)
    process.exit(1)
  })
}
