// Tier A's loopback dial (loopbackDial.ts) against the fleet's side of its port: it greets, asks and forgets as the
// round dial's firmware does (devices/harness-device/firmware/main/cable_client.c), on virtual time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CableDecoder, CableType, encodeCableFrame } from '../../../cable/cableFrame.js'
import { CAROUSEL_REFRESH_MS } from '../../dialCarousel.js'
import { LoopbackDial } from './loopbackDial.js'

// The dial's timers are virtual; setImmediate stays real, so what it answers in a microtask lands.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }) })
afterEach(() => { vi.useRealTimers() })

/** The fleet's side of a port the dial was plugged into: what the dial sent, decoded, and how to send it a frame. */
async function opened(dial: LoopbackDial) {
  dial.replug()
  const heard: Array<Record<string, unknown>> = []
  const decoder = new CableDecoder()
  const port = await dial.cable.open!('/dev/eval-dial', (chunk) => decoder.feed(chunk, (frame) => {
    if (frame.type === CableType.Json) heard.push(JSON.parse(Buffer.from(frame.payload).toString('utf8')) as Record<string, unknown>)
  }), () => {})
  const tell = async (...messages: Array<Record<string, unknown>>) => {
    for (const message of messages) await port.write(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(message), 'utf8')))
  }
  const said = (t: string) => heard.filter((m) => m.t === t)
  return { heard, tell, said }
}

/** The microtasks the dial answers in, after the write that carried what it answers. */
const answered = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

describe("tier A's loopback dial", () => {
  it('greets as the firmware does: its settings and pets, no fw, every 2 s until welcomed and every 15 s after', async () => {
    const dial = new LoopbackDial(() => Date.now())
    const { tell, said } = await opened(dial)
    vi.advanceTimersByTime(0)
    const [hello] = said('hello')
    expect(hello).toMatchObject({ product: 'harness', proto: 3, appFilter: 'v1', questionTier: 'v1', pets: 2, petIds: [],
      settings: { brightness: expect.any(Number), muted: false, round: true, voiceLang: 'en' } })
    // A greeting that names a firmware has the daemon read the firmware manifest over the network.
    expect(hello).not.toHaveProperty('fw')
    vi.advanceTimersByTime(2_000)
    expect(said('hello')).toHaveLength(2)
    await tell({ t: 'welcome', proto: 3 })
    // The next greeting was set as the last one went: 2 s after it, then the keepalive's 15 s.
    vi.advanceTimersByTime(2_000)
    expect(said('hello')).toHaveLength(3)
    vi.advanceTimersByTime(14_999)
    expect(said('hello')).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(said('hello')).toHaveLength(4)
  })

  it("asks for the machines and the agents after each link's first welcome, as session_up does", async () => {
    const dial = new LoopbackDial(() => Date.now())
    const first = await opened(dial)
    await first.tell({ t: 'welcome', proto: 3 })
    await answered()
    await first.tell({ t: 'welcome', proto: 3 })
    await answered()
    expect(first.heard.map((m) => m.t).filter((t) => t !== 'hello')).toEqual(['machines.list', 'agents.list'])
    dial.unplug()
    const second = await opened(dial)
    await second.tell({ t: 'welcome', proto: 3 })
    await answered()
    expect(second.heard.map((m) => m.t).filter((t) => t !== 'hello')).toEqual(['machines.list', 'agents.list'])
  })

  it('unplugged, it forgets its tiles, its page and a pick not landed yet, and its face shows it', async () => {
    const dial = new LoopbackDial(() => Date.now())
    const { tell } = await opened(dial)
    await tell({ t: 'welcome', proto: 3 }, { t: 'apps', shown: 'claude' }, { t: 'agents.begin' }, { t: 'agent', id: 'eval-a' },
      { t: 'agent', id: 'eval-b' }, { t: 'agents.end', total: 2 })
    vi.advanceTimersByTime(CAROUSEL_REFRESH_MS)
    dial.swipe('eval-b')
    expect(dial.faces.at(-1)).toMatchObject({ page: 'claude', tiles: ['eval-a', 'eval-b'], active: 'eval-b' })
    dial.pick('codex')
    dial.unplug()
    expect(dial.faces.at(-1)).toMatchObject({ page: '', tiles: [], active: null })
    // Plugged in again, the ChatGPT app's ring lands no tile on the face: the pick went with the power.
    const again = await opened(dial)
    await again.tell({ t: 'welcome', proto: 3 }, { t: 'apps', shown: 'codex' }, { t: 'agents.begin' }, { t: 'agent', id: 'eval-t1' },
      { t: 'agents.end', total: 1 })
    vi.advanceTimersByTime(CAROUSEL_REFRESH_MS)
    expect(dial.faces.at(-1)).toMatchObject({ page: 'codex', tiles: ['eval-t1'], active: null })
  })
})
