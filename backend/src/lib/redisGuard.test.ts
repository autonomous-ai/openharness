import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { Redis } from 'ioredis'
import { createCircuitBreaker, CircuitOpenError } from './circuitBreaker.js'
import { guardRedisCommands, isRedisFailure, wasNotSent } from './redisGuard.js'

// Real clients, against the fake server below: the shared setup's never connect (noRedis.test-support.ts).
vi.unmock('ioredis')

// A real ioredis client against a loopback server that speaks just enough RESP: while `answering` is false it reads
// commands and never replies (a Redis that is up but stuck); once answering it owes, and sends in order, a nil for every
// command it has read, as a Redis that comes unstuck does.
let server: Server | undefined
let client: Redis | undefined
const sockets = new Set<Socket>()
afterEach(async () => {
  client?.disconnect()
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = client = undefined
})

async function stuckRedis(): Promise<{ client: Redis; answer: (on: boolean, reply?: string) => void; commands: () => number }> {
  let answering = false
  let reply = '$-1\r\n'
  let commands = 0
  const owed = new Map<Socket, number>()
  server = createServer(socket => {
    sockets.add(socket)
    owed.set(socket, 0)
    socket.on('data', (chunk: Buffer) => {
      const count = chunk.toString('utf8').split('\r\n').filter(line => line.startsWith('*')).length
      commands += count
      if (answering) socket.write(reply.repeat(count))
      else owed.set(socket, owed.get(socket)! + count)
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  client = new Redis({ port: (server.address() as AddressInfo).port, host: '127.0.0.1', enableReadyCheck: false,
    enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 50, lazyConnect: true })
  await client.connect()
  const answer = (on: boolean, with_ = '$-1\r\n') => {
    answering = on
    reply = with_
    if (!on) return
    for (const [socket, count] of owed) { socket.write(reply.repeat(count)); owed.set(socket, 0) }
  }
  return { client, answer, commands: () => commands }
}

describe('guarded Redis commands', () => {
  it('a stuck Redis costs the command timeout a few times, then commands fail at once without being sent', async () => {
    const redis = await stuckRedis()
    guardRedisCommands(redis.client, createCircuitBreaker({ name: 'redis', failureThreshold: 3, openMs: 60_000 }))
    for (let i = 0; i < 3; i++) await expect(redis.client.get('k')).rejects.toThrow(/timed out/i)
    const sent = redis.commands()

    const started = Date.now()
    const refused = await redis.client.get('k').catch((err: unknown) => err)

    expect(refused).toBeInstanceOf(CircuitOpenError)
    expect(wasNotSent(refused)).toBe(true)
    expect(Date.now() - started).toBeLessThan(40)
    expect(redis.commands()).toBe(sent)
  })

  it('tries again after the open period and closes on an answer', async () => {
    let now = 0
    const redis = await stuckRedis()
    const breaker = createCircuitBreaker({ name: 'redis', failureThreshold: 1, openMs: 1_000, now: () => now })
    guardRedisCommands(redis.client, breaker)
    await expect(redis.client.get('k')).rejects.toThrow(/timed out/i)
    redis.answer(true)
    await expect(redis.client.get('k')).rejects.toBeInstanceOf(CircuitOpenError)

    now += 1_000
    await expect(redis.client.get('k')).resolves.toBeNull()

    expect(breaker.state()).toBe('closed')
    await expect(redis.client.set('k', 'v')).resolves.toBeNull()
  })

  it('leaves transactions and pipelines to the command timeout alone, so their batch is never split', async () => {
    const redis = await stuckRedis()
    guardRedisCommands(redis.client, createCircuitBreaker({ name: 'redis', failureThreshold: 1, openMs: 60_000 }))
    await expect(redis.client.get('k')).rejects.toThrow(/timed out/i)
    redis.answer(true)

    const results = await redis.client.pipeline().get('a').get('b').exec()

    expect(results).toEqual([[null, null], [null, null]])
  })

  it('a command that could not be written because Redis is away was not sent', async () => {
    const offline = new Redis({ lazyConnect: true, enableOfflineQueue: false })
    const error = await offline.get('k').catch((err: unknown) => err)

    expect(wasNotSent(error)).toBe(true)
    expect(wasNotSent(new Error('Command timed out'))).toBe(false)
    offline.disconnect()
  })

  it('an error Redis answers with is Redis working, not failing', async () => {
    const redis = await stuckRedis()
    const breaker = createCircuitBreaker({ name: 'redis', failureThreshold: 2, openMs: 60_000, isFailure: isRedisFailure })
    guardRedisCommands(redis.client, breaker)
    redis.answer(true, '-WRONGTYPE Operation against a key holding the wrong kind of value\r\n')
    for (let i = 0; i < 5; i++) await expect(redis.client.get('k')).rejects.toThrow(/WRONGTYPE/)

    expect(breaker.state()).toBe('closed')
  })

  // While the circuit is closed a command is sent directly and its outcome counted from its own promise: no `run`, no
  // async frame and no AbortController per command (spec 2026-11-02-swarm-cache-delta-design, Part 4).
  it('a closed circuit sends without run', async () => {
    const redis = await stuckRedis()
    const breaker = createCircuitBreaker({ name: 'redis', failureThreshold: 5, openMs: 5_000, isFailure: isRedisFailure })
    const run = vi.spyOn(breaker, 'run')
    guardRedisCommands(redis.client, breaker)
    redis.answer(true)

    await expect(redis.client.get('k')).resolves.toBeNull()
    await expect(redis.client.set('k', 'v')).resolves.toBeNull()

    expect(run).not.toHaveBeenCalled()
    expect(breaker.state()).toBe('closed')
  })

  it('five failures through the fast path open it', async () => {
    const redis = await stuckRedis()
    const breaker = createCircuitBreaker({ name: 'redis', failureThreshold: 5, openMs: 5_000, isFailure: isRedisFailure })
    const run = vi.spyOn(breaker, 'run')
    guardRedisCommands(redis.client, breaker)

    for (let i = 0; i < 4; i++) await expect(redis.client.get('k')).rejects.toThrow(/timed out/i)
    expect(breaker.state()).toBe('closed')
    await expect(redis.client.get('k')).rejects.toThrow(/timed out/i)

    expect(breaker.state()).toBe('open')
    expect(run).not.toHaveBeenCalled()
    const sent = redis.commands()
    await expect(redis.client.get('k')).rejects.toBeInstanceOf(CircuitOpenError)
    expect(redis.commands()).toBe(sent)
  })

  it('open refuses, and after 5 s one trial closes it on success', async () => {
    let now = 0
    const redis = await stuckRedis()
    const breaker = createCircuitBreaker({ name: 'redis', failureThreshold: 5, openMs: 5_000, isFailure: isRedisFailure, now: () => now })
    guardRedisCommands(redis.client, breaker)
    for (let i = 0; i < 5; i++) await expect(redis.client.get('k')).rejects.toThrow(/timed out/i)
    redis.answer(true)
    now += 4_999
    await expect(redis.client.get('k')).rejects.toBeInstanceOf(CircuitOpenError)

    now += 1
    // One trial at a time: the second command, sent while the first is in flight, is still refused.
    const trial = redis.client.get('k')
    const other = redis.client.get('k').catch((err: unknown) => err)
    await expect(trial).resolves.toBeNull()
    expect(await other).toBeInstanceOf(CircuitOpenError)

    expect(breaker.state()).toBe('closed')
    await expect(redis.client.get('k')).resolves.toBeNull()
  })

  it('a reply error does not count as a failure', async () => {
    const redis = await stuckRedis()
    const breaker = createCircuitBreaker({ name: 'redis', failureThreshold: 2, openMs: 60_000, isFailure: isRedisFailure })
    const run = vi.spyOn(breaker, 'run')
    guardRedisCommands(redis.client, breaker)

    await expect(redis.client.get('k')).rejects.toThrow(/timed out/i)
    redis.answer(true, '-WRONGTYPE Operation against a key holding the wrong kind of value\r\n')
    await expect(redis.client.get('k')).rejects.toThrow(/WRONGTYPE/)
    redis.answer(false)
    // The answer in between reset the count, so one more timeout is the first in a row again.
    await expect(redis.client.get('k')).rejects.toThrow(/timed out/i)

    expect(breaker.state()).toBe('closed')
    expect(run).not.toHaveBeenCalled()
  })

  it('lets a connection that is not ready yet send its own setup, so it can come back while the circuit is open', async () => {
    // A Redis that answers, including the INFO that ioredis' ready check sends before the connection is ready.
    server = createServer(socket => {
      sockets.add(socket)
      socket.on('data', (chunk: Buffer) => {
        // One answer per command in the chunk: a command starts with its `*` count, and INFO is the only one named alone.
        for (const command of chunk.toString('utf8').split(/(?=\*\d+\r\n)/)) {
          if (command) socket.write(/^\*1\r\n\$4\r\ninfo\r\n$/i.test(command) ? '$9\r\nloading:0\r\n' : '$-1\r\n')
        }
      })
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    client = new Redis({ port: (server.address() as AddressInfo).port, host: '127.0.0.1', enableOfflineQueue: false, lazyConnect: true })
    const breaker = createCircuitBreaker({ name: 'redis', failureThreshold: 1, openMs: 60_000 })
    await breaker.run(() => Promise.reject(new Error('Command timed out'))).catch(() => {})
    guardRedisCommands(client, breaker)

    await client.connect()

    expect(client.status).toBe('ready')
    await expect(client.get('k')).rejects.toBeInstanceOf(CircuitOpenError)
  })
})
