import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { conversationTokens } from './conversationSize.js'

const assistant = (usage: Record<string, number>) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [], usage } })
const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
// Sums to 150 000: what the conversation weighs once this answer is in it.
const NEWEST = { input_tokens: 10, cache_read_input_tokens: 140_000, cache_creation_input_tokens: 9_000, output_tokens: 990 }

describe('conversationTokens — how long a Claude Code conversation is now', () => {
  let dir: string
  const transcript = (lines: string[]) => {
    const file = join(dir, 'session.jsonl')
    writeFileSync(file, lines.join('\n') + '\n')
    return file
  }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'conversation-size-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sums the newest assistant entry\'s usage', async () => {
    expect(await conversationTokens(transcript([user('hi'), assistant({ input_tokens: 5, output_tokens: 5 }), user('more'), assistant(NEWEST)])))
      .toBe(150_000)
  })

  it('is not changed by a later entry that carries no usage', async () => {
    expect(await conversationTokens(transcript([assistant(NEWEST), user('and then?')]))).toBe(150_000)
  })

  it('counts a missing field as nothing', async () => {
    expect(await conversationTokens(transcript([assistant({ input_tokens: 7, output_tokens: 3 })]))).toBe(10)
  })

  it('finds the newest usage in the tail of a long transcript', async () => {
    const filler = user('x'.repeat(1_000))
    const lines = [assistant({ input_tokens: 1, output_tokens: 1 }), ...Array.from({ length: 1_000 }, () => filler), assistant(NEWEST), ...Array.from({ length: 50 }, () => filler)]
    expect(await conversationTokens(transcript(lines))).toBe(150_000)
  })

  it('is null when no assistant entry has usage, skipping malformed lines', async () => {
    expect(await conversationTokens(transcript([user('hi'), '{"type":"assistant","mess', JSON.stringify({ type: 'assistant', message: {} })]))).toBeNull()
  })

  it('is null when the transcript cannot be read', async () => {
    expect(await conversationTokens(join(dir, 'missing.jsonl'))).toBeNull()
  })
})
