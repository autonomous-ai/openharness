/**
 * The dial eval's network guard (netGuard.cjs). Never a real host: every refused attempt goes to 192.0.2.1 (TEST-NET-1)
 * or example.invalid, so a guard that let one through still reaches nobody.
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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket as WsWebSocket } from 'ws'
import { describeAttempt, guardThisProcess, isLocal, NET_GUARD_FILE_ENV, NET_GUARD_PRELOAD, netGuardEnv, readNetGuard,
  type NetAttempt } from './netGuard.js'

const OFF = '192.0.2.1'
// Not 9, the discard port: fetch and WebSocket refuse it themselves, before any socket the guard could see.
const PORT = 8
const RESOLVES = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx',
  'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt'] as const

/** The source of each guarded entry point: a Node with nothing installed has these. */
function sources(): string {
  return [net.Socket.prototype.connect, dgram.Socket.prototype.send, dgram.Socket.prototype.connect, dns.lookup,
    dns.promises.lookup].map(String).join('\n')
}
const pristine = sources()

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

  it.each([undefined, '', 'localhost', 'eval.localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '::1', '::', '[::1]',
    '::ffff:127.0.0.1', '[::ffff:127.0.0.1]'])('%s is local', (host) => {
    expect(isLocal(host)).toBe(true)
  })

  it.each([OFF, 'example.invalid', '10.0.0.1', '192.168.1.2', '::ffff:192.0.2.1', '2001:db8::1', 'localhost.example.invalid'])(
    '%s is not', (host) => {
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

it('uninstall puts every entry point back', () => {
  guard.uninstall()
  const before = {
    connect: net.Socket.prototype.connect, send: dgram.Socket.prototype.send, dgramConnect: dgram.Socket.prototype.connect,
    lookup: dns.lookup, esmLookup: dnsNamespace.lookup, promisesLookup: dns.promises.lookup,
    esmPromisesLookup: dnsPromisesNamespace.lookup,
    ...Object.fromEntries(RESOLVES.flatMap((name) => [[name, dns[name]], [`promises.${name}`, dns.promises[name]]])),
  }
  guard = guardThisProcess()
  expect(net.Socket.prototype.connect).not.toBe(before.connect)
  expect(dnsNamespace.lookup).not.toBe(before.esmLookup)
  expect(dnsPromisesNamespace.lookup).not.toBe(before.esmPromisesLookup)
  guard.uninstall()
  expect({
    connect: net.Socket.prototype.connect, send: dgram.Socket.prototype.send, dgramConnect: dgram.Socket.prototype.connect,
    lookup: dns.lookup, esmLookup: dnsNamespace.lookup, promisesLookup: dns.promises.lookup,
    esmPromisesLookup: dnsPromisesNamespace.lookup,
    ...Object.fromEntries(RESOLVES.flatMap((name) => [[name, dns[name]], [`promises.${name}`, dns.promises[name]]])),
  }).toEqual(before)
  expect(sources()).toBe(pristine)
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
    const env = netGuardEnv(file, '--max-old-space-size=123')
    expect(env[NET_GUARD_FILE_ENV]).toBe(file)
    expect(env.NODE_OPTIONS.endsWith(' --max-old-space-size=123')).toBe(true)
    const { pid, stdout } = await child('__run', env, `
      console.log(require('node:v8').getHeapStatistics().heap_size_limit <= 200 * 1024 * 1024)
    `)
    expect(stdout.trim()).toBe('true')
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

  it('a missing file reads as nothing', () => {
    expect(readNetGuard(join(folder(), 'none.jsonl'))).toEqual({ loaded: [], attempts: [] })
  })
})
