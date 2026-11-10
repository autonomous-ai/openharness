/**
 * The browser's proxy inside its container: Chrome sends every request to http://127.0.0.1:3128, loopback included,
 * proxy or not. CONNECT tunnels (which carry WebSockets too) and absolute-form plain HTTP.
 *
 * With no proxy it connects directly, but never to the host: on a Podman machine gvproxy maps 192.168.127.254 to the
 * Mac's own 127.0.0.1 and serves its control API on 192.168.127.1, and Chrome's URLBlocklist stops only navigations,
 * not a page's fetch or WebSocket. So it resolves the name itself, refuses (403) loopback, link-local, unspecified,
 * gvproxy's network, the container's own gateway and network (from its routing table at start) and the host's names,
 * and connects to the very address it checked, so a name that changes its answer (DNS rebinding) cannot get past it.
 *
 * With a proxy it adds the person's login to every request it forwards, since Chrome cannot take a proxy's login on its
 * command line: to an HTTP or HTTPS proxy with Proxy-Authorization, or through a SOCKS5 username/password handshake
 * that sends the host name (socks5.mjs), so DNS leaves through the proxy too. Ported from ai-assitant-sanbox
 * `electron/browser/proxy-relay.ts`, which had no SOCKS5. Fail closed: it then connects to the proxy and to nothing
 * else. An unreachable proxy or a refused login is a 502 for the page, never a direct connection.
 *
 * Run by entrypoint.sh. With `PROXY=1` it reads the proxy from the Podman secret, makes one start probe through it, and
 * listens only when the probe passed, so the entrypoint knows by the port alone (no port is exit code 4,
 * `proxy_failed`). The password is in that file and this process only, and is never logged.
 */
import { lookup } from 'node:dns/promises'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { socks5Connect } from './socks5.mjs'

const RELAY_PORT = 3128
const SECRET = '/run/secrets/harness-proxy'
const ROUTES = '/proc/net/route'
const LOOKUP = new URL('http://ip-api.com/json/?fields=status,timezone,query')
const CONNECT_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 15_000
const MAX_CONNECT_RESPONSE_BYTES = 64 * 1024
const answer = (status, text) => `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nproxy relay: ${text}`
const unusable = (up) => up ? 'the proxy cannot be used' : 'the site cannot be reached'
const REFUSED = 'that destination is not allowed'
const REFUSALS_LOGGED = 50
const REFUSAL_COUNT_MS = 60_000

/** The host's names in Podman and Docker: refused by name, whatever they resolve to. */
const HOST_NAMES = new Set(['host.containers.internal', 'host.docker.internal', 'gateway.containers.internal', 'gateway.docker.internal'])
/** Each refused category and its subnets; the container's own network is added at start. */
const REFUSED_SUBNETS = [
  ['loopback', [['127.0.0.0', 8], ['::1', 128]]],
  ['link-local', [['169.254.0.0', 16], ['fe80::', 10]]],
  ['unspecified', [['0.0.0.0', 8], ['::', 128]]],
  // gvproxy, on a Podman machine: .254 is the Mac's loopback, .1 its control API.
  ['gvproxy', [['192.168.127.0', 24]]],
]

/**
 * The refused category of an IP address, or null. `routes` is the container's own gateway and network, as
 * containerNetwork reads them. An IPv4-mapped IPv6 address is checked as its IPv4 one (BlockList does that).
 */
export function refusedBy(routes) {
  const lists = [...REFUSED_SUBNETS, ['container network', routes]].map(([category, subnets]) => {
    const list = new net.BlockList()
    for (const [address, prefix] of subnets) list.addSubnet(address, prefix, net.isIP(address) === 6 ? 'ipv6' : 'ipv4')
    return [category, list]
  })
  return (address) => {
    const family = net.isIP(address) === 6 ? 'ipv6' : 'ipv4'
    return lists.find(([, list]) => list.check(address, family))?.[0] ?? null
  }
}

/**
 * Logs a refusal by its category: each of the first 50, then one line a minute with how many more. A page that loops
 * fetches to loopback is refused every time, and a line each would fill the container's /tmp.
 */
export function refusalLog(write = (line) => console.error(line)) {
  let logged = 0
  let more = 0
  let timer = null
  return (category) => {
    if (logged < REFUSALS_LOGGED) {
      logged += 1
      return write(`proxy relay: refused a ${category} destination`)
    }
    more += 1
    timer ??= setTimeout(() => {
      write(`proxy relay: refused ${more} more destinations`)
      more = 0
      timer = null
    }, REFUSAL_COUNT_MS).unref()
  }
}

/** The gateway (as a /32) and the network of each route in /proc/net/route, but loopback's and the default route's. */
export function containerNetwork(table) {
  const address = (hex) => [...Buffer.from(hex, 'hex').reverse()].join('.')
  const routes = []
  for (const line of table.split('\n').slice(1)) {
    const [iface, destination, gateway, , , , , mask] = line.trim().split(/\s+/)
    if (!mask || iface === 'lo') continue
    if (gateway !== '00000000') routes.push([address(gateway), 32])
    if (mask !== '00000000') routes.push([address(destination), Number.parseInt(mask, 16).toString(2).split('1').length - 1])
  }
  return routes
}

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

/**
 * With no proxy: a socket straight to `target`, unless the host is refused. Every address the name resolves to is
 * checked, and the socket goes to the one checked, never to the name again. A refusal names its category only.
 */
