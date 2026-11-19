import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startEngineSetup } from './engineSetup.js'
import { createNativeSetupLink } from '../engines/kit/nativeSetupLink.js'
import type { NativeSetup } from '../engines/kit/nativeSetup.js'
import { createServiceLinks, type ServiceFrame, type ServiceLink } from '../core/serviceLinks.js'
import { runServiceProcess } from './process.js'

const owner = { local: true, owner: true }
let setup: NativeSetup, service: ReturnType<typeof startEngineSetup>
const input = (engine: 'claude' | 'codex' = 'codex') => ({
  purpose: 'launchSettings' as const, version: 2 as const, engine, environment: { HOME: '/fixture/home' }, cwd: '/fixture/work',
  runtimeNode: '/fixture/node', platform: 'darwin' as const, gitBash: null,
  owner: { machineId: 'fixture-machine', accountId: 'fixture-account' },
})
const candidate = (engine: 'claude' | 'codex' = 'codex') => ({ version: 2 as const,
  values: { instructions: 'prepared instruction', settings: engine === 'claude' ? '{"statusLine":{"type":"command","command":"fixture","padding":2}}' : null },
})
const rendering = (answer = candidate()) => vi.fn<NonNullable<NativeSetup['prepareSettings']>>(async (_input, _request, current, commit) =>
  await commit!() && current() ? answer : null)
const request = (type: string, payload: Record<string, unknown>) => Promise.resolve(service.requests[type]!(payload, owner))
beforeEach(() => {
  setup = { probe: vi.fn(async () => null), opencodeMajor: vi.fn(async () => null), hermesKeepsRecord: vi.fn(async () => null),
    downloading: vi.fn(async () => false), installations: { ensure: vi.fn(), status: vi.fn() } }
  service = startEngineSetup('/fixture/data', setup)
})
afterEach(() => { service.stop() })

