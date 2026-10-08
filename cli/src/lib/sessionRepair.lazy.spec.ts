import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Repair reads the other engines' files with their own code, loaded when it is asked (engines/inProcess.ts). An
 * engine whose code could not be loaded has no repair answer, as when nothing is found; Claude Code's and Codex's
 * repair loads nothing. `sessionRepair.spec.ts` and `engines/otherIdentity.golden.spec.ts` pin the answers.
 */
const loader = vi.hoisted(() => ({ refused: new Set<string>(), asked: [] as string[] }))
vi.mock('../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../engines/inProcess.js')>()
  return {
    ...actual,
    loadEngine: vi.fn(async (name: Parameters<typeof actual.loadEngine>[0]) => {
      loader.asked.push(name)
      return loader.refused.has(name) ? null : actual.loadEngine(name)
    }),
  }
})

const STARTED_AT = Date.parse('2026-10-08T09:00:00Z')
const CWD = '/work/project'
const UUID = '0b6f4f2e-6c1a-4c55-9a51-000000000001'
let root = ''
const saved: Record<string, string | undefined> = {}
let repair: typeof import('./sessionRepair.js')

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'repair-lazy-'))
  const env = {
    MUSE_HOME: join(root, 'muse'), COPILOT_HOME: join(root, 'copilot'), HERMES_HOME: join(root, 'hermes'),
    AGY_HOME: join(root, 'agy'), PI_HOME: join(root, 'pi'), GROK_HOME: join(root, 'grok'), CLAUDE_PROJECTS_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'),
  }
  for (const [name, value] of Object.entries(env)) { saved[name] = process.env[name]; process.env[name] = value }
  // A muse conversation that repair binds when muse's code is there.
  const museDir = join(root, 'muse', 'sessions', '2026', '10', '08', UUID)
  mkdirSync(museDir, { recursive: true })
  const museFile = join(museDir, 'session.jsonl')
  writeFileSync(museFile, [
    JSON.stringify({ payload: { record: { workspace_root: CWD } } }),
    JSON.stringify({ payload: { kind: 'run', event: { kind: 'started', prompt: 'hi' } } }),
  ].join('\n') + '\n')
  utimesSync(museFile, new Date(STARTED_AT + 5_000), new Date(STARTED_AT + 5_000))
  vi.resetModules()
  repair = await import('./sessionRepair.js')
})

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  rmSync(root, { recursive: true, force: true })
})

describe('session repair, with the other engines\' code loaded when asked', () => {
  it('binds by the engine\'s own reader, loaded for that engine alone', async () => {
    loader.asked.length = 0
    expect(await repair.findLiveSession('muse', CWD, STARTED_AT)).toMatchObject({ sessionId: UUID })
    expect(loader.asked).toEqual(['muse'])
  })

  it('has no answer for an engine whose code could not be loaded', async () => {
    loader.refused = new Set(['muse', 'hermes', 'copilot', 'agy', 'pi'])
    try {
      expect(await repair.findLiveSession('muse', CWD, STARTED_AT)).toBeNull()
      expect(await repair.findLiveSession('hermes', CWD, STARTED_AT)).toBeNull()
      expect(await repair.findLiveSession('copilot', CWD, STARTED_AT, { pid: 4242 })).toBeNull()
      expect(await repair.findLiveSession('agy', CWD, STARTED_AT, { pid: 4242 })).toBeNull()
      await expect(repair.findResumedTranscript('pi', 'abc123', { cwd: CWD })).rejects.toThrow('The Pi conversation location is unavailable.')
    } finally { loader.refused = new Set() }
  })

  it('loads nothing for Claude Code, Codex, or an engine whose files it reads itself', async () => {
    loader.asked.length = 0
    await repair.findLiveSession('claude', CWD, STARTED_AT)
    await repair.findLiveSession('codex', CWD, STARTED_AT)
    await repair.findResumedTranscript('claude', UUID)
    await repair.findLiveSession('grok', CWD, STARTED_AT)
    await repair.findLiveSession('pi', CWD, STARTED_AT)
    expect(loader.asked).toEqual([])
  })
})
