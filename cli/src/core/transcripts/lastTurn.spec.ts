import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { createLastTurnReader } from './lastTurn.js'

// Every engine's own reader is tested with that engine; this file checks that each engine is read its own way.
const text = (from: string) => ({ text: from })
vi.mock('../../engines/opencode/reader.js', () => ({ readOpencodeMessages: vi.fn(async (db: string, id: string) => [`opencode ${db} ${id}`]) }))
vi.mock('../../engines/opencode/normalizer.js', () => ({ lastOpencodeTurnText: vi.fn((rows: string[]) => ({ text: rows[0] })) }))
vi.mock('../../engines/kilo/reader.js', () => ({ readKiloMessages: vi.fn(async (db: string, id: string) => [`kilo ${db} ${id}`]) }))
vi.mock('../../engines/kilo/normalizer.js', () => ({ lastKiloTurnText: vi.fn((rows: string[]) => ({ text: rows[0] })) }))
vi.mock('../../engines/hermes/reader.js', () => ({ readHermesMessages: vi.fn(async (db: string, id: string) => [`hermes ${db} ${id}`]) }))
vi.mock('../../engines/hermes/normalizer.js', () => ({ lastHermesTurnText: vi.fn((rows: string[]) => ({ text: rows[0] })) }))
vi.mock('../../engines/devin/reader.js', () => ({ readDevinMessages: vi.fn(async (db: string, id: string) => [`devin ${db} ${id}`]) }))
vi.mock('../../engines/devin/normalizer.js', () => ({ lastDevinTurnText: vi.fn((rows: string[]) => ({ text: rows[0] })) }))
vi.mock('../../engines/codex/lastTurn.js', () => ({ readLastCodexTurnText: vi.fn(async (path: string) => ({ text: `codex ${path}` })) }))
vi.mock('../../lib/transcriptTail.js', () => ({
  tailFileCapped: vi.fn(async (path: string) => ({ lines: [`${path} capped`], truncated: false })),
  tailFileUntil: vi.fn(async (path: string) => [`${path} back to the last turn`]),
}))
vi.mock('../../lib/normalize.js', () => ({
  lastTurnTextFromRawLines: vi.fn((lines: string[]) => ({ text: `raw: ${lines[0]}` })),
  selectClaudeRecapLine: vi.fn(),
}))
vi.mock('../../engines/cursor/normalizer.js', () => ({ lastCursorTurnText: vi.fn((lines: string[]) => ({ text: `cursor: ${lines[0]}` })) }))
vi.mock('../../engines/muse/normalizer.js', () => ({ lastMuseTurnText: vi.fn((lines: string[]) => ({ text: `muse: ${lines[0]}` })) }))
vi.mock('../../engines/amp/normalizer.js', () => ({ lastAmpTurnText: vi.fn((lines: string[]) => ({ text: `amp: ${lines[0]}` })) }))
vi.mock('../../engines/grok/normalizer.js', () => ({ lastGrokTurnText: vi.fn((lines: string[]) => ({ text: `grok: ${lines[0]}` })) }))
vi.mock('../../engines/agy/normalizer.js', () => ({ lastAgyTurnText: vi.fn((lines: string[]) => ({ text: `agy: ${lines[0]}` })) }))
vi.mock('../../engines/copilot/normalizer.js', () => ({ lastCopilotTurnText: vi.fn((lines: string[]) => ({ text: `copilot: ${lines[0]}` })) }))
vi.mock('../../engines/pi/normalizer.js', () => ({ lastPiTurnText: vi.fn((lines: string[]) => ({ text: `pi: ${lines[0]}` })) }))
vi.mock('../../engines/commandcode/normalizer.js', () => ({ lastCommandCodeTurnText: vi.fn((lines: string[]) => ({ text: `commandcode: ${lines[0]}` })) }))

const session = (engine: string, transcriptPath?: string): RegisteredSession =>
  ({ agentId: `${engine}-agent`, sessionId: `${engine}-s`, engine, transcriptPath }) as RegisteredSession

async function reader(sessions: RegisteredSession[]) {
  const create = createLastTurnReader
  const bySession = new Map(sessions.map((s) => [s.sessionId, s]))
  return create({
    bySession: (sessionId) => bySession.get(sessionId),
    dbs: { opencode: '/db/opencode.db', kilo: '/db/kilo.db', devin: '/db/devin.db' },
    hermesDb: async (s) => `/db/hermes-${s.agentId}.db`,
  })
}

describe('the last turn of each engine', () => {
  it('is nothing for a session it does not know, or a file engine without a transcript yet', async () => {
    const read = await reader([session('cursor')])
    expect(await read('nobody')).toBeNull()
    expect(await read('cursor-s')).toBeNull()
  })

  it('is read from the store of each database engine', async () => {
    const read = await reader([session('opencode'), session('kilo'), session('hermes'), session('devin')])
    expect(await read('opencode-s')).toEqual(text('opencode /db/opencode.db opencode-s'))
    expect(await read('kilo-s')).toEqual(text('kilo /db/kilo.db kilo-s'))
    expect(await read('hermes-s')).toEqual(text('hermes /db/hermes-hermes-agent.db hermes-s'))
    expect(await read('devin-s')).toEqual(text('devin /db/devin.db devin-s'))
  })

  it('is read backward for Claude Code, from the rollout for Codex, and from the whole transcript for the rest', async () => {
    const engines = ['cursor', 'muse', 'amp', 'grok', 'agy', 'copilot', 'pi', 'commandcode']
    const read = await reader([
      session('claude', '/t/claude.jsonl'), session('codex', '/t/codex.jsonl'), session('terminal', '/t/shell.log'),
      ...engines.map((engine) => session(engine, `/t/${engine}.jsonl`)),
    ])
    expect(await read('claude-s')).toEqual(text('raw: /t/claude.jsonl back to the last turn'))
    expect(await read('codex-s')).toEqual(text('codex /t/codex.jsonl'))
    for (const engine of engines) {
      expect(await read(`${engine}-s`), engine).toEqual(text(`${engine}: /t/${engine}.jsonl capped`))
    }
    // An engine with no reader of its own: its raw lines.
    expect(await read('terminal-s')).toEqual(text('raw: /t/shell.log capped'))
  })
})
