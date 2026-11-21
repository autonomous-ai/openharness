/**
 * The dial eval's network guard (netGuard.cjs). Never a real host: every refused attempt goes to 192.0.2.1 (TEST-NET-1)
 * or a name under .invalid, so a guard that let one through still reaches nobody. The one name with .local has a lookup
 * that never answers, and the one DNS server asked is a socket of this spec's own.
 */
import { spawn } from 'node:child_process'
import dgram from 'node:dgram'
import dns from 'node:dns'
import * as dnsNamespace from 'node:dns'
import * as dnsPromisesNamespace from 'node:dns/promises'
import { once } from 'node:events'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket as WsWebSocket } from 'ws'
import { describeAttempt, guardThisProcess, isLocal, NET_GUARD_FILE_ENV, NET_GUARD_PRELOAD, netGuardEnv, readNetGuard,
  type NetAttempt } from './netGuard.js'

const OFF = '192.0.2.1'
// Not 9, the discard port: fetch and WebSocket refuse it themselves, before any socket the guard could see.
const PORT = 8
const member = (owner: object, name: string): unknown => (owner as Record<string, unknown>)[name]
// Every function of node:dns but these, which ask nothing of the network: a query a later Node adds is in it.
const NOT_QUERIES = ['Resolver', 'getDefaultResultOrder', 'setDefaultResultOrder', 'getServers', 'setServers']
const DNS_QUERIES = Object.keys(dns).filter((name) => typeof member(dns, name) === 'function' && !NOT_QUERIES.includes(name))

/** The source of each guarded entry point: a Node with nothing installed has these. */
function sources(): string {
  return [net.Socket.prototype.connect, dgram.Socket.prototype.send, dgram.Socket.prototype.connect, dns.lookup,
    dns.promises.lookup].map(String).join('\n')
}
const pristine = sources()

/** Every entry point the guard wraps, by where it is: each query of node:dns where it is one, in CommonJS and in ESM. */
function doors(): Record<string, unknown> {
  const owners: Record<string, object> = { dns, 'dns.promises': dns.promises, 'dns.Resolver#': dns.Resolver.prototype,
    'dns.promises.Resolver#': dns.promises.Resolver.prototype, 'node:dns': dnsNamespace, 'node:dns/promises': dnsPromisesNamespace }
  return {
    'net.Socket#connect': net.Socket.prototype.connect, 'dgram.Socket#send': dgram.Socket.prototype.send,
    'dgram.Socket#connect': dgram.Socket.prototype.connect, 'dgram.createSocket': dgram.createSocket,
    ...Object.fromEntries(Object.entries(owners).flatMap(([owner, at]) => DNS_QUERIES
      .filter((name) => Object.hasOwn(at, name)).map((name) => [`${owner}.${name}`, member(at, name)]))),
  }
}