describe('optional component snapshots on existing preparation', () => {
  it.each(['codex', 'claude'] as const)('releases only declared snapshot values for %s after positive commit', async engine => {
    const given = input(engine), prepared = candidate(engine)
    setup.prepareSettings = rendering(prepared)
    const pending = await request('setup_files_prepare', { request: 'optional', ...given })
    expect(pending.preparation).toBeTypeOf('string')
    expect(await request('setup_files_commit', { ...pending, purpose: given.purpose, version: 2, engine, request: 'optional', allowed: true }))
      .toEqual({ files: prepared })
    expect(setup.prepareSettings).toHaveBeenCalledExactlyOnceWith(given, 'optional', expect.any(Function), expect.any(Function))
    expect(setup.installations.ensure).not.toHaveBeenCalled()
  })

  it.each(['codex', 'claude'] as const)('preserves %s settings across the real routed service envelope', async engine => {
    const given = input(engine), prepared = candidate(engine), routed: ServiceFrame[] = []
    setup.prepareSettings = rendering(prepared)
    const links = createServiceLinks({ token: 'fixture-token', owned: { engineSetup: ['setup_files_prepare', 'setup_files_commit', 'setup_prepare'] },
      answer: () => ({}), log: () => {} })
    let accepted: ServiceLink | null = null
    // Only the socket is in memory: both production routers parse their real serialized envelopes.
    class Socket extends EventEmitter {
      readyState: number = WebSocket.CONNECTING
      receive(frame: ServiceFrame): void { this.emit('message', Buffer.from(JSON.stringify(frame)), false) }
      send(text: string): void {
        const frame = JSON.parse(text) as ServiceFrame
        if (frame.type === 'machine_select') {
          expect(frame.payload).toMatchObject({ role: 'service', service: 'engineSetup', token: 'fixture-token' })
          accepted = links.accept('engineSetup', 'fixture-token', { sendFrame: message => {
            routed.push(message); this.receive(message); return true
          } }, () => this.close(), () => this.receive({ type: 'connected' }))
          expect(accepted).not.toBeNull()
        } else accepted!.receive(frame)
      }
      close(): void { this.readyState = WebSocket.CLOSED; this.emit('close', 1000); accepted?.closed() }
      terminate(): void { this.close() }
    }
    const socket = new Socket()
    const transport = runServiceProcess({ name: 'engineSetup', socketPath: '/fixture/socket', machineId: 'fixture-machine',
      token: 'fixture-token', requests: service.requests, onDisconnected: service.disconnect, env: {}, log: () => {},
      connect: () => socket as unknown as WebSocket })
    socket.readyState = WebSocket.OPEN; socket.emit('open')
    try {
      const link = createNativeSetupLink((type, payload, wait) => links.call('engineSetup', type, payload, wait))
      expect(await link.prepareSettings!(given, 'routed-optional', () => true)).toEqual(prepared)
      expect(routed.map(frame => frame.type)).toEqual(['setup_files_prepare', 'setup_files_commit'])
      expect(routed.map(frame => frame.payload?.requestId)).toEqual([expect.any(String), expect.any(String)])
      expect(routed[0].payload!.requestId).not.toBe(routed[1].payload!.requestId)
      expect(setup.prepareSettings).toHaveBeenCalledExactlyOnceWith(given, 'routed-optional', expect.any(Function), expect.any(Function))
      expect(await links.call('engineSetup', 'setup_files_prepare', { ...given, request: 'unknown-field', argv: ['outside'] }))
        .toEqual({ files: null })
      expect(await links.call('engineSetup', 'setup_prepare', { ...given, request: 'generic', kind: 'files' }))
        .toEqual({ installation: { complete: false, detail: 'Waiting for engine setup.' } })
      expect(setup.prepareSettings).toHaveBeenCalledOnce()
      expect(setup.installations.ensure).not.toHaveBeenCalled()
    } finally { await transport.stop() }
  })

  it('carries a settings-only candidate through the core link without exposing publication files', async () => {
    const given = input(), prepared = candidate()
    setup.prepareSettings = rendering(prepared)
    const link = createNativeSetupLink((type, payload) => request(type, payload))
    expect(await link.prepareSettings!(given as never, 'optional-snapshot', () => true)).toEqual(prepared)
    expect(setup.installations.ensure).not.toHaveBeenCalled()
  })

  it.each([
    { settings: '{"permissions":{"allow":["Bash(*)"]}}' },
    { settings: '{"statusLine":{},"hooks":{}}' },
    { settings: '[]' },
    { settings: '{"statusLine":{}}\u0000' },
    { instructions: 'x'.repeat(65_537) },
    { instructions: null, unexpected: 'argv' },
  ])('never releases undeclared or oversized optional settings %j', async values => {
    setup.prepareSettings = vi.fn(async () => ({ ...candidate('claude'), values: { ...candidate('claude').values, ...values } })) as never
    expect(await request('setup_files_prepare', { request: 'invalid', ...input('claude') })).toEqual({ files: null })
  })

  it('keeps ordinary hook preparation strict when its output count is zero', async () => {
    setup.prepareFiles = vi.fn(async () => ({ version: 1, files: [] })) as never
    expect(await request('setup_files_prepare', { engine: 'codex', request: 'ordinary', environment: { HOME: '/fixture/home' }, port: 1234, files: [] }))
      .toEqual({ files: null })
    expect(setup.prepareFiles).not.toHaveBeenCalled()
  })
})

it('uses one optional deadline for prepare and commit, including a late reply', async () => {
  let now = 100
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  try {
    const call = vi.fn(async (type: string) => {
      if (type === 'setup_files_prepare') { now = 3100; return { preparation: 'prepared' } }
      now = 5100
      return { files: candidate() }
    })
    expect(await createNativeSetupLink(call).prepareSettings!(input(), 'deadline', () => true)).toBeNull()
    expect(call.mock.calls[0]).toEqual(['setup_files_prepare', expect.any(Object), 5000])
    expect(call.mock.calls[1]).toEqual(['setup_files_commit', expect.any(Object), 2000])
  } finally { clock.mockRestore() }
})

