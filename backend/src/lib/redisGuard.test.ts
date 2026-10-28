import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { Redis } from 'ioredis'
import { createCircuitBreaker, CircuitOpenError } from './circuitBreaker.js'
import { guardRedisCommands, isRedisFailure, wasNotSent } from './redisGuard.js'

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
})
