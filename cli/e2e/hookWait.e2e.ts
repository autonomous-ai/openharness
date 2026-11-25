/**
 * Hooks that arrive while their session is still being admitted, on the real daemon: Claude Code on Windows announces
 * SessionStart before its transcript exists (2-3 s measured, CLI 0.6.89), so the daemon holds that admission until the
 * file is there, and a prompt the person typed meanwhile sends its Stop to a session not bound yet. The Stop waits
 * behind the admission and runs once the session is bound (core/engines/sessionHookWait.ts, hookServer.ts), instead of
 * being refused as unbound; a background subagent started meanwhile sends its SubagentStart there too, which waits as
 * well, so its lead reads working until the subagent ends. The fake engine's `lateTranscript` keeps the transcript back
 * until the test releases it (fakeEngine.mjs).
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
   * A prompt typed into the pane while [sessionId]'s transcript is kept back: its Stop reaches the daemon before the
   * session is bound and waits behind the admission, then the release. The agent is bound to that session, idle, with
   * the prompt and its recap, and the Stop ran bound once the session was, never refused.
   */
  async function promptBeforeTheBind(d: IsolatedDaemon, client: LocalClient, agentId: string, pane: string, sessionId: string, word: string): Promise<void> {
    const prompt = `tell me about the ${word}`
    await d.tmux.run('send-keys', '-t', pane, '-l', prompt)
    await d.tmux.run('send-keys', '-t', pane, 'Enter')
    // The daemon's own word that it holds the Stop: the engine notes its Stop ran even when notify.mjs gave up after its
    // 500 ms, and that Stop could then reach the daemon after the bind.
    await until(`the Stop of ${word} to wait for the admission`, () =>
      d.log().includes(`[hooks] ${sid(sessionId)} turn-stop waits for its session's admission`) || null, 30_000, 50)
    release(d, sessionId)
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
    // The held Stop's own line, said as it runs bound, as a Stop sent after the bind says it.
    expect(log).toMatch(new RegExp(`\\[hooks\\] ${sid(sessionId)} turn-stop(?: · .*)?$`, 'm'))
    expect(log.split('\n').filter((line) => line.includes(sid(sessionId)) && line.includes('refused · unbound'))).toEqual([])
  }

  it('Claude Code: a session whose SessionStart comes before its transcript, then a prompt and a Stop: the Stop waits for the bind, and a recap is made', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'hook-wait-start')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id
    const sessionId = await waitingSession(d)
    const pane = (await until('the agent\'s pane', async () => (await row(client, agentId))?.tmuxPane || null, 30_000, 100)) as string
    await promptBeforeTheBind(d, client, agentId, pane, sessionId, 'axolotl')
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
    // A known gap, from before the wait: the rebound agent reads a transcript that already holds the whole turn as
    // history (lib/firstTurnReplay.ts takes no rebound for a first turn; core/transcripts/attach.ts), so the turn is
    // recapped as caught up (commander.ts catchUp), not seen starting and ending.
    await promptBeforeTheBind(d, client, agentId, first.tmuxPane, sessionId, 'quokka')
    expect(client.frames.filter((frame) => frame.type === 'session_reset').map((frame) => frame.payload?.staleSessionId)).toEqual([first.sessionId])
    client.close()
  })

  it('Claude Code: a background subagent started before the bind keeps its lead working until it ends', async () => {
    const d = await fresh()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'hook-wait-subagent')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id
    const sessionId = await waitingSession(d)
    const pane = (await until('the agent\'s pane', async () => (await row(client, agentId))?.tmuxPane || null, 30_000, 100)) as string
    await d.tmux.run('send-keys', '-t', pane, '-l', '!spawn otter')
    await d.tmux.run('send-keys', '-t', pane, 'Enter')
    // The subagent's start waits first, then the lead's own Stop, which its engine ran with the subagent still running.
    // The daemon says only the first hook it holds of an admission: the Stop is known held by the count that ran.
    await until('the subagent\'s start to wait', () => d.log().includes(`[hooks] ${sid(sessionId)} subagent waits for its session's admission`) || null, 30_000, 50)
    await until('the engine to run the lead\'s Stop', () => d.hookLog().includes(` Stop session=${sessionId} ran`) || null, 30_000, 50)
    release(d, sessionId)
    await until('both waiting hooks to run', () => d.log().includes(`[hooks] ${sid(sessionId)} waiting hooks ran · 2`) || null, 30_000, 50)
    expect(d.log()).toContain(`[turn] ${sid(sessionId)} Stop left its turn open · subagents run`)
    // The lead's turn, read once the session is bound, ends only at its Stop after the subagent's.
    await until('the lead, bound, to read working', async () => {
      const now = await row(client, agentId)
      return now?.sessionId === sessionId && now.activity?.state === 'working' ? now : null
    }, 30_000, 250)
    // A round trip after the Stop ran and the turn was read: the turn has not ended since.
    expect((await row(client, agentId))?.activity?.state, 'the lead reads as working while its subagent runs').toBe('working')
    expect(client.frames.filter(isTurn('turn_ended', agentId)), 'no turn_ended while the subagent runs').toEqual([])
    const ended = client.next(isTurn('turn_ended', agentId), 60_000, 'turn_ended after the subagent stops')
    const recap = client.next((frame) => isTurn('turn_summary', agentId)(frame) && JSON.stringify(frame.payload).includes('otter found 3 files'), 60_000, 'the wrap-up\'s recap')
    writeFileSync(join(d.root, 'otter.release'), '')
    await ended
    expect((await recap).payload?.restored, 'a recap of a turn seen ending, not caught up').not.toBe(true)
    await until('the lead to read idle', async () => (await row(client, agentId))?.activity?.state !== 'working' || null, 30_000, 250)
    expect(client.frames.filter(isTurn('turn_ended', agentId))).toHaveLength(1)
    client.close()
  })
})
