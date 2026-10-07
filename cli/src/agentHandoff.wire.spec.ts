// agent_handoff_prepare end to end on the daemon side: the real socket case (backendSocket.ts) with the
// real provider (lib/agentHandoff.ts) wired the way cli.ts wires it. The unit specs fake one side each;
// this one pins the seam the desktop depends on (desktop/lib/state/agent_handoff_file.dart
// `acceptAgentHandoffReply`): the reply's `file` is exactly `.harness/handoff/<sanitized agent id>-<change
// id>.md`, `cwd` is the registry's string as-is (the desktop compares it to its own folder string), and
// the provider's error codes reach the wire as `{error}`.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BackendSocket } from './backendSocket.js'
import { relaySocket } from './testing/relaySocket.js'
import { bindHandoffRequest } from './testing/socketCore.js'
import { prepareAgentHandoff, type HandoffDeps } from './lib/agentHandoff.js'
import { CommanderMirror } from './lib/commander.js'
import { handoffProviderDeps, type HandoffWiring } from './lib/handoffDiscovery.js'
import type { LiveEvent } from './lib/normalize.js'
import type { RegisteredSession } from './lib/registry.js'

type Frame = { type: string; payload: Record<string, unknown> }

const CHANGE = '0123456789abcdef0123456789abcdef'
const OTHER = 'fedcba9876543210fedcba9876543210'
const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

let root: string
let ws: string
let socket: BackendSocket
let frames: Frame[]

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-wire-')))
  ws = join(root, 'ws')
  mkdirSync(ws)
  socket = relaySocket('token')
  frames = []
  socket.registerLocalClient('local:w', { sendFrame: (frame) => { frames.push(frame as Frame); return true }, sendBinary: () => true })
})
afterEach(async () => {
  await socket.unregisterLocalClient('local:w')
  await socket.stop()
  rmSync(root, { recursive: true, force: true })
})

const git = (...args: string[]) => execFileSync('git', ['-C', ws, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { env: gitEnv })

function makeRepo(): void {
  git('init', '-q', '-b', 'main')
  writeFileSync(join(ws, 'a.txt'), 'v1\n')
  git('add', '.')
  git('commit', '-q', '-m', 'initial')
}

function transcript(): string {
  const path = join(root, 'tx.jsonl')
  const at = (m: number) => `2026-09-20T10:0${m}:00.000Z`
  writeFileSync(path, [
    JSON.stringify({ type: 'user', uuid: 'u0', timestamp: at(0), message: { role: 'user', content: 'Fix the login bug' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }], stop_reason: 'end_turn' } }),
  ].join('\n') + '\n')
  return path
}

const session = (over: Record<string, unknown> = {}): RegisteredSession => ({
  agentId: 'agent-1', sessionId: 'sess-1', engine: 'claude', cwd: ws, transcriptPath: transcript(),
  registeredAt: Date.now() - 60_000, projectDir: 'ws', ...over,
}) as unknown as RegisteredSession

/**
 * The provider's deps built by the very factory cli.ts calls (`handoffProviderDeps`), over fakes of the real
 * functions: a swapped argument between them shows here. `over` replaces single deps afterwards (a deadline, a
 * reader); `fakes` replaces a function the factory is built from.
 */
function wire(sessions: RegisteredSession[], over: Partial<HandoffDeps> = {}, fakes: Partial<HandoffWiring> = {}): void {
  const deps = handoffProviderDeps({
    // As cli.ts's registry: `resolve` answers by agent id or session id, so the file is named by the resolved agent id.
    registry: {
      resolve: (id) => sessions.find((s) => s.agentId === id || (!!s.sessionId && s.sessionId === id)) ?? null,
      byAgent: (id) => sessions.find((s) => s.agentId === id),
      bySession: (sid) => (sid ? sessions.find((s) => s.sessionId === sid) : undefined),
    },
    stopped: { get: () => null, ids: () => [] },
    mirror: { recentAsks: () => [], lastFullText: () => undefined, recent: () => [] },
    databaseHistory: () => undefined,
    findLiveSession: async () => null,
    claudeProcessSession: async () => null,
    isRecentlyDeleted: () => false,
    findResumedTranscript: async () => null,
    validTranscriptPath: (_engine, path) => existsSync(path),
    ...fakes,
  })
  bindHandoffRequest(socket, (req) => prepareAgentHandoff({ ...deps, ...over }, req))
}

