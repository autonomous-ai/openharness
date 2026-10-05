import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendSocket } from './backendSocket.js'
import { codexMessagesToEvents, windowCodexLines } from './engines/codex/normalizer.js'
import { messagesToEvents, subagentStatsFromRawLines, windowRawLines } from './lib/normalize.js'
import { registry } from './lib/registry.js'
import { tailFile } from './lib/transcriptTail.js'
import { cl, claude, claudeScenario, codexScenario } from './testing/transcriptScenarios.js'

// Transcripts are only served from the engines' own folders. Those default to this computer's real
// ~/.claude and ~/.codex, so they are pointed at throwaway ones before the config is read.
const roots = vi.hoisted(() => {
  const base = `${process.env.TMPDIR || '/tmp'}/history-roots-${process.pid}-${Date.now()}`
  process.env.CLAUDE_PROJECTS_DIR = `${base}/claude-projects`
  process.env.CODEX_HOME = `${base}/codex`
  return { base, claude: process.env.CLAUDE_PROJECTS_DIR, codex: `${process.env.CODEX_HOME}/sessions` }
})
afterAll(() => rmSync(roots.base, { recursive: true, force: true }))

/**
 * `session_get` and `sessions_list` for Claude Code and Codex, through the socket: what a client
 * scrolling a thread gets is what the whole-file read gave it, page for page (lib/transcriptPages.ts).
 */
