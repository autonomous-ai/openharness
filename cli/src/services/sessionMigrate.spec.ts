import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentView } from '../core/api.js'
import { env } from '../config/env.js'
import { createSessionMigrate, productionMigrateDeps, type MigrateDeps } from './sessionMigrate.js'

vi.mock('../lib/engineProbe.js', () => ({ probeEngines: vi.fn(async (engines: string[]) => engines.map(engine => ({ engine, installed: true, signedIn: true }))) }))
vi.mock('../lib/loginShellEnv.js', async (original) => ({ ...await original<object>(), warmLoginShellEnvironment: vi.fn(async () => ({})) }))

/**
 * `agent_session_migrate`: the owner's alone, checked before anything is read; the agent's own vouched transcript
 * converted and written where the other engine resumes it; a code, and nothing else of a failure, on the wire.
 */
const OWNER = { owner: true }
const NEW_ID = '0b5a3c1e-7d2f-4e8a-9c61-2f4d8b7a1e90'
const NOW = Date.parse('2026-11-19T10:00:00.000Z')
let dir: string, cwd: string, transcript: string, claudeProjects: string, codexHome: string

const claudeLines = (sessionId: string) => [
  { type: 'user', uuid: 'u1', parentUuid: null, sessionId, cwd: '/w', entrypoint: 'cli', timestamp: '2026-11-18T09:00:00.000Z', message: { role: 'user', content: 'hello' } },
  { type: 'assistant', uuid: 'u2', parentUuid: 'u1', sessionId, cwd: '/w', entrypoint: 'cli', timestamp: '2026-11-18T09:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
].map(line => JSON.stringify(line)).join('\n') + '\n'

const agent = (over: Partial<AgentView> = {}) => ({ agentId: 'a1', engine: 'claude', sessionId: 'c1', cwd, transcriptPath: transcript, ...over }) as AgentView

function deps(over: Partial<MigrateDeps> = {}, conversations: Partial<MigrateDeps['conversations']> = {}): MigrateDeps {
  return {
    conversations: { resolve: vi.fn(async () => agent()), findTranscript: vi.fn(async () => null), transcriptOk: vi.fn(async () => true), ...conversations },
    probe: vi.fn(async () => ({ installed: true, signedIn: true })),
    home: vi.fn(async (engine) => engine === 'claude' ? claudeProjects : codexHome),
    now: () => NOW, newId: () => NEW_ID,
    ...over,
  }
}
const ask = (d: MigrateDeps, payload: Record<string, unknown> = { agentId: 'a1', targetEngine: 'codex' }, asker = OWNER) => createSessionMigrate(d)(payload, asker)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'session-migrate-'))
  cwd = join(dir, 'work'); mkdirSync(cwd)
  transcript = join(dir, 'source.jsonl'); writeFileSync(transcript, claudeLines('c1'))
  claudeProjects = join(dir, 'claude', 'projects'); codexHome = join(dir, 'codex')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('agent_session_migrate', () => {
  it('writes the conversation as a new Codex session in the home a new agent uses, and answers its id and folder', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {})
    const d = deps()
    expect(await ask(d, { agentId: 'a1', targetEngine: 'codex', cwd: '/elsewhere' })).toStrictEqual({ engine: 'codex', sessionId: NEW_ID, cwd })
    const day = join(codexHome, 'sessions', '2026', '11', String(new Date(NOW).getDate()).padStart(2, '0'))
    const [file] = readdirSync(day)
    expect(file).toMatch(new RegExp(`^rollout-.*-${NEW_ID}\\.jsonl$`))
    expect(JSON.parse(readFileSync(join(day, file!), 'utf8').split('\n')[0]!).payload).toMatchObject({ id: NEW_ID, cwd, source: 'cli' })
    expect(readFileSync(transcript, 'utf8')).toBe(claudeLines('c1'))
    expect(d.conversations.transcriptOk).toHaveBeenCalledWith('claude', transcript, null)
    expect(d.probe).toHaveBeenCalledWith('codex')
    expect(logged.mock.calls[0]![0]).toMatch(/^\[migrate\] claude → codex · \d+ bytes read · \d+ lines written · \d+ ms$/)
  })

  it('writes a Codex conversation into Claude Code\'s folder for its cwd, found by id when its bound path is not vouched', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const rollout = join(dir, 'rollout.jsonl')
    writeFileSync(rollout, [
      { timestamp: '2026-11-18T09:00:00.000Z', type: 'session_meta', payload: { id: 'x1', cwd: '/w', source: 'cli' } },
      { timestamp: '2026-11-18T09:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hey' } },
      { timestamp: '2026-11-18T09:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hey' }] } },
    ].map(line => JSON.stringify(line)).join('\n'))
    const transcriptOk = vi.fn(async (_engine: string, path: string) => path === rollout)
    const findTranscript = vi.fn(async () => rollout)
    const d = deps({}, { resolve: vi.fn(async () => agent({ engine: 'codex', sessionId: 'x1', transcriptPath: '/stale.jsonl', codexHome: '/profile' })), transcriptOk, findTranscript })
    expect(await ask(d, { agentId: 'a1', targetEngine: 'claude' })).toStrictEqual({ engine: 'claude', sessionId: NEW_ID, cwd })
    expect(findTranscript).toHaveBeenCalledWith('codex', 'x1', { codexHome: '/profile' })
    expect(transcriptOk).toHaveBeenCalledWith('codex', rollout, '/profile')
    const folder = join(claudeProjects, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    expect(readdirSync(folder)).toEqual([`${NEW_ID}.jsonl`])
  })

  it('is the owner\'s alone, and checks the agent and the engine before anything is read', async () => {
    const d = deps()
    expect(await ask(d, { agentId: 'a1', targetEngine: 'codex' }, { owner: false })).toStrictEqual({ error: 'OWNER_REQUIRED' })
    for (const [payload, error] of [
      [{ targetEngine: 'codex' }, 'MISSING_AGENT_ID'], [{ agentId: '', targetEngine: 'codex' }, 'MISSING_AGENT_ID'],
      [{ agentId: 'x'.repeat(201), targetEngine: 'codex' }, 'MISSING_AGENT_ID'],
      [{ agentId: 'a1', targetEngine: 'opencode' }, 'BAD_ENGINE'], [{ agentId: 'a1', targetEngine: 7 }, 'BAD_ENGINE'],
    ] as const) expect(await ask(d, payload)).toStrictEqual({ error })
    expect(d.conversations.resolve).not.toHaveBeenCalled()
  })

  it('refuses an agent it cannot move, by code, logging the code alone', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {})
    const refused = async (row: AgentView | null, target = 'codex') =>
      (await ask(deps({}, { resolve: vi.fn(async () => row) }), { agentId: 'a1/../x', targetEngine: target })).error
    expect(await refused(null)).toBe('UNKNOWN_AGENT')
    expect(await refused(agent({ engine: 'opencode' }))).toBe('BAD_ENGINE')
    expect(await refused(agent(), 'claude')).toBe('BAD_ENGINE')
    expect(await refused(agent({ sessionId: '' }))).toBe('NO_SESSION')
    expect(await refused(agent({ identityHold: 'unverified' }))).toBe('NO_SESSION')
    expect(await refused(agent({ cwd: null }))).toBe('NO_SESSION')
    expect(await refused(agent({ cwd: 'relative' }))).toBe('NO_SESSION')
    expect(await refused(agent({ cwd: join(dir, 'gone') }))).toBe('NO_SESSION')
    expect(await refused(agent({ transcriptPath: '/p/s/subagents/agent-1.jsonl' }))).toBe('NO_SESSION')
    expect(logged.mock.calls.map(([line]) => line)).toContain('[migrate] a1____x refused · UNKNOWN_AGENT')
  })

  it('reads only a transcript the core vouches for', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const unvouched = { transcriptOk: vi.fn(async () => false) }
    expect(await ask(deps({}, { ...unvouched, findTranscript: vi.fn(async () => null) }))).toStrictEqual({ error: 'NO_SESSION' })
    expect(await ask(deps({}, { ...unvouched, findTranscript: vi.fn(async () => transcript) }))).toStrictEqual({ error: 'NO_SESSION' })
    const subagent = deps({}, { resolve: vi.fn(async () => agent({ transcriptPath: null })), findTranscript: vi.fn(async () => '/p/s/subagents/agent-1.jsonl') })
    expect(await ask(subagent)).toStrictEqual({ error: 'NO_SESSION' })
    expect(subagent.conversations.transcriptOk).not.toHaveBeenCalled()
  })

  it('needs the other engine installed here and not signed out', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await ask(deps({ probe: vi.fn(async () => ({ installed: false })) }))).toStrictEqual({ error: 'TARGET_UNAVAILABLE' })
    expect(await ask(deps({ probe: vi.fn(async () => ({ installed: true, signedIn: false })) }))).toStrictEqual({ error: 'TARGET_UNAVAILABLE' })
    expect(await ask(deps({ probe: vi.fn(async () => { throw new Error('spawn') }) }))).toStrictEqual({ error: 'TARGET_UNAVAILABLE' })
    // A CLI that cannot say is let through, as the New dialog lets it.
    expect(await ask(deps({ probe: vi.fn(async () => ({ installed: true, signedIn: null })) }))).toMatchObject({ engine: 'codex' })
  })

  it('answers CONVERT_FAILED for a transcript too long, empty, or a session already there, and says only the kind', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await ask(deps({ maxBytes: 10 }))).toStrictEqual({ error: 'CONVERT_FAILED' })
    writeFileSync(transcript, '{"type":"summary","summary":"secret words"}\n')
    expect(await ask(deps())).toStrictEqual({ error: 'CONVERT_FAILED' })
    writeFileSync(transcript, claudeLines('c1'))
    const claudeTarget = deps({}, { resolve: vi.fn(async () => agent({ engine: 'codex' })) })
    writeFileSync(transcript, '{"timestamp":"2026-11-18T09:00:00.000Z","type":"session_meta","payload":{"id":"c1"}}\n'
      + '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"x"}]}}\n')
    const folder = join(claudeProjects, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, `${NEW_ID}.jsonl`), 'theirs\n')
    expect(await ask(claudeTarget, { agentId: 'a1', targetEngine: 'claude' })).toStrictEqual({ error: 'CONVERT_FAILED' })
    expect(readFileSync(join(folder, `${NEW_ID}.jsonl`), 'utf8')).toBe('theirs\n')
    expect(failed.mock.calls.map(([line]) => line)).toEqual(['[migrate] a1 failed: ConvertError', '[migrate] a1 failed: EEXIST'])
  })

  it('gives up at its deadline and writes nothing after it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    let release!: (row: AgentView) => void
    const resolve = vi.fn(() => new Promise<AgentView>(r => { release = r }))
    expect(await ask(deps({ deadlineMs: 5 }, { resolve }))).toStrictEqual({ error: 'TIMEOUT' })
    release(agent())
    await new Promise(r => setImmediate(r))
    expect(() => readdirSync(codexHome)).toThrow(/ENOENT/)
  })

  it('shares one conversion between a request and its retry', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const d = deps({ now: undefined, newId: undefined })
    const handler = createSessionMigrate(d)
    const [first, second] = await Promise.all([handler({ agentId: 'a1', targetEngine: 'codex' }, OWNER), handler({ agentId: 'a1', targetEngine: 'codex' }, OWNER)])
    expect(second).toBe(first)
    expect(first).toMatchObject({ engine: 'codex', sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(d.conversations.resolve).toHaveBeenCalledTimes(1)
  })
})

describe('the production facts', () => {
  it('probes with the New dialog\'s probe and writes where a launch made now looks', async () => {
    const d = productionMigrateDeps(deps().conversations)
    expect(await d.probe('codex')).toEqual({ engine: 'codex', installed: true, signedIn: true })
    vi.stubEnv('CODEX_HOME', '')
    vi.stubEnv('CLAUDE_CONFIG_DIR', '')
    expect(await d.home('codex')).toBe(env.CODEX_HOME)
    expect(await d.home('claude')).toBe(env.CLAUDE_PROJECTS_DIR)
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(dir, 'moved'))
    expect(await d.home('claude')).toBe(join(dir, 'moved', 'projects'))
  })
})
