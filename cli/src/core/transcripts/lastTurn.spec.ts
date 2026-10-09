import { EngineReadError } from '../../engines/worker/protocol.js'
import { engineTranscriptFor } from '../../engines/transcripts.js'
import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { createLastTurnReader } from './lastTurn.js'
import { loadEngine } from '../../engines/inProcess.js'

// Each engine's readers are its own code, loaded in this process; a test may say one could not be.
vi.mock('../../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../../engines/inProcess.js')>()
  return { ...actual, loadEngine: vi.fn(actual.loadEngine) }
})

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
vi.mock('../../engines/claude/normalize.js', () => ({
  lastTurnTextFromRawLines: vi.fn((lines: string[]) => ({ text: `raw: ${lines[0]}` })),
  selectClaudeRecapLine: vi.fn(),
  claudePageLine: vi.fn(),
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
    readerFor: engineTranscriptFor,
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

  it('is nothing for an engine whose code could not be loaded', async () => {
    const engines = ['opencode', 'kilo', 'hermes', 'devin', 'cursor', 'muse', 'amp', 'grok', 'agy', 'copilot', 'pi', 'commandcode']
    const read = await reader(engines.map((engine) => session(engine, `/t/${engine}.jsonl`)))
    vi.mocked(loadEngine).mockResolvedValue(null as never)
    try {
      for (const engine of engines) expect(await read(`${engine}-s`), engine).toBeNull()
    } finally { vi.mocked(loadEngine).mockReset() }
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
    // An engine with no reader and no code of its own here has no last turn: core reads no engine's lines itself.
    // (A shell keeps no transcript: registry.engineKeepsTranscriptFile.)
    expect(await read('terminal-s')).toBeNull()
  })
})


it('drops a recap read when its session binding changes and contains worker failures', async () => {
  const s = session('claude', '/read.jsonl')
  const deps = { bySession: () => s, dbs: { opencode: '', kilo: '', devin: '' }, hermesDb: async () => '' }
  const result = { userMessage: 'question', assistantText: 'answer' }
  const readerFor = () => ({ historyPage: async () => ({ events: [], timestamp: '' }), lastTurnText: async () => {
    s.transcriptPath = '/replacement.jsonl'
    return result
  } })
  expect(await createLastTurnReader({ ...deps, readerFor })('claude-s')).toBeNull()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    for (const error of [new EngineReadError('ENGINE_BUSY'), new Error('transport')]) {
      expect(await createLastTurnReader({ ...deps, readerFor: () => ({ ...readerFor(), lastTurnText: async () => { throw error } }) })('claude-s')).toBeNull()
    }
    expect(warn).toHaveBeenCalledWith('[engine claude] last turn unavailable · ENGINE_BUSY')
    expect(warn).toHaveBeenCalledWith('[engine claude] last turn unavailable · ENGINE_UNAVAILABLE')
  } finally { warn.mockRestore() }
})
