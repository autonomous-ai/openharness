import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CheckpointStages, type CheckpointStage } from './checkpointStages.js'

const reads = vi.hoisted(() => ({ path: '', opens: 0, calls: 0, cap: 1024, empty: false,
  mutate: undefined as (() => void) | undefined, descriptors: new Set<number>() }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args)
      if (String(args[0]) === reads.path) { reads.opens++; reads.descriptors.add(fd) }
      return fd
    },
    closeSync: (fd: number) => { reads.descriptors.delete(fd); fs.closeSync(fd) },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      if (!reads.descriptors.has(fd)) return fs.readSync(fd, buffer, offset, length, position)
      reads.calls++
      if (reads.empty) return 0
      const count = fs.readSync(fd, buffer, offset, Math.min(length, reads.cap), position)
      const mutate = reads.mutate; reads.mutate = undefined; mutate?.()
      return count
    },
  }
})
const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
let root: string
const leases: CheckpointStage[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'checkpoint-owner-read-'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  reads.path = ''; reads.opens = reads.calls = 0; reads.cap = 1024
  reads.empty = false; reads.mutate = undefined; reads.descriptors.clear()
  for (const lease of leases.splice(0)) await lease.close()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
async function acquire() {
  reads.path = join(root, '.stages', '0', 'owner.json')
  const lease = await new CheckpointStages(join(root, '.stages')).acquire(target())
  leases.push(lease); reads.opens = 0
  return lease
}
const target = () => join(root, `${'a'.repeat(64)}-${'b'.repeat(36)}.history`)
const owner = async () => JSON.parse(await readFile(reads.path, 'utf8'))

it.skipIf(process.platform === 'win32').each(['writer', 'settled', 'destination'] as const)(
  'checks the %s owner without another open', async operation => {
    const lease = await acquire(), previous = await owner()
    if (operation === 'writer') {
      await lease.writer(process.pid)
      expect(await owner()).toEqual({ ...previous, writer: process.pid })
    } else if (operation === 'settled') {
      await lease.settled()
      expect(await owner()).toEqual({ ...previous, settled: true, destination: target().split('/').at(-1) })
    } else {
      await lease.settled()
      await writeFile(lease.stage.path, 'history')
      await lease.verify({ bytes: 7, sha256: createHash('sha256').update('history').digest('hex') })
      const destination = `${'a'.repeat(64)}-${'b'.repeat(36)}.history`
      await lease.publish(() => {})
      expect(await owner()).toEqual({ ...previous, settled: true, destination })
      expect(await readFile(join(root, destination), 'utf8')).toBe('history')
    }
    expect(reads.opens).toBe(0)
    expect(reads.calls).toBeGreaterThan(0)
  })

it.skipIf(process.platform === 'win32')('completes bounded short reads without moving the write offset and truncates the shorter owner', async () => {
  const lease = await acquire(), previous = await owner()
  const padded = JSON.stringify(previous) + ' '.repeat(256)
  await writeFile(reads.path, padded)
  reads.cap = 7
  await lease.settled()
  expect(await readFile(reads.path, 'utf8')).toBe(JSON.stringify({ ...previous, settled: true, destination: target().split('/').at(-1) }))
  expect(Buffer.byteLength(await readFile(reads.path, 'utf8'))).toBeLessThan(Buffer.byteLength(padded))
  expect(reads.calls).toBe(Math.ceil(Buffer.byteLength(padded) / 7))
  expect(reads.opens).toBe(0)
})

it.skipIf(process.platform === 'win32')('refuses a premature end of the owner read before changing any bytes', async () => {
  const lease = await acquire(), previous = await readFile(reads.path, 'utf8')
  reads.empty = true
  await expect(lease.settled()).rejects.toThrow('checkpoint owner unavailable')
  expect(await readFile(reads.path, 'utf8')).toBe(previous)
  expect(reads.calls).toBe(1)
})

it.skipIf(process.platform === 'win32').each(['lease', 'same lease'] as const)(
  'preserves an owner changed during its read: %s', async change => {
    const lease = await acquire(), previous = await owner()
    const newer = JSON.stringify({ ...previous, core: process.pid + 1,
      ...(change === 'lease' ? { lease: 'e'.repeat(32) } : {}) })
    reads.mutate = () => {
      fs.writeFileSync(reads.path, newer)
      // A distinct timestamp makes the same-inode change deterministic on coarse filesystems.
      fs.utimesSync(reads.path, 100, 100)
    }
    await expect(lease.settled()).rejects.toThrow('checkpoint owner changed')
    expect(await readFile(reads.path, 'utf8')).toBe(newer)
  })

it.each(['', '{', 'x'.repeat(1025)])('preserves a malformed or oversized owner (%j)', async text => {
  const lease = await acquire()
  await writeFile(reads.path, text)
  await expect(lease.settled()).rejects.toThrow()
  expect(await readFile(reads.path, 'utf8')).toBe(text)
})
