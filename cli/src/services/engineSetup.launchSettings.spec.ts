import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startEngineSetup } from './engineSetup.js'
import { createNativeSetupLink } from '../engines/kit/nativeSetupLink.js'
import type { NativeSetup } from '../engines/kit/nativeSetup.js'

const owner = { local: true, owner: true }
let setup: NativeSetup, service: ReturnType<typeof startEngineSetup>
const input = (engine: 'claude' | 'codex' = 'codex') => ({
  purpose: 'launchSettings' as const, engine, environment: { HOME: '/fixture/home' }, cwd: '/fixture/work',
  dataDir: '/fixture/data', runtimeNode: '/fixture/node', platform: 'darwin' as const, gitBash: null,
  owner: { machineId: 'fixture-machine', accountId: 'fixture-account' },
  sources: [{ file: '/fixture/data/agent-settings.json', content: '{"machineId":"fixture-machine","accountId":"fixture-account","agentsStartAgents":true}' }],
  files: engine === 'claude' ? [{ file: '/fixture/data/statusline/statusline.mjs', directory: '/fixture/data/statusline', content: null }] : [],
})
const candidate = (engine: 'claude' | 'codex' = 'codex') => ({ version: 1 as const,
  values: { instructions: 'prepared instruction', settings: engine === 'claude' ? '{"statusLine":{"type":"command","command":"fixture","padding":2}}' : null },
  files: engine === 'claude' ? [{ index: 0, content: 'prepared script' }] : [],
})
const request = (type: string, payload: Record<string, unknown>) => Promise.resolve(service.requests[type]!(payload, owner))
beforeEach(() => {
  setup = { probe: vi.fn(async () => null), opencodeMajor: vi.fn(async () => null), hermesKeepsRecord: vi.fn(async () => null),
    downloading: vi.fn(async () => false), installations: { ensure: vi.fn(), status: vi.fn() } }
  service = startEngineSetup('/fixture/data', setup)
})
afterEach(() => { service.stop() })

