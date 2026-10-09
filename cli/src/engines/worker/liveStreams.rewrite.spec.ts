import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { LivePage, LiveSession } from './liveProtocol.js'
import { LIVE_PREPARE, LIVE_READ } from './liveProtocol.js'
import { engineLiveRequests } from './liveRequests.js'

// A rewritten file past the history limit hydrates silently from the boundary instead of replaying. The
// limit is 32 MiB; here it is a few records, so the large path runs on a small file.
vi.mock('./liveProtocol.js', async (original) => ({ ...await original<typeof import('./liveProtocol.js')>(), LIVE_HISTORY_BYTES: 64 }))

const dirs: string[] = []
const who = { owner: true, local: true }
const prompt = (engine: string, text: string) => JSON.stringify(engine === 'claude'
  ? { type: 'user', message: { role: 'user', content: text } }
  : { type: 'event_msg', payload: { type: 'user_message', message: text } }) + '\n'
const done = (engine: string) => JSON.stringify(engine === 'claude'
  ? { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }
  : { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } }) + '\n'
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

it.each(['claude', 'codex'] as const)('%s: a large rewritten file hydrates up to where the read found the rewrite, and a turn appended since is live', async engine => {
  const dir = await mkdtemp(join(tmpdir(), 'engine-rewrite-')); dirs.push(dir)
  const file = join(dir, 'transcript.jsonl')
  await writeFile(file, prompt(engine, `original ${'x'.repeat(400)}`) + done(engine))
  const session: LiveSession = { agentId: 'agent', sessionId: 'session', engine, transcriptPath: file, cwd: dir, model: null, cliVersion: null, codexHome: dir }
  const worker = engineLiveRequests(engine)
  const ask = { version: 1, token: 'binding', session, cursor: null as LivePage['cursor'] | null, fromStart: false, replay: false }
  const page = async (extra: Record<string, unknown> = {}): Promise<LivePage> => {
    const reply = await worker[ask.cursor ? LIVE_READ : LIVE_PREPARE]({ ...ask, ...extra }, who) as { answer: LivePage }
    expect(reply.answer).toBeDefined()
    ask.cursor = reply.answer.cursor
    return reply.answer
  }
  await page()
  await writeFile(file, prompt(engine, `history ${'y'.repeat(200)}`) + done(engine))
  expect(await worker[LIVE_READ](ask, who)).toMatchObject({ error: 'ENGINE_TRANSCRIPT_CHANGED' })
  await appendFile(file, prompt(engine, 'fresh') + done(engine))

  ask.token = 'next'
  ask.cursor = null
  const turns: Array<[string, boolean]> = []
  let prepared = false
  for (let next = await page({ rewritten: true, rewrittenFrom: 'binding' }); ; next = await page({ rewritten: true, rewrittenFrom: 'binding' })) {
    expect(next.cursor.historyUntil).toBeUndefined()
    for (const frame of next.frames) for (const event of frame.events) if (event.type.startsWith('turn_')) turns.push([event.type, frame.replay])
    if (prepared && !next.frames.length) break
    prepared ||= next.prepared === true
  }
  // The history is folded silently; what was appended after the rewrite was found arrives as it would live.
  expect(turns).toEqual([['turn_started', false], ['turn_ended', false]])
})
