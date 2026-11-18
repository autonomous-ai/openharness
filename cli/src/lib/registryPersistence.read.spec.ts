import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const io = vi.hoisted(() => ({
  file: '', stats: 0, readFileCalls: 0, readChunk: Infinity,
  reads: [] as Array<{ position: number, requested: number, bytesRead: number }>,
  handles: [] as FileHandle[],
  afterStat: undefined as undefined | (() => void),
  statError: undefined as undefined | Error,
  readError: undefined as undefined | { at: number, error: Error },
}))

// Keep real files, descriptor metadata, bytes and closure; interleave only at named boundaries.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    if (String(args[0]) !== io.file) return handle
    io.handles.push(handle)
    const stat = handle.stat.bind(handle), read = handle.read.bind(handle), readFile = handle.readFile.bind(handle)
    handle.stat = (async (...options: Parameters<typeof handle.stat>) => {
      const value = await stat(...options)
      io.stats++
      if (io.statError) throw io.statError
      const afterStat = io.afterStat
      io.afterStat = undefined
      afterStat?.()
      return value
    }) as typeof handle.stat
    handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
      const value = await read(buffer, offset, Math.min(length, io.readChunk), position)
      io.reads.push({ position, requested: length, bytesRead: value.bytesRead })
      if (io.readError?.at === io.reads.length) throw io.readError.error
      return value
    }) as typeof handle.read
    handle.readFile = (async (...options: Parameters<typeof handle.readFile>) => {
      io.readFileCalls++
      return readFile(...options)
    }) as typeof handle.readFile
    return handle
  } }
})

import { readPrivateRegistryOwner } from './registryPersistence.js'

let directory = ''
const LIMIT = 4_096
const privateFile = (contents: string) => writeFileSync(io.file, contents, { mode: 0o600 })

async function allocationProfile(read: () => Promise<string>) {
  const allocations: Array<{ method: string, bytes: number }> = []
  const alloc = Buffer.alloc, unsafe = Buffer.allocUnsafe, slow = Buffer.allocUnsafeSlow
  const spies = [
    vi.spyOn(Buffer, 'alloc').mockImplementation((...args: Parameters<typeof alloc>) => {
      const value = alloc(...args)
      allocations.push({ method: 'alloc', bytes: value.length })
      return value
    }),
    vi.spyOn(Buffer, 'allocUnsafe').mockImplementation((size: number) => {
      const value = unsafe(size)
      allocations.push({ method: 'allocUnsafe', bytes: value.length })
      return value
    }),
    vi.spyOn(Buffer, 'allocUnsafeSlow').mockImplementation((size: number) => {
      const value = slow(size)
      allocations.push({ method: 'allocUnsafeSlow', bytes: value.length })
      return value
    }),
  ]
  try { return { contents: await read(), allocations } }
  finally { for (const spy of spies) spy.mockRestore() }
}

beforeEach(() => {
  directory = mkdtempSync(join(process.env.ADAPTER_DATA_DIR!, 'bounded-read-'))
  io.file = join(directory, 'owner.json')
  io.stats = 0; io.readFileCalls = 0; io.readChunk = Infinity
  io.reads = []; io.handles = []
  io.afterStat = undefined; io.statError = undefined; io.readError = undefined
})

