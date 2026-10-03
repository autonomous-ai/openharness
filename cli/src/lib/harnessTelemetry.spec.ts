import { expect, it, vi } from 'vitest'
import { createHarnessStorageReader, parseProcessGpuMemory, parseProcessGpuUsage, parseProcessIo } from './harnessTelemetry.js'

it('keeps Linux physical I/O distinct from logical byte counts, preserving zero and unknown', () => {
  expect(parseProcessIo('rchar: 99999\nwchar: 50000\nread_bytes: 0\nwrite_bytes: 8192\n')).toEqual({ readBytes: 0, writeBytes: 8192 })
  expect(parseProcessIo('read_bytes: -1\nwrite_bytes: 999999999999999999999')).toEqual({ readBytes: null, writeBytes: null })
})
it('counts multi-GPU allocations once per device and never substitutes GPU capacity', () => {
  const memory = parseProcessGpuMemory('10, GPU-one, 200\n10, GPU-one, 200\n10, GPU-two, 300\n20, GPU-one, [N/A]\n30, GPU-one, 0')
  expect(memory.get(10)).toBe(500 * 1024 ** 2)
  expect(memory.get(20)).toBeNull()
  expect(memory.get(30)).toBe(0)
  expect(memory.has(40)).toBe(false)
})
it('reads per-process GPU compute utilization by header, not device-level utilization', () => {
  const result = parseProcessGpuUsage('# gpu pid type sm mem enc dec command\n# Idx # C/G % % % % name\n0 10 C 25 90 0 0 python\n1 10 C 40 10 0 0 python\n0 20 C - - - - model\n0 30 C 0 0 0 0 model')
  expect([...result]).toEqual([[10, 65], [20, null], [30, 0]])
  expect(parseProcessGpuUsage('unavailable').size).toBe(0)
})
it('storage sampling coalesces shared paths, bounds concurrency and never stalls inventory', async () => {
  let now = 100_000
  const pending: Array<(size: number) => void> = []
  const size = vi.fn(() => new Promise<number>(resolve => pending.push(resolve)))
  const read = createHarnessStorageReader({ now: () => now, size, transcript: async () => 70, canonical: async path => path === '/alias' ? '/project' : path })
  const agents = [{ agentId: 'a', cwd: '/project', transcriptPath: '/log' }, { agentId: 'b', cwd: '/alias' }, { agentId: 'c', cwd: '/other' }, { agentId: 'd', cwd: '/third' }]
  const first = await read(agents)
  expect(first.get('a')).toMatchObject({ workspaceBytes: null, transcriptBytes: 70, workspacePath: '/project' })
  expect(size).toHaveBeenCalledTimes(2)
  pending[0](1000); pending[1](2000)
  await vi.waitFor(() => expect(size).toHaveBeenCalledTimes(3))
  pending[2](3000)
  await Promise.resolve()
  expect((await read(agents)).get('b')?.workspaceBytes).toBe(1000)
  expect(size).toHaveBeenCalledTimes(3)
  now += 61_000
  await read(agents)
  expect(size).toHaveBeenCalledTimes(5)
  pending[3](1100); pending[4](2100)
  await vi.waitFor(() => expect(size).toHaveBeenCalledTimes(6))
  pending[5](3100)
})
it('storage failures and unknown transcripts remain unknown and do not immediately retry', async () => {
  const size = vi.fn(async () => { throw Error('denied') })
  const read = createHarnessStorageReader({ now: () => 10000, size, transcript: async () => { throw Error('missing') }, canonical: async p => p })
  const rows = [{ agentId: 'a', cwd: '/project', transcriptPath: '/unreadable' }, { agentId: 'b', cwd: '/' }]
  await read(rows)
  const values = await read(rows)
  expect(values.get('a')).toMatchObject({ workspaceBytes: null, transcriptBytes: null })
  expect(values.get('b')?.workspaceBytes).toBeNull()
  expect(size).toHaveBeenCalledTimes(1)
})
it('reports session storage separately, caches it, and refreshes a rotated conversation', async () => {
  const session = vi.fn(async () => 4096)
  const read = createHarnessStorageReader({ now: () => 10000, size: async () => 1e9,
    transcript: async () => 2048, canonical: async p => p, session })
  const rows = [{ agentId: 'a', sessionId: 'first', cwd: '/project', transcriptPath: '/history' }]
  await read(rows)
  await vi.waitFor(async () => expect((await read(rows)).get('a')).toMatchObject({ workspaceBytes: 1e9, sessionBytes: 4096, transcriptBytes: 2048 }))
  expect(session).toHaveBeenCalledTimes(1)
  await read([{ ...rows[0], sessionId: 'second' }])
  expect(session).toHaveBeenCalledTimes(2)
})
it('invalidates disk totals after deletion without accepting a late pre-deletion probe', async () => {
  const pending: Array<(size: number) => void> = []
  const read = createHarnessStorageReader({ now: () => 10000,
    size: () => new Promise(resolve => pending.push(resolve)), transcript: async () => null, canonical: async p => p })
  const rows = [{ agentId: 'a', cwd: '/project' }]
  await read(rows)
  await read([], true)
  await read(rows)
  pending[1](20)
  await Promise.resolve()
  pending[0](1000)
  await Promise.resolve()
  expect((await read(rows)).get('a')?.workspaceBytes).toBe(20)
})
