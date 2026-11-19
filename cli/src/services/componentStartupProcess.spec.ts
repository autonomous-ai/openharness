import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import type { CoreMessage } from '../harnessd/protocol.js'
import type { ServiceProcessOptions } from '../serviceProcess.js'
import type { ComponentStartupOptions } from './componentStartup.js'
import { runComponentStartupService } from './componentStartupProcess.js'

const options: ServiceProcessOptions = { dataDir: '/saved', socketPath: '/unused', token: 'unused', machineId: 'unused' }
const snapshot = { type: 'harnessd:peers', available: ['devices', 'wifi'], started: ['wifi'] }
let channel: EventEmitter & { send?: Mock<(message: CoreMessage, done: (error?: Error | null) => void) => unknown> }
let active: { started: Mock<(service: string) => void>; stop: Mock<() => void> }
let start: ReturnType<typeof vi.fn<(config: ComponentStartupOptions) => typeof active>>
let log: Mock<(line: string) => void>
beforeEach(() => {
  vi.useFakeTimers()
  channel = Object.assign(new EventEmitter(), { send: vi.fn((_message, done) => done(null)) })
  active = { started: vi.fn(), stop: vi.fn() }; start = vi.fn(() => active); log = vi.fn()
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const run = () => runComponentStartupService(options, { channel, start, log, runtimeDir: '/runtime', cableDisabled: true, testDialPort: '/fixture' })

it('subscribes before sending and starts once from the bounded master snapshot', () => {
  channel.send = vi.fn((_message, done) => { channel.emit('message', snapshot); done() })
  const service = run()
  expect(channel.send).toHaveBeenCalledWith({ type: 'harnessd:watch-peers' }, expect.any(Function))
  expect(start).toHaveBeenCalledOnce()
  const config = start.mock.calls[0][0]
  expect(config).toMatchObject({ dataDir: '/saved', runtimeDir: '/runtime', cableDisabled: true, testDialPort: '/fixture', available: new Set(['devices', 'wifi']), started: new Set(['wifi']) })
  channel.emit('message', snapshot)
  channel.emit('message', { type: 'harnessd:peer-started', service: 'devices' })
  expect(active.started).toHaveBeenCalledWith('devices')
  config.want('devices')
  expect(channel.send).toHaveBeenLastCalledWith({ type: 'harnessd:want', service: 'devices' }, expect.any(Function))
  expect(start).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  service.stop(); service.stop(); config.want('devices')
  expect(active.stop).toHaveBeenCalledOnce(); expect(channel.listenerCount('message')).toBe(0)
})

it('ignores unrelated messages and pre-snapshot deltas, then times out visibly', () => {
  run()
  channel.emit('message', null)
  channel.emit('message', { type: 'harnessd:update', version: '1' })
  channel.emit('message', { type: 'harnessd:peer-started', service: 'devices' })
  vi.advanceTimersByTime(10_000)
  expect(start).not.toHaveBeenCalled(); expect(active.started).not.toHaveBeenCalled()
  expect(log.mock.calls).toEqual([['[startup] STARTUP_UNAVAILABLE']])
  expect(channel.listenerCount('message')).toBe(0); expect(vi.getTimerCount()).toBe(0)
})

it.each([false, true])('honors shutdown with active detector %s', initialized => {
  const service = run()
  if (initialized) channel.emit('message', snapshot)
  channel.emit('message', { type: 'harnessd:shutdown' })
  service.stop(); vi.advanceTimersByTime(10_000)
  expect(active.stop).toHaveBeenCalledTimes(initialized ? 1 : 0); expect(log).not.toHaveBeenCalled()
})

it.each(['missing', 'throw', 'callback'])('stops on %s IPC failure', mode => {
  let completion: ((error: Error) => void) | undefined
  if (mode === 'missing') delete channel.send
  if (mode === 'throw') channel.send = vi.fn(() => { throw new Error('private') })
  if (mode === 'callback') channel.send = vi.fn((_message, done) => { completion = done })
  const service = run()
  completion?.(new Error('private')); completion?.(new Error('late'))
  expect(log.mock.calls).toEqual([['[startup] STARTUP_UNAVAILABLE']])
  expect(channel.listenerCount('message')).toBe(0); expect(vi.getTimerCount()).toBe(0)
  service.stop()
})

it('stops an initialized detector on failed peer-start delivery', () => {
  const service = run(); channel.emit('message', snapshot)
  channel.send = vi.fn((_message, done) => done(new Error('private')))
  start.mock.calls[0][0].want('devices')
  expect(active.stop).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalledOnce(); service.stop()
})

it('releases a detector constructed during synchronous send failure', () => {
  run()
  channel.send = vi.fn(() => { throw new Error('closed') })
  start.mockImplementation(config => { config.want('devices'); return active })
  channel.emit('message', snapshot)
  expect(active.stop).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalledOnce()
})

it('reports a failed detector without leaking its handshake listener', () => {
  start.mockImplementation(() => { throw new Error('private') })
  run(); channel.emit('message', snapshot)
  expect(log.mock.calls).toEqual([['[startup] STARTUP_UNAVAILABLE']])
  expect(channel.listenerCount('message')).toBe(0)
})

it('can run beside core without connecting to its socket or reading a credential', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  // Vitest uses a real fork channel. Stub only its send; never send a product message to the test runner.
  vi.spyOn(process, 'send').mockImplementation(() => { throw new Error('closed') })
  const service = runComponentStartupService(options)
  // A closed master channel refuses once and owns no timer or listener.
  expect(warn).toHaveBeenCalledWith('[startup] STARTUP_UNAVAILABLE')
  expect(vi.getTimerCount()).toBe(0); service.stop()
})

it('uses environment defaults only after a valid snapshot arrives', () => {
  const service = runComponentStartupService(options, { channel, start, log })
  channel.emit('message', snapshot)
  expect(start.mock.calls[0][0].runtimeDir).toEqual(expect.any(String))
  service.stop()
})