afterEach(async () => {
  const unclosed = io.handles.filter(handle => handle.fd !== -1)
  try { expect(unclosed, 'the reader must close every opened descriptor').toHaveLength(0) }
  finally {
    await Promise.all(unclosed.map(handle => handle.close()))
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('allocates the observed small file plus an EOF probe, instead of its entire permitted limit', async () => {
  privateFile('{}')
  const profile = await allocationProfile(() => readPrivateRegistryOwner(io.file, LIMIT))
  expect(profile.contents).toBe('{}')
  expect(io.stats).toBe(1)
  expect(io.readFileCalls).toBe(0)
  expect(profile.allocations.length).toBeGreaterThan(0)
  expect(profile.allocations.reduce((total, allocation) => total + allocation.bytes, 0),
    JSON.stringify(profile.allocations)).toBeLessThanOrEqual(3)
})

it.each([
  { contents: '', limit: 0 },
  { contents: '', limit: 32 },
  { contents: '{}', limit: 2 },
  { contents: 'x'.repeat(32), limit: 32 },
  { contents: 'é🙂', limit: 6 },
])('returns every byte of a file at or below its $limit-byte bound ($contents)', async ({ contents, limit }) => {
  privateFile(contents)
  expect(await readPrivateRegistryOwner(io.file, limit)).toBe(contents)
  expect(io.stats).toBe(1)
  expect(io.reads.reduce((total, read) => total + read.bytesRead, 0)).toBe(Buffer.byteLength(contents))
  expect(io.reads.every(read => read.position + read.requested <= limit + 1)).toBe(true)
})

it('rejects a file already above its bound before reading bytes', async () => {
  privateFile('x'.repeat(33))
  await expect(readPrivateRegistryOwner(io.file, 32)).rejects.toThrow('state file exceeds its size limit')
  expect(io.stats).toBe(1)
  expect(io.reads).toEqual([])
})

it.each([
  { initial: '', suffix: '{}', limit: 32 },
  { initial: '{}', suffix: ' '.repeat(19), limit: 32 },
  { initial: '{}', suffix: ' '.repeat(30), limit: 32 },
])('reads growth after stat through EOF without returning a valid but truncated prefix ($initial/$limit)',
  async ({ initial, suffix, limit }) => {
    privateFile(initial)
    io.afterStat = () => appendFileSync(io.file, suffix)
    expect(await readPrivateRegistryOwner(io.file, limit)).toBe(initial + suffix)
    expect(io.stats).toBe(1)
    expect(io.reads.reduce((total, read) => total + read.bytesRead, 0)).toBe(Buffer.byteLength(initial + suffix))
    expect(io.reads.every(read => read.position + read.requested <= limit + 1)).toBe(true)
  })

it('rejects growth past the cap after stat, even when its bounded prefix is valid JSON', async () => {
  privateFile('{}')
  io.afterStat = () => appendFileSync(io.file, ' '.repeat(31))
  await expect(readPrivateRegistryOwner(io.file, 32)).rejects.toThrow('state file exceeds its size limit')
  expect(io.stats).toBe(1)
  expect(io.reads.reduce((total, read) => total + read.bytesRead, 0)).toBe(33)
  expect(io.reads.every(read => read.position + read.requested <= 33)).toBe(true)
})

it('decodes UTF-8 once after characters cross short reads and a growth boundary', async () => {
  privateFile('a')
  io.afterStat = () => appendFileSync(io.file, '🙂é')
  io.readChunk = 2
  expect(await readPrivateRegistryOwner(io.file, 64)).toBe('a🙂é')
  expect(io.stats).toBe(1)
  expect(io.reads.filter(read => read.bytesRead > 0).map(read => read.bytesRead)).toEqual([2, 2, 2, 1])
})

it('refuses a registry image through the lock-owner reader instead of reading it without a bound', async () => {
  const contents = 'a'.repeat(LIMIT + 1) + '🙂'
  privateFile(contents)
  await expect(readPrivateRegistryOwner(io.file)).rejects.toThrow('state file exceeds its size limit')
  expect(io.stats).toBe(1)
  expect(io.readFileCalls).toBe(0)
  expect(io.reads).toEqual([])
})

it.each([-1, 0.5, Infinity, LIMIT + 1])('refuses an invalid lock-owner limit (%s) before opening a file', async limit => {
  await expect(readPrivateRegistryOwner(io.file, limit)).rejects.toThrow('invalid owner read limit')
  expect(io.handles).toEqual([])
})

it.each(['stat', 'read'] as const)('propagates a %s failure and closes its actual descriptor', async phase => {
  const error = new Error(`fixture ${phase} unavailable`)
  privateFile('{}')
  if (phase === 'stat') io.statError = error
  else {
    io.afterStat = () => appendFileSync(io.file, ' '.repeat(19))
    io.readError = { at: 2, error }
  }
  await expect(readPrivateRegistryOwner(io.file, 32)).rejects.toBe(error)
  expect(io.handles).toHaveLength(1)
  expect(io.handles[0]!.fd).toBe(-1)
})

it.skipIf(process.platform === 'win32')('tightens readable permissions and rechecks the same descriptor', async () => {
  privateFile('{}')
  chmodSync(io.file, 0o644)
  expect(await readPrivateRegistryOwner(io.file, LIMIT)).toBe('{}')
  expect(statSync(io.file).mode & 0o777).toBe(0o600)
  expect(io.stats).toBe(2)
})

it.skipIf(process.platform === 'win32')('refuses group-writable files without reading their contents', async () => {
  privateFile('{}')
  chmodSync(io.file, 0o620)
  await expect(readPrivateRegistryOwner(io.file, LIMIT)).rejects.toThrow('state file is group/world writable')
  expect(io.reads).toEqual([])
})

it.skipIf(typeof process.getuid !== 'function')('refuses a descriptor owned by another user', async () => {
  privateFile('{}')
  vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1)
  await expect(readPrivateRegistryOwner(io.file, LIMIT)).rejects.toThrow('state file has unsafe owner or type')
  expect(io.reads).toEqual([])
})

it.skipIf(process.platform === 'win32')('refuses directory descriptors and closes them', async () => {
  mkdirSync(io.file, { mode: 0o700 })
  await expect(readPrivateRegistryOwner(io.file, LIMIT)).rejects.toThrow('state file has unsafe owner or type')
  expect(io.reads).toEqual([])
  expect(io.handles).toHaveLength(1)
})

it.skipIf(process.platform === 'win32')('does not follow a file symlink', async () => {
  const target = join(directory, 'target.json')
  writeFileSync(target, '{}', { mode: 0o600 })
  symlinkSync(target, io.file)
  await expect(readPrivateRegistryOwner(io.file, LIMIT)).rejects.toMatchObject({ code: 'ELOOP' })
  expect(io.handles).toEqual([])
})

it.skipIf(process.platform !== 'win32')('refuses a file outside the configured Windows private roots', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'bounded-outside-'))
  try {
    io.file = join(outside, 'names.json')
    privateFile('{}')
    await expect(readPrivateRegistryOwner(io.file, LIMIT)).rejects.toThrow('state path is outside the configured private roots')
    expect(io.handles).toEqual([])
  } finally { rmSync(outside, { recursive: true, force: true }) }
})