async function dialDirect(refused, target) {
  const name = target.host.toLowerCase().replace(/\.$/, '')
  let category = HOST_NAMES.has(name) ? 'host name' : null
  let address = name
  if (!category) {
    const found = net.isIP(name) ? [{ address: name }] : await resolve(name)
    category = found.map(({ address: one }) => refused(one)).find(Boolean) ?? null
    address = found[0].address
  }
  if (category) throw Object.assign(new Error('refused'), { refused: category })
  const socket = net.connect({ host: address, port: target.port })
  socket.on('error', () => socket.destroy())
  socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(new Error('the site did not answer')))
  await once(socket, 'connect').catch((error) => { socket.destroy(); throw error })
  return socket
}

/** Every address of a name, within the connect timeout. */
function resolve(name) {
  let timer
  return Promise.race([
    lookup(name, { all: true, verbatim: true }),
    new Promise((_done, fail) => { timer = setTimeout(() => fail(new Error('the name did not resolve')), CONNECT_TIMEOUT_MS) }),
  ]).finally(() => clearTimeout(timer))
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

async function tunnel(up, refused, authority) {
  const target = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority)
  if (!target) throw new Error('not a host and port')
  if (!up) {
    const socket = await dialDirect(refused, { host: bare(target[1]), port: Number(target[2]) })
    socket.setTimeout(0)
    return socket
  }
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

/**
 * A plain HTTP request for `url`: to an HTTP proxy in absolute form; through SOCKS5, or with no proxy (`up` null)
 * directly, to the site in origin form.
 */
function forward(up, refused, url, method, headers) {
  const origin = !up || up.scheme === 'socks5'
  const target = { host: bare(url.hostname), port: Number(url.port) || 80 }
  return http.request({
    method,
    path: origin ? url.pathname + url.search : url.href,
    headers: origin ? headers : { ...headers, ...loginOf(up) },
    createConnection: (_options, done) => {
      (up ? dial(up, target) : dialDirect(refused, target))
        .then((socket) => { socket.setTimeout(0); done(null, socket) }, done)
    },
  })
}

/**
 * The relay's server, not yet listening. `up` is the proxy, or null to connect directly; `routes` the container's own
 * gateway and network (containerNetwork), refused with no proxy.
 */
export function createRelay(up, routes = []) {
  const refused = refusedBy(routes)
  const logRefusal = refusalLog()
  const server = http.createServer((req, res) => {
    let url = null
    try { url = new URL(req.url ?? '') } catch { /* answered below */ }
    if (url?.protocol !== 'http:') return void res.writeHead(400, { 'content-type': 'text/plain' }).end('proxy relay: absolute http URL required')
    const headers = { ...req.headers }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    const upReq = forward(up, refused, url, req.method, headers)
    upReq.on('response', (upRes) => {
      // A refused login is the relay's failure, not the site's answer.
      if (upRes.statusCode === 407 && up && up.scheme !== 'socks5') {
        upRes.resume()
        return void res.writeHead(502, { 'content-type': 'text/plain' }).end('proxy relay: the proxy refused the login')
      }
      res.writeHead(upRes.statusCode ?? 502, upRes.rawHeaders)
      upRes.on('error', () => res.destroy())
      upRes.pipe(res)
    })
    upReq.on('error', (error) => {
      if (res.headersSent) res.destroy()
      else if (error.refused) {
        logRefusal(error.refused)
        res.writeHead(403, { 'content-type': 'text/plain' }).end(`proxy relay: ${REFUSED}`)
      } else res.writeHead(502, { 'content-type': 'text/plain' }).end(`proxy relay: ${unusable(up)}`)
    })
    req.on('error', () => upReq.destroy())
    res.on('error', () => upReq.destroy())
    req.pipe(upReq)
  })

  // The server stops handling a connection's errors once it turns into a tunnel; this covers it from the start.
  server.on('connection', (socket) => socket.on('error', () => socket.destroy()))

  server.on('connect', (req, client, head) => {
    tunnel(up, refused, req.url ?? '').then((upstream) => {
      if (client.destroyed) return void upstream.destroy()
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
      upstream.on('close', () => client.destroy())
      client.on('close', () => upstream.destroy())
    }, (error) => {
      if (error.refused) logRefusal(error.refused)
      client.end(error.refused ? answer('403 Forbidden', REFUSED) : answer('502 Bad Gateway', unusable(up)))
    })
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
    const req = forward(up, null, LOOKUP, 'GET', { host: LOOKUP.host, connection: 'close' })
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
  let up = null
  let routes
  try {
    routes = containerNetwork(readFileSync(ROUTES, 'utf8'))
  } catch (error) {
    // Without it the container's gateway would be reachable: no relay, so no browser.
    console.error(`proxy relay: the routing table cannot be read: ${error.message}`)
    process.exit(1)
  }
  if (process.env.PROXY === '1') {
    try {
      up = JSON.parse(readFileSync(SECRET, 'utf8'))
    } catch {
      // Never the parser's message: it quotes the file, password and all.
      console.error('proxy relay: the proxy secret cannot be read')
      process.exit(1)
    }
  }
  const listen = () => {
    const server = createRelay(up, routes)
    server.on('error', (error) => {
      console.error(`proxy relay: ${error.message}`)
      process.exit(1)
    })
    server.listen(RELAY_PORT, '127.0.0.1')
  }
  if (!up) listen()
  else probe(up).then(listen, (error) => {
    console.error(`proxy relay: the proxy cannot be used: ${error.message}`)
    process.exit(1)
  })
}
