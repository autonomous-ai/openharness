import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readRunIdentity, readSessionHeader, type RunIdentity, UNSETTLED } from './sessionIdentity.js'
import { readPiHead } from '../repairIdentities.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const pathFor = (text: string) => {
  const root = mkdtempSync(join(tmpdir(), 'identity-head-')); roots.push(root)
  const path = join(root, 'session.jsonl'); writeFileSync(path, text); return path
}
const rule: RunIdentity = { bytes: [64, 128], cwd: ['header', 'cwd'], run: [{ field: ['run', 'kind'], value: 'started' }] }
const header = JSON.stringify({ header: { cwd: '/work' } }) + '\n'
const run = JSON.stringify({ run: { kind: 'started' } })

it('does not read a conversation body once its identity is in the first bounded head', async () => {
  const path = pathFor(header + run + '\n' + 'x'.repeat(1024 * 1024))
  await expect(readRunIdentity(rule, path, async () => true)).resolves.toEqual({ cwd: '/work' })
})
it('expands a head for later identity and accepts a complete final line without a newline', async () => {
  const path = pathFor(header + ' '.repeat(40) + '\n' + run)
  await expect(readRunIdentity(rule, path, async () => true)).resolves.toEqual({ cwd: '/work' })
})
it('holds when a run marker lies beyond the bound, instead of ruling out a competing conversation', async () => {
  const path = pathFor(header + ' '.repeat(200) + '\n' + run)
  await expect(readRunIdentity(rule, path, async () => true)).rejects.toThrow('identity is held')
})
it('holds when even the first line exceeds the bound', async () => {
  const path = pathFor(JSON.stringify({ padding: 'x'.repeat(200), header: { cwd: '/work' } }) + '\n' + run)
  await expect(readRunIdentity(rule, path, async () => true)).rejects.toThrow('identity is held')
})
it('a file from another workspace cannot hold this workspace on a late marker', async () => {
  const matches = vi.fn(async () => false)
  const path = pathFor(header + 'x'.repeat(200))
  await expect(readRunIdentity(rule, path, matches)).resolves.toBeNull()
  expect(matches).toHaveBeenCalledExactlyOnceWith('/work')
})
it.each(['', 'bad\n', 'null\n', '[]\n', '{"header":[]}\n', header + '{"run":'])('holds an incomplete or invalid identity: %j', async text => {
  await expect(readRunIdentity(rule, pathFor(text), async () => true)).rejects.toThrow('identity is held')
})
it('excludes a complete background task with a valid workspace header', async () => {
  await expect(readRunIdentity(rule, pathFor(header + '{"run":{"kind":"task"}}'), async () => true)).resolves.toBeNull()
})
it('keeps native I/O failure distinct from an absent run', async () => {
  const path = pathFor(''); rmSync(path)
  await expect(readRunIdentity(rule, path, async () => true)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  await expect(readPiHead(path)).resolves.toBe(UNSETTLED)
  mkdirSync(path)
  await expect(readPiHead(path)).resolves.toBe(UNSETTLED)
})
it('reads a header from declared fields and preserves an optional reader\'s I/O refusal', async () => {
  const headerRule = { bytes: [100], type: 'begin', id: { field: ['record', 'id'], pattern: /^id$/ }, cwd: ['record', 'cwd'] }
  await expect(readSessionHeader(headerRule, async () => '{"type":"begin","record":{"id":"id","cwd":"/work"}}\n'))
    .resolves.toEqual({ sessionId: 'id', cwd: '/work' })
  await expect(readSessionHeader(headerRule, async () => { throw new Error('read failed') })).rejects.toThrow('read failed')
})
