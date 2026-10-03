import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'

const host = vi.hoisted(() => ({ platform: 'darwin', execFile: vi.fn(), beforeStat: undefined as Promise<void> | undefined }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), platform: () => host.platform }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: host.execFile }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    await host.beforeStat
    return fs.lstat(...args)
  } }
})
const { nativeProcessImages, parseNativeProcessImages, prepareProcessImageHelper } = await import('./nativeProcessImages.js')

const header = '{"schema":1,"mode":"paths"}\n'
const record = (pid: number, path = '/fixture/native') => ({
  pid, startMarker: 'Fri Oct  2 10:00:00 2026', startSeconds: 1770000000,
  startMicros: 123456, imageHex: Buffer.from(path).toString('hex'),
})
const output = (...rows: unknown[]) => header + rows.map(row => JSON.stringify(row) + '\n').join('')
// Never executed: the child-process mock represents the versioned protocol.
const bytes = Buffer.alloc(64, 7)
const artifact = { schema: 1 as const, sha256: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length, base64: bytes.toString('base64') }
const originalRuntime = env.ADAPTER_RUNTIME_DIR
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-native-images-'))
  env.ADAPTER_RUNTIME_DIR = root
  host.platform = 'darwin'
  host.execFile.mockReset()
  host.beforeStat = undefined
})
afterEach(async () => {
  env.ADAPTER_RUNTIME_DIR = originalRuntime
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('native process-image protocol', () => {
  it('preserves valid UTF-8 paths including JSON delimiters and newlines', () => {
    const path = '/fixture/引擎 "quote"\nnew line\\tail'
    expect(parseNativeProcessImages(output(record(10, path)), new Set([10])).get(10))
      .toEqual({ path, startMarker: record(10).startMarker })
  })

  it('requires the protocol header and ignores unrequested processes', () => {
    expect(parseNativeProcessImages(JSON.stringify(record(10)) + '\n', new Set([10])).size).toBe(0)
    expect(parseNativeProcessImages(output(record(20)), new Set([10])).size).toBe(0)
    expect(parseNativeProcessImages(output(record(10)).replace('"schema":1', '"schema":2'), new Set([10])).size).toBe(0)
  })

  it('keeps complete records before a truncated tail but refuses conflicting duplicates', () => {
    const partial = output(record(10)) + JSON.stringify(record(20)).slice(0, -4)
    expect([...parseNativeProcessImages(partial, new Set([10, 20])).keys()]).toEqual([10])
    const conflict = output(record(10), { pid: 10, unavailable: true }, record(20), record(10))
    expect([...parseNativeProcessImages(conflict, new Set([10, 20])).keys()]).toEqual([20])
  })

  it('rejects malformed bytes, relative paths and unavailable birth metadata', () => {
    for (const row of [
      record(10, 'relative'), record(10, '/with\0nul'), { ...record(10), imageHex: '2fff' },
      { ...record(10), imageHex: '2f7' }, { ...record(10), imageHex: 'xx' },
      { ...record(10), imageHex: '2f'.repeat(4096) }, { ...record(10), startSeconds: -1 },
      { ...record(10), startMicros: 1_000_000 }, { ...record(10), startMarker: 'unknown' },
      { ...record(10), unavailable: true }, { ...record(10), pid: 10.5 },
    ]) expect(parseNativeProcessImages(output(row), new Set([10])).size).toBe(0)
  })
})

describe('bundled native helper preparation', () => {
  it('materializes exact pinned bytes once under a private, executable path', async () => {
    const paths = await Promise.all(Array.from({ length: 4 }, () => prepareProcessImageHelper(artifact, root)))
    expect(new Set(paths).size).toBe(1)
    const path = paths[0]!
    expect(await readFile(path)).toEqual(bytes)
    expect((await lstat(path)).mode & 0o777).toBe(0o500)
    expect(await readdir(join(root, 'process-images'))).toEqual([artifact.sha256])
    expect(await prepareProcessImageHelper(artifact, root)).toBe(path)
  })

  it('rejects an invalid embedded hash without writing a file', async () => {
    expect(await prepareProcessImageHelper({ ...artifact, sha256: '0'.repeat(64) }, root)).toBeNull()
    expect(await readdir(root)).toEqual([])
  })

  it('does not execute, replace or repair an existing corrupt target or symlink', async () => {
    const folder = join(root, 'process-images')
    await mkdir(folder, { mode: 0o700 })
    const target = join(folder, artifact.sha256)
    await writeFile(target, 'other contents', { mode: 0o500 })
    expect(await prepareProcessImageHelper(artifact, root)).toBeNull()
    expect(await readFile(target, 'utf8')).toBe('other contents')
    await rm(target)
    const elsewhere = join(root, 'elsewhere')
    await writeFile(elsewhere, bytes, { mode: 0o500 })
    await symlink(elsewhere, target)
    expect(await prepareProcessImageHelper(artifact, root)).toBeNull()
    expect((await lstat(target)).isSymbolicLink()).toBe(true)
    expect(await readFile(elsewhere)).toEqual(bytes)
  })

  it('leaves unsafe directory permissions unchanged and falls back', async () => {
    await chmod(root, 0o777)
    expect(await prepareProcessImageHelper(artifact, root)).toBeNull()
    expect((await lstat(root)).mode & 0o777).toBe(0o777)
    expect(await readdir(root)).toEqual([])
  })
})

describe('fresh native image reads', () => {
  it('does nothing on other platforms or when no native artifact was bundled', async () => {
    expect((await nativeProcessImages([10], 500)).size).toBe(0)
    vi.stubGlobal('__DARWIN_PROCESS_IMAGES__', JSON.stringify(artifact))
    host.platform = 'linux'
    expect((await nativeProcessImages([10], 500)).size).toBe(0)
    expect(host.execFile).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })

  it('shares only executable preparation and issues a fresh query after exec', async () => {
    vi.stubGlobal('__DARWIN_PROCESS_IMAGES__', JSON.stringify(artifact))
    host.execFile.mockImplementationOnce((_path, _args, _options, done) => done(null, output(record(10, '/before'))))
      .mockImplementationOnce((_path, _args, _options, done) => done(null, output(record(10, '/after'))))
    expect((await nativeProcessImages([10], 500)).get(10)?.path).toBe('/before')
    expect((await nativeProcessImages([10], 500)).get(10)?.path).toBe('/after')
    expect(host.execFile).toHaveBeenCalledTimes(2)
    for (const [path, args, options] of host.execFile.mock.calls) {
      expect(path).toBe(join(root, 'process-images', artifact.sha256))
      expect(args).toEqual(['--paths', '10'])
      expect(options.timeout).toBeGreaterThan(0)
      expect(options.timeout).toBeLessThanOrEqual(500)
      expect(options.env.LC_TIME).toBe('C')
    }
  })

  it('preserves complete records from a failed partial query and handles an unavailable helper', async () => {
    vi.stubGlobal('__DARWIN_PROCESS_IMAGES__', JSON.stringify(artifact))
    host.execFile.mockImplementationOnce((_path, _args, _options, done) => done(new Error('timeout'), output(record(10)) + '{'))
      .mockImplementationOnce((_path, _args, _options, done) => done(new Error('cannot execute'), ''))
    expect([...(await nativeProcessImages([10, 20], 500)).keys()]).toEqual([10])
    expect((await nativeProcessImages([10], 500)).size).toBe(0)
  })

  it('rejects unbounded or invalid requests without preparing an executable', async () => {
    vi.stubGlobal('__DARWIN_PROCESS_IMAGES__', JSON.stringify(artifact))
    for (const pids of [[], [0], [-1], [10.1], [0x80000000], new Array(4097).fill(7)]) {
      expect((await nativeProcessImages(pids, 500)).size).toBe(0)
    }
    expect((await nativeProcessImages([10], 0)).size).toBe(0)
    expect(host.execFile).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
  })

  it('backs off a failed helper and rematerializes a deleted cache entry on retry', async () => {
    vi.stubGlobal('__DARWIN_PROCESS_IMAGES__', JSON.stringify(artifact))
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    host.execFile.mockImplementationOnce((_path, _args, _options, done) => done(null, output(record(10))))
      .mockImplementationOnce((_path, _args, _options, done) => done(Object.assign(new Error('missing'), { code: 'ENOENT' }), ''))
      .mockImplementationOnce((_path, _args, _options, done) => done(null, output(record(10, '/new'))))
    expect((await nativeProcessImages([10], 500)).size).toBe(1)
    const path = join(root, 'process-images', artifact.sha256)
    await rm(path)
    expect((await nativeProcessImages([10], 500)).size).toBe(0)
    expect((await nativeProcessImages([10], 500)).size).toBe(0)
    expect(host.execFile).toHaveBeenCalledTimes(2)
    now = 60_001
    expect((await nativeProcessImages([10], 500)).get(10)?.path).toBe('/new')
    expect(await readFile(path)).toEqual(bytes)
  })

  it('does not launch a late helper when preparation exceeds the request deadline', async () => {
    vi.stubGlobal('__DARWIN_PROCESS_IMAGES__', JSON.stringify(artifact))
    let resume!: () => void
    host.beforeStat = new Promise<void>(resolve => { resume = resolve })
    expect((await nativeProcessImages([10], 20)).size).toBe(0)
    expect(host.execFile).not.toHaveBeenCalled()
    resume()
    await vi.waitFor(async () => expect(await readFile(join(root, 'process-images', artifact.sha256))).toEqual(bytes))
    expect(host.execFile).not.toHaveBeenCalled()
  })
})