describe('optional launch values on existing file preparation', () => {
  it.each(['codex', 'claude'] as const)('releases only declared values and indexed outputs for %s after positive commit', async engine => {
    const given = input(engine), prepared = candidate(engine)
    setup.prepareFiles = vi.fn(async () => prepared) as never
    const pending = await request('setup_files_prepare', { request: 'optional', ...given })
    expect(pending.preparation).toBeTypeOf('string')
    expect(await request('setup_files_commit', { ...pending, purpose: given.purpose, engine, request: 'optional', allowed: true }))
      .toEqual({ files: prepared })
    expect(setup.prepareFiles).toHaveBeenCalledExactlyOnceWith(given, 'optional', expect.any(Function))
    expect(setup.installations.ensure).not.toHaveBeenCalled()
  })

  it('carries a settings-only candidate through the core link without inventing a publication file', async () => {
    const given = input(), prepared = candidate()
    setup.prepareFiles = vi.fn(async () => prepared) as never
    const link = createNativeSetupLink((type, payload) => request(type, payload))
    expect(await link.prepareFiles!(given as never, 'optional-zero-files', () => true)).toEqual(prepared)
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
    setup.prepareFiles = vi.fn(async () => ({ ...candidate('claude'), values: { ...candidate('claude').values, ...values } })) as never
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
    expect(await createNativeSetupLink(call).prepareFiles!(input(), 'deadline', () => true)).toBeNull()
    expect(call.mock.calls[0]).toEqual(['setup_files_prepare', expect.any(Object), 5000])
    expect(call.mock.calls[1]).toEqual(['setup_files_commit', expect.any(Object), 2000])
  } finally { clock.mockRestore() }
})

it('keeps required setup admission available while optional renderers remain unsettled', async () => {
  const settle: ((value: null) => void)[] = []
  setup.prepareFiles = vi.fn(() => new Promise<null>(resolve => settle.push(resolve)))
  const pending = Array.from({ length: 7 }, (_, index) => request('setup_files_prepare', { request: `held-${index}`, ...input() }))
  try {
    expect(await request('setup_files_prepare', { request: 'overflow', ...input() })).toMatchObject({ error: 'SETUP_BUSY' })
    expect(await request('setup_download', { engine: 'codex' })).toEqual({ downloading: false })
    expect(setup.downloading).toHaveBeenCalledOnce()
  } finally { settle.forEach(done => done(null)); await Promise.all(pending) }
})

it('reserves native file preparation space when seven optional commits are outstanding', async () => {
  setup.prepareFiles = vi.fn(async given => 'purpose' in given ? candidate() : { version: 1 as const, files: [{ index: 0, content: '{}' }] })
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
  setup.prepareFiles = vi.fn(async () => candidate())
  const ready = await request('setup_files_prepare', { request: 'purpose', ...input() })
  expect(await request('setup_files_commit', { ...ready, engine: 'codex', request: 'purpose', allowed: true })).toEqual({ files: null })
  expect(await request('setup_files_commit', { ...ready, purpose: 'unknown', engine: 'codex', request: 'purpose', allowed: true })).toEqual({ files: null })
  expect(await request('setup_files_commit', { ...ready, purpose: 'launchSettings', engine: 'codex', request: 'purpose', allowed: true })).toEqual({ files: candidate() })
  expect(await request('setup_files_prepare', { request: 'unknown', ...input(), purpose: 'unknown' })).toEqual({ files: null })
})

it('expires optional replies promptly while retaining unsettled ownership and required admission', async () => {
  vi.useFakeTimers()
  const settle: ((value: null) => void)[] = []
  setup.prepareFiles = vi.fn(() => new Promise<null>(resolve => settle.push(resolve)))
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
  setup.prepareFiles = vi.fn(async () => { throw Error('private fixture content') })
  expect(await request('setup_files_prepare', { request: 'invalid', ...input(), argv: ['outside'] })).toEqual({ files: null })
  expect(setup.prepareFiles).not.toHaveBeenCalled()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(await request('setup_files_prepare', { request: 'throws', ...input() })).toEqual({ files: null })
    expect(warning).toHaveBeenCalledExactlyOnceWith('[engine-setup] SETTINGS_PREPARATION_FAILED')
  } finally { warning.mockRestore() }
})

it('refuses generic settings requests beside alias work without consuming the reserved required slot', async () => {
  setup.prepareFiles = vi.fn(async () => candidate())
  const ready = await request('setup_files_prepare', { request: 'alias-token', ...input() })
  expect(ready.preparation).toBeTypeOf('string')
  const commit = { ...ready, kind: 'files', purpose: 'launchSettings', engine: 'codex', request: 'alias-token', allowed: true }
  expect(await request('setup_commit', commit)).toEqual({ installation: { complete: false, detail: 'Waiting for engine setup.' } })
  expect(await request('setup_files_commit', commit)).toEqual({ files: candidate() })

  const settle: ((value: null) => void)[] = []
  setup.prepareFiles = vi.fn(() => new Promise<null>(resolve => settle.push(resolve)))
  const pending = Array.from({ length: 7 }, (_, index) => request('setup_files_prepare', { request: `mixed-${index}`, ...input() }))
  try {
    expect(await request('setup_prepare', { kind: 'files', request: 'generic-overflow', ...input() }))
      .toEqual({ installation: { complete: false, detail: 'Waiting for engine setup.' } })
    expect(setup.prepareFiles).toHaveBeenCalledTimes(7)
    expect(await request('setup_files_prepare', { request: 'alias-overflow', ...input() })).toMatchObject({ error: 'SETUP_BUSY' })
    expect(await request('setup_download', { engine: 'codex' })).toEqual({ downloading: false })
    expect(setup.downloading).toHaveBeenCalledOnce()
  } finally { settle.forEach(done => done(null)); await Promise.all(pending) }
})
