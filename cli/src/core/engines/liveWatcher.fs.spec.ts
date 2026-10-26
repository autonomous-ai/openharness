import { writeFileSync } from 'node:fs'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { engineLiveRequests } from '../../engines/worker/liveRequests.js'
import { LIVE_READ, type LivePage } from '../../engines/worker/liveProtocol.js'
import { Watcher } from '../../watcher/watcher.js'
import { createLiveTransport } from './liveTransport.js'
import { createLiveWatcher } from './liveWatcher.js'

const fileSignals = vi.hoisted(() => new Map<string, (path: string) => void>())
vi.mock('chokidar', () => ({ default: { watch: () => {
  const watcher = {
    on(name: string, handler: (path: string) => void) { fileSignals.set(name, handler); return watcher },
    add() {}, async unwatch() {}, async close() {},
  }
  return watcher
} } }))

const prompt = (text: string) => JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: text } }) + '\n'
const done = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } }) + '\n'

it('replays a Codex rewrite hidden by a rapid preceding file change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-rewrite-watch-'))
  const file = join(dir, 'transcript.jsonl')
  const retained = prompt('retained history') + done
  await writeFile(file, prompt('an older turn that will be removed') + done + retained)
  const session = { agentId: 'agent', sessionId: 'session', engine: 'codex', transcriptPath: file,
    cwd: dir, codexHome: dir, model: null, cliVersion: null, boundAt: 1 } as RegisteredSession
  const watched = { sessionId: session.sessionId, engine: session.engine, transcriptPath: file }
  const worker = engineLiveRequests('codex', { fields: () => [] })
  let rewrote = false
  let connected = false
  const transport = createLiveTransport({ call: async (service, method, payload) => {
    if (!connected) { connected = true; transport.connected(service) }
    const reply = await worker[method](payload, { local: true, owner: true }) as { answer?: LivePage }
    // The real E2E rewrites as soon as it receives this turn's completion. Do it before the
    // first change's 50 ms Chokidar throttle expires, after the worker has read the old file.
    if (!rewrote && method === LIVE_READ && reply.answer?.frames.some(frame => frame.events.some(event => event.type === 'turn_ended'))) {
      rewrote = true
      writeFileSync(file, retained)
    }
    return reply
  } })
  const frames: LivePage['frames'][number][] = []
  let liveWatcher: ReturnType<typeof createLiveWatcher> | undefined
  try {
    fileSignals.clear()
    liveWatcher = createLiveWatcher(new Watcher(), {
      handles: engine => engine === 'codex', transport, bySession: () => session,
      frame: (_session, frame) => { frames.push(frame) },
      log: () => {},
      reattach: async () => {
        const hold = await liveWatcher!.watcher.hold(session.sessionId, file)
        try {
          const prepared = await liveWatcher!.live.prepare(session, { live: false }, () => {})
          expect(liveWatcher!.live.install(prepared)).toBe(true)
        } finally { hold?.release() }
        await liveWatcher!.watcher.addSession(watched)
      },
    })
    liveWatcher.watcher.start()
    const prepared = await liveWatcher.live.prepare(session, { live: false }, () => {})
    expect(liveWatcher.live.install(prepared)).toBe(true)
    await liveWatcher.watcher.addSession(watched)
    await appendFile(file, prompt('new turn') + done)
    // Chokidar emits this change, then suppresses the rewrite's event in its 50 ms window.
    fileSignals.get('change')!(file)

    await vi.waitFor(() => expect(rewrote).toBe(true), { timeout: 3_000 })
    await vi.waitFor(() => expect(frames.some(frame => frame.replay && frame.events.some(event => event.type === 'turn_ended'))).toBe(true), { timeout: 4_000 })
    expect(frames.filter(frame => !frame.replay && frame.events.some(event => event.type === 'turn_ended'))).toHaveLength(1)
  } finally {
    await liveWatcher?.watcher.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
