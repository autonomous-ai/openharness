import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { latestCompactSummary, readCompactSummary } from './compactSummary.js'

const RULE = { flag: 'isCompactSummary', text: ['message', 'content'] } as const
import { sessionStore as claudeStore } from '../engines/claude/sessionStore.js'
const CLAUDE = claudeStore.compactSummary!
const line = (value: unknown) => JSON.stringify(value) + '\n'
const summary = (content: unknown) => line({ type: 'user', isCompactSummary: true, message: { role: 'user', content } })
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('latestCompactSummary', () => {
  it('takes the latest summary, as a string or as text blocks', () => {
    const text = summary('first summary') + line({ type: 'assistant' }) + summary([{ type: 'text', text: 'second' }, { type: 'image' }, { type: 'text', text: 'part' }])
    expect(latestCompactSummary(text, RULE, false)).toBe('second\npart')
  })
  it('skips malformed lines and lines without the flag', () => {
    const text = summary('kept') + '{"isCompactSummary":true,\n' + line({ type: 'user', message: { content: 'not a summary' } })
    expect(latestCompactSummary(text, RULE, false)).toBe('kept')
  })
  it('ignores a first line cut by the window and a summary with no text', () => {
    const text = summary('cut off').slice(5) + summary([{ type: 'image' }])
    expect(latestCompactSummary(text, RULE, true)).toBeNull()
  })
  it('is null when there is none', () => {
    expect(latestCompactSummary(line({ type: 'user', message: { content: 'hi' } }), RULE, false)).toBeNull()
  })
})

describe('readCompactSummary', () => {
  const file = (body: string) => {
    const root = mkdtempSync(join(tmpdir(), 'compact-summary-')); roots.push(root)
    const path = join(root, 't.jsonl'); writeFileSync(path, body); return path
  }
  it('reads the latest summary up to end', async () => {
    const path = file(summary('old') + summary('new') + line({ type: 'assistant' }))
    const handle = await open(path)
    try { expect(await readCompactSummary(handle, (await handle.stat()).size, RULE)).toBe('new') } finally { await handle.close() }
  })
  it('does not look before the window: an older summary is no summary', async () => {
    const path = file(summary('too old') + line({ type: 'assistant', pad: 'x'.repeat(2000) }))
    const handle = await open(path)
    try { expect(await readCompactSummary(handle, (await handle.stat()).size, RULE, 1000)).toBeNull() } finally { await handle.close() }
  })
  it('does not read past end (bytes appended after the verified size)', async () => {
    const before = summary('verified')
    const path = file(before + summary('appended later'))
    const handle = await open(path)
    try { expect(await readCompactSummary(handle, Buffer.byteLength(before), RULE)).toBe('verified') } finally { await handle.close() }
  })
})

// Claude Code wraps every summary in its own resume orders: "Continue … without asking the user any further questions",
// and a pointer to its raw transcript outside the project. Carried into the record they contradict "wait for the user",
// and they are the engine's words, not the person's, so they are cut before the summary is quoted (review, 2026-10-21).
describe('Claude\'s own wrapper around a summary', () => {
  const real = [
    'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
    '',
    'Summary:',
    '1. **Primary Request and Intent:**',
    '   - Add D7 to the desktop report.',
    '',
    'If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /Users/someone/.claude/projects/-w/abc.jsonl',
    'Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.',
    '',
    'The messages after this summary are the most recent messages from before compaction, kept verbatim. The summary was written without seeing them, so something it says has not happened yet may already have happened in them.',
  ].join('\n')
  it('keeps the summary and drops the engine\'s opening line, its transcript pointer and its resume orders', () => {
    const out = latestCompactSummary(summary(real), CLAUDE, false)!
    expect(out).toBe('Summary:\n1. **Primary Request and Intent:**\n   - Add D7 to the desktop report.')
  })
  it('keeps a summary without the wrapper as it is, and drops one that is only the wrapper', () => {
    expect(latestCompactSummary(summary('Summary:\n- plain'), CLAUDE, false)).toBe('Summary:\n- plain')
    const onlyWrapper = real.split('\n').filter((line) => !line.startsWith('Summary:') && !line.startsWith('1.') && !line.startsWith('   -')).join('\n')
    expect(latestCompactSummary(summary(onlyWrapper), CLAUDE, false)).toBeNull()
  })
})