const ask = (requestId: string, agentId: string, changeId = CHANGE): void =>
  socket.handleLocalFrame('local:w', { type: 'agent_handoff_prepare', payload: { requestId, agentId, changeId, targetEngine: 'codex' } })
const reply = async (requestId: string): Promise<Record<string, unknown>> => {
  let found: Record<string, unknown> | undefined
  await expect.poll(() => (found = frames.find((f) => f.type === 'agent_handoff_prepare_result' && f.payload.requestId === requestId)?.payload), { timeout: 8_000 }).toBeDefined()
  return found!
}

describe('agent_handoff_prepare, socket + real provider', () => {
  it('replies with the path the desktop computes itself and writes it there', async () => {
    makeRepo()
    // A ':' is not path-safe: the desktop's vectors map it to '_' (agent_handoff_file_test.dart).
    wire([session({ agentId: 'agent:1' })])
    ask('r1', 'agent:1')
    const r = await reply('r1')
    expect(r).toEqual({ requestId: 'r1', agentId: 'agent:1', file: `.harness/handoff/agent_1-${CHANGE}.md`, gitRepo: true, cwd: ws, degraded: [] })
    expect(existsSync(join(ws, '.harness', 'handoff', `agent_1-${CHANGE}.md`))).toBe(true)
    expect(existsSync(join(ws, '.harness', 'handoff', `agent_1-${CHANGE}.transcript.md`))).toBe(true)
  })

  it('reports the registry cwd string as-is, not its resolved path (the desktop compares strings)', async () => {
    const alias = join(root, 'alias')
    symlinkSync(ws, alias)
    wire([session({ cwd: alias })])
    ask('r1', 'agent-1')
    const r = await reply('r1')
    expect(r.cwd).toBe(alias)
    expect(r.file).toBe(`.harness/handoff/agent-1-${CHANGE}.md`)
    expect(r.gitRepo).toBe(false)
    expect(r.degraded).toEqual(['git'])
  })

  it('answers a retry of the same change with the same file, written once', async () => {
    wire([session()])
    ask('r1', 'agent-1')
    const first = await reply('r1')
    ask('r2', 'agent-1')
    const second = await reply('r2')
    expect(second.file).toBe(first.file)
    expect(readdirSync(join(ws, '.harness', 'handoff')).filter((n) => n.endsWith('.md')).sort())
      .toEqual([`agent-1-${CHANGE}.md`, `agent-1-${CHANGE}.transcript.md`])
  })

  it('carries UNKNOWN_AGENT and NO_PROJECT as error codes', async () => {
    wire([session({ agentId: 'gone-cwd', cwd: join(root, 'missing') })])
    ask('r1', 'nobody')
    ask('r2', 'gone-cwd')
    expect(await reply('r1')).toEqual({ requestId: 'r1', error: 'UNKNOWN_AGENT' })
    expect(await reply('r2')).toEqual({ requestId: 'r2', error: 'NO_PROJECT' })
  })

  it('carries BUSY for a second change of an agent still being prepared, and TIMEOUT without writing', async () => {
    // A database engine whose history never arrives holds the first preparation until its deadline.
    const hung = new Promise<readonly LiveEvent[]>(() => {})
    wire([session({ engine: 'opencode', transcriptPath: null })], { readHistory: () => () => hung, deadlineMs: 300 })
    ask('r1', 'agent-1', CHANGE)
    ask('r2', 'agent-1', OTHER)
    expect(await reply('r2')).toEqual({ requestId: 'r2', error: 'BUSY' })
    expect(await reply('r1')).toEqual({ requestId: 'r1', error: 'TIMEOUT' })
    expect(existsSync(join(ws, '.harness'))).toBe(false)
  })

  it('hands over the stored recaps of a real mirror, with cli.ts\'s own deps, when the transcript is gone', async () => {
    // The mirror as the daemon keeps it on disk: recaps newest first, no asks, no full answer. Without the
    // `recaps` dep this agent had "nothing to hand off" (file null) though the old prompt path would send them.
    const dataDir = join(root, 'data')
    mkdirSync(dataDir)
    writeFileSync(join(dataDir, 'summaries-history.json'), JSON.stringify({
      'sess-1': ['Retry added to fetchUser, token=abcdefgh1234 used\n\nAdded a retry with backoff.', 'README updated\n\nRewrote the setup section.'],
    }))
    const mirror = new CommanderMirror({ send: () => {}, sendWeb: () => {}, hasDevice: () => false, summarize: async () => null, dataDir })
    // The mirror goes through the same factory cli.ts uses, so its recaps arrive by the dep cli.ts wires.
    wire([session({ transcriptPath: join(root, 'missing.jsonl') })], {}, { mirror })
    ask('r1', 'agent-1')
    const r = await reply('r1')
    expect(r).toEqual({ requestId: 'r1', agentId: 'agent-1', file: `.harness/handoff/agent-1-${CHANGE}.md`, gitRepo: false, cwd: ws, degraded: ['transcript', 'git'] })
    const md = readFileSync(join(ws, '.harness', 'handoff', `agent-1-${CHANGE}.md`), 'utf8')
    const last = md.slice(md.indexOf('## Last answer'), md.indexOf('## Recent activity'))
    expect(last).toContain('Retry added to fetchUser')
    expect(md).not.toContain('abcdefgh1234')
    expect(readFileSync(join(ws, '.harness', 'handoff', `agent-1-${CHANGE}.transcript.md`), 'utf8')).toContain('README updated')
  })

  it('answers with no file when the agent has said nothing yet', async () => {
    const empty = join(root, 'empty.jsonl')
    writeFileSync(empty, '')
    wire([session({ transcriptPath: empty })])
    ask('r1', 'agent-1')
    expect(await reply('r1')).toEqual({ requestId: 'r1', agentId: 'agent-1', file: null, gitRepo: false, cwd: ws, degraded: [] })
    expect(existsSync(join(ws, '.harness'))).toBe(false)
  })
})