it('keeps required setup admission available while optional renderers remain unsettled', async () => {
  const settle: ((value: null) => void)[] = []
  setup.prepareSettings = vi.fn(() => new Promise<null>(resolve => settle.push(resolve)))
  const pending = Array.from({ length: 7 }, (_, index) => request('setup_files_prepare', { request: `held-${index}`, ...input() }))
  try {
    expect(await request('setup_files_prepare', { request: 'overflow', ...input() })).toMatchObject({ error: 'SETUP_BUSY' })
    expect(await request('setup_download', { engine: 'codex' })).toEqual({ downloading: false })
    expect(setup.downloading).toHaveBeenCalledOnce()
  } finally { settle.forEach(done => done(null)); await Promise.all(pending) }
})

it('reserves native file preparation space when seven optional commits are outstanding', async () => {
  setup.prepareSettings = rendering()
  setup.prepareFiles = vi.fn(async () => ({ version: 1 as const, files: [{ index: 0, content: '{}' }] }))
  const tokens = await Promise.all(Array.from({ length: 7 }, (_, index) => request('setup_files_prepare', { request: `optional-${index}`, ...input() })))
  expect(tokens.every(token => typeof token.preparation === 'string')).toBe(true)
  expect(await request('setup_files_prepare', { request: 'optional-overflow', ...input() })).toMatchObject({ error: 'SETUP_BUSY' })
  const hook = { engine: 'codex', environment: { HOME: '/fixture/home' }, port: 1234,
    files: [{ file: '/fixture/config.toml', directory: '/fixture', content: null }] }
  const ready = await request('setup_files_prepare', { request: 'required', ...hook })
  expect(ready.preparation).toBeTypeOf('string')
  expect(await request('setup_files_commit', { ...ready, engine: 'codex', request: 'required', allowed: true }))
    .toEqual({ files: { version: 1, files: [{ index: 0, content: '{}' }] } })
})

it('binds an optional preparation token to its purpose and refuses unknown purposes', async () => {
  setup.prepareSettings = rendering()
  const ready = await request('setup_files_prepare', { request: 'purpose', ...input() })
  expect(await request('setup_files_commit', { ...ready, engine: 'codex', request: 'purpose', allowed: true })).toEqual({ files: null })
  expect(await request('setup_files_commit', { ...ready, purpose: 'unknown', engine: 'codex', request: 'purpose', allowed: true })).toEqual({ files: null })
  expect(await request('setup_files_commit', { ...ready, purpose: 'launchSettings', version: 2, engine: 'codex', request: 'purpose', allowed: true })).toEqual({ files: candidate() })
  expect(await request('setup_files_prepare', { request: 'unknown', ...input(), purpose: 'unknown' })).toEqual({ files: null })
})

it('expires optional replies promptly while retaining unsettled ownership and required admission', async () => {
  vi.useFakeTimers()
  const settle: ((value: null) => void)[] = []
  setup.prepareSettings = vi.fn(() => new Promise<null>(resolve => settle.push(resolve)))
  const pending = Array.from({ length: 7 }, (_, index) => request('setup_files_prepare', { request: `expiry-${index}`, ...input() }))
  try {
    await vi.advanceTimersByTimeAsync(5000)
    expect(await Promise.all(pending)).toEqual(Array(7).fill({ files: null }))
    expect(await request('setup_files_prepare', { request: 'still-owned', ...input() })).toMatchObject({ error: 'SETUP_BUSY' })
    expect(await request('setup_download', { engine: 'codex' })).toEqual({ downloading: false })
  } finally { settle.forEach(done => done(null)); await Promise.all(pending); vi.useRealTimers() }
})

it('refuses missing renderers and invalid settings inputs without preparing, and names renderer failure without content', async () => {
  expect(await request('setup_files_prepare', { request: 'missing', ...input() })).toEqual({ files: null })
  setup.prepareSettings = vi.fn(async () => { throw Error('private fixture content') })
  expect(await request('setup_files_prepare', { request: 'invalid', ...input(), argv: ['outside'] })).toEqual({ files: null })
  expect(setup.prepareSettings).not.toHaveBeenCalled()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(await request('setup_files_prepare', { request: 'throws', ...input() })).toEqual({ files: null })
    expect(warning).toHaveBeenCalledExactlyOnceWith('[engine-setup] SETTINGS_PREPARATION_FAILED · Error')
  } finally { warning.mockRestore() }
})

