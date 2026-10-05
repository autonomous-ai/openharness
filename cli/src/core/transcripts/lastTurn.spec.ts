import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { env } from '../../config/env.js'
import type { Engine } from '../../engines/engine.js'
import { engineFor } from '../../engines/registry.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createLastTurnReader } from './lastTurn.js'

// Every engine's own reader is tested with that engine; this file checks that each engine is read its own way,
// through the engine registry the daemon uses.
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
vi.mock('../../lib/hermesHome.js', () => ({ hermesDbForSession: vi.fn(async (s: RegisteredSession) => `/db/hermes-${s.agentId}.db`) }))
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

function reader(sessions: RegisteredSession[], engines: (name: string) => Engine | undefined = engineFor) {
  const bySession = new Map(sessions.map((s) => [s.sessionId, s]))
  return createLastTurnReader({ bySession: (sessionId) => bySession.get(sessionId), engineFor: engines })
}

describe('the last turn of each engine', () => {
  it('is nothing for a session it does not know, or a file engine without a transcript yet', async () => {
    const read = reader([session('cursor')])
    expect(await read('nobody')).toBeNull()
    expect(await read('cursor-s')).toBeNull()
  })

  it('is read from the store of each database engine', async () => {
    const read = reader([session('opencode'), session('kilo'), session('hermes'), session('devin')])
    // Each engine resolves its own store, where cli.ts used to pass the same paths in.
    expect(await read('opencode-s')).toEqual(text(`opencode ${join(env.OPENCODE_DATA_DIR, 'opencode.db')} opencode-s`))
    expect(await read('kilo-s')).toEqual(text(`kilo ${join(env.KILO_DATA_DIR, 'kilo.db')} kilo-s`))
    expect(await read('hermes-s')).toEqual(text('hermes /db/hermes-hermes-agent.db hermes-s'))
    expect(await read('devin-s')).toEqual(text(`devin ${join(env.DEVIN_HOME, 'sessions.db')} devin-s`))
  })

  it('is read backward for Claude Code, from the rollout for Codex, and from the whole transcript for the rest', async () => {
    const engines = ['cursor', 'muse', 'amp', 'grok', 'agy', 'copilot', 'pi', 'commandcode']
    const read = reader([
      session('claude', '/t/claude.jsonl'), session('codex', '/t/codex.jsonl'), session('terminal', '/t/shell.log'),
      ...engines.map((engine) => session(engine, `/t/${engine}.jsonl`)),
    ])
    expect(await read('claude-s')).toEqual(text('raw: /t/claude.jsonl back to the last turn'))
    expect(await read('codex-s')).toEqual(text('codex /t/codex.jsonl'))
    for (const engine of engines) {
      expect(await read(`${engine}-s`), engine).toEqual(text(`${engine}: /t/${engine}.jsonl capped`))
    }
    // A terminal is a shell, with no engine and so no reader: it has no last turn. (Before the engine
    // interface it fell through to Claude Code's raw-line reader; a terminal row never carries a session,
    // so that was never reached in the daemon.)
    expect(await read('terminal-s')).toBeNull()
  })

  it('is nothing for an engine whose transcript has no last-turn reader', async () => {
    const read = reader([session('pi', '/t/pi.jsonl')], (name) => ({ name, transcript: {} }) as Engine)
    expect(await read('pi-s')).toBeNull()
  })
})
