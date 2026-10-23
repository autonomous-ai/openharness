import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as zlib from 'node:zlib'
import { materializeResumeTranscript } from './resumeTranscript.js'
import { controlTranscriptEvidence } from './transcriptBindings.js'

const zstd = zlib as typeof zlib & { zstdCompressSync: (value: Buffer | string) => Buffer }
const id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
let root: string, home: string, path: string
const history = (sessionId = id, source: unknown = 'cli') => JSON.stringify({ type: 'session_meta',
  payload: { id: sessionId, cwd: root, source } }) + '\n' + JSON.stringify({ type: 'event_msg',
  payload: { type: 'user_message', message: 'Keep this conversation' } }) + '\n'
const archive = (text = history(), at = path) => {
  mkdirSync(dirname(at), { recursive: true })
  writeFileSync(at + '.zst', zstd.zstdCompressSync(text), { mode: 0o600 })
}
const restore = (current = () => true, limits?: { timeoutMs: number; maxBytes: number }) =>
  materializeResumeTranscript('codex', id, path, home, current, limits)
const noTemporary = () => expect(readdirSync(dirname(path)).filter(name => name.startsWith('.harness-restore-'))).toEqual([])
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'resume-compressed-')))
  home = join(root, 'codex')
  path = join(home, 'sessions', '2026', '10', '05', `rollout-${id}.jsonl`)
  archive()
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

it('restores the exact history before control verification, retaining the archive and private permissions', async () => {
  expect(() => controlTranscriptEvidence('codex', id, path, home)).toThrow('unavailable')
  const compressed = readFileSync(path + '.zst')
  expect(await restore()).toBe(path)
  expect(readFileSync(path, 'utf8')).toBe(history())
  expect(readFileSync(path + '.zst')).toEqual(compressed)
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(() => controlTranscriptEvidence('codex', id, path, home).verify()).not.toThrow()
  noTemporary()
})

it('recovers again if Codex compresses the stopped conversation a second time', async () => {
  await restore()
  const later = history() + JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Later reply' } }) + '\n'
  archive(later)
  unlinkSync(path)
  await restore()
  expect(readFileSync(path, 'utf8')).toBe(later)
})

it('accepts an explicitly compressed saved path in a private profile', async () => {
  expect(await materializeResumeTranscript('codex', id, path + '.zst', home, () => true)).toBe(path)
  expect(() => controlTranscriptEvidence('codex', id, path, home).verify()).not.toThrow()
})

it('keeps an existing plain history authoritative even when the archive is stale or corrupt', async () => {
  const current = history() + '{"type":"compacted"}\n'
  writeFileSync(path, current)
  writeFileSync(path + '.zst', 'corrupt old archive')
  expect(await restore()).toBe(path)
  expect(readFileSync(path, 'utf8')).toBe(current)
  noTemporary()
})

it.each(['leading blank lines', 'no final newline'])('uses the existing header rules with %s', async kind => {
  const text = kind === 'leading blank lines' ? '\n \n' + history() : history().split('\n')[0]
  archive(text)
  await restore()
  expect(readFileSync(path, 'utf8')).toBe(text)
  expect(() => controlTranscriptEvidence('codex', id, path, home).verify()).not.toThrow()
})

it('does not decompress histories of an engine that does not declare compression, or invent missing history', async () => {
  expect(await materializeResumeTranscript('claude', id, path, home, () => true)).toBe(path)
  expect(existsSync(path)).toBe(false)
  unlinkSync(path + '.zst')
  expect(await restore()).toBe(path)
  expect(existsSync(path)).toBe(false)
})

it.each([
  ['different', () => history('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb')],
  ['delegated', () => history(id, { subagent: { thread_spawn: { parent_thread_id: id } } })],
  ['invalid', (): string => '{"type":"not_session_meta"}\n'],
  ['incomplete', (): string => history().split('\n')[0].slice(0, -1)],
  ['oversized', (): string => JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source: 'cli', padding: 'x'.repeat(128 * 1024) } }) + '\n'],
] as const)('never publishes a %s identity', async (_label, value) => {
  archive(value())
  const compressed = readFileSync(path + '.zst')
  await expect(restore()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(existsSync(path)).toBe(false)
  expect(readFileSync(path + '.zst')).toEqual(compressed)
  noTemporary()
})

it.each(['invalid', 'truncated'] as const)('never publishes a %s archive or leaks its content in the error', async kind => {
  const bytes = kind === 'invalid' ? Buffer.from('PRIVATE_ARCHIVE_CONTENT') : readFileSync(path + '.zst').subarray(0, -5)
  writeFileSync(path + '.zst', bytes)
  await expect(restore()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(existsSync(path)).toBe(false)
  expect(readFileSync(path + '.zst')).toEqual(bytes)
  noTemporary()
})

it('refuses a destination outside the declared profile', async () => {
  path = join(root, 'outside', `rollout-${id}.jsonl`); archive()
  await expect(restore()).rejects.toThrow('outside')
  expect(existsSync(path)).toBe(false)
})

it('rejects a truncated large archive even when the native decoder emits a complete header and many valid turns', async () => {
  archive(history() + Array.from({ length: 20_000 }, (_,i) => JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: `Turn ${i}` } }) + '\n').join(''))
  writeFileSync(path + '.zst', readFileSync(path + '.zst').subarray(0, -1))
  await expect(restore()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(existsSync(path)).toBe(false)
  noTemporary()
})

it('refuses a leaf symlink for either the archive or the missing destination', async () => {
  const elsewhere = join(root, 'other.zst')
  renameSync(path + '.zst', elsewhere)
  symlinkSync(elsewhere, path + '.zst')
  await expect(restore()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  unlinkSync(path + '.zst'); archive()
  symlinkSync(join(root, 'absent.jsonl'), path)
  expect(await restore()).toBe(path)
  expect(() => controlTranscriptEvidence('codex', id, path, home)).toThrow()
  expect(existsSync(join(root, 'absent.jsonl'))).toBe(false)
})

it('does not overwrite a plain file that appears while decompressing', async () => {
  let calls = 0
  await restore(() => {
    if (++calls === 2) writeFileSync(path, history('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'))
    return true
  })
  expect(readFileSync(path, 'utf8')).toContain('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb')
  expect(() => controlTranscriptEvidence('codex', id, path, home)).toThrow('different')
  noTemporary()
})

it('refuses an archive replaced while decompressing and keeps both versions', async () => {
  let calls = 0
  await expect(restore(() => {
    if (++calls === 2) { renameSync(path + '.zst', path + '.old.zst'); archive() }
    return true
  })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(existsSync(path)).toBe(false)
  expect(existsSync(path + '.old.zst')).toBe(true)
  noTemporary()
})

it.each([1, 2, 3])('retains the archive when cancelled at checkpoint %i', async when => {
  let calls = 0
  await expect(restore(() => ++calls !== when)).rejects.toThrow('cancelled')
  expect(existsSync(path)).toBe(false)
  expect(existsSync(path + '.zst')).toBe(true)
  noTemporary()
})

it('bounds decoded bytes without leaving a partial destination', async () => {
  await expect(restore(() => true, { maxBytes: 16, timeoutMs: 30_000 })).rejects.toThrow('size limit')
  expect(existsSync(path)).toBe(false)
  noTemporary()
})

it('bounds the total restore time without leaving a partial destination', async () => {
  await expect(restore(() => true, { maxBytes: 1024 ** 3, timeoutMs: 0 })).rejects.toThrow('retained')
  expect(existsSync(path)).toBe(false)
  noTemporary()
})
