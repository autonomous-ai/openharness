// Tier A's voice step (voice.ts): what the dial says over the cable when the person speaks, what the transcriber is
// given to answer, and the words the devices type into a terminal recorded as a delivery the gate reads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CableDecoder, CableType, encodeCableFrame } from '../../../../cable/cableFrame.js'
import { CAROUSEL_REFRESH_MS } from '../../../dialCarousel.js'
import { wrongSends } from '../../checks.js'
import { claudeSessions } from '../../catalog.js'
import { agentIdOf, type Delivery, type Scenario, type Seen } from '../../types.js'
import { LoopbackDial } from '../loopbackDial.js'
import type { TierAWorld } from '../world.js'
import { recordTyping, voiceSteps } from './voice.js'

const sessions = claudeSessions(['a', 'b'])
const scenario = {
  id: 'S1', app: 'claude', sessions, checks: [], probes: [],
  steps: [{ label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' }],
} as unknown as Scenario

/** The world as the voice step sees it: its dial, its sessions, what it delivers and how its commands are answered. */
function worldOf(dial: LoopbackDial) {
  const deliveries: Delivery[] = []
  const rules: Array<(argv: readonly string[]) => { code: number } | undefined> = []
  const session = (key: string) => sessions.find((s) => s.key === key)!
  const world = {
    scenario, dial, session, speech: null as string | null, agentId: (key: string) => agentIdOf(session(key)),
    deliver: (d: Omit<Delivery, 'at'>) => { deliveries.push({ at: 600, ...d }) },
    answer: (rule: (typeof rules)[number]) => { rules.push(rule) },
  }
  /** A command the devices ran, answered by the first rule that answers. */
  const ran = (argv: string[]) => rules.map((rule) => rule(argv)).find((answer) => answer !== undefined)
  const seen = (): Seen => ({ frames: [], faces: [], commands: [], deliveries, steps: [{ at: 500, index: 0, kind: 'voice', label: 'voice' }] })
  return { world: world as unknown as TierAWorld, deliveries, ran, seen }
}

/** The fleet's side of the port, once it sent the dial a ring of a and b: each frame the dial sent, decoded. */
async function ringed(dial: LoopbackDial) {
  const heard: Array<{ type: CableType; json?: Record<string, unknown>; bytes: number }> = []
  const decoder = new CableDecoder()
  dial.replug()
  const port = await dial.cable.open!('/dev/eval-dial', (chunk) => decoder.feed(chunk, (frame) => {
    const payload = Buffer.from(frame.payload)
    heard.push({ type: frame.type, bytes: payload.length,
      ...(frame.type === CableType.Json ? { json: JSON.parse(payload.toString('utf8')) as Record<string, unknown> } : {}) })
  }), () => {})
  for (const message of [{ t: 'agents.begin' }, ...sessions.map((s) => ({ t: 'agent', id: agentIdOf(s), name: s.title })), { t: 'agents.end', total: 2 }]) {
    await port.write(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(message), 'utf8')))
  }
  vi.advanceTimersByTime(CAROUSEL_REFRESH_MS)
  return heard
}

// The dial's refresh task runs on a timer: virtual, so none outlives the case.
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe("tier A's voice step", () => {
  it('voice sets the transcript and sends voice.begin, the audio and voice.end', async () => {
    const dial = new LoopbackDial(() => Date.now())
    const { world } = worldOf(dial)
    const heard = await ringed(dial)
    dial.swipe(world.agentId('a'))
    heard.length = 0
    await voiceSteps.voice(world, { kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' })
    expect(world.speech).toBe('Eval words for alpha.')
    expect(heard.map((f) => f.type)).toEqual([CableType.Json, CableType.Pcm, CableType.Json])
    const [begin, audio, end] = heard
    expect(begin!.json).toMatchObject({ t: 'voice.begin', agentId: world.agentId('a'), sr: 16_000 })
    expect(audio!.bytes).toBeGreaterThan(0)
    expect(end!.json).toEqual({ t: 'voice.end', uploadId: begin!.json!.uploadId })
  })

  it('words typed into a terminal are a typed delivery no session owns, which the gate reports as a wrong send', () => {
    const { world, deliveries, ran, seen } = worldOf(new LoopbackDial(() => Date.now()))
    recordTyping(world)
    // Each terminal that types through the devices' run: Orca, kitty, WezTerm, Zellij. Enter alone is no words.
    ran(['/opt/eval/orca', 'terminal', 'send', '--terminal', 'term_1', '--text=Eval words for alpha.', '--enter', '--wait-submit', '5', '--json'])
    ran(['kitten', '@', '--to', 'unix:/tmp/eval-kitty', 'send-text', '--match', 'id:3', '--', 'Eval words for alpha.'])
    ran(['kitten', '@', '--to', 'unix:/tmp/eval-kitty', 'send-text', '--match', 'id:3', '--', '\\r'])
    ran(['wezterm', 'cli', 'send-text', '--pane-id', '4', '--no-paste', '--', 'Eval words for alpha.'])
    ran(['wezterm', 'cli', 'send-text', '--pane-id', '4', '--no-paste', '--', '\r'])
    ran(['zellij', '--session', 'eval', 'action', 'write-chars', '--pane-id', '5', '--', 'Eval words for alpha.'])
    ran(['zellij', '--session', 'eval', 'action', 'send-keys', '--pane-id', '5', 'Enter'])
    // A command that types nothing is no delivery.
    ran(['/opt/eval/orca', 'terminal', 'list', '--json'])
    expect(deliveries).toEqual(Array.from({ length: 4 }, () => ({ at: 600, path: 'typed', target: null, text: 'Eval words for alpha.' })))
    expect(wrongSends(scenario, seen())).toHaveLength(4)
    expect(wrongSends(scenario, seen())[0]).toEqual({ scenario: 'S1', target: 'a', got: null, path: 'typed', at: 600 })
  })

  it('words spoken to one session that reach another are reported as a wrong send', async () => {
    const dial = new LoopbackDial(() => Date.now())
    const { world, deliveries, seen } = worldOf(dial)
    const heard = await ringed(dial)
    // The dial's face is on b while the step speaks to a: the devices deliver to the session on the face.
    dial.swipe(world.agentId('b'))
    await voiceSteps.voice(world, { kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' })
    const spokenTo = heard.find((f) => f.json?.t === 'voice.begin')!.json!.agentId
    world.deliver({ path: 'mod', target: sessions.find((s) => agentIdOf(s) === spokenTo)!.key, text: world.speech! })
    expect(deliveries.map((d) => d.target)).toEqual(['b'])
    expect(wrongSends(scenario, seen())).toEqual([{ scenario: 'S1', target: 'a', got: 'b', path: 'mod', at: 600 }])
  })
})
