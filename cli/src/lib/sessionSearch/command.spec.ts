import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SESSION_SEARCH_FILE, searchCommand } from './command.js'
import { SessionSearchStore } from './store.js'

const NOW = Date.parse('2026-09-26T12:00:00Z')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function run(argv: string[], dataDir: string, color = false) {
  const out: string[] = []
  const err: string[] = []
  const code = searchCommand({ argv, dataDir, output: (line) => out.push(line), error: (line) => err.push(line), color, now: NOW })
  return { code, out, err }
}

function indexed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-search-'))
  dirs.push(dir)
  const store = SessionSearchStore.open(join(dir, SESSION_SEARCH_FILE))!
  store.writeSession({
    sessionId: 's1', agentId: 'agent-12345678', engine: 'claude', path: '/t', header: 'Mobile app · Mobile app build · app code',
    size: 1, mtime: 1, resumeOffset: 0, resumeTurn: 0, lastAt: NOW - 2 * 3_600_000, turns: 0,
  }, 0, [{ turn: 0, offset: 0, at: NOW - 3 * 86_400_000, ask: 'swipe right should open Find', answer: '', tools: '' }])
  store.close()
  return dir
}

describe('harness search', () => {
  it('prints each session with where it said the words', () => {
    const dir = indexed()
    expect(run(['swipe'], dir)).toEqual({ code: 0, err: [], out: ['Mobile app  3d ago · agent-12', '  > swipe right should open Find'] })
    expect(run(['swipe'], dir, true).out[1]).toBe('  > \x1b[1mswipe\x1b[22m right should open Find')
    expect(run(['nothing-here'], dir).out).toEqual(['Nothing on this computer mentions "nothing-here".'])
    const json = JSON.parse(run(['swipe', '--json'], dir).out[0])
    expect(json.hits[0]).toMatchObject({
      name: 'Mobile app', sessionId: 's1', field: 'ask',
      snippet: 'swipe right should open Find', matches: [[0, 5]],
    })
    // `--limit N` is a flag and its value, not a search word.
    expect(run(['swipe', '--limit', '1'], dir).out[0]).toBe('Mobile app  3d ago · agent-12')
  })

  it('reads a time in the words as when the session was worked on', () => {
    const dir = indexed()
    // The turn was three days before NOW; the session was last worked on two hours before.
    expect(run(['swipe', '3', 'days', 'ago'], dir).out[0]).toBe('Mobile app  3d ago · agent-12')
    expect(run(['swipe', 'yesterday'], dir).out).toEqual(['Nothing on this computer mentions "swipe" yesterday.'])
    expect(run(['3', 'days', 'ago'], dir).out[1]).toBe('  > swipe right should open Find')
    expect(run(['yesterday'], dir).out).toEqual(['Nothing on this computer was worked on yesterday.'])
  })

  it('never rewrites an index another version of the daemon owns', () => {
    const dir = indexed()
    const path = join(dir, SESSION_SEARCH_FILE)
    const raw = SessionSearchStore.open(path)!
    ;(raw as unknown as { db: { exec(sql: string): void } }).db.exec("UPDATE meta SET value = 'future' WHERE key = 'schema'")
    raw.close()
    expect(run(['swipe'], dir)).toMatchObject({ code: 1, err: [expect.stringContaining('another version')] })
    expect(statSync(path).size).toBeGreaterThan(0)
    const after = SessionSearchStore.openReader(path)
    expect(after).toBe('outdated')
  })

  it('explains a missing index and a bad invocation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-search-'))
    dirs.push(dir)
    expect(run(['swipe'], dir)).toMatchObject({ code: 1, err: [expect.stringContaining('No session index yet')] })
    expect(run([], dir)).toMatchObject({ code: 2, err: [expect.stringContaining('usage')] })
    expect(run(['x', '--limit=0'], dir).code).toBe(2)
  })
})
