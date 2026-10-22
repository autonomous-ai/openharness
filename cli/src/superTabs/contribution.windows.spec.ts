// What Add machine sends from a Windows daemon: node:path is win32's, as it is there, so the swarm workspace is a
// drive path (C:\…) that the backend accepts for machine.contribute.cwd.
import * as nodePath from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { prepareContribution } from './contribution.js'

vi.mock('node:path', async (original) => {
  const real = await original<typeof nodePath>()
  return { ...real, ...real.win32, default: real.win32, win32: real.win32, posix: real.posix }
})
vi.mock('node:fs/promises', async (original) => ({ ...await original<object>(), mkdir: vi.fn(async () => undefined) }))

describe('contributing a Windows machine to a swarm', () => {
  it('offers the swarm workspace as a drive path under the daemon data folder', async () => {
    const core = fakeCore({ dataDir: 'C:\\Users\\dev\\.harness\\cli\\data' })
    const request = vi.fn(async () => ({ engines: [{ engine: 'claude', installed: true, signedIn: true }] }))
    const deps = { backend: vi.fn(async () => ({ state: {} })), open: vi.fn(async () => ({ request, close: vi.fn() })), prepare: vi.fn(),
      capacity: vi.fn(async () => ({ ok: true, resources: { memoryTotalBytes: 8 * 1024 ** 3, memoryUsedBytes: 0, projectDiskFreeBytes: 1e11 } })) }
    const result = await prepareContribution(core, { tabId: 'tab', scope: 'swarm' }, deps as never)
    expect(result).toMatchObject({ scope: 'swarm', cwd: 'C:\\Users\\dev\\.harness\\cli\\data\\swarm-projects\\tab' })
    expect(deps.prepare).not.toHaveBeenCalled()
  })
})
