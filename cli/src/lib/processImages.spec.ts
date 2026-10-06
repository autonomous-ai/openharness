import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeProcessImage } from './nativeProcessImages.js'
import type { ProcessRow } from './tmux.js'

const execFile = vi.hoisted(() => vi.fn())
const nativeImages = vi.hoisted(() => vi.fn())
vi.mock('./nativeProcessImages.js', () => ({ nativeProcessImages: nativeImages }))
vi.mock('child_process', async original => ({
  ...await original<typeof import('child_process')>(), execFile,
}))
vi.mock('node:os', async original => ({
  ...await original<typeof import('node:os')>(), platform: () => 'darwin',
}))
const { createDeletedImageMemo, enrichProcessRows } = await import('./tmux.js')

const row = (pid: number): ProcessRow => ({
  pid, parentPid: 1, executable: 'unidentified', args: 'unidentified',
  startMarker: 'Fri Oct 02 10:00:00 2026',
})
const image = (pid: number, path: string) => `p${pid}\nftxt\nn${path}\n`
const answer = (text: string, error: Error | null = null) =>
  execFile.mockImplementationOnce((_command, _args, _options, callback) => callback(error, text))
const native = (images: [number, NativeProcessImage][] = [], unavailable: number[] = []) =>
  ({ images: new Map(images), unavailable: new Set(unavailable) })

beforeEach(async () => {
  execFile.mockReset()
  nativeImages.mockReset().mockResolvedValue(native())
  await enrichProcessRows([])
})
afterEach(() => vi.restoreAllMocks())

