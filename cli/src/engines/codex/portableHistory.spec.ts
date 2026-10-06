import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { constants as bufferConstants } from 'node:buffer'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { portableCodexHistory, prepareCodexResume } from './portableHistory.js'

// Keep the real filesystem, with configurable exports for simulating a concurrent writer.
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))

const SESSION = '01a0a3cd-a374-71f2-a11a-1fc1cc41b36d'
const BAD_ID = 'msg_aY9suLof0GA06VzeKPXLM7rjUhoRRF9d'
const summary = [{ type: 'summary_text', text: 'Prior engine summary.' }]
const record = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-09-15T06:43:10.580Z', type, payload })
const meta = record('session_meta', { id: SESSION, cwd: '/workspace', model_provider: 'openai' })
const badReasoning = () => ({ type: 'reasoning', id: BAD_ID, summary, content: [] })
const message = { type: 'message', id: BAD_ID, role: 'assistant', content: [{ type: 'output_text', text: 'Hello.' }] }
const history = (...items: unknown[]) => [meta, ...items.map(item => record('response_item', item)), ''].join('\n')
const payloads = (value: string) => value.trim().split('\n').slice(1).map(line => JSON.parse(line).payload)

describe('Codex reasoning history portability', () => {
  it('repairs the screenshot pair without changing the answer, its id, or the reasoning summary', () => {
    const original = history(badReasoning(), message)
    const result = portableCodexHistory(original, SESSION)
    expect(result.repairedItems).toBe(1)
    expect(payloads(result.history)).toEqual([{ type: 'reasoning', summary, content: [] }, message])
    expect(result.history.split('\n')[2]).toBe(original.split('\n')[2])
    expect(portableCodexHistory(result.history, SESSION)).toEqual({ history: result.history, repairedItems: 0 })
  })

  it('keeps local reasoning text when repairing legacy content and rs_ ids', () => {
    const result = portableCodexHistory(history({
      type: 'reasoning', id: 'rs_local', summary: [], content: [{ text: 'one ' }, { text: 'two' }],
    }), SESSION)
    expect(payloads(result.history)).toEqual([{
      type: 'reasoning', summary: [{ type: 'summary_text', text: 'one two' }], content: [],
    }])
  })

  it('keeps an existing summary when content also needs repair', () => {
    const result = portableCodexHistory(history({ ...badReasoning(), content: [{ text: 'duplicate' }] }), SESSION)
    expect(payloads(result.history)[0]).toEqual({ type: 'reasoning', summary, content: [] })
  })

  it('preserves vendor encrypted reasoning and tool relationships byte for byte', () => {
    const original = history(
      { type: 'reasoning', id: 'rs_vendor', encrypted_content: 'opaque-vendor-data', summary: [], content: [{ type: 'reasoning_text', text: 'vendor' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'workspace' },
      message,
    ).replaceAll('\n', '\r\n')
    expect(portableCodexHistory(original, SESSION)).toEqual({ history: original, repairedItems: 0 })
  })

  it('repairs replacement history that compaction will replay, leaving other nested data alone', () => {
    const compacted = record('compacted', { message: 'Context summary', replacement_history: [badReasoning(), message] })
    const event = record('event_msg', { type: 'agent_reasoning', text: 'Visible trace', metadata: badReasoning() })
    const original = `${meta}\n${compacted}\n${event}\n`
    const result = portableCodexHistory(original, SESSION)
    expect(result.repairedItems).toBe(1)
    expect(payloads(result.history)[0].replacement_history).toEqual([{ type: 'reasoning', summary, content: [] }, message])
    expect(result.history.split('\n')[2]).toBe(event)
  })
})

describe('preparing a stopped Codex session for resume', () => {
  let profile: string
  let file: string
  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), 'codex-portable-history-'))
    const dir = join(profile, 'sessions', '2026', '09', '15')
    mkdirSync(dir, { recursive: true })
    file = join(dir, `rollout-2026-09-15T13-42-38-${SESSION}.jsonl`)
  })
  afterEach(() => { vi.restoreAllMocks(); rmSync(profile, { recursive: true, force: true }) })
  const source = () => ({ engine: 'codex', sessionId: SESSION, transcriptPath: file, codexHome: profile })

  it('backs up the exact original, repairs the same session, and is a no-op on the next resume', () => {
    const original = history(badReasoning(), message)
    writeFileSync(file, original)
    const result = prepareCodexResume(source())
    expect(result.repairedItems).toBe(1)
    expect(readFileSync(result.backupPath!, 'utf8')).toBe(original)
    expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toBe(portableCodexHistory(original, SESSION).history)
    // repairedBytes lets a live tailer re-sync its offset to the shrunk file without another stat.
    expect(result.repairedBytes).toBe(statSync(file).size)
    expect(result.repairedBytes).toBeLessThan(Buffer.byteLength(original, 'utf8'))
    const before = statSync(file)
    expect(prepareCodexResume(source())).toEqual({ repairedItems: 0 })
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs)
    expect(statSync(file).ino).toBe(before.ino)
    expect(readdirSync(join(profile, 'sessions', '2026', '09', '15'))).toHaveLength(2)
  })

  it('resumes and repairs a rollout larger than the engine single-string limit without losing history', () => {
    const chunk = Buffer.from(record('event_msg', { type: 'agent_message', message: 'x'.repeat(512 * 1024) }) + '\n')
    const fd = openSync(file, 'wx')
    const originalHash = createHash('sha256')
    const write = (bytes: string | Buffer) => { writeSync(fd, Buffer.from(bytes)); originalHash.update(bytes) }
    try {
      write(meta + '\r\n')
      for (let bytes = 0; bytes <= bufferConstants.MAX_STRING_LENGTH; bytes += chunk.length) write(chunk)
    } finally { closeSync(fd) }
    const before = statSync(file)
    expect(before.size).toBeGreaterThan(bufferConstants.MAX_STRING_LENGTH)
    // The common case must not rewrite or create a backup just to reopen an existing session.
    expect(prepareCodexResume(source())).toEqual({ repairedItems: 0 })
    expect(statSync(file).ino).toBe(before.ino)
    expect(readdirSync(join(profile, 'sessions', '2026', '09', '15'))).toHaveLength(1)

    const tail = record('response_item', badReasoning())
    writeFileSync(file, tail, { flag: 'a' })
    originalHash.update(tail)
    const result = prepareCodexResume(source())
    expect(result.repairedItems).toBe(1)
    expect(result.repairedBytes).toBe(statSync(file).size)
    const backupHash = createHash('sha256')
    const backup = openSync(result.backupPath!, 'r')
    try {
      const buffer = Buffer.alloc(64 * 1024)
      let read: number
      while ((read = readSync(backup, buffer)) > 0) backupHash.update(buffer.subarray(0, read))
    } finally { closeSync(backup) }
    expect(backupHash.digest('hex')).toBe(originalHash.digest('hex'))
    const repaired = openSync(file, 'r')
    try {
      const expected = Buffer.from(record('response_item', { type: 'reasoning', summary, content: [] }))
      const actual = Buffer.alloc(expected.length)
      readSync(repaired, actual, 0, actual.length, statSync(file).size - actual.length)
      expect(actual).toEqual(expected)
    } finally { closeSync(repaired) }
  }, 30_000)

  it('preserves UTF-8, CRLF, blank lines, and a final record without a newline across chunk boundaries', () => {
    const original = '\r\n' + history(badReasoning(), { ...message,
      content: [{ type: 'output_text', text: '𐐀é'.repeat(40_000) }],
    }).replaceAll('\n', '\r\n').trimEnd()
    writeFileSync(file, original)
    const result = prepareCodexResume(source())
    expect(result.repairedItems).toBe(1)
    expect(readFileSync(result.backupPath!, 'utf8')).toBe(original)
    expect(readFileSync(file, 'utf8')).toBe(portableCodexHistory(original, SESSION).history)
  })

  it('keeps a concurrent writer’s update instead of replacing it with prepared history', () => {
    writeFileSync(file, history(badReasoning()))
    const originalRead = fs.readSync
    let changed = false
    const appended = record('event_msg', { type: 'agent_message', message: 'new work' }) + '\n'
    vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const read = originalRead(...args)
      if (!changed) { changed = true; writeFileSync(file, appended, { flag: 'a' }) }
      return read
    })
    expect(() => prepareCodexResume(source())).toThrow('changed during resume preparation')
    expect(readFileSync(file, 'utf8')).toBe(history(badReasoning()) + appended)
    expect(readdirSync(join(profile, 'sessions', '2026', '09', '15'))).toHaveLength(1)
  })

  it('resolves a rollout in the selected profile when the registry has no transcript path', () => {
    writeFileSync(file, history(badReasoning()))
    expect(prepareCodexResume({ ...source(), transcriptPath: null }).repairedItems).toBe(1)
  })

  it('resolves the session again when the registry points at a missing rollout', () => {
    writeFileSync(file, history(badReasoning()))
    expect(prepareCodexResume({ ...source(), transcriptPath: join(profile, 'sessions', 'missing.jsonl') }).repairedItems).toBe(1)
    expect(payloads(readFileSync(file, 'utf8'))[0]).not.toHaveProperty('id')
  })

  it.each(['invalid JSON', '{"type":"response_item","payload":'])('does not rewrite or back up a partial or invalid rollout (%s)', (invalid) => {
    const original = history(badReasoning()) + invalid
    writeFileSync(file, original)
    expect(() => prepareCodexResume(source())).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(readdirSync(join(profile, 'sessions', '2026', '09', '15'))).toHaveLength(1)
  })

  // A person who moved CODEX_HOME in their shell profile keeps their rollouts there, and an agent of theirs
  // names no profile of its own. The rollout was held to the daemon's own CODEX_HOME, refused as "outside the
  // session profile", and every restart or reopen of that agent failed after its engine had been stopped.
  it('prepares a rollout kept in a CODEX_HOME the person moved, for an agent on no profile of its own', async () => {
    writeFileSync(file, history(badReasoning()))
    vi.resetModules()
    vi.stubEnv('CODEX_HOME', join(profile, 'daemon-codex'))
    const homes = await import('../../lib/engineHomes.js')
    homes.adoptEngineHomes({ CODEX_HOME: profile }, { claudeHome: '/nowhere/.claude', codexHome: '/nowhere/.codex' })
    try {
      const fresh = await import('./portableHistory.js')
      expect(fresh.prepareCodexResume({ ...source(), codexHome: null }).repairedItems).toBe(1)
      // Found by its id there too, when the registry has no path for it.
      writeFileSync(file, history(badReasoning()))
      expect(fresh.prepareCodexResume({ ...source(), codexHome: null, transcriptPath: null }).repairedItems).toBe(1)
      // A file in no Codex home at all is still refused.
      const stray = join(profile, 'stray.jsonl')
      writeFileSync(stray, history(badReasoning()))
      expect(() => fresh.prepareCodexResume({ ...source(), codexHome: null, transcriptPath: stray })).toThrow('outside the session profile')
    } finally {
      vi.unstubAllEnvs()
      rmSync(join(process.env.ADAPTER_DATA_DIR!, 'engine-homes.json'), { force: true })
      homes.resetEngineHomes()
    }
  })

  it('refuses a different session instead of modifying the wrong history', () => {
    const original = history(badReasoning())
    writeFileSync(file, original)
    expect(() => prepareCodexResume({ ...source(), sessionId: 'another-session' })).toThrow('does not belong')
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  it('refuses symlinks and files outside the profile', () => {
    const outside = join(profile, 'other.jsonl')
    const original = history(badReasoning())
    writeFileSync(outside, original)
    symlinkSync(outside, file)
    expect(() => prepareCodexResume(source())).toThrow('outside the session profile')
    expect(() => prepareCodexResume({ ...source(), transcriptPath: outside })).toThrow('outside the session profile')
    expect(readFileSync(outside, 'utf8')).toBe(original)
  })

  it('leaves other engines, fresh sessions, and missing histories to the existing launch path', () => {
    expect(prepareCodexResume({ ...source(), engine: 'claude' })).toEqual({ repairedItems: 0 })
    expect(prepareCodexResume({ ...source(), sessionId: '' })).toEqual({ repairedItems: 0 })
    expect(prepareCodexResume(source())).toEqual({ repairedItems: 0 })
    expect(prepareCodexResume({ ...source(), transcriptPath: null })).toEqual({ repairedItems: 0 })
  })
})
