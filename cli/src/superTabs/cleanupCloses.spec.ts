import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CLEANUP_CLOSED_KEEP_MS, CLEANUP_CLOSED_MAX, cleanupClosed, cleanupClosesFile, recordCleanupClose } from './cleanupCloses.js'

const roots: string[] = []
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'cleanup-closes-')); roots.push(dir); return dir }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('names the sessions the idle cleanup closed for a while, privately, and forgets them after', () => {
  const dir = root(), now = 1_000_000
  expect([...cleanupClosed(dir, now)]).toEqual([])
  recordCleanupClose(dir, 'tern', now)
  recordCleanupClose(dir, 'heron', now + 1000)
  expect([...cleanupClosed(dir, now + 1000)].sort()).toEqual(['heron', 'tern'])
  expect(statSync(cleanupClosesFile(dir)).mode & 0o777).toBe(0o600)
  expect([...cleanupClosed(dir, now + CLEANUP_CLOSED_KEEP_MS)]).toEqual(['heron'])
  // A later close drops what has run out, so the file never grows past what it keeps.
  recordCleanupClose(dir, 'gannet', now + CLEANUP_CLOSED_KEEP_MS + 1000)
  expect(Object.keys(JSON.parse(readFileSync(cleanupClosesFile(dir), 'utf8')).closed)).toEqual(['gannet'])
})

it('keeps the newest, reads a damaged file as none, and says, never throwing, when it cannot write', () => {
  const dir = root(), now = 1_000_000
  // A full record written at once, then one more close: filling it close by close read and rewrote the file a thousand
  // times, which ran past five seconds in a loaded run of the whole folder (2026-11-10).
  mkdirSync(dirname(cleanupClosesFile(dir)), { recursive: true })
  writeFileSync(cleanupClosesFile(dir), JSON.stringify({ version: 1,
    closed: Object.fromEntries(Array.from({ length: CLEANUP_CLOSED_MAX }, (_, i) => [`h${i}`, now + i])) }))
  expect(recordCleanupClose(dir, `h${CLEANUP_CLOSED_MAX}`, now + CLEANUP_CLOSED_MAX)).toBe(true)
  const kept = cleanupClosed(dir, now + CLEANUP_CLOSED_MAX)
  expect(kept.size).toBe(CLEANUP_CLOSED_MAX)
  expect(kept.has('h0')).toBe(false)
  writeFileSync(cleanupClosesFile(dir), '{not json')
  expect([...cleanupClosed(dir, now)]).toEqual([])
  writeFileSync(cleanupClosesFile(dir), JSON.stringify({ closed: { ok: now, '../bad': now, odd: 'x' } }))
  expect([...cleanupClosed(dir, now)]).toEqual(['ok'])
  const blocked = join(root(), 'file')
  writeFileSync(blocked, '')
  expect(recordCleanupClose(join(blocked, 'data'), 'tern', now)).toBe(false)
  expect(recordCleanupClose(dir, 'tern', now)).toBe(true)
})
