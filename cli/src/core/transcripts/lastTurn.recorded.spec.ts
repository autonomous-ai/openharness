import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { createLastTurnReader } from './lastTurn.js'

/**
 * Every file engine's last turn, read for real (no mocks) from a recorded session through the reader the
 * recap uses. Written before the reader moved behind the engine interface
 * (docs/design/2026-10-05-engine-interface.md, step 1) so the move had to keep every answer: the e2e suite
 * proves Claude Code and Codex, and these are the proof for the engines it has no fake for.
 */
const FIXTURES = join(__dirname, '../../lib/__fixtures__')
const recorded = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
/** Each engine's answer as the reader gave it on 2026-10-05, before the move. A change to an engine's
 *  reader that changes its answer updates this file in the same commit, on purpose. */
const ANSWERS = JSON.parse(recorded('last-turn-answers.json')) as Record<string, unknown>
const lines = (rows: readonly string[]): string => `${rows.join('\n')}\n`
const json = (value: unknown): string => JSON.stringify(value)

// Codex, in the record shapes engines/codex/lastTurn.spec.ts uses.
const codexEvent = (payload: unknown) => json({ type: 'event_msg', payload })
// Cursor, as engines/cursor/normalizer.spec.ts writes it.
const cursorUser = (text: string) => json({ role: 'user', message: { content: [{ type: 'text', text: `<timestamp>now</timestamp>\n<user_query>\n${text}\n</user_query>` }] } })
const cursorAssistant = (text: string) => json({ role: 'assistant', message: { content: [{ type: 'text', text }] } })
// pi and Command Code: lines from the real sessions their normalizer specs were recorded from.
const PI_CALL = 'chatcmpl-tool-873e31c30f939d10'
const PI = [
  '{"type":"session","version":3,"id":"019fa2a5-a26d-700c-bf8c-97af19ae3d5f","timestamp":"2026-07-27T08:16:31.854Z","cwd":"/tmp/pi-probe"}',
  '{"type":"message","id":"b0ecca48","parentId":"1da16955","message":{"role":"user","content":[{"type":"text","text":"list the files here"}]}}',
  `{"type":"message","id":"0fc9ca48","parentId":"b0ecca48","message":{"role":"assistant","content":[{"type":"toolCall","id":"${PI_CALL}","name":"bash","arguments":{"command":"ls"}}],"stopReason":"toolUse"}}`,
  `{"type":"message","id":"1a2b3c4d","parentId":"0fc9ca48","message":{"role":"toolResult","toolCallId":"${PI_CALL}","toolName":"bash","content":[{"type":"text","text":"a.txt\\nb.txt\\n"}],"isError":false}}`,
  '{"type":"message","id":"9f8e7d6c","parentId":"1a2b3c4d","message":{"role":"assistant","content":[{"type":"text","text":"DONE"}],"stopReason":"stop"}}',
]
const CC_CALL = 'call_00_U0MkyEAMP9Xu'
const COMMANDCODE = [
  '{"type":"session","version":3,"id":"34e1385f-c18a-4f54-bf12-f8f57e151a3d","timestamp":"2026-07-28T04:16:39.000Z","cwd":"/tmp/cc-probe"}',
  '{"type":"message","id":"59ec89ec","parentId":null,"timestamp":"t3","message":{"role":"user","content":[{"type":"text","text":"list the files"}],"meta":{"source":"user","messageId":"m3"}}}',
  `{"type":"message","id":"6c05e6e5","parentId":"59ec89ec","timestamp":"t4","message":{"role":"assistant","content":[{"type":"tool_use","id":"${CC_CALL}","name":"shell_command","input":{"command":"ls -1"}}],"meta":{"source":"model","messageId":"m4"}}}`,
  `{"type":"message","id":"72d9f290","parentId":"6c05e6e5","timestamp":"t5","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${CC_CALL}","content":[{"type":"text","text":"a.txt\\nb.txt"}]}],"meta":{"source":"tool","messageId":"m5"}}}`,
  '{"type":"message","id":"4c3052c4","parentId":"72d9f290","timestamp":"t6","message":{"role":"assistant","content":[{"type":"text","text":"a.txt and b.txt"}],"meta":{"source":"model","messageId":"m6"}}}',
]

const TRANSCRIPTS: Record<string, string> = {
  claude: recorded('transcript-async-subagents.jsonl'),
  codex: lines([
    codexEvent({ type: 'user_message', message: 'the old question' }),
    codexEvent({ type: 'agent_message', message: 'the old answer' }),
    codexEvent({ type: 'user_message', message: 'what changed?' }),
    codexEvent({ type: 'agent_message', message: 'Two files changed.', phase: 'final_answer' }),
  ]),
  cursor: lines([cursorUser('an earlier ask'), cursorAssistant('an earlier answer'), cursorUser('hi'), cursorAssistant('Hi, what next?')]),
  pi: lines(PI),
  commandcode: lines(COMMANDCODE),
  agy: recorded('agy-session.jsonl'),
  amp: recorded('amp-session.jsonl'),
  copilot: recorded('copilot-session.jsonl'),
  grok: recorded('grok-session.jsonl'),
  muse: recorded('muse-session.jsonl'),
}

const dir = mkdtempSync(join(tmpdir(), 'last-turn-recorded-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const sessions = Object.entries(TRANSCRIPTS).map(([engine, text]) => {
  const transcriptPath = join(dir, `${engine}.jsonl`)
  writeFileSync(transcriptPath, text)
  return { agentId: `${engine}-agent`, sessionId: `${engine}-session`, engine, transcriptPath } as RegisteredSession
})
const bySession = new Map(sessions.map((s) => [s.sessionId, s]))
const read = createLastTurnReader({
  bySession: (sessionId) => bySession.get(sessionId),
  // No file engine reads a store; these are never opened.
  dbs: { opencode: join(dir, 'none.db'), kilo: join(dir, 'none.db'), devin: join(dir, 'none.db') },
  hermesDb: async () => join(dir, 'none.db'),
})

describe('the last turn of every file engine, from a recorded session', () => {
  it('has an answer on file for every engine it reads', () => {
    expect(Object.keys(ANSWERS).sort()).toEqual(Object.keys(TRANSCRIPTS).sort())
  })

  it.each(Object.keys(TRANSCRIPTS))('%s', async (engine) => {
    expect(await read(`${engine}-session`)).toEqual(ANSWERS[engine])
  })
})
