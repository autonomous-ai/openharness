import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Native repair remains available while optional interpretation is missing or still loading.
 * The former-code golden pins the answers; these tests deliberately withhold all optional readers.
 */
const loader = vi.hoisted(() => ({ stalled: false, asked: [] as string[] }))
vi.mock('../engines/inProcess.js', () => ({ loadEngine: vi.fn(async (name: string) => {
  loader.asked.push(name)
  return loader.stalled ? new Promise(() => {}) : null
}) }))

const STARTED_AT = Date.parse('2026-10-08T09:00:00Z')
let CWD = ''
let piDirectory = ''
const UUID = '0b6f4f2e-6c1a-4c55-9a51-000000000001'
let root = ''
const saved: Record<string, string | undefined> = {}
let repair: typeof import('./sessionRepair.js')

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'repair-lazy-'))
  CWD = join(root, 'work'); mkdirSync(CWD)
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
  piDirectory = join(root, 'pi', 'agent', 'sessions', `--${CWD.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
  mkdirSync(piDirectory, { recursive: true })
  writeFileSync(join(piDirectory, '2026-10-09_abc123.jsonl'), JSON.stringify({ type: 'session', id: 'abc123', cwd: CWD }) + '\n')
  vi.resetModules()
  repair = await import('./sessionRepair.js')
})

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value
  rmSync(root, { recursive: true, force: true })
})

describe('session repair, independent of optional readers', () => {
  it.each(['missing', 'stalled'])('finds Muse and Pi identity while optional code is %s', async mode => {
    loader.stalled = mode === 'stalled'
    loader.asked.length = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([
        Promise.all([repair.findLiveSession('muse', CWD, STARTED_AT), repair.findResumedTranscript('pi', 'abc123', { cwd: CWD })]),
        new Promise(resolve => { timer = setTimeout(() => resolve('blocked on optional code'), 1000) }),
      ])
      expect(value).toEqual([{ sessionId: UUID, transcriptPath: join(root, 'muse', 'sessions', '2026', '10', '08', UUID, 'session.jsonl') },
        join(piDirectory, '2026-10-09_abc123.jsonl')])
      expect(loader.asked).toEqual([])
    } finally { clearTimeout(timer); loader.stalled = false }
  })

  it('loads nothing for Claude Code, Codex, or an engine whose files or stores it reads itself', async () => {
    loader.asked.length = 0
    await repair.findLiveSession('claude', CWD, STARTED_AT)
    await repair.findLiveSession('codex', CWD, STARTED_AT)
    await repair.findResumedTranscript('claude', UUID)
    await repair.findLiveSession('grok', CWD, STARTED_AT)
    await repair.findLiveSession('pi', CWD, STARTED_AT)
    await repair.findLiveSession('copilot', CWD, STARTED_AT, { pid: 4242 })
    // Hermes's homes are declared: its stores are read without its code.
    await repair.findLiveSession('hermes', CWD, STARTED_AT)
    expect(loader.asked).toEqual([])
  })
})
