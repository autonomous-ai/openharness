// What Add machine sends from a Windows daemon: both node:path and the home folder are Windows-shaped,
// so new and earlier Swarm workspace paths remain drive paths the backend accepts for machine.contribute.cwd.
import * as nodePath from 'node:path'
import { mkdir } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { prepareContribution } from './contribution.js'

vi.mock('node:path', async (original) => {
  const real = await original<typeof nodePath>()
  return { ...real, ...real.win32, default: real.win32, win32: real.win32, posix: real.posix }
})
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => 'C:\\Users\\dev' }))
vi.mock('node:fs/promises', async (original) => ({ ...await original<object>(), mkdir: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

function fixture(existing?: string) {
  const core = fakeCore({ dataDir: 'C:\\Users\\dev\\.harness\\cli\\data' })
  const request = vi.fn(async () => ({ engines: [{ engine: 'claude', installed: true, signedIn: true }] }))
  const close = vi.fn()
  const machines = existing ? [{ machineId: core.daemon.machineId(), cwd: existing }] : []
  const deps = { backend: vi.fn(async () => ({ state: { machines } })), open: vi.fn(async () => ({ request, close })), prepare: vi.fn(),
    capacity: vi.fn(async () => ({ ok: true, resources: { memoryTotalBytes: 8 * 1024 ** 3, memoryUsedBytes: 0, projectDiskFreeBytes: 1e11 } })) }
  return { core, deps, close }
}

describe('contributing a Windows machine to a swarm', () => {
  it.each([
    { name: 'offers a drive path under the visible Swarm root for a new contribution', existing: undefined,
      cwd: 'C:\\Users\\dev\\harnesses\\swarms\\tab' },
    { name: 'keeps an earlier contribution drive path under the daemon data folder',
      existing: 'C:\\Users\\dev\\.harness\\cli\\data\\swarm-projects\\tab',
      cwd: 'C:\\Users\\dev\\.harness\\cli\\data\\swarm-projects\\tab' },
  ])('$name', async ({ existing, cwd }) => {
    const { core, deps, close } = fixture(existing)
    const result = await prepareContribution(core, { tabId: 'tab', scope: 'swarm' }, deps as never)
    expect(result).toEqual({ ok: true, state: 'ready', scope: 'swarm', cwd, engines: ['claude'], maxAgents: 2, maxAvailableAgents: 4 })
    expect(mkdir).toHaveBeenCalledExactlyOnceWith(cwd, { recursive: true })
    expect(deps.capacity).toHaveBeenCalledExactlyOnceWith({ cwd, tools: ['git'], devices: [] })
    expect(deps.prepare).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })
})
