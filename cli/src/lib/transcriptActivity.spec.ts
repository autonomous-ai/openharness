import { appendFile, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { transcriptActivityAt } from './transcriptActivity.js'

let dir: string
let file: string
const work = '2026-09-22T16:11:03.605Z'
const metadata = '2026-09-23T01:04:42.169Z'
const line = (row: unknown) => JSON.stringify(row) + '\n'
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'transcript-activity-')); file = join(dir, 'history.jsonl') })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('ignores a fresh file mtime and bookkeeping events on a long-idle Claude harness', async () => {
  await writeFile(file, line({ type: 'assistant', timestamp: work })
    + line({ type: 'ai-title', timestamp: metadata }) + line({ type: 'permission-mode', timestamp: metadata }))
  await utimes(file, new Date(metadata), new Date(metadata))
  expect(await transcriptActivityAt(file, 'claude')).toBe(Date.parse(work))
  await appendFile(file, line({ type: 'mode', timestamp: metadata }))
  expect(await transcriptActivityAt(file, 'claude')).toBe(Date.parse(work))
})

it('crosses chunk boundaries and large metadata records without inventing recent work', async () => {
  await writeFile(file, line({ type: 'user', timestamp: work, text: 'old work' })
    + line({ type: 'ai-title', timestamp: metadata, padding: 'x'.repeat(180_000) }))
  expect(await transcriptActivityAt(file, 'claude')).toBe(Date.parse(work))
})

it('advances for real work and turn completion, and tolerates unfinished final JSON', async () => {
  await writeFile(file, line({ type: 'assistant', timestamp: work }) + '{"type":"assistant",')
  expect(await transcriptActivityAt(file, 'claude')).toBe(Date.parse(work))
  await appendFile(file, `"timestamp":"${metadata}"}\n`)
  expect(await transcriptActivityAt(file, 'claude')).toBe(Date.parse(metadata))
  await appendFile(file, line({ type: 'system', subtype: 'turn_duration', timestamp: '2026-09-23T01:05:00Z' }))
  expect(await transcriptActivityAt(file, 'claude')).toBe(Date.parse('2026-09-23T01:05:00Z'))
})

it('uses Codex messages and tool activity, not context or rate-limit snapshots', async () => {
  await writeFile(file, line({ type: 'response_item', timestamp: work, payload: { type: 'function_call' } })
    + line({ type: 'turn_context', timestamp: metadata })
    + line({ type: 'event_msg', timestamp: metadata, payload: { type: 'token_count', info: null } }))
  expect(await transcriptActivityAt(file, 'codex')).toBe(Date.parse(work))
  await appendFile(file, line({ type: 'event_msg', timestamp: metadata, payload: { type: 'item_completed', item: { type: 'AgentMessage' } } }))
  expect(await transcriptActivityAt(file, 'codex')).toBe(Date.parse(metadata))
})

it('invalidates cached activity after truncation or file replacement', async () => {
  await writeFile(file, line({ type: 'assistant', timestamp: metadata }))
  expect(await transcriptActivityAt(file, 'claude')).toBe(Date.parse(metadata))
  await writeFile(file, '{}\n')
  expect(await transcriptActivityAt(file, 'claude')).toBeNull()
  await writeFile(join(dir, 'replacement'), line({ type: 'user', timestamp: work }))
  await rename(join(dir, 'replacement'), file)
  expect(await transcriptActivityAt(file, 'claude')).toBe(Date.parse(work))
})

it('returns unknown for missing, unsupported, malformed, or unbounded metadata-only histories', async () => {
  expect(await transcriptActivityAt(file, 'claude')).toBeNull()
  await writeFile(file, line({ type: 'assistant', timestamp: 'invalid' }) + 'bad\n')
  expect(await transcriptActivityAt(file, 'claude')).toBeNull()
  expect(await transcriptActivityAt(file, 'opencode')).toBeNull()
  await writeFile(file, line({ type: 'assistant', timestamp: work })
    + line({ type: 'ai-title', padding: 'x'.repeat(2 * 1024 * 1024 + 1) }))
  expect(await transcriptActivityAt(file, 'claude')).toBeNull()
})