it('refuses generic settings requests beside alias work without consuming the reserved required slot', async () => {
  setup.prepareSettings = rendering()
  const ready = await request('setup_files_prepare', { request: 'alias-token', ...input() })
  expect(ready.preparation).toBeTypeOf('string')
  const commit = { ...ready, kind: 'files', purpose: 'launchSettings', version: 2, engine: 'codex', request: 'alias-token', allowed: true }
  expect(await request('setup_commit', commit)).toEqual({ installation: { complete: false, detail: 'Waiting for engine setup.' } })
  expect(await request('setup_files_commit', commit)).toEqual({ files: candidate() })

  const settle: ((value: null) => void)[] = []
  setup.prepareSettings = vi.fn(() => new Promise<null>(resolve => settle.push(resolve)))
  const pending = Array.from({ length: 7 }, (_, index) => request('setup_files_prepare', { request: `mixed-${index}`, ...input() }))
  try {
    expect(await request('setup_prepare', { kind: 'files', request: 'generic-overflow', ...input() }))
      .toEqual({ installation: { complete: false, detail: 'Waiting for engine setup.' } })
    expect(setup.prepareSettings).toHaveBeenCalledTimes(7)
    expect(await request('setup_files_prepare', { request: 'alias-overflow', ...input() })).toMatchObject({ error: 'SETUP_BUSY' })
    expect(await request('setup_download', { engine: 'codex' })).toEqual({ downloading: false })
    expect(setup.downloading).toHaveBeenCalledOnce()
  } finally { settle.forEach(done => done(null)); await Promise.all(pending) }
})

it('refuses old worker snapshots and never falls back to core rendering', async () => {
  const calls: string[] = []
  const link = createNativeSetupLink(async type => {
    calls.push(type)
    return type === 'setup_files_prepare' ? { preparation: 'old-worker' } : { files: { version: 1, values: candidate().values, files: [] } }
  })
  expect(await link.prepareSettings!(input(), 'old-worker', () => true)).toBeNull()
  expect(calls).toEqual(['setup_files_prepare', 'setup_files_commit'])
})

it('does not send old context or expired commit authorization', async () => {
  const call = vi.fn(async () => ({ preparation: 'late' }))
  const link = createNativeSetupLink(call)
  expect(await link.prepareSettings!({ ...input(), version: 1 } as never, 'old-core', () => true)).toBeNull()
  expect(call).not.toHaveBeenCalled()
  let now = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
  call.mockImplementationOnce(async () => { now = 5000; return { preparation: 'late' } })
  try {
    expect(await link.prepareSettings!(input(), 'late', () => true)).toBeNull()
    expect(call).toHaveBeenCalledOnce()
  } finally { clock.mockRestore() }
})

it.each([{}, { preparation: '' }, { preparation: 'x\0' }])('omits unavailable optional worker preparation %j', async answer => {
  const call = vi.fn(async () => answer)
  expect(await createNativeSetupLink(call).prepareSettings!(input(), 'unavailable', () => true)).toBeNull()
  expect(call).toHaveBeenCalledOnce()
})
it('refuses a late component commit request after disconnect revoked its capture', async () => {
  let release!: () => void
  const captured = new Promise<void>(done => { release = done })
  const permitted = vi.fn()
  setup.prepareSettings = async (_input, _request, _current, commit) => {
    await captured
    permitted(await commit!())
    return null
  }
  const pending = request('setup_files_prepare', { request: 'disconnected-capture', ...input() })
  service.disconnect(); release()
  expect(await pending).toEqual({ files: null })
  expect(permitted).toHaveBeenCalledExactlyOnceWith(false)
})
