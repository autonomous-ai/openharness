import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

it('keeps the newest, reads a damaged file as none, and never throws on a write it cannot make', () => {
  const dir = root(), now = 1_000_000
  for (let i = 0; i <= CLEANUP_CLOSED_MAX; i++) recordCleanupClose(dir, `h${i}`, now + i)
  const kept = cleanupClosed(dir, now + CLEANUP_CLOSED_MAX)
  expect(kept.size).toBe(CLEANUP_CLOSED_MAX)
  expect(kept.has('h0')).toBe(false)
  writeFileSync(cleanupClosesFile(dir), '{not json')
  expect([...cleanupClosed(dir, now)]).toEqual([])
  writeFileSync(cleanupClosesFile(dir), JSON.stringify({ closed: { ok: now, '../bad': now, odd: 'x' } }))
  expect([...cleanupClosed(dir, now)]).toEqual(['ok'])
  const blocked = join(root(), 'file')
  writeFileSync(blocked, '')
  expect(() => recordCleanupClose(join(blocked, 'data'), 'tern', now)).not.toThrow()
})
