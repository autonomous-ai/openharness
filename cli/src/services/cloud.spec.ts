import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { CLOUD_REQUESTS, startCloud, startCloudOn } from './cloud.js'

let dataDir: string
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'cloud-service-')) })
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

describe('cloud agents in the core\'s process', () => {
  it('fills its port, tells the core its harnesses at once, and answers its requests', async () => {
    const cloud = { publish: vi.fn(), ask: vi.fn(), unask: vi.fn() }
    const ports = emptyPorts()
    const requests = startCloud(fakeCore({ dataDir, cloud }), ports, { bridge: { connections: async () => [], mcpUrl: () => '', api: async () => ({ status: 200, json: {} }) } })
    expect(Object.keys(requests).sort()).toEqual([...CLOUD_REQUESTS].sort())
    expect(cloud.publish).toHaveBeenCalledWith([], [])
    expect(ports.cloud).toMatchObject({ create: expect.any(Function), deliver: expect.any(Function), answer: expect.any(Function), rename: expect.any(Function), stopHarness: expect.any(Function), stop: expect.any(Function) })
    expect(await ports.cloud!.create({ engine: 'claude' })).toMatchObject({ ok: false, error: 'INVALID_ENGINE' })
    ;(ports.cloud as unknown as { stop: () => void }).stop()
  })

  it('does not start on a core that offers it no doors', () => {
    expect(() => startCloudOn(fakeCore({ dataDir }), emptyPorts())).toThrow('no doors')
  })
})
