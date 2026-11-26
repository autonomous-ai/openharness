import { request } from 'node:http'
import { heardClip } from '../../src/cable/__fixtures__/heardClip.js'
import { CLAUDE_PLUGIN_OFF, CLAUDE_RESTART } from '../../src/cable/hosts/observed.js'
import { until, type IsolatedDaemon } from './daemon.js'
import type { DialMessage, FakeDial } from './fakeDial.js'

/** The Claude mod's poll over the daemon's socket, as the mod sends it: its status and what it was answered (`null`
 *  when the answer is empty). [signal] ends a held poll. An answer that is not JSON, or is cut short, fails the poll. */
export function inboxPoll(d: Pick<IsolatedDaemon, 'socketPath'>, sessionId: string, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: d.socketPath, path: '/api/hook/inbox', method: 'POST', headers: { 'Content-Type': 'application/json' }, signal },
      (res) => {
        let said = ''
        res.on('data', (chunk: Buffer) => { said += chunk.toString('utf8') })
        res.on('error', reject)
        // An answer cut short closes with no `end`.
        res.on('close', () => { if (!res.complete) reject(new Error("the daemon's inbox answer was cut short")) })
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, body: said ? JSON.parse(said) : null }) } catch (error) { reject(error) }
        })
      })
    req.on('error', reject)
    req.end(JSON.stringify({ sessionId }))
  })
}

/** What the dial is told of a Claude Code session no route reaches yet (cable/hosts/observed.ts voiceRefusal): Harness's
 *  plugin not on in its home yet, or on and its mod not polling yet. */
export const UNREACHED: readonly string[] = [CLAUDE_PLUGIN_OFF, CLAUDE_RESTART]
/** How often typed words go again while no poll took them: the dial hears nothing of a turn.send no route took. */
const SEND_AGAIN_MS = 1_000

/** The dial speaks to [agentId] once, as a person does, on upload [uploadId]: the transcript or the refusal it is
 *  answered with. */
export function speakOnce(dial: FakeDial, agentId: string, uploadId: string, ms = 45_000): Promise<DialMessage> {
  const since = dial.messages.length
  dial.send({ t: 'voice.begin', agentId, uploadId, sr: 16_000, lang: 'en' })
  for (const frame of heardClip()) dial.audio(frame)
  dial.send({ t: 'voice.end', uploadId })
  return dial.next((m) => (m.t === 'voice.transcript' || m.t === 'voice.error') && m.uploadId === uploadId, ms,
    'the answer to its words', since)
}

/**
 * The dial speaks to [agentId] until a route takes its words. A Claude Code session has `v` before any does (its mod's
 * first poll held, its pane's maker read), and until then the dial is refused with one of [unreached]. The daemon gives
 * no other sign that a route is there (PM decision 6, 2026-11-26), so the dial speaks again as a person would at that
 * sentence, each time on a new upload once the last was answered. The first other answer; at [ms] in all, the last
 * refusal, for the test to read.
 */
export async function spokenTo(dial: FakeDial, agentId: string, uploadId: string, unreached = UNREACHED, ms = 45_000): Promise<DialMessage> {
  const deadline = Date.now() + ms
  let last: DialMessage | undefined
  for (let tries = 1; ; tries++) {
    try {
      last = await speakOnce(dial, agentId, `${uploadId}-${tries}`, Math.max(deadline - Date.now(), 0))
    } catch (error) {
      if (last) return last
      throw error
    }
    if (last.t !== 'voice.error' || !unreached.includes(String(last.message)) || Date.now() >= deadline) return last
  }
}

/**
 * The dial's typed words to [agentId], sent again until [poll], the mod's, is answered: its row has `v` before the poll
 * is held, and words sent before then find no route and are dropped, which the dial is not told. [poll]'s answer.
 */
export async function sentThroughMod<T>(dial: FakeDial, agentId: string, text: string, poll: Promise<T>, ms = 45_000): Promise<T> {
  let answered = false
  void poll.then(() => { answered = true }, () => { answered = true })
  let sentAt = 0
  await until('the mod\'s poll to take the dial\'s words', () => {
    if (answered) return true
    if (Date.now() - sentAt >= SEND_AGAIN_MS) {
      dial.send({ t: 'turn.send', agentId, text })
      sentAt = Date.now()
    }
    return null
  }, ms, 50)
  return poll
}
