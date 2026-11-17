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
