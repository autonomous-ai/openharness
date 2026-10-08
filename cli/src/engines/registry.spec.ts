/** The pre-extraction reply, pinned on 557ea832a against recorded, sanitized sessions. Hashes include
 *  every event field and wire cursor, excluding only the fixture file's filesystem timestamp. This
 *  catches lost delegation/tool cards and subtle paging changes while the ownership moves. */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { engineReaderRequests } from './worker/process.js'
import { createEngineReaders } from '../core/engines/readers.js'
import { expect, it } from 'vitest'
import { engineTranscriptFor } from './transcripts.js'
import { engineFor } from './registry.js'
import { createHistory } from '../core/transcripts/history.js'
import { createLastTurnReader } from '../core/transcripts/lastTurn.js'
import { TranscriptPager } from '../lib/transcriptPages.js'
import type { RegisteredSession } from '../lib/registry.js'

it.each(['inline', 'worker'])('preserves recorded history, cursors and last-turn replies for Claude Code and Codex (%s)', async (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'engine-oracle-'))
  const answer: Record<string, unknown> = {}
  try {
    for (const [engine, fixture] of Object.entries({ claude: '../lib/__fixtures__/transcript-async-subagents.jsonl', codex: '../lib/fixtures/session-work-codex.jsonl' })) {
      const transcriptPath = join(root, engine + '.jsonl')
      copyFileSync(fileURLToPath(new URL(fixture, import.meta.url)), transcriptPath)
      const codexHome = join(root, 'codex-home'); mkdirSync(codexHome, { recursive: true })
      const session = { agentId: 'agent', sessionId: 'session', engine, transcriptPath, touchedAt: 1791374400000, cwd: '/fixture', codexHome } as RegisteredSession
      const requests = engineReaderRequests(engine as 'claude' | 'codex')
      const port = createEngineReaders({ isolated: new Set([`engine-${engine}`]), call: async (_service, type, payload) => await requests[type](JSON.parse(JSON.stringify(payload)), { owner: true, local: true }) })
      port.connected(`engine-${engine}`)
      const deps = { readerFor: mode === 'worker' ? port.forEngine : engineTranscriptFor, resolve: () => session, stopped: () => [], pages: new TranscriptPager(), dbs: { opencode: '', kilo: '', devin: '' }, hermesDb: async () => '' }
      const history = createHistory(deps)
      const digest = (value: Record<string, unknown>) => {
        const { timestamp, ...stable } = value
        return { sha256: createHash('sha256').update(JSON.stringify(stable)).digest('hex'), eventTypes: (value.events as Array<{ type: string }>).map(e => e.type), hasMore: value.hasMore ?? null, oldestCursor: value.oldestCursor ?? null }
      }
      const whole = await history.sessionGet({ sessionId: 'session' })
      const latest = await history.sessionGet({ sessionId: 'session', limit: 3 })
      const older = await history.sessionGet({ sessionId: 'session', limit: 3, before: latest.oldestCursor! })
      const stale = await history.sessionGet({ sessionId: 'session', limit: 3, before: 'missing-cursor' })
      const readLast = createLastTurnReader({ ...deps, bySession: () => session })
      answer[engine] = { whole: digest(whole), latest: digest(latest), older: digest(older), stale: digest(stale), lastTurn: await readLast('session') }
    }
    expect(answer).toEqual(JSON.parse(readFileSync(new URL('./__fixtures__/transcript-contracts.json', import.meta.url), 'utf8')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('does not mistake unknown names or object prototype properties for an engine', () => {
  for (const name of [null, undefined, '', 'future-engine', 'constructor', 'toString', '__proto__']) expect(engineFor(name)).toBeUndefined()
  expect(engineFor('claude')?.name).toBe('claude')
  expect(engineFor('codex')?.name).toBe('codex')
})

it('answers an unbound conversation without reading any engine home', async () => {
  const pages = new TranscriptPager()
  for (const name of ['claude', 'codex']) {
    const session = { engine: name, touchedAt: 1791374400000 } as RegisteredSession
    const transcript = engineFor(name)!.transcript
    expect(await transcript.lastTurnText(session)).toBeNull()
    expect(await transcript.historyPage(session, {}, pages)).toEqual({ events: [], timestamp: new Date(session.touchedAt).toISOString(), hasMore: false, oldestCursor: null })
  }
})