let guard: ReturnType<typeof guardThisProcess>
const roots: string[] = []
beforeEach(() => { guard = guardThisProcess() })
afterEach(() => {
  guard.uninstall()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const attempt = (api: NetAttempt['api'], host: string, port: number | null): NetAttempt =>
  ({ api, host, port, pid: process.pid, process: 'node' })

/** The error an emitter reports, or the event a browser-style socket fires. */
const failure = async (target: { once?: (event: string, listener: (value: unknown) => void) => unknown }) =>
  (await once(target as NodeJS.EventEmitter, 'error'))[0]

/** The messages of an error and its causes, as a caller would print them. */
function messages(error: unknown): string {
  const seen: string[] = []
  for (let at = error as { message?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) seen.push(String(at.message))
  return seen.join(' | ')
}

describe('a host off this machine', () => {
  it.each<[string, () => Promise<unknown>, NetAttempt['api']]>([
    ['fetch', () => fetch(`http://${OFF}:${PORT}/`).then(() => undefined, (error: unknown) => error), 'net'],
    ['a ws WebSocket', () => failure(new WsWebSocket(`ws://${OFF}:${PORT}/`)), 'net'],
    ['the global WebSocket', async () => {
      const socket = new WebSocket(`ws://${OFF}:${PORT}/`)
      return await new Promise((resolve) => socket.addEventListener('error', resolve, { once: true }))
    }, 'net'],
    ['net.connect', () => failure(net.connect({ host: OFF, port: PORT })), 'net'],
    ['a net.Socket\'s connect', () => failure(new net.Socket().connect(PORT, OFF)), 'net'],
    ['tls.connect', () => failure(tls.connect({ host: OFF, port: PORT })), 'tls'],
    ['http.request', () => failure(http.request({ host: OFF, port: PORT }).end()), 'net'],
    ['https.request', () => failure(https.request(`https://${OFF}:${PORT}/`).end()), 'tls'],
  ])('%s fails and is recorded by host and port', async (_name, reach, api) => {
    expect(await reach()).toBeDefined()
    expect(guard.taken()).toEqual([attempt(api, OFF, PORT)])
    expect(guard.taken()).toEqual([])
  })

  it('a refused socket fails with ENETUNREACH, naming its host and port', async () => {
    const error = await failure(net.connect(9, OFF)) as NodeJS.ErrnoException
    expect(error.code).toBe('ENETUNREACH')
    expect(error.message).toBe(`the dial eval reaches no network: ${OFF}:9`)
    guard.taken()
  })

  it('a URL\'s path, its query and a request\'s body are never recorded', async () => {
    const error = await fetch(`http://example.invalid:${PORT}/stt?hostname=eval-marker-host`, { method: 'POST', body: 'eval-marker-body' })
      .then(() => undefined, (reason: unknown) => reason)
    expect(error).toBeDefined()
    const taken = guard.taken()
    expect(taken).toEqual([attempt('net', 'example.invalid', PORT)])
    for (const said of [JSON.stringify(taken), messages(error)]) {
      expect(said).not.toContain('eval-marker')
      expect(said).not.toContain('stt')
    }
  })
})

/** What a caller's own lookup answers here: 192.0.2.1 for localhost, an address as itself (a dgram socket's bind asks
 *  for 0.0.0.0). Each answers on a later turn, as a resolver does. */
const answerFor = (hostname: string): string => hostname === 'localhost' ? OFF : hostname
const answersOff: net.LookupFunction = (hostname, options, callback) => {
  const address = answerFor(hostname)
  const family = net.isIP(address)
  // All of them when Node asks so, as it does for a connect that tries each family.
  setImmediate(() => options.all ? callback(null, [{ address, family }]) : callback(null, address, family))
}
const dgramAnswersOff: NonNullable<dgram.SocketOptions['lookup']> = (hostname, _family, callback) => {
  const address = answerFor(hostname)
  setImmediate(() => callback(null, address, net.isIP(address)))
}

/** What a socket's lookup reported; the socket goes then, so a connect the guard let through gets no further. */
async function lookedUp(socket: net.Socket): Promise<unknown> {
  // A refused lookup fails the socket as well: its error is read from the lookup.
  socket.on('error', () => {})
  const [error] = await once(socket, 'lookup')
  socket.destroy()
  return error
}

describe('localhost, where a caller\'s own lookup answers 192.0.2.1', () => {
  it.each<[string, () => Promise<unknown>, NetAttempt['api']]>([
    ['net.connect', () => lookedUp(net.connect({ host: 'localhost', port: PORT, lookup: answersOff })), 'net'],
    ['tls.connect', () => lookedUp(tls.connect({ host: 'localhost', port: PORT, lookup: answersOff })), 'tls'],
    ['http.request', async () => {
      const request = http.request({ host: 'localhost', port: PORT, lookup: answersOff }).on('error', () => {})
      request.end()
      const [socket] = await once(request, 'socket') as [net.Socket]
      return lookedUp(socket)
    }, 'net'],
    // The handshake's bound only ends a connect the guard let through.
    ['a ws WebSocket', () => failure(new WsWebSocket(`ws://localhost:${PORT}/`, { lookup: answersOff, handshakeTimeout: 200 })), 'net'],
  ])('%s fails and is recorded by that address and its port', async (_name, reach, api) => {
    const error = await reach() as NodeJS.ErrnoException | undefined
    expect({ code: error?.code, message: error?.message })
      .toEqual({ code: 'ENETUNREACH', message: `the dial eval reaches no network: ${OFF}:${PORT}` })
    expect(guard.taken()).toEqual([attempt(api, OFF, PORT)])
  })

  it('a dgram socket\'s send fails and is recorded by that address', async () => {
    const socket = dgram.createSocket({ type: 'udp4', lookup: dgramAnswersOff })
    try {
      const sent = await new Promise<Error | null>((resolve) => socket.send('eval', PORT, 'localhost', resolve))
      expect((sent as NodeJS.ErrnoException | null)?.code).toBe('ENETUNREACH')
      expect(guard.taken()).toEqual([attempt('dgram', OFF, null)])
    } finally {
      socket.close()
    }
  })
})

// The machine's name can be the person's.
it.each([
  ['eval-machine.invalid', 'eval-machine.invalid'],
  ['eval-machine.invalid', 'EVAL-Machine.invalid.local'],
  ['eval-machine.invalid.local', 'eval-machine.invalid'],
])('on a machine named %s, a refused %s is recorded and said as <this machine>', async (hostname, host) => {
  const named = vi.spyOn(os, 'hostname').mockReturnValue(hostname)
  // Its lookup never answers, so even a guard that let the name through would ask no resolver for it.
  const never: net.LookupFunction = (_name, _options, callback) =>
    setImmediate(() => callback(Object.assign(new Error('never resolved'), { code: 'ENOTFOUND' }), ''))
  try {
    const error = await failure(net.connect({ host, port: PORT, lookup: never })) as Error
    expect(error.message).toBe(`the dial eval reaches no network: <this machine>:${PORT}`)
    expect(guard.taken()).toEqual([attempt('net', '<this machine>', PORT)])
  } finally {
    named.mockRestore()
  }
})

describe('this machine', () => {
  it.each(['localhost', '127.0.0.1', '::1'])('%s still connects', async (host) => {
    const server = net.createServer((socket) => socket.end('ok'))
    server.listen(0, host === 'localhost' ? '127.0.0.1' : host)
    await once(server, 'listening')
    try {
      const socket = net.connect({ host, port: (server.address() as net.AddressInfo).port })
      socket.setEncoding('utf8')
      let said = ''
      socket.on('data', (chunk: string) => { said += chunk })
      await once(socket, 'end')
      expect(said).toBe('ok')
      expect(guard.taken()).toEqual([])
    } finally {
      server.close()
    }
  })

  it('a Unix socket (a named pipe on Windows) still connects', async () => {
    let path = `\\\\.\\pipe\\net-guard-${process.pid}`
    if (process.platform !== 'win32') {
      const root = mkdtempSync(join(tmpdir(), 'ng-'))
      roots.push(root)
      path = join(root, 's')
    }
    const server = net.createServer((socket) => socket.end('ok'))
    server.listen(path)
    await once(server, 'listening')
    try {
      const socket = net.connect(path)
      socket.setEncoding('utf8')
      let said = ''
      socket.on('data', (chunk: string) => { said += chunk })
      await once(socket, 'end')
      expect(said).toBe('ok')
      expect(guard.taken()).toEqual([])
    } finally {
      server.close()
    }
  })

  it.each([undefined, '', 'localhost', 'LocalHost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '::1', '::', '[::1]',
    '::ffff:127.0.0.1', '[::ffff:127.0.0.1]'])('%s is local', (host) => {
    expect(isLocal(host)).toBe(true)
  })

  // A name under localhost is the resolver's to answer, which may ask a DNS server.
  it.each([OFF, 'example.invalid', '10.0.0.1', '192.168.1.2', '::ffff:192.0.2.1', '2001:db8::1', 'localhost.example.invalid',
    'eval.localhost'])('%s is not', (host) => {
    expect(isLocal(host)).toBe(false)
  })
})

it('a lookup of example.invalid is refused and recorded, and localhost resolves', async () => {
  const called = (call: (done: (error: NodeJS.ErrnoException | null) => void) => void) =>
    new Promise<NodeJS.ErrnoException | null>((resolve) => call(resolve))
  const rejected = (promise: Promise<unknown>) => promise.then(() => null, (error: NodeJS.ErrnoException) => error)
  const refused = [
    await called((done) => dns.lookup('example.invalid', done)),
    await called((done) => dnsNamespace.lookup('example.invalid', done)),
    await called((done) => dns.resolve4('example.invalid', done)),
    await rejected(dns.promises.lookup('example.invalid')),
    await rejected(dnsPromisesNamespace.lookup('example.invalid')),
    await rejected(dnsPromisesNamespace.resolveTxt('example.invalid')),
  ]
  for (const error of refused) {
    expect(error?.code).toBe('ENOTFOUND')
    expect(error?.message).toBe('the dial eval reaches no network: example.invalid')
  }
  expect(guard.taken()).toEqual(refused.map(() => attempt('dns', 'example.invalid', null)))
  expect((await dns.promises.lookup('localhost')).address).toMatch(/^(127\.|::1$)/)
  expect(guard.taken()).toEqual([])
})

it('every query of node:dns, of its promises and of both Resolvers is refused and recorded', async () => {
  expect(DNS_QUERIES).toEqual(expect.arrayContaining(['lookup', 'lookupService', 'resolveTlsa', 'reverse']))
  const call = (owner: object, name: string, args: unknown[]) => (member(owner, name) as (...all: unknown[]) => unknown).call(owner, ...args)
  const called = (owner: object, name: string, args: unknown[]) =>
    new Promise<unknown>((resolve) => { call(owner, name, [...args, resolve]) })
  const rejected = (owner: object, name: string, args: unknown[]) =>
    (call(owner, name, args) as Promise<unknown>).then(() => null, (error: unknown) => error)
  const resolver = new dns.Resolver()
  const promises = new dns.promises.Resolver()
  for (const name of DNS_QUERIES) {
    // The two that take an address are asked of 192.0.2.1.
    const args = name === 'lookupService' ? [OFF, 9] : name === 'reverse' ? [OFF] : ['example.invalid']
    const asks: Array<[string, () => Promise<unknown>]> = [[`dns.${name}`, () => called(dns, name, args)],
      [`dns.promises.${name}`, () => rejected(dns.promises, name, args)]]
    if (Object.hasOwn(dns.Resolver.prototype, name)) asks.push([`Resolver#${name}`, () => called(resolver, name, args)])
    if (Object.hasOwn(dns.promises.Resolver.prototype, name)) asks.push([`promises.Resolver#${name}`, () => rejected(promises, name, args)])
    for (const [door, ask] of asks) {
      const error = await ask() as NodeJS.ErrnoException | null
      expect({ door, code: error?.code, message: error?.message, taken: guard.taken() }).toEqual({ door, code: 'ENOTFOUND',
        message: `the dial eval reaches no network: ${args[0]}`, taken: [attempt('dns', String(args[0]), null)] })
    }
  }
})

// Only a lookup reads the hosts file; every other query is a DNS server's to answer.
it('a resolve or a reverse of this machine is refused all the same, and the DNS server hears nothing', async () => {
  // The server is this machine's: a query the guard let through reaches no one else.
  const server = dgram.createSocket('udp4')
  let heard = 0
  server.on('message', () => { heard++ })
  server.bind(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const servers = [`127.0.0.1:${server.address().port}`]
    const resolver = new dns.Resolver({ timeout: 50, tries: 1 })
    resolver.setServers(servers)
    const promises = new dns.promises.Resolver({ timeout: 50, tries: 1 })
    promises.setServers(servers)
    const errors = [
      await new Promise<NodeJS.ErrnoException | null>((resolve) => resolver.resolve4('localhost', resolve)),
      await new Promise<NodeJS.ErrnoException | null>((resolve) => resolver.reverse('127.0.0.1', resolve)),
      await promises.resolve4('localhost').then(() => null, (error: NodeJS.ErrnoException) => error),
      await promises.reverse('::1').then(() => null, (error: NodeJS.ErrnoException) => error),
    ]
    expect(errors.map((error) => error?.code)).toEqual(['ENOTFOUND', 'ENOTFOUND', 'ENOTFOUND', 'ENOTFOUND'])
    expect(guard.taken()).toEqual(['localhost', '127.0.0.1', 'localhost', '::1'].map((host) => attempt('dns', host, null)))
    expect(heard).toBe(0)
  } finally {
    server.close()
  }
})

it('a dgram send or connect to 192.0.2.1 is refused and recorded, and one to 127.0.0.1 arrives', async () => {
  const receiver = dgram.createSocket('udp4')
  const sender = dgram.createSocket('udp4')
  try {
    receiver.bind(0, '127.0.0.1')
    await once(receiver, 'listening')
    const sent = await new Promise<Error | null>((resolve) => sender.send('eval', 9, OFF, resolve))
    expect((sent as NodeJS.ErrnoException).code).toBe('ENETUNREACH')
    const connected = await new Promise<Error | undefined>((resolve) => sender.connect(9, OFF, resolve as () => void))
    expect((connected as NodeJS.ErrnoException).code).toBe('ENETUNREACH')
    expect(guard.taken()).toEqual([attempt('dgram', OFF, 9), attempt('dgram', OFF, 9)])
    const arrived = once(receiver, 'message')
    sender.send('eval', (receiver.address()).port, '127.0.0.1')
    expect(String((await arrived)[0])).toBe('eval')
    expect(guard.taken()).toEqual([])
  } finally {
    receiver.close()
    sender.close()
  }
})

it('install wraps every entry point, and uninstall puts each back', () => {
  guard.uninstall()
  const before = doors()
  guard = guardThisProcess()
  const installed = doors()
  expect(Object.keys(before).filter((door) => installed[door] === before[door])).toEqual([])
  guard.uninstall()
  expect(doors()).toEqual(before)
  expect(sources()).toBe(pristine)
})

// A proxy on this machine would carry each request off it, past every check of the guard's.
it.each<[string, Record<string, string>]>([
  ['NODE_USE_ENV_PROXY', { NODE_USE_ENV_PROXY: '1' }],
  ['--use-env-proxy', { NODE_OPTIONS: '--max-old-space-size=123 --use-env-proxy' }],
])('%s from the env stops the guard installing, naming it', (name, env) => {
  guard.uninstall()
  let installed: ReturnType<typeof guardThisProcess> | undefined
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  try {
    expect(() => { installed = guardThisProcess() }).toThrow(`the network guard cannot hold under ${name}`)
  } finally {
    installed?.uninstall()
    vi.unstubAllEnvs()
    guard = guardThisProcess()
  }
})

it('describes an attempt by its process, its door, its host and its port', () => {
  expect(describeAttempt(attempt('net', OFF, 9))).toBe(`node net ${OFF}:9`)
  expect(describeAttempt({ ...attempt('dns', 'example.invalid', null), process: 'devices' })).toBe('devices dns example.invalid')
})

describe('the preload', () => {
  /** A child Node as harnessd starts one, `--` its role, with the env given; its stdout once it exits. */
  async function child(role: string, env: Record<string, string>, script: string): Promise<{ pid: number; stdout: string }> {
    const root = mkdtempSync(join(tmpdir(), 'ng-'))
    roots.push(root)
    const started = spawn(process.execPath, ['-e', script, '--', role], { env: { HOME: root, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    started.stdout.on('data', (chunk) => { stdout += chunk })
    started.stderr.on('data', (chunk) => { stderr += chunk })
    const [code] = await once(started, 'exit')
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    return { pid: started.pid!, stdout }
  }
  const folder = () => {
    const root = mkdtempSync(join(tmpdir(), 'ng-'))
    roots.push(root)
    return root
  }

  it('preloaded through netGuardEnv into a child Node with __service and HARNESSD_SERVICE=devices, the file records it '
    + 'loaded as devices and its attempt on 192.0.2.1, and its local connection works', async () => {
    const server = net.createServer((socket) => socket.end('ok'))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const file = join(folder(), 'net.jsonl')
    try {
      const { pid, stdout } = await child('__service', { ...netGuardEnv(file), HARNESSD_SERVICE: 'devices' }, `
        const net = require('node:net')
        net.connect(9, '${OFF}').on('error', (error) => {
          console.log(error.code)
          const local = net.connect(${(server.address() as net.AddressInfo).port}, '127.0.0.1')
          local.setEncoding('utf8')
          local.on('data', (said) => console.log(said))
        })
      `)
      expect(stdout.split('\n').filter(Boolean)).toEqual(['ENETUNREACH', 'ok'])
      expect(readNetGuard(file)).toEqual({
        loaded: [{ pid, process: 'devices' }],
        attempts: [{ api: 'net', host: OFF, port: 9, pid, process: 'devices' }],
      })
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      server.close()
    }
  })

  it('netGuardEnv keeps the NODE_OPTIONS it is given', async () => {
    const file = join(folder(), 'net.jsonl')
    // An option the child reads back exactly: a heap limit also counts the young generation, whose size differs by
    // Node version (over 200 MiB under --max-old-space-size=123 on Node 24 and 26).
    const env = netGuardEnv(file, '--stack-trace-limit=7')
    expect(env[NET_GUARD_FILE_ENV]).toBe(file)
    expect(env.NODE_OPTIONS.endsWith(' --stack-trace-limit=7')).toBe(true)
    const { pid, stdout } = await child('__run', env, 'console.log(Error.stackTraceLimit)')
    expect(stdout.trim()).toBe('7')
    expect(readNetGuard(file).loaded).toEqual([{ pid, process: 'core' }])
  })

  it('without its file the preload installs nothing', async () => {
    const { NODE_OPTIONS } = netGuardEnv(join(folder(), 'net.jsonl'))
    expect(NODE_OPTIONS).toContain(NET_GUARD_PRELOAD.split(/[\\/]/).pop())
    const { stdout } = await child('__harnessd', { NODE_OPTIONS }, `
      const net = require('node:net'), dgram = require('node:dgram'), dns = require('node:dns')
      console.log(JSON.stringify([net.Socket.prototype.connect, dgram.Socket.prototype.send, dgram.Socket.prototype.connect,
        dns.lookup, dns.promises.lookup].map(String).join('\\n')))
    `)
    expect(JSON.parse(stdout)).toBe(pristine)
  })

  it('a Node started with --use-env-proxy does not start under it, and says why', async () => {
    const started = spawn(process.execPath, ['--use-env-proxy', '-e', 'console.log("ran")'],
      { env: { HOME: folder(), ...netGuardEnv(join(folder(), 'net.jsonl')) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let said = ''
    started.stdout.on('data', (chunk) => { said += chunk })
    started.stderr.on('data', (chunk) => { said += chunk })
    const [code] = await once(started, 'exit')
    expect(code).not.toBe(0)
    expect(said).toContain('the network guard cannot hold under --use-env-proxy')
    expect(said).not.toContain('ran')
  })

  it('a missing file reads as nothing', () => {
    expect(readNetGuard(join(folder(), 'none.jsonl'))).toEqual({ loaded: [], attempts: [] })
  })
})
