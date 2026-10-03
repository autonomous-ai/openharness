import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const { enrichProcessRows } = await import('./tmux.js')

const row = (pid: number): ProcessRow => ({
  pid, parentPid: 1, executable: 'unidentified', args: 'unidentified',
  startMarker: 'Fri Oct 02 10:00:00 2026',
})
const image = (pid: number, path: string) => `p${pid}\nftxt\nn${path}\n`
const answer = (text: string, error: Error | null = null) =>
  execFile.mockImplementationOnce((_command, _args, _options, callback) => callback(error, text))

beforeEach(() => {
  execFile.mockReset()
  nativeImages.mockReset().mockResolvedValue(new Map())
})
afterEach(() => vi.restoreAllMocks())

describe('macOS executable images', () => {
  it('uses fresh native paths without starting lsof when all births match', async () => {
    nativeImages.mockResolvedValue(new Map([[10, { path: '/fixture/native', startMarker: 'Fri Oct  2 10:00:00 2026' }]]))
    expect((await enrichProcessRows([row(10)]))[0].imagePath).toBe('/fixture/native')
    expect(nativeImages).toHaveBeenCalledWith([10], 500)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('uses the ordinary reader only for native identities that are unavailable', async () => {
    nativeImages.mockResolvedValue(new Map([[10, { path: '/fixture/native', startMarker: row(10).startMarker }]]))
    answer(image(20, '/fixture/fallback'))
    expect((await enrichProcessRows([row(10), row(20)])).map(row => row.imagePath))
      .toEqual(['/fixture/native', '/fixture/fallback'])
    expect(execFile.mock.calls[0][1]).toEqual(['-b', '-a', '-p', '20', '-d', 'txt', '-Fn'])
  })

  it('drops a PID with a proven new birth instead of combining new identity and old arguments', async () => {
    nativeImages.mockResolvedValue(new Map([[10, { path: '/fixture/new-owner', startMarker: 'Fri Oct  2 10:00:01 2026' }]]))
    const rows = [row(10), row(20)]
    expect(await enrichProcessRows(rows, new Set([10]))).toEqual([rows[1]])
    expect(rows).toHaveLength(2)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('includes native-query time in the overall fallback deadline', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    nativeImages.mockImplementation(async () => { now = 500; return new Map() })
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
