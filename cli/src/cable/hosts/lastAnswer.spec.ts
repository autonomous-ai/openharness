import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readLastAnswer } from './lastAnswer.js'

let dir: string
let root: string
let outside: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lastanswer-'))
  root = join(dir, 'projects')
  outside = join(dir, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const claudeLines = (answer: string) => [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi there' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } }),
].join('\n') + '\n'

const opts = (extra: object = {}) => ({ roots: [root], maxBytes: 262144, deadlineMs: 1000, ...extra })

describe('readLastAnswer', () => {
  it('reads the last claude answer inside a root', async () => {
    const f = join(root, 's.jsonl')
    writeFileSync(f, claudeLines('All done.'))
    expect(await readLastAnswer('claude', f, opts())).toBe('All done.')
  })

  it('reads the last codex answer', async () => {
    const f = join(root, 'r.jsonl')
    writeFileSync(f, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: 'Shipped.' } }),
    ].join('\n') + '\n')
    expect(await readLastAnswer('codex', f, opts())).toBe('Shipped.')
  })

  it('refuses a transcript path that resolves outside the engine roots', async () => {
    const f = join(outside, 's.jsonl')
    writeFileSync(f, claudeLines('secret'))
    expect(await readLastAnswer('claude', f, opts())).toBeUndefined()
    expect(await readLastAnswer('claude', join(root, '..', 'outside', 's.jsonl'), opts())).toBeUndefined()
    symlinkSync(f, join(root, 'link.jsonl'))
    expect(await readLastAnswer('claude', join(root, 'link.jsonl'), opts())).toBeUndefined()
    symlinkSync(outside, join(root, 'dirlink'))
    expect(await readLastAnswer('claude', join(root, 'dirlink', 's.jsonl'), opts())).toBeUndefined()
  })

  it('refuses the root itself and a missing file', async () => {
    expect(await readLastAnswer('claude', root, opts())).toBeUndefined()
    expect(await readLastAnswer('claude', join(root, 'none.jsonl'), opts())).toBeUndefined()
  })

  it('gives up after the deadline and clears its timer', async () => {
    const f = join(root, 's.jsonl')
    writeFileSync(f, claudeLines('late'))
    const t0 = Date.now()
    const never = () => new Promise<{ lines: string[] }>(() => {})
    expect(await readLastAnswer('claude', f, opts({ deadlineMs: 30, tail: never }))).toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('reads at most 256 KB from the end', async () => {
    const f = join(root, 'big.jsonl')
    const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(1000) } }) + '\n'
    // The first line is an old answer; the filler after it pushes it past the cap.
    writeFileSync(f, claudeLines('old answer') + filler.repeat(400))
    const seen: number[] = []
    const spy = async (p: string, max: number) => {
      seen.push(max)
      const { tailFileCapped } = await import('../../lib/transcriptTail.js')
      return tailFileCapped(p, max)
    }
    expect(await readLastAnswer('claude', f, opts({ tail: spy }))).toBeUndefined()
    expect(seen).toEqual([262144])
  })
})