describe('agent_handoff_prepare, socket + real provider: hostile text (R2S1)', () => {
  /** A Claude transcript of one request and one answer, as given. */
  function talk(ask: string, answer: string): string {
    const path = join(root, 'hostile.jsonl')
    writeFileSync(path, [
      JSON.stringify({ type: 'user', uuid: 'u0', timestamp: '2026-09-20T10:00:00.000Z', message: { role: 'user', content: ask } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: '2026-09-20T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' } }),
    ].join('\n') + '\n')
    return path
  }

  it('answers within the deadline, never holding the thread, on a 30 000-character `?key` run in a commit subject, a request and an answer', async () => {
    makeRepo()
    const run = '?key'.repeat(7_500)
    writeFileSync(join(ws, 'b.txt'), 'b\n')
    git('add', 'b.txt')
    // Before the run cap, this subject alone held the daemon for minutes inside the redaction.
    git('commit', '-q', '-m', `?token=hunter2secretvalue${run}`)
    // The production deadline (5 s): a TIMEOUT here means the redaction ate it.
    wire([session({ transcriptPath: talk(`please ${run}`, `done ${run}`) })], { lastFullText: () => `done ${run}` })
    let worst = 0
    let last = performance.now()
    const probe = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now }, 5)
    const started = performance.now()
    let r: Record<string, unknown>
    try {
      ask('r1', 'agent-1')
      r = await reply('r1')
    } finally { clearInterval(probe) }
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(worst).toBeLessThan(1_000)
    expect(r).toEqual({ requestId: 'r1', agentId: 'agent-1', file: `.harness/handoff/agent-1-${CHANGE}.md`, gitRepo: true, cwd: ws, degraded: [] })
    const md = readFileSync(join(ws, '.harness', 'handoff', `agent-1-${CHANGE}.md`), 'utf8')
    const transcriptFile = readFileSync(join(ws, '.harness', 'handoff', `agent-1-${CHANGE}.transcript.md`), 'utf8')
    expect(md).toContain('characters omitted')
    expect(md).not.toContain('?key?key?key?key')
    expect(md).not.toContain('hunter2secretvalue')
    expect(transcriptFile).not.toContain('?key?key?key?key')
    expect(md.length).toBeLessThan(60_000)
  }, 20_000)

  it('writes no secret whose label ended a run the cap swallowed, in either file', async () => {
    const blob = 'QUJD'.repeat(150)
    wire([session({ transcriptPath: talk(`config: {"blob":"${blob}","password": "hunter2secretvalue"}`, 'Noted.') })])
    ask('r1', 'agent-1')
    expect((await reply('r1')).file).toBe(`.harness/handoff/agent-1-${CHANGE}.md`)
    for (const name of [`agent-1-${CHANGE}.md`, `agent-1-${CHANGE}.transcript.md`]) {
      expect(readFileSync(join(ws, '.harness', 'handoff', name), 'utf8')).not.toContain('hunter2secretvalue')
    }
  })

  it('writes no secret after a label that ended a swallowed run, in a request or an answer, and keeps the label', async () => {
    const blob = 'QUJD'.repeat(150)
    const shapes = [`${blob}password: hunter2secretvalue`, `${blob}&api_key= hunter2secretvalue`, `x${blob}Bearer hunter2secretvalue`]
    wire([session({ transcriptPath: talk(`see ${shapes.join(' and ')}`, `ok ${shapes.join(' and ')}`) })], { lastFullText: () => `ok ${shapes.join(' and ')}` })
    ask('r1', 'agent-1')
    expect((await reply('r1')).file).toBe(`.harness/handoff/agent-1-${CHANGE}.md`)
    for (const name of [`agent-1-${CHANGE}.md`, `agent-1-${CHANGE}.transcript.md`]) {
      const text = readFileSync(join(ws, '.harness', 'handoff', name), 'utf8')
      expect(text, name).not.toContain('hunter2secretvalue')
      expect(text, name).not.toContain('QUJDQUJD')
      expect(text, name).toContain('password: <redacted>')
      expect(text, name).toContain('Bearer <redacted>')
    }
  })
})

