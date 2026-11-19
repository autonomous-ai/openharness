import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  start: vi.fn(), connect: vi.fn(), request: vi.fn(), phoneClose: vi.fn(), windowClose: vi.fn(),
}))
vi.mock('../../e2e/harness/fleet.js', () => ({ startPhoneMachine: fixture.start }))
vi.mock('../../e2e/harness/client.js', () => ({ LocalClient: { connect: fixture.connect } }))
vi.mock('../../e2e/harness/relayPhone.js', () => ({ RelayPhone: class {
  open = async () => {}
  request = fixture.request
  close = fixture.phoneClose
} }))
vi.mock('../../e2e/harness/daemon.js', () => ({
  CLI_ROOT: process.cwd(), until: async (_name: string, read: () => unknown) => read(),
}))
vi.mock('../../e2e/harness/desk.js', () => ({ devicesPids: () => [20] }))
vi.mock('node:child_process', () => ({ execFileSync: (command: string) => command === 'git' ? 'fixture-head\n' : '10 00:00.10\n20 00:00.10\n' }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let root: string, reportPath: string, run: () => Promise<void>
const worlds: Array<{ machine: { daemon: { close: ReturnType<typeof vi.fn> } }; backend: { close: ReturnType<typeof vi.fn> }; close: ReturnType<typeof vi.fn> }> = []

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  worlds.length = 0
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  root = mkdtempSync(join(tmpdir(), 'owner-bench-cleanup-'))
  reportPath = join(root, 'report.json')
  const bundle = join(root, 'bundle.js')
  writeFileSync(bundle, 'fixture only')
  vi.stubEnv('OWNER_COMMANDS_BENCH_BASE', bundle)
  vi.stubEnv('OWNER_COMMANDS_BENCH_REPORT', reportPath)
  vi.stubEnv('E2E_BUNDLE_PATH', bundle)
  fixture.start.mockImplementation(async () => {
    const world = {
      machine: { machineId: 'machine', identity: { pub: new Uint8Array() },
        daemon: { projectsDir: root, corePid: () => 10, close: vi.fn(async () => {}) } },
      backend: { nodeUp: () => true, close: vi.fn(async () => {}) },
      phone: { identity: {}, token: 'fixture' },
      // Match the old fleet wrapper, which discards the daemon's rejection.
      close: vi.fn(async () => {
        await world.machine.daemon.close().catch(() => {})
        await world.backend.close()
      }),
    }
    worlds.push(world)
    return world
  })
  fixture.connect.mockResolvedValue({
    close: fixture.windowClose,
    request: async (type: string) => type === 'agent_create' ? { agent: { id: 'agent' } }
      : { agents: [{ id: 'agent', sessionId: 'session', status: 'active' }] },
  })
  fixture.request.mockImplementation(async (type: string) => type === 'route_send' ? { error: 'INVALID_REQUEST' }
    : type === 'route_task' ? { agentId: 'agent' } : { agents: [{}] })
  // Capture the actual opt-in caller without registering a benchmark inside this unit test.
  const capture = vi.spyOn(it, 'runIf').mockImplementation((() => (_name: string, body: () => Promise<void>) => { run = body }) as never)
  try { await import('../../e2e/ownerCommandsBench.e2e.ts' as string) } finally { capture.mockRestore() }
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it('rejects and records a daemon cleanup failure after all timed samples, while closing both backends', async () => {
  fixture.phoneClose.mockImplementationOnce(() => {
    worlds[0].machine.daemon.close.mockRejectedValueOnce(new Error('fixture escaped hook'))
  })
  await expect(run()).rejects.toThrow('benchmark cleanup failed')
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  expect(report).toMatchObject({ status: 'cleanup_failed', samples: expect.any(Array) })
  expect(report.samples).toHaveLength(36)
  expect(report.cleanup).toContainEqual(expect.objectContaining({ daemon: 'rejected', backend: 'fulfilled' }))
  expect(worlds.every(world => world.backend.close.mock.calls.length === 1)).toBe(true)
})

it('records cleanup failure during partial preparation and still closes the backend', async () => {
  fixture.connect.mockImplementationOnce(async () => {
    worlds[0].machine.daemon.close.mockRejectedValueOnce(new Error('fixture remaining process'))
    throw new Error('fixture connect failure')
  })
  await expect(run()).rejects.toThrow('benchmark cleanup failed')
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  expect(report).toMatchObject({ status: 'cleanup_failed', failure: 'Error', samples: [],
    cleanup: [{ phone: 'fulfilled', window: 'fulfilled', daemon: 'rejected', backend: 'fulfilled' }] })
  expect(worlds[0].backend.close).toHaveBeenCalledOnce()
})

it('retains a failed preparation when cleanup succeeds', async () => {
  fixture.connect.mockRejectedValueOnce(new Error('fixture connect failure'))
  await expect(run()).rejects.toThrow('fixture connect failure')
  expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ status: 'failed', samples: [],
    cleanup: [{ phone: 'fulfilled', window: 'fulfilled', daemon: 'fulfilled', backend: 'fulfilled' }] })
})

it('records successful daemon and backend cleanup after all timed samples', async () => {
  await expect(run()).resolves.toBeUndefined()
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  expect(report).toMatchObject({ status: 'passed' })
  expect(report.cleanup).toEqual(Array(2).fill({ phone: 'fulfilled', window: 'fulfilled', daemon: 'fulfilled', backend: 'fulfilled' }))
  expect(worlds.every(world => world.machine.daemon.close.mock.calls.length === 1 && world.backend.close.mock.calls.length === 1)).toBe(true)
})

it('records client and backend cleanup failures without skipping the daemon', async () => {
  fixture.phoneClose.mockImplementationOnce(() => {
    worlds[0].backend.close.mockRejectedValueOnce(new Error('fixture backend failure'))
    throw new Error('fixture client failure')
  })
  await expect(run()).rejects.toThrow('benchmark cleanup failed')
  expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ status: 'cleanup_failed',
    cleanup: expect.arrayContaining([{ phone: 'rejected', window: 'fulfilled', daemon: 'fulfilled', backend: 'rejected' }]) })
  expect(worlds.every(world => world.machine.daemon.close.mock.calls.length === 1)).toBe(true)
})