describe('macOS executable images', () => {
  it('uses fresh native paths without starting lsof when all births match', async () => {
    nativeImages.mockResolvedValue(native([[10, { path: '/fixture/native', startMarker: 'Fri Oct  2 10:00:00 2026' }]]))
    expect((await enrichProcessRows([row(10)]))[0].imagePath).toBe('/fixture/native')
    expect(nativeImages).toHaveBeenCalledWith([10], 500)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('uses the ordinary reader only for native identities that are unavailable', async () => {
    nativeImages.mockResolvedValue(native([[10, { path: '/fixture/native', startMarker: row(10).startMarker }]]))
    answer(image(20, '/fixture/fallback'))
    expect((await enrichProcessRows([row(10), row(20)])).map(row => row.imagePath))
      .toEqual(['/fixture/native', '/fixture/fallback'])
    expect(execFile.mock.calls[0][1]).toEqual(['-b', '-a', '-p', '20', '-d', 'txt', '-Fn'])
  })

  it('drops a PID with a proven new birth instead of combining new identity and old arguments', async () => {
    nativeImages.mockResolvedValue(native([[10, { path: '/fixture/new-owner', startMarker: 'Fri Oct  2 10:00:01 2026' }]]))
    const rows = [row(10), row(20)]
    expect(await enrichProcessRows(rows, new Set([10]))).toEqual([rows[1]])
    expect(rows).toHaveLength(2)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('includes native-query time in the overall fallback deadline', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    nativeImages.mockImplementation(async () => { now = 500; return native() })
    execFile.mockImplementationOnce((_command, _args, _options, callback) => {
      now = 1500
      callback(new Error('timeout'), '')
    })
    answer(image(10, '/fixture/fallback'))
    await enrichProcessRows([row(10)])
    expect(execFile.mock.calls[1][2]).toEqual({ timeout: 1500 })
  })

  it('gets all images in one nonblocking call, preserving spaces and Unicode', async () => {
    answer(image(10, '/fixture/renamed engine') + image(10, '/fixture/later.dylib')
      + image(20, '/fixture/引擎'))
    const result = await enrichProcessRows([row(10), row(20)])
    expect(result.map(item => item.imagePath)).toEqual(['/fixture/renamed engine', '/fixture/引擎'])
    expect(execFile).toHaveBeenCalledOnce()
    expect(execFile.mock.calls[0].slice(0, 3)).toEqual([
      'lsof', ['-b', '-a', '-p', '10,20', '-d', 'txt', '-Fn'], { timeout: 1000 },
    ])
  })

  it('keeps usable partial output and retries only missing PIDs', async () => {
    answer(image(10, '/fixture/first'), new Error('one process exited'))
    answer(image(20, '/fixture/second'))
    const result = await enrichProcessRows([row(10), row(20)])
    expect(result.map(item => item.imagePath)).toEqual(['/fixture/first', '/fixture/second'])
    expect(execFile).toHaveBeenCalledTimes(2)
    expect(execFile.mock.calls[1][1]).toEqual(['-a', '-p', '20', '-d', 'txt', '-Fn'])
  })

  it('falls back when the nonblocking invocation cannot return output', async () => {
    answer('', new Error('unsupported option'))
    answer(image(10, '/fixture/legacy'))
    expect((await enrichProcessRows([row(10)]))[0].imagePath).toBe('/fixture/legacy')
    expect(execFile).toHaveBeenCalledTimes(2)
  })

  it('does not confuse an error or a later mapped library with the executable', async () => {
    answer(image(10, 'region info error: permission denied') + image(10, '/fixture/library.dylib'))
    answer(image(10, '/fixture/executable'))
    expect((await enrichProcessRows([row(10)]))[0].imagePath).toBe('/fixture/executable')
    expect(execFile).toHaveBeenCalledTimes(2)
  })

  it('leaves unavailable identity unknown after both probes fail', async () => {
    answer('', new Error('failed'))
    answer('', new Error('failed'))
    const original = row(10)
    expect(await enrichProcessRows([original])).toEqual([original])
    expect(execFile).toHaveBeenCalledTimes(2)
  })

  it('retries a text record truncated by a failed helper', async () => {
    answer('p10\nftxt\nn/fixture/truncated', new Error('buffer limit'))
    answer(image(10, '/fixture/complete'))
    expect((await enrichProcessRows([row(10)]))[0].imagePath).toBe('/fixture/complete')
    expect(execFile).toHaveBeenCalledTimes(2)
  })

  it('preserves the overall deadline when the first call is slow', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    execFile.mockImplementationOnce((_command, _args, _options, callback) => {
      now = 1000
      callback(new Error('timeout'), '')
    })
    answer(image(10, '/fixture/after-timeout'))
    await enrichProcessRows([row(10)])
    expect(execFile.mock.calls[1][2]).toEqual({ timeout: 2000 })
  })

  it('does not start another helper after the deadline has elapsed', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    execFile.mockImplementationOnce((_command, _args, _options, callback) => {
      now = 3001
      callback(new Error('delayed timeout'), '')
    })
    expect(await enrichProcessRows([row(10)])).toEqual([row(10)])
    expect(execFile).toHaveBeenCalledOnce()
  })

  it('only probes the selected terminal subtree and does no work for an empty set', async () => {
    const rows = [row(10), row(20)]
    expect(await enrichProcessRows(rows, new Set())).toBe(rows)
    expect(execFile).not.toHaveBeenCalled()
    answer(image(20, '/fixture/selected'))
    const result = await enrichProcessRows(rows, new Set([20]))
    expect(result[0]).toBe(rows[0])
    expect(result[1].imagePath).toBe('/fixture/selected')
    expect(execFile.mock.calls[0][1]).toEqual(['-b', '-a', '-p', '20', '-d', 'txt', '-Fn'])
  })

  it('reads the current image again when a live PID execs another binary', async () => {
    answer(image(10, '/fixture/before-exec'))
    answer(image(10, '/fixture/after-exec'))
    const rows = [row(10)]
    expect((await enrichProcessRows(rows))[0].imagePath).toBe('/fixture/before-exec')
    expect((await enrichProcessRows(rows))[0].imagePath).toBe('/fixture/after-exec')
    expect(execFile).toHaveBeenCalledTimes(2)
    expect(rows[0].imagePath).toBeUndefined()
  })
})

describe('deleted executable image memo', () => {
  it('reuses a deleted path while the helper still reports unavailable', async () => {
    nativeImages.mockResolvedValue(native([], [30]))
    answer(image(30, '/fixture/deleted-30'))
    answer(image(30, '/fixture/deleted-30'))
    expect((await enrichProcessRows([row(30)]))[0].imagePath).toBe('/fixture/deleted-30')
    expect((await enrichProcessRows([row(30)]))[0].imagePath).toBe('/fixture/deleted-30')
    expect(execFile).toHaveBeenCalledOnce()
  })

  it('reads again when the helper says nothing about a remembered PID', async () => {
    nativeImages.mockResolvedValueOnce(native([], [30])).mockResolvedValueOnce(native())
    answer(image(30, '/fixture/deleted-30'))
    answer(image(30, '/fixture/fallback-30'))
    expect((await enrichProcessRows([row(30)]))[0].imagePath).toBe('/fixture/deleted-30')
    const result = await enrichProcessRows([row(30)])
    expect(execFile).toHaveBeenCalledTimes(2)
    expect(result[0].imagePath).toBe('/fixture/fallback-30')
  })

  it('reads an existing path on every pass even when the helper reports unavailable', async () => {
    nativeImages.mockResolvedValue(native([], [31]))
    answer(image(31, process.execPath))
    answer(image(31, process.execPath))
    expect((await enrichProcessRows([row(31)]))[0].imagePath).toBe(process.execPath)
    expect((await enrichProcessRows([row(31)]))[0].imagePath).toBe(process.execPath)
    expect(execFile).toHaveBeenCalledTimes(2)
  })

  it('reads again when arguments or the process birth change', async () => {
    nativeImages.mockResolvedValue(native([], [32]))
    for (let pass = 0; pass < 3; pass++) answer(image(32, '/fixture/deleted-32'))
    const resumed = { ...row(32), args: 'claude --resume' }
    for (const current of [row(32), resumed, { ...resumed, startMarker: 'Fri Oct 02 10:00:05 2026' }]) {
      expect((await enrichProcessRows([current]))[0].imagePath).toBe('/fixture/deleted-32')
    }
    expect(execFile).toHaveBeenCalledTimes(3)
  })

  it('uses a readable native image instead of the memo', async () => {
    nativeImages.mockResolvedValueOnce(native([], [33]))
      .mockResolvedValueOnce(native([[33, { path: '/fixture/native-33', startMarker: row(33).startMarker }]]))
      .mockResolvedValueOnce(native([], [33]))
    answer(image(33, '/fixture/deleted-33'))
    answer(image(33, '/fixture/after-native-33'))
    expect((await enrichProcessRows([row(33)]))[0].imagePath).toBe('/fixture/deleted-33')
    expect((await enrichProcessRows([row(33)]))[0].imagePath).toBe('/fixture/native-33')
    expect(execFile).toHaveBeenCalledOnce()
    const result = await enrichProcessRows([row(33)])
    expect(execFile).toHaveBeenCalledTimes(2)
    expect(result[0].imagePath).toBe('/fixture/after-native-33')
  })

  it('forgets PIDs that disappear from the full table', async () => {
    nativeImages.mockResolvedValueOnce(native([], [34]))
      .mockResolvedValueOnce(native([[35, { path: '/fixture/native-35', startMarker: row(35).startMarker }]]))
      .mockResolvedValueOnce(native([], [34]))
    answer(image(34, '/fixture/deleted-34'))
    answer(image(34, '/fixture/deleted-34'))
    answer(image(34, '/fixture/deleted-34'))
    expect((await enrichProcessRows([row(34)]))[0].imagePath).toBe('/fixture/deleted-34')
    expect((await enrichProcessRows([row(35)]))[0].imagePath).toBe('/fixture/native-35')
    expect((await enrichProcessRows([row(34)]))[0].imagePath).toBe('/fixture/deleted-34')
    expect(execFile).toHaveBeenCalledTimes(2)
  })

  it('checks existence, arguments and birth, forgets existing paths and prunes absent PIDs', () => {
    let exists = false
    const memo = createDeletedImageMemo({ exists: () => exists })
    const original = row(1)
    memo.remember(original, '/fixture/deleted')
    expect(memo.recall(original)).toBe('/fixture/deleted')
    expect(memo.recall({ ...original, args: 'claude --resume' })).toBeUndefined()
    expect(memo.recall({ ...original, startMarker: 'Fri Oct 02 10:00:05 2026' })).toBeUndefined()
    exists = true
    expect(memo.recall(original)).toBeUndefined()
    memo.remember(original, '/fixture/deleted')
    exists = false
    expect(memo.recall(original)).toBeUndefined()
    memo.remember(original, '/fixture/deleted')
    memo.prune([row(2)])
    expect(memo.recall(original)).toBeUndefined()
  })

  it('keeps other panes memoised when only one pane is selected', async () => {
    nativeImages.mockResolvedValueOnce(native([], [36]))
      .mockResolvedValueOnce(native([[37, { path: '/fixture/native-37', startMarker: row(37).startMarker }]]))
      .mockResolvedValueOnce(native([], [36]))
    answer(image(36, '/fixture/deleted-36'))
    answer(image(36, '/fixture/deleted-36'))
    answer(image(36, '/fixture/deleted-36'))
    expect((await enrichProcessRows([row(36)]))[0].imagePath).toBe('/fixture/deleted-36')
    const selected = await enrichProcessRows([row(36), row(37)], new Set([37]))
    expect(selected[1].imagePath).toBe('/fixture/native-37')
    expect((await enrichProcessRows([row(36)]))[0].imagePath).toBe('/fixture/deleted-36')
    expect(execFile).toHaveBeenCalledOnce()
  })

  it('prunes when the full table or selected set is empty', async () => {
    nativeImages.mockResolvedValue(native([], [31]))
    for (let pass = 0; pass < 3; pass++) answer(image(31, '/fixture/deleted-31'))
    expect((await enrichProcessRows([row(31)]))[0].imagePath).toBe('/fixture/deleted-31')
    const unselected = [row(37)]
    expect(await enrichProcessRows(unselected, new Set())).toBe(unselected)
    expect((await enrichProcessRows([row(31)]))[0].imagePath).toBe('/fixture/deleted-31')
    expect(await enrichProcessRows([])).toEqual([])
    expect((await enrichProcessRows([row(31)]))[0].imagePath).toBe('/fixture/deleted-31')
    expect(execFile).toHaveBeenCalledTimes(3)
  })
})