describe('agent_handoff_prepare, socket + real provider: a fork that has not answered yet (A2/A3)', () => {
  const T0 = Date.parse('2026-09-20T10:00:00.000Z')
  const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString()
  /** A Claude transcript: `Fix the login bug` at 0 s, its answer at 5 s, then `later` at 30 s. */
  function parentFile(name: string, later: string): string {
    const path = join(root, name)
    writeFileSync(path, [
      JSON.stringify({ type: 'user', uuid: 'u0', timestamp: at(0), message: { role: 'user', content: 'Fix the login bug' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: at(5), message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }], stop_reason: 'end_turn' } }),
      JSON.stringify({ type: 'user', uuid: 'u2', timestamp: at(30), message: { role: 'user', content: later } }),
      JSON.stringify({ type: 'assistant', uuid: 'a3', timestamp: at(35), message: { role: 'assistant', content: [{ type: 'text', text: 'Done later.' }], stop_reason: 'end_turn' } }),
    ].join('\n') + '\n')
    return path
  }
  const parent = (over: Record<string, unknown> = {}): RegisteredSession => session({
    agentId: 'parent-1', sessionId: 'sp-1', transcriptPath: parentFile('parent.jsonl', 'POST-FORK ask'), registeredAt: T0 - 3_600_000, boundAt: T0 - 60_000, ...over,
  })
  const fork = (over: Record<string, unknown> = {}): RegisteredSession => session({
    agentId: 'fork-1', sessionId: '', transcriptPath: null, registeredAt: T0 + 10_000, boundAt: null,
    forkedFrom: { agentId: 'parent-1', name: 'Parent agent' }, ...over,
  })
  const md = (): string => readFileSync(join(ws, '.harness', 'handoff', `fork-1-${CHANGE}.md`), 'utf8')
  /** A live Claude pane that has not found its session: the process the daemon identifies it by. */
  const unbound = (agentId: string, over: Record<string, unknown> = {}): RegisteredSession =>
    session({ agentId, sessionId: '', transcriptPath: null, processIdentity: { pid: 4242, executable: 'claude', startMarker: 'Fri Oct  2 16:58:26 2026' }, ...over })

  it('W1: a legacy fork switched at once gets its parent\'s conversation up to the fork', async () => {
    const findLiveSession = vi.fn(async () => null)
    const claudeProcessSession = vi.fn(async () => null)
    wire([parent(), fork()], {}, { findLiveSession, claudeProcessSession })
    ask('r1', 'fork-1')
    expect(await reply('r1')).toEqual({ requestId: 'r1', agentId: 'fork-1', file: `.harness/handoff/fork-1-${CHANGE}.md`, gitRepo: false, cwd: ws, degraded: ['git'] })
    expect(md()).toContain('Fix the login bug')
    expect(md()).not.toContain('POST-FORK ask')
    expect(md()).toContain('`Parent agent`')
    expect(findLiveSession).not.toHaveBeenCalled()
    expect(claudeProcessSession).not.toHaveBeenCalled()
  })

  it('W2: a recorded session is read after the parent moved to another one, never the parent\'s current one', async () => {
    // The recorded file names its session, as Claude's do.
    const dir = join(root, 'projects')
    mkdirSync(dir)
    const oldFile = join(dir, 'sp-1.jsonl')
    writeFileSync(oldFile, readFileSync(parentFile('seed.jsonl', 'POST-FORK ask')))
    const moved = parent({ sessionId: 'sp-2', transcriptPath: parentFile('new.jsonl', 'NEW-SESSION ask'), boundAt: T0 + 20_000 })
    wire([moved, fork({ forkedFrom: { agentId: 'parent-1', name: 'Parent agent', sessionId: 'sp-1', transcriptPath: oldFile } })])
    ask('r1', 'fork-1')
    expect((await reply('r1')).file).toBe(`.harness/handoff/fork-1-${CHANGE}.md`)
    expect(md()).toContain('Fix the login bug')
    expect(md()).not.toContain('POST-FORK ask')
    expect(md()).not.toContain('NEW-SESSION ask')
  })

  it('W3: a legacy fork whose parent was bound after the fork inherits nothing', async () => {
    wire([parent({ boundAt: T0 + 20_000 }), fork()])
    ask('r1', 'fork-1')
    expect(await reply('r1')).toEqual({ requestId: 'r1', agentId: 'fork-1', file: null, gitRepo: false, cwd: ws, degraded: ['transcript'] })
    expect(existsSync(join(ws, '.harness'))).toBe(false)
  })

  it('W4: an unbound agent that is not a fork is handed the session the daemon found for it', async () => {
    const found = parentFile('found.jsonl', 'later ask')
    const claudeProcessSession = vi.fn(async () => ({ sessionId: 'sx', transcriptPath: found }))
    wire([unbound('fork-1')], {}, { claudeProcessSession })
    ask('r1', 'fork-1')
    expect((await reply('r1')).file).toBe(`.harness/handoff/fork-1-${CHANGE}.md`)
    expect(claudeProcessSession).toHaveBeenCalledTimes(1)
    expect(claudeProcessSession).toHaveBeenCalledWith(4242, ws, Date.parse('Fri Oct  2 16:58:26 2026'))
    expect(md()).toContain('Fix the login bug')
  })
  // Verifier additions (unit-INT-a3-r1): discovery refusals through the real provider and socket.
  const nothing = (agentId: string) => ({ requestId: 'r1', agentId, file: null, gitRepo: false, cwd: ws, degraded: ['transcript'] })
  it('W5: a discovered session another agent holds is never handed over', async () => {
    const other = session({ agentId: 'other-1', sessionId: 'sx', transcriptPath: parentFile('other.jsonl', 'OTHER ask') })
    const claudeProcessSession = vi.fn(async () => ({ sessionId: 'sx', transcriptPath: other.transcriptPath! }))
    wire([unbound('new-1'), other], {}, { claudeProcessSession })
    ask('r1', 'new-1')
    expect(await reply('r1')).toEqual(nothing('new-1'))
    expect(claudeProcessSession).toHaveBeenCalledTimes(1)
    expect(existsSync(join(ws, '.harness'))).toBe(false)
  })

  it('W6: a discovered subagent transcript of another session is never handed over', async () => {
    const dir = join(root, 'sp-1', 'subagents')
    mkdirSync(dir, { recursive: true })
    const sub = join(dir, 'agent-a.jsonl')
    writeFileSync(sub, readFileSync(parentFile('sub-seed.jsonl', 'SUBAGENT ask')))
    wire([unbound('new-1')], {}, { claudeProcessSession: async () => ({ sessionId: 'agent-a', transcriptPath: sub }) })
    ask('r1', 'new-1')
    expect(await reply('r1')).toEqual(nothing('new-1'))
    expect(existsSync(join(ws, '.harness'))).toBe(false)
  })

  it('W7: a fork whose record is malformed is neither discovered nor inherited', async () => {
    const claudeProcessSession = vi.fn(async () => ({ sessionId: 'sx', transcriptPath: parentFile('found.jsonl', 'later ask') }))
    wire([parent(), fork({ forkedFrom: 'parent-1', processIdentity: { pid: 4242, executable: 'claude', startMarker: 'Fri Oct  2 16:58:26 2026' } })], {}, { claudeProcessSession })
    ask('r1', 'fork-1')
    expect(await reply('r1')).toEqual(nothing('fork-1'))
    expect(claudeProcessSession).not.toHaveBeenCalled()
  })

  it('W8: a discovery that never answers does not hold the reply, and a later change reuses the search still running', async () => {
    const claudeProcessSession = vi.fn(() => new Promise<null>(() => {}))
    wire([unbound('new-1')], { discoverMs: 50 }, { claudeProcessSession })
    ask('r1', 'new-1')
    expect(await reply('r1')).toEqual(nothing('new-1'))
    ask('r2', 'new-1', OTHER)
    expect(await reply('r2')).toEqual({ ...nothing('new-1'), requestId: 'r2' })
    // The deps are built once per provider, so the second request meets the first one's search.
    expect(claudeProcessSession).toHaveBeenCalledTimes(1)
  })

  it('W9: a discovered session is never handed over while one stopped record cannot be read (ownership fails closed)', async () => {
    const claudeProcessSession = vi.fn(async () => ({ sessionId: 'sx', transcriptPath: parentFile('found.jsonl', 'later ask') }))
    const stopped = { ids: () => ['ok-1', 'bad-1'], get: (id: string) => { if (id === 'bad-1') throw new Error('Could not read the saved stopped harness.'); return { agentId: id, sessionId: 'other' } as unknown as RegisteredSession } }
    wire([unbound('new-1')], {}, { claudeProcessSession, stopped })
    ask('r1', 'new-1')
    expect(await reply('r1')).toEqual(nothing('new-1'))
    expect(claudeProcessSession).toHaveBeenCalledTimes(1)
  })

  it('W10: a Claude pane with no process identity is not searched for at all', async () => {
    const claudeProcessSession = vi.fn(async () => ({ sessionId: 'sx', transcriptPath: parentFile('found.jsonl', 'later ask') }))
    wire([unbound('new-1', { processIdentity: null })], {}, { claudeProcessSession })
    ask('r1', 'new-1')
    expect(await reply('r1')).toEqual(nothing('new-1'))
    expect(claudeProcessSession).not.toHaveBeenCalled()
  })
})
