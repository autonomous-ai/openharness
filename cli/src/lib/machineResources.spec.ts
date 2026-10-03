import { describe, expect, it, vi } from 'vitest'
import { createMachineResourcesReader } from './machineResources.js'
import { encryptDownFrame, encryptRpcResult } from './e2ee/applicationFrames.js'

function fixture() {
  return {
    cpuTimes: vi.fn()
      .mockReturnValueOnce({ idle: 100, total: 200 })
      .mockReturnValue({ idle: 250, total: 400 }),
    memory: vi.fn(async () => ({ total: 32 * 1024 ** 3, available: 12 * 1024 ** 3 })),
    wait: vi.fn(async () => {}),
    now: vi.fn(() => 1000),
  }
}

describe('on-demand machine resources', () => {
  it('measures CPU over a sample interval and memory in bytes', async () => {
    expect(await createMachineResourcesReader(fixture())()).toEqual({
      cpuPercent: 25,
      memoryUsedBytes: 20 * 1024 ** 3,
      memoryTotalBytes: 32 * 1024 ** 3,
    })
  })

  it.each([
    { idle: 100, total: 200 }, // No elapsed CPU time.
    { idle: 10, total: 20 }, // Counters reset or a CPU disappeared.
    { idle: 99, total: 400 },
    { idle: 400, total: 400 },
    { idle: NaN, total: Infinity },
  ])('does not turn invalid CPU counters into fake zero usage: %o', async after => {
    const deps = fixture()
    deps.cpuTimes.mockReturnValue(after)
    expect(await createMachineResourcesReader(deps)()).toMatchObject({ cpuPercent: null })
  })

  it.each([
    { total: 0, available: 0 },
    { total: 100, available: -1 },
    { total: 100, available: 101 },
    { total: NaN, available: 1 },
    { total: 100, available: Infinity },
  ])('leaves invalid memory readings unknown: %o', async memory => {
    const deps = fixture()
    deps.memory.mockResolvedValue(memory)
    expect(await createMachineResourcesReader(deps)()).toEqual({
      cpuPercent: 25, memoryUsedBytes: null, memoryTotalBytes: null,
    })
  })

  it('coalesces concurrent requests, then reuses only fresh samples', async () => {
    const deps = fixture()
    let complete!: () => void
    deps.wait.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve }))
    const read = createMachineResourcesReader(deps)
    const first = read()
    expect(read()).toBe(first)
    expect(deps.wait).toHaveBeenCalledTimes(1)
    complete()
    const reading = await first
    deps.now.mockReturnValue(2999)
    expect(await read()).toBe(reading)
    expect(deps.wait).toHaveBeenCalledTimes(1)
    deps.now.mockReturnValue(3000)
    await read()
    expect(deps.wait).toHaveBeenCalledTimes(2)
  })

  it('allows retry after a failed sample', async () => {
    const deps = fixture()
    deps.memory.mockRejectedValueOnce(new Error('unavailable'))
    const read = createMachineResourcesReader(deps)
    await expect(read()).rejects.toThrow('unavailable')
    await expect(read()).resolves.toMatchObject({ memoryTotalBytes: 32 * 1024 ** 3 })
    expect(deps.wait).toHaveBeenCalledTimes(2)
  })

  it('keeps CPU/RAM available when optional hardware probes fail', async () => {
    const hardware = vi.fn().mockRejectedValue(new Error('unsupported'))
    expect(await createMachineResourcesReader({ ...fixture(), hardware })()).toEqual({
      cpuPercent: 25, memoryUsedBytes: 20 * 1024 ** 3, memoryTotalBytes: 32 * 1024 ** 3,
    })
  })

  it('returns optional hardware readings without combining GPUs', async () => {
    const gpus = [
      { id: 'a', name: 'First', utilizationPercent: 80 },
      { id: 'b', name: 'Second', utilizationPercent: 60 },
    ]
    const deps = { ...fixture(), hardware: async () => ({ gpus, diskFreeBytes: 4000 }) }
    expect(await createMachineResourcesReader(deps)()).toMatchObject({ gpus, diskFreeBytes: 4000 })
  })

  it('encrypts both the request and response between machines', () => {
    expect(encryptDownFrame('machine_resources')).toBe(true)
    expect(encryptRpcResult('machine_resources_result')).toBe(true)
  })
})