describe.each([
  ['claude', claudeScenario, windowRawLines, (lines: string[]) => messagesToEvents(lines)],
  ['codex', codexScenario, windowCodexLines, (lines: string[]) => codexMessagesToEvents(lines)],
] as const)('%s history through the socket', (engine, scenario, window, toEvents) => {
  let dir: string
  let socket: BackendSocket
  let frames: Array<{ type: string; payload: Record<string, any> }>
  let agentId: string
  let sessionId: string
  let file: string
  let pane = 7400

  beforeEach(() => {
    const root = engine === 'claude' ? roots.claude : roots.codex
    mkdirSync(root, { recursive: true })
    dir = mkdtempSync(join(root, 'history-'))
    file = join(dir, 'transcript.jsonl')
    writeFileSync(file, scenario().join('\n') + '\n')
    socket = new BackendSocket('fixture')
    frames = []
    socket.registerLocalClient('local:history', { sendFrame: (frame) => { frames.push(frame as never); return true }, sendBinary: () => true })
    const paneId = `%${++pane}`
    agentId = registry.openPendingAgent({ engine, runtimes: [{ backend: 'tmux', paneId }], cwd: dir })!.agentId
    sessionId = `${engine}-history-${pane}`
    registry.register({ engine, sessionId, transcriptPath: file, tmuxPane: paneId, cwd: dir })
  })

  afterEach(async () => {
    registry.removeAgent(agentId)
    await socket.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  let requests = 0
  async function ask(type: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
    const requestId = `r${++requests}`
    await (socket as any).dispatchDown({ type, payload: { requestId, ...payload } }, 'local:history', 'local')
    return frames.find((frame) => frame.type === `${type}_result` && frame.payload.requestId === requestId)!.payload
  }

  it('is bound to the transcript under test', () => {
    expect(registry.resolve(sessionId)?.transcriptPath).toBe(file)
  })

  it('pages back through the thread exactly as the whole-file read did, cursor for cursor', async () => {
    const lines = await tailFile(file, Infinity)
    for (const limit of [1, 4, 500]) {
      let before: string | undefined
      for (let page = 0; page < lines.length + 1; page++) {
        const reply = await ask('session_get', { sessionId, limit, before })
        const old = window(lines, { limit, before })
        const events = toEvents(old.window)
        if (before && events[events.length - 1]?.type === 'done') events.pop()
        expect(reply.events, `limit ${limit}, page ${page}`).toEqual(JSON.parse(JSON.stringify(events)))
        expect({ hasMore: reply.hasMore, oldestCursor: reply.oldestCursor }).toEqual({ hasMore: old.hasMore, oldestCursor: old.oldestCursor })
        if (!old.hasMore || !old.oldestCursor) break
        before = old.oldestCursor
      }
    }
  })

  it('answers a request with no limit with the whole thread, in the reply it always had', async () => {
    const reply = await ask('session_get', { sessionId, before: 'ignored without a limit' })
    expect(reply.events).toEqual(JSON.parse(JSON.stringify(toEvents(await tailFile(file, Infinity)))))
    expect(reply).not.toHaveProperty('hasMore')
    expect(reply).not.toHaveProperty('oldestCursor')
  })

  it('says a cursor it cannot find is stale, so the client reloads', async () => {
    const reply = await ask('session_get', { sessionId, limit: 5, before: 'not-a-cursor-in-this-file' })
    expect(reply).toMatchObject({ events: [], hasMore: false, oldestCursor: null, staleCursor: true })
  })

  it('totals a sub-agent from its own transcript, read a line at a time', async () => {
    if (engine !== 'claude') return
    const launch = cl({ type: 'assistant', message: { id: 'mt', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: 'look around' } }], stop_reason: 'tool_use' } })
    const result = cl({
      type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_task', content: 'launched' }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent7' },
    })
    writeFileSync(file, [claude.user('send a helper'), launch, result].join('\n') + '\n')
    const sub = [
      JSON.stringify({ type: 'user', timestamp: '2026-10-04T10:00:00.000Z', message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-04T10:00:05.000Z', message: { content: [{ type: 'tool_use', id: 'a' }, { type: 'tool_use', id: 'b' }], usage: { input_tokens: 10, output_tokens: 5 } } }),
      '',
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-04T10:01:00.000Z', message: { content: [{ type: 'tool_use', id: 'c' }], usage: { cache_read_input_tokens: 7 } } }),
    ]
    mkdirSync(join(dir, 'transcript', 'subagents'), { recursive: true })
    writeFileSync(join(dir, 'transcript', 'subagents', 'agent-agent7.jsonl'), sub.join('\r\n'))
    const reply = await ask('session_get', { sessionId, limit: 50 })
    const end = reply.events.find((event: { type: string; payload: { subagent?: unknown } }) => event.type === 'tool_end' && event.payload.subagent)
    expect(end.payload.subagent).toMatchObject({ agentId: 'agent7', ...subagentStatsFromRawLines(sub) })
    expect(end.payload.subagent).toMatchObject({ totalToolUseCount: 3, totalDurationMs: 60_000, totalTokens: 22 })
    // Totals the launch already reported stand; only what it left out is filled in.
    const reported = cl({
      type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_task', content: 'launched' }] },
      toolUseResult: { agentId: 'agent7', totalDurationMs: 5, totalTokens: 9 },
    })
    writeFileSync(file, [claude.user('send a helper'), launch, reported].join('\n') + '\n')
    const again = await ask('session_get', { sessionId, limit: 50 })
    const kept = again.events.find((event: { type: string; payload: { subagent?: unknown } }) => event.type === 'tool_end' && event.payload.subagent)
    expect(kept.payload.subagent).toMatchObject({ agentId: 'agent7', totalToolUseCount: 3, totalDurationMs: 5, totalTokens: 9 })
  })

  it('answers for a transcript that is gone as for an empty one', async () => {
    rmSync(file)
    const reply = await ask('session_get', { sessionId, limit: 5 })
    // What the whole-file read made of the empty history it read there: no lines, then the end marker.
    expect(reply.events).toEqual(JSON.parse(JSON.stringify(toEvents([]))))
    expect(reply).toMatchObject({ hasMore: false, oldestCursor: window([], { limit: 5 }).oldestCursor })
    expect(Date.parse(reply.timestamp)).toBeGreaterThan(Date.now() - 60_000)
  })

  it('counts the thread without reading it whole', async () => {
    const reply = await ask('sessions_list', { agentId })
    expect(reply.sessions).toHaveLength(1)
    expect(reply.sessions[0]).toMatchObject({ id: sessionId, messageCount: (await tailFile(file, Infinity)).length })
  })

  it('counts nothing for an agent whose engine keeps no transcript file', async () => {
    const paneId = `%${++pane}`
    const store = registry.openPendingAgent({ engine: 'opencode', runtimes: [{ backend: 'tmux', paneId }], cwd: dir })!.agentId
    try {
      registry.register({ engine: 'opencode', sessionId: `ses_history${pane}`, tmuxPane: paneId, cwd: dir })
      const reply = await ask('sessions_list', { agentId: store })
      expect(reply.sessions).toEqual([expect.objectContaining({ id: `ses_history${pane}`, messageCount: 0 })])
    } finally { registry.removeAgent(store) }
  })
})
