/**
 * Hooks that arrive while their session is still being admitted, on the real daemon: Claude Code on Windows announces
 * SessionStart before its transcript exists (2-3 s measured, CLI 0.6.89), so the daemon holds that admission until the
 * file is there, and a prompt the person typed meanwhile sends its Stop to a session not bound yet. The Stop waits
 * behind the admission and runs once the session is bound (core/engines/sessionHookWait.ts, hookServer.ts), instead of
 * being refused as unbound. The fake engine's `lateTranscript` keeps the transcript back until the test releases it
 * (fakeEngine.mjs).
 */
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { fakeEngineShim, IsolatedDaemon, until } from './harness/daemon.js'
import { sid } from '../src/lib/log.js'

const rows = async (client: LocalClient) =>
  (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
const users = async (client: LocalClient, sessionId: string): Promise<string[]> => {
  const page = await client.request<{ events?: Array<{ type: string; payload: Record<string, any> }>; error?: string }>('session_get', { sessionId, limit: 200 }, 30_000)
  expect(page.error, JSON.stringify(page)).toBeUndefined()
  return (page.events ?? []).filter((event) => event.type === 'user_message').map((event) => String(event.payload.content))
}

describe('hooks during an admission', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  /** A daemon whose Claude Code creates each new conversation's transcript only once the test releases it. */
  const fresh = async () => {
    const d = daemon = await IsolatedDaemon.create()
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`)
      console.log(`---- hook log\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    const wrapper = join(d.root, 'bin', 'claude')
    writeFileSync(`${wrapper}.new`, fakeEngineShim('claude', { ...d.engineConfig, lateTranscript: true }), { mode: 0o755 })
    renameSync(`${wrapper}.new`, wrapper)
    await d.start()
    return d
  }
  const release = (d: IsolatedDaemon, sessionId: string) => writeFileSync(join(d.root, `transcript.${sessionId}.release`), '')
  /** The session whose transcript the engine keeps back, once it is one other than [other]. */
  const waitingSession = (d: IsolatedDaemon, other?: string) => until('the engine to hold its new transcript back', () =>
    readdirSync(d.root).map((name) => /^transcript\.(.+)\.waiting$/.exec(name)?.[1]).find((named) => named && named !== other) ?? null,
  30_000, 50)

  /**
   * A prompt typed into the pane while [sessionId]'s transcript is kept back: its Stop runs in the engine before the
   * session is bound, then the release. The agent is bound to that session, idle, with the prompt and its recap, and
   * the Stop waited for the admission, never refused. [streamed]: the turn is seen starting and ending.
   */
  async function promptBeforeTheBind(d: IsolatedDaemon, client: LocalClient, agentId: string, pane: string, sessionId: string, word: string, streamed: boolean): Promise<void> {
    const prompt = `tell me about the ${word}`
    const started = client.next(isTurn('turn_started', agentId), 60_000, `turn_started (${word})`)
    const ended = client.next(isTurn('turn_ended', agentId), 60_000, `turn_ended (${word})`)
    const recap = client.next((frame) => isTurn('turn_summary', agentId)(frame) && JSON.stringify(frame.payload).includes(word), 60_000, `turn_summary (${word})`)
    // Not waited on when not [streamed]: a timeout must not reject unheard.
    if (!streamed) for (const unheard of [started, ended, recap]) unheard.catch(() => {})
    await d.tmux.run('send-keys', '-t', pane, '-l', prompt)
    await d.tmux.run('send-keys', '-t', pane, 'Enter')
    // The Stop hook ran once the daemon answered it, so it reached the daemon before the session could be bound.
    await until(`the engine to run the Stop of ${word}`, () =>
      d.hookLog().split('\n').some((line) => line.includes(` Stop session=${sessionId} ran`)) || null, 30_000, 50)
    release(d, sessionId)
    if (streamed) await Promise.all([started, ended, recap])
    // The recap a device restoring its tile is answered with.
    await until(`the recap of ${word}`, async () => {
      const recent = await client.request('agent_recent', { agentId }, 10_000)
      return JSON.stringify(recent.events ?? []).includes(word) || null
    }, 30_000, 200)
    const bound = await until('the agent to bind the session the engine named', async () => {
      const now = await row(client, agentId)
      return now?.status === 'active' && now.sessionId === sessionId ? now : null
    }, 30_000, 250)
    expect(bound.activity?.state).not.toBe('working')
    expect(await users(client, sessionId)).toEqual([prompt])
    await until('the waiting Stop to run', () => d.log().includes(`[hooks] ${sid(sessionId)} waiting hooks ran`) || null, 30_000, 50)
    const log = d.log()
    expect(log).toContain(`[hooks] ${sid(sessionId)} turn-stop waits for its session's admission`)
    expect(log.split('\n').filter((line) => line.includes(sid(sessionId)) && line.includes('refused · unbound'))).toEqual([])
  }

  it('Claude Code: a session whose SessionStart comes before its transcript, then a prompt and a Stop: the turn starts and ends, and a recap is made', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'hook-wait-start')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id
    const sessionId = await waitingSession(d)
    const pane = (await until('the agent\'s pane', async () => (await row(client, agentId))?.tmuxPane || null, 30_000, 100)) as string
    await promptBeforeTheBind(d, client, agentId, pane, sessionId, 'axolotl', true)
    client.close()
  })

  it('Claude Code: a /clear whose new transcript comes late, then a prompt and a Stop', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'hook-wait-clear')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id
    // The first conversation's transcript released at once, and one turn on it.
    release(d, await waitingSession(d))
    const first = await until('the agent to bind its first conversation', async () => {
      const now = await row(client, agentId)
      return now?.sessionId && now.status === 'active' && now.tmuxPane ? now : null
    }, 60_000, 250)
    const ended = client.next(isTurn('turn_ended', agentId), 45_000, 'turn_ended (first)')
    client.send('message', { agentId, content: 'in the first conversation' })
    await ended

    await d.tmux.run('send-keys', '-t', first.tmuxPane, '!clear', 'Enter')
    const sessionId = await waitingSession(d, first.sessionId)
    // The rebound agent first reads a transcript that already holds the whole turn, as history (core/transcripts/
    // attach.ts): the turn is recapped as caught up (commander.ts catchUp), not seen starting and ending.
    await promptBeforeTheBind(d, client, agentId, first.tmuxPane, sessionId, 'quokka', false)
    expect(client.frames.filter((frame) => frame.type === 'session_reset').map((frame) => frame.payload?.staleSessionId)).toEqual([first.sessionId])
    client.close()
  })
})
