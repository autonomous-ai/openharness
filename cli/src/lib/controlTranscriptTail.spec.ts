import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { controlTranscriptTail } from './controlTranscriptTail.js'
import { recoveryBoundary } from './transcriptBoundary.js'

const directories: string[] = []
const fixture = (text: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'control-tail-'))
  directories.push(directory)
  const file = join(directory, 'session.jsonl')
  writeFileSync(file, text)
  const boundary = recoveryBoundary(file)
  return { file, closes: [{ offset: boundary.offset, reason: 'cancel' as const, boundary }] }
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it('keeps UTF-8 record offsets and leaves an unfinished append for the tail', async () => {
  const before = '{"prompt":"é📘"}\n', after = '{"prompt":"later"}\n'
  const { file, closes } = fixture(before)
  appendFileSync(file, after + '{"partial":')
  expect(await controlTranscriptTail(file, closes, 4096)).toEqual({
    lines: [before.trim(), after.trim()], offsets: [0, Buffer.byteLength(before)],
    identity: closes[0].boundary, start: 0, next: Buffer.byteLength(before + after), truncated: false,
  })
})

it('reads only a bounded suffix while retaining every complete record after Cancel', async () => {
  const { file, closes } = fixture(' '.repeat(200_000) + '\n{"old":true}\n')
  appendFileSync(file, '{"new":true}')
  const result = await controlTranscriptTail(file, closes, 64)
  expect(result.lines).toEqual(['{"old":true}', '{"new":true}'])
  expect(result.offsets).toEqual([200_001, closes[0].offset])
  expect(result.next).toBe(closes[0].offset + 12)
  expect(result.truncated).toBe(true)
})

it('can close an empty transcript and a turn whose old record exceeds the read budget', async () => {
  const empty = fixture('')
  expect(await controlTranscriptTail(empty.file, empty.closes, 64)).toEqual({ lines: [], offsets: [], identity: empty.closes[0].boundary, start: 0, next: 0, truncated: false })
  const large = fixture(JSON.stringify({ old: 'x'.repeat(200_000) }) + '\n')
  expect(await controlTranscriptTail(large.file, large.closes, 64)).toEqual({
    lines: [], offsets: [], identity: large.closes[0].boundary, start: large.closes[0].offset, next: large.closes[0].offset, truncated: true,
  })
})

it.each(['\n {"old":true}\n', '\n \r\n'])('keeps a complete bounded prefix beginning with blank lines: %j', async text => {
  const { file, closes } = fixture(text)
  const result = await controlTranscriptTail(file, closes, 64, true)
  expect(result.start).toBe(0)
  expect(result.truncated).toBe(false)
  expect(result.next).toBe(Buffer.byteLength(text))
})

it('holds a suffix that is too large instead of skipping records after cancellation', async () => {
  const { file, closes } = fixture('{"old":true}\n')
  appendFileSync(file, JSON.stringify({ new: 'x'.repeat(100) }) + '\n')
  await expect(controlTranscriptTail(file, closes, 64)).rejects.toThrow('exceeds the recovery read limit')
})

it('leaves even valid unterminated Cursor JSON for its newline-based watcher', async () => {
  const { file, closes } = fixture('{"old":true}\n')
  appendFileSync(file, '{"new":true}')
  const result = await controlTranscriptTail(file, closes, 64, true)
  expect(result.lines).toEqual(['{"old":true}'])
  expect(result.next).toBe(closes[0].offset)
})

it('holds a control read without an original file identity', async () => {
  const { file } = fixture('')
  await expect(controlTranscriptTail(file, [{ offset: 0, reason: 'cancel' }], 64)).rejects.toThrow('file identity is unavailable')
})

it.each(['rewrite', 'replace', 'truncate', 'missing'] as const)('refuses a %s at the retained boundary', async change => {
  const { file, closes } = fixture('{"old":true}\n')
  if (change === 'rewrite') writeFileSync(file, '{"bad":true}\n')
  if (change === 'replace') { renameSync(file, file + '.old'); writeFileSync(file, '{"old":true}\n') }
  if (change === 'truncate') writeFileSync(file, '')
  if (change === 'missing') renameSync(file, file + '.old')
  await expect(controlTranscriptTail(file, closes, 64)).rejects.toThrow('ENGINE_CONTROL_BOUNDARY_CHANGED')
})
