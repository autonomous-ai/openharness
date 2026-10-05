import { expect, it } from 'vitest'
import { hasMemoryForegroundActivity, MemorySessionRoster } from './hostSessions.js'
import { lineToEvents, newTurnState } from '../../../cli/src/lib/normalize.js'
import { CodexNormalizer } from '../../../cli/src/engines/codex/normalizer.js'

const session = { agentId: 'agent', engine: 'claude', sessionId: 'native', cwd: '/projects/code',
  transcriptPath: '/native/session.jsonl', registeredAt: 100 }
const no = () => false
it('admits coding processes and bundled coding DSHs while excluding other domains, subagents and home', () => {
  const roster = new MemorySessionRoster('/home/person')
  expect(roster.refresh([session], no, no)).toHaveLength(1)
  for (const change of [{ dsh: 'autonomous/roundtable' }, { dsh: 'autonomous/pair' }, { engine: 'terminal' },
    { cwd: '/home/person' }, { cwd: '/' }, { sessionId: '' }, { transcriptPath: null }]) {
    expect(roster.refresh([{ ...session, ...change }], no, no)).toEqual([])
  }
  expect(roster.refresh([{ ...session, dsh: 'autonomous/web-studio' }], no, no)).toHaveLength(1)
  expect(roster.refresh([session], no, () => true)).toEqual([])
})

it('retains a recently exited process long enough to capture its final native reply, without archive discovery', () => {
  let now = 1_000
  const roster = new MemorySessionRoster('/home/person', () => now)
  expect(roster.refresh([{ ...session, title: 'Parser fixes' }], () => true, no))
    .toMatchObject([{ present: true, name: 'Parser fixes' }])
  now += 10_000
  expect(roster.refresh([], no, no)).toMatchObject([{ sessionId: 'native', busy: false, present: false }])
  now += 120_001
  expect(roster.refresh([], no, no)).toEqual([])
})

it('preserves the host-observed fork boundary and replaces a rotated session instead of reusing its binding', () => {
  const roster = new MemorySessionRoster('/home/person')
  expect(roster.refresh([{ ...session, forkedFrom: { agentId: 'parent' } }], no, no)[0].liveFrom).toBe(100)
  expect(roster.refresh([{ ...session, sessionId: 'new_native' }], no, no)).toMatchObject([{ sessionId: 'new_native' }])
  expect(roster.refresh([session], no, no)[0].liveFrom).toBeUndefined()
})

it('uses personal scope only for the current verified collection conversation, not an archived companion', () => {
  const roster = new MemorySessionRoster('/home/person')
  const companion = { ...session, dsh: 'autonomous/pair' }
  expect(roster.refresh([companion], no, no)).toEqual([])
  expect(roster.refresh([companion], no, no, 'agent')).toMatchObject([{ scope: 'profile' }])
  expect(roster.refresh([], no, no, 'another_agent')).toEqual([])
})

it('binds OpenCode to the host database and includes only the verified collection conversation in personal scope', () => {
  const roster = new MemorySessionRoster('/home/person', Date.now, { opencode: '/native/opencode.db' })
  const companion = { ...session, engine: 'opencode', transcriptPath: null, dsh: 'autonomous/pair' }
  expect(roster.refresh([companion], no, no)).toEqual([])
  expect(roster.refresh([companion], no, no, 'agent')).toMatchObject([
    { engine: 'opencode', scope: 'profile', transcriptPath: '/native/opencode.db', sessionId: 'native' },
  ])
  expect(roster.refresh([{ ...companion, transcriptPath: '/model/supplied/path' }], no, no, 'agent')[0].transcriptPath)
    .toBe('/native/opencode.db')
  expect(roster.refresh([companion], no, () => true, 'agent')).toEqual([])
  expect(new MemorySessionRoster('/home/person').refresh([companion], no, no, 'agent')).toEqual([])
})

it('recognizes fresh requests in both native event formats without treating their streamed replies as new activity', () => {
  const claude = newTurnState()
  const user = lineToEvents(JSON.stringify({ type: 'user', uuid: 'question', message: { role: 'user', content: 'Fix the parser.' } }), claude)
  expect(hasMemoryForegroundActivity(user)).toBe(true)
  const reply = lineToEvents(JSON.stringify({ type: 'assistant', uuid: 'reply',
    message: { role: 'assistant', content: [{ type: 'text', text: 'I am checking the parser.' }] } }), claude)
  expect(reply.length).toBeGreaterThan(0)
  expect(hasMemoryForegroundActivity(reply)).toBe(false)
  const codex = new CodexNormalizer('live')
  expect(hasMemoryForegroundActivity(codex.ingest(JSON.stringify({ type: 'event_msg',
    payload: { type: 'user_message', message: 'Fix the parser.' } })))).toBe(true)
  const codexReply = codex.ingest(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Checking now.' } }))
  expect(codexReply.length).toBeGreaterThan(0)
  expect(hasMemoryForegroundActivity(codexReply)).toBe(false)
})

it('does not interrupt learning for replay, resume, compaction, tool traffic or completion events', () => {
  const prompt = [{ type: 'turn_started' as const }]
  expect(hasMemoryForegroundActivity(prompt, { replay: true })).toBe(false)
  expect(hasMemoryForegroundActivity(prompt, { resumed: true })).toBe(false)
  expect(hasMemoryForegroundActivity([{ type: 'user_message' }])).toBe(true)
  expect(hasMemoryForegroundActivity(['thinking_delta', 'text_delta', 'tool_start', 'tool_end', 'context_compact',
    'done', 'turn_ended', 'subagent_finished'].map(type => ({ type })) as Parameters<typeof hasMemoryForegroundActivity>[0])).toBe(false)
  expect(hasMemoryForegroundActivity([])).toBe(false)
})
