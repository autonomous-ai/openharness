import { appendFileSync, chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeFileKey } from '../kit/nativePaths.js'
import { sqliteReadAll } from '../../lib/sqliteRead.js'
import * as checkpoint from './checkpoint.js'
import { STORAGE_COMPARE_BYTES, STORAGE_COMPARE_WORK_MS, type ExportSource, type SavedCheckpoint } from '../worker/storageProtocol.js'

const io = vi.hoisted(() => ({ read: undefined as (() => void) | undefined, short: false, zero: false, opens: [] as number[], closed: 0 }))
vi.mock('../../lib/sqliteRead.js', () => ({ sqliteReadAll: vi.fn() }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    if (String(args[0]).endsWith('saved.history')) {
      io.opens.push(Number(args[1]))
      const read = handle.read.bind(handle), close = handle.close.bind(handle)
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        if (io.zero) return { buffer, bytesRead: 0 }
        const result = await read(buffer, offset, io.short ? Math.min(length, 17) : length, position)
        io.read?.()
        return result
      }) as typeof handle.read
      handle.close = async () => { await close(); io.closed++ }
    }
    return handle
  } }
})
let root: string, source: ExportSource, saved: SavedCheckpoint, message: string
const session = { sessionId: 'wanted' }
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'checkpoint-compare-')))
  const path = join(root, 'state.db'), output = join(root, 'saved.history')
  writeFileSync(path, 'native database fixture', { mode: 0o600 })
  writeFileSync(output, '', { mode: 0o600 })
  source = { path, key: nativeFileKey(lstatSync(path, { bigint: true })), database: path }
  saved = { path: output, key: nativeFileKey(lstatSync(output, { bigint: true })), bytes: 0 }
  message = 'the saved conversation'
  vi.mocked(sqliteReadAll).mockReset().mockImplementation(async (_file, sql) => ({ ok: true, via: 'builtin', rows:
    sql.includes('pragma_table_xinfo') ? [{ name: 'id', pk: 1 }, { name: 'body', pk: 0 }]
      : sql.startsWith('WITH RECURSIVE') ? [{ id: 'message-1', body: message, page_n: 1, page_more: 0, page_big: 0 }]
        : [{ id: 'wanted' }] }))
  io.read = undefined; io.short = false; io.zero = false
  saved.bytes = (await checkpoint.exportDatabase('hermes', session, saved, source)).bytes
  io.opens = []; io.closed = 0; vi.mocked(sqliteReadAll).mockClear()
})
afterEach(() => { io.read = undefined; vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
const compare = (current?: () => boolean) => checkpoint.compareDatabase('hermes', session, saved, source, current)

it('compares the actual post-exit content without opening the checkpoint for writing', async () => {
  const before = readFileSync(saved.path)
  expect(await compare()).toBe(true)
  expect(readFileSync(saved.path)).toEqual(before)
  // O_RDONLY is zero; NOFOLLOW/NONBLOCK may also be present.
  expect(io.opens.every(flags => (flags & 3) === 0)).toBe(true)
  expect(io.closed).toBeGreaterThan(0)
})

it('rejects changed rows at the same size even when every native stat is unchanged', async () => {
  const before = lstatSync(source.path, { bigint: true })
  message = 'a changed conversation'
  expect(Buffer.byteLength(message)).toBe(Buffer.byteLength('the saved conversation'))
  expect(await compare()).toBe(false)
  expect(lstatSync(source.path, { bigint: true })).toEqual(before)
})

it.each(['truncated', 'extra bytes', 'changed byte'])('does not accept %s in the saved checkpoint', async change => {
  const original = readFileSync(saved.path)
  if (change === 'truncated') writeFileSync(saved.path, original.subarray(0, original.length - 1))
  else if (change === 'extra bytes') appendFileSync(saved.path, '\n')
  else { original[original.length - 5] ^= 1; writeFileSync(saved.path, original) }
  expect(await compare()).toBe(false)
})

it.each(['replaced', 'alias', 'hard link', 'mode'])('refuses a checkpoint with changed %s before reading rows', async change => {
  if (change === 'replaced' || change === 'alias') {
    renameSync(saved.path, saved.path + '.old')
    if (change === 'alias') symlinkSync(saved.path + '.old', saved.path)
    else writeFileSync(saved.path, readFileSync(saved.path + '.old'), { mode: 0o600 })
  } else if (change === 'hard link') linkSync(saved.path, saved.path + '.link')
  else chmodSync(saved.path, 0o644)
  await expect(compare()).rejects.toThrow()
  expect(sqliteReadAll).not.toHaveBeenCalled()
})

it.each(['source', 'checkpoint'])('refuses a changed %s during the comparison', async target => {
  io.read = () => { io.read = undefined; appendFileSync(target === 'source' ? source.path : saved.path, 'changed') }
  expect(await compare().catch(() => false)).not.toBe(true)
  expect(io.closed).toBeGreaterThan(0)
})

it('handles short reads without accepting an incomplete comparison', async () => {
  io.short = true
  expect(await compare()).toBe(true)
  io.zero = true
  expect(await compare()).toBe(false)
})

it('does not reuse a checkpoint after cancellation during an actual read', async () => {
  let current = true
  io.read = () => { current = false }
  await expect(compare(() => current)).rejects.toThrow()
  expect(io.closed).toBeGreaterThan(0)
})

it('does not turn a failed native query into an equal conversation', async () => {
  vi.mocked(sqliteReadAll).mockResolvedValueOnce({ ok: false, reason: 'unavailable' } as never)
  await expect(compare()).rejects.toThrow()
})

it('compares UTF-8 and escaped text across both JSON and file chunk boundaries', async () => {
  message = ('a'.repeat(16_383) + '😀\n\u0000').repeat(12)
  writeFileSync(saved.path, '')
  saved.bytes = (await checkpoint.exportDatabase('hermes', session, saved, source)).bytes
  expect(await compare()).toBe(true)
  message = message.slice(0, -1) + 'x'
  expect(await compare()).toBe(false)
})

it.each([0, -1, STORAGE_COMPARE_BYTES + 1, Number.NaN])('does not read a checkpoint outside the bounded comparison size: %s', async bytes => {
  saved.bytes = bytes
  expect(await compare()).toBeNull()
  expect(sqliteReadAll).not.toHaveBeenCalled()
  expect(io.opens).toEqual([])
})

it('requires the manifest byte count to equal the saved file length', async () => {
  saved.bytes++
  expect(await compare()).toBe(false)
  expect(sqliteReadAll).not.toHaveBeenCalled()
})

it('stops at its cooperative work deadline without reporting a partial match', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(0)
  io.read = () => { now.mockReturnValue(STORAGE_COMPARE_WORK_MS) }
  expect(await compare()).toBeNull()
  expect(io.closed).toBe(1)
})

it('does not read under a different owner', async () => {
  if (!process.getuid) return
  const owner = process.getuid()
  vi.spyOn(process, 'getuid').mockReturnValue(owner + 1)
  await expect(compare()).rejects.toThrow()
  expect(sqliteReadAll).not.toHaveBeenCalled()
})

it('does not treat an unwritten OpenClaw stream prefix as equal history', async () => {
  vi.mocked(sqliteReadAll).mockResolvedValue({ ok: true, via: 'builtin', rows: [] })
  await expect(checkpoint.compareDatabase('openclaw', session, saved, source)).rejects.toThrow()
})
