// Test-only. The dial eval's network guard: a devices spec's red run posted to the production speech-to-text, and tier A
// once opened WebSockets to the production backend with this machine's hostname in the query (2026-11-21). Under it a
// connection to anything but this machine fails, and the attempt is kept by host and port only: a path, a query or a
// payload can carry what is not the test's. Plain CommonJS on Node's built-ins, so `--require` loads it into any Node
// (as e2e/harness/corePerf.cjs); netGuard.ts is the door every TypeScript caller uses. Nothing in production loads it.
'use strict'
const dgram = require('node:dgram')
const dns = require('node:dns')
const { appendFileSync } = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const net = require('node:net')
const tls = require('node:tls')

const FILE_ENV = 'HARNESS_E2E_NET_GUARD_FILE'
// Every query node:dns offers, by its name, so one a later Node adds is guarded too.
const DNS_QUERIES = Object.keys(dns).filter((name) => /^(lookup|resolve|reverse)/.test(name) && typeof dns[name] === 'function')

// The machine's own hostname and its LAN addresses are not here: a lookup of the hostname can leave the machine.
function isLocal(host) {
  if (host === undefined || host === null || host === '') return true
  let name = String(host).toLowerCase()
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1)
  return name === 'localhost' || name.endsWith('.localhost') || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
    || name === '0.0.0.0' || name === '::1' || name === '::' || name.startsWith('::ffff:127.')
}

// A name harnessd gives the process, never a path or an argument.
function processName() {
  if (process.argv.includes('__service')) {
    const service = process.env.HARNESSD_SERVICE || ''
    return /^[a-z][a-z0-9-]{0,40}$/.test(service) ? service : 'node'
  }
  if (process.argv.includes('__run')) return 'core'
  if (process.argv.includes('__harnessd')) return 'master'
  return 'node'
}

function portOf(port) {
  const number = Number(port)
  return port === undefined || port === null || port === '' || !Number.isInteger(number) ? null : number
}

/** Where a socket's connect goes, in each form Node passes it; null for a Unix socket or a named pipe. */
function socketTarget(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (first !== null && typeof first === 'object') return first.path ? null : { host: first.host, port: first.port }
  // A string that is not a port is a pipe's path, as Node's own reading of the arguments has it.
  if (typeof first === 'string' && !(Number(first) >= 0)) return null
  return { host: typeof args[1] === 'string' ? args[1] : undefined, port: first }
}

let installed = false

/** Puts the guard on every entry point, telling `record` of each refused attempt; returns what takes it off again. */
function install(record) {
  if (installed) throw new Error('the network guard is already installed')
  installed = true
  const refusal = (api, host, port, code) => {
    const attempt = { api, host: String(host), port: portOf(port), pid: process.pid, process: processName() }
    record(attempt)
    const where = attempt.port === null ? attempt.host : `${attempt.host}:${attempt.port}`
    return Object.assign(new Error(`the dial eval reaches no network: ${where}`), { code })
  }
  const saved = []
  const replace = (owner, name, wrap) => {
    const original = owner[name]
    saved.push([owner, name, original])
    owner[name] = wrap(original)
  }

  // The one door of net.connect, tls.connect, http(s).request, `ws`, fetch and the global WebSocket.
  replace(net.Socket.prototype, 'connect', (original) => function connect(...args) {
    const target = socketTarget(args)
    if (!target || isLocal(target.host)) return original.apply(this, args)
    const error = refusal(this instanceof tls.TLSSocket ? 'tls' : 'net', target.host, target.port, 'ENETUNREACH')
    // The next tick, never a timer: tier A's fake clock must not hold the failure back.
    process.nextTick(() => this.destroy(error))
    return this
  })

  const dgramRefused = (socket, callback, error) => process.nextTick(() => {
    if (typeof callback === 'function') callback(error)
    else socket.emit('error', error)
  })
  replace(dgram.Socket.prototype, 'send', (original) => function send(...args) {
    // A connected socket sends only where its guarded connect went; remoteAddress throws on one not connected.
    let connected = true
    try { this.remoteAddress() } catch { connected = false }
    if (connected) return original.apply(this, args)
    let [, port, address, callback] = args
    if (args[4] || (args[3] && typeof args[3] !== 'function')) [, , , port, address, callback] = args
    if (typeof address === 'function') [callback, address] = [address, undefined]
    if (isLocal(address)) return original.apply(this, args)
    dgramRefused(this, callback, refusal('dgram', address, port, 'ENETUNREACH'))
  })
  replace(dgram.Socket.prototype, 'connect', (original) => function connect(port, address, callback) {
    if (typeof address === 'function') [callback, address] = [address, undefined]
    if (isLocal(address)) return original.apply(this, arguments)
    dgramRefused(this, callback, refusal('dgram', address, port, 'ENETUNREACH'))
  })

  for (const name of DNS_QUERIES) {
    // A lookup (getaddrinfo, getnameinfo) answers this machine's names from the hosts file; a resolve or a reverse asks
    // a DNS server whatever it names.
    const passes = (hostname) => name.startsWith('lookup') && isLocal(hostname)
    const withCallback = (original) => function guarded(hostname, ...rest) {
      const callback = rest[rest.length - 1]
      if (passes(hostname) || typeof callback !== 'function') return original.call(this, hostname, ...rest)
      process.nextTick(callback, refusal('dns', hostname, null, 'ENOTFOUND'))
    }
    const withPromise = (original) => function guarded(hostname, ...rest) {
      if (passes(hostname)) return original.call(this, hostname, ...rest)
      return Promise.reject(refusal('dns', hostname, null, 'ENOTFOUND'))
    }
    replace(dns, name, withCallback)
    replace(dns.promises, name, withPromise)
    // node:dns's own functions are bound copies of these: a new Resolver's are the prototype's.
    if (Object.hasOwn(dns.Resolver.prototype, name)) replace(dns.Resolver.prototype, name, withCallback)
    if (Object.hasOwn(dns.promises.Resolver.prototype, name)) replace(dns.promises.Resolver.prototype, name, withPromise)
  }
  // So an ESM import of node:dns or node:dns/promises sees the guard as well.
  syncBuiltinESMExports()

  let removed = false
  return () => {
    if (removed) return
    removed = true
    for (const [owner, name, original] of saved.reverse()) owner[name] = original
    syncBuiltinESMExports()
    installed = false
  }
}

const file = process.env[FILE_ENV]
if (file) {
  const write = (line) => appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 })
  install((attempt) => write({ kind: 'attempt', ...attempt }))
  // So a caller can prove the guard is in a process.
  write({ kind: 'loaded', pid: process.pid, process: processName() })
}

module.exports = { isLocal, install }
