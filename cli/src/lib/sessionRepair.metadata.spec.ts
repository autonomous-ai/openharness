import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { constants } from 'node:buffer'
import * as fs from 'fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentEngine } from '../engines/types.js'

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const LIMIT = 256 * 1024
const CWD = '/fixture/工作/📘'
const META = JSON.stringify({ type: 'session', cwd: CWD })
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'repair-meta-')) })
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.resetModules()
  rmSync(directory, { recursive: true, force: true })
})

async function fixture(text: string, engine: AgentEngine = 'claude') {
  const config: Record<string, [string, string[]]> = {
    claude: ['CLAUDE_PROJECTS_DIR', []],
    pi: ['PI_HOME', ['agent', 'sessions']],
    commandcode: ['COMMANDCODE_HOME', ['projects']],
    amp: ['AMP_SESSIONS_DIR', []],
  }
  const [variable, subdirectories] = config[engine]
  vi.stubEnv(variable, directory)
  const root = join(directory, ...subdirectories, 'project')
  mkdirSync(root, { recursive: true })
  const path = join(root, 'session-id.jsonl')
  writeFileSync(path, text)
  vi.resetModules()
  const { findLiveSession } = await import('./sessionRepair.js')
  const read = () => findLiveSession(engine, CWD, Date.now() - 1000)
  return { path, read }
}

describe('bounded session metadata discovery', () => {
  it.each(['claude', 'pi', 'commandcode', 'amp'] as const)('finds %s metadata without retaining a large history', async engine => {
    const { path, read } = await fixture(META + '\n' + 'x'.repeat(4 * 1024 * 1024), engine)
    await expect(read()).resolves.toEqual({ sessionId: 'session-id', transcriptPath: path })
  })

  it.each([19, 20])('keeps the 20-line limit with %i bookkeeping lines', async count => {
    const { read } = await fixture(Array(count).fill('{}').join('\n') + '\n' + META + '\n')
    if (count === 19) await expect(read()).resolves.toMatchObject({ sessionId: 'session-id' })
    else await expect(read()).resolves.toBeNull()
  })

  it.each([0, 1])('keeps the UTF-16 character boundary with metadata ending %i characters after the limit', async overflow => {
    // > 256 KiB of UTF-8 bytes before the cwd, but still within 256K JS characters.
    const padding = JSON.stringify({ bookkeeping: '漢'.repeat(90_000) }) + '\n'
    const text = padding + ' '.repeat(LIMIT - padding.length - META.length + overflow) + META + '\nmore history'
    expect(Buffer.byteLength(text)).toBeGreaterThan(LIMIT)
    const { read } = await fixture(text)
    if (overflow === 0) await expect(read()).resolves.toMatchObject({ sessionId: 'session-id' })
    else await expect(read()).resolves.toBeNull()
  })

  it('keeps the first declared directory authoritative', async () => {
    const { read } = await fixture(JSON.stringify({ cwd: '/somewhere/else' }) + '\n' + META + '\n')
    await expect(read()).resolves.toBeNull()
  })

  it('finds a valid header even when the file exceeds the maximum JS string length', async () => {
    const { path, read } = await fixture(META + '\n')
    // A sparse suffix exercises the real file-size limit without allocating 512 MiB in the test.
    truncateSync(path, constants.MAX_STRING_LENGTH + 4096)
    await expect(read()).resolves.toMatchObject({ sessionId: 'session-id' })
  })

  it('bounds the actual disk read even when the transcript is much larger', async () => {
    const { path, read } = await fixture(META + '\n' + 'x'.repeat(4 * 1024 * 1024))
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    const handle = await actual.open(path, 'r')
    const reads = vi.spyOn(handle, 'read')
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    try {
      await expect(read()).resolves.toMatchObject({ sessionId: 'session-id' })
      expect(reads).toHaveBeenCalledTimes(1)
      expect(reads.mock.calls[0].slice(1)).toEqual([0, LIMIT * 4, 0])
      expect(handle.fd).toBe(-1)
    } finally { if (handle.fd !== -1) await handle.close() }
  })

  it('fills short file reads and closes the handle', async () => {
    const { path, read } = await fixture(META + '\n')
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    const handle = await actual.open(path, 'r')
    const originalRead = handle.read.bind(handle)
    vi.spyOn(handle, 'read').mockImplementation(((buffer: Buffer, offset: number, length: number, position: number) =>
      originalRead(buffer, offset, Math.min(length, 7), position)) as typeof handle.read)
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    try {
      await expect(read()).resolves.toMatchObject({ sessionId: 'session-id' })
      expect(handle.fd).toBe(-1)
    } finally { if (handle.fd !== -1) await handle.close() }
  })

  it('returns no binding and closes the handle after a read error', async () => {
    const { path, read } = await fixture(META + '\n')
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    const handle = await actual.open(path, 'r')
    vi.spyOn(handle, 'read').mockRejectedValueOnce(new Error('fixture read failure'))
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    try {
      await expect(read()).resolves.toBeNull()
      expect(handle.fd).toBe(-1)
    } finally { if (handle.fd !== -1) await handle.close() }
  })

  it('stops and closes the handle if the file reaches EOF before its stated size', async () => {
    const { path, read } = await fixture(META + '\n')
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
    const handle = await actual.open(path, 'r')
    vi.spyOn(handle, 'read').mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(0) })
    vi.mocked(fs.open).mockResolvedValueOnce(handle)
    try {
      await expect(read()).resolves.toBeNull()
      expect(handle.fd).toBe(-1)
    } finally { if (handle.fd !== -1) await handle.close() }
  })
})
