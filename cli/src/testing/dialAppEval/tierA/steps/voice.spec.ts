// Tier A's voice step (voice.ts): what the dial says over the cable when the person speaks, what the transcriber is
// given to answer, and the words the devices type into a terminal recorded as a delivery the gate reads.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CableDecoder, CableType, encodeCableFrame } from '../../../../cable/cableFrame.js'
import { CAROUSEL_REFRESH_MS } from '../../../dialCarousel.js'
import { wrongSends } from '../../checks.js'
import { claudeSessions, orcaSession } from '../../catalog.js'
import { agentIdOf, orcaTerminalHandle, type Delivery, type Scenario, type Seen } from '../../types.js'
import { LoopbackDial } from '../loopbackDial.js'
import { machine } from '../machine.js'
import type { TierAWorld } from '../world.js'
import { sessionsSteps } from './sessions.js'
import { recordTyping, voiceSteps } from './voice.js'

// No process starts: the words the devices type are recorded from the commands they run, never run.
const { reached, refused } = await vi.hoisted(async () => await import('../refuseProcesses.js'))
vi.mock('node:child_process', refused)
vi.mock('child_process', refused)

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
  const heard: Array<{ type: number; json?: Record<string, unknown>; bytes: number }> = []
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

const WORDS = 'Eval words for alpha.'
const roots: string[] = []

/** Codex agents in Orca's panes, a and b, h in a pane another program made and t under tmux in its pane, started (so no
 *  mod polls), the voice step speaking to `target`: the words the devices type through Orca's `terminal send` to a
 *  handle, and what reached whom. */
async function orcaWorld(target = 'a') {
  const of = {
    id: 'S2', app: 'orca', checks: [], probes: [], platforms: ['darwin'],
    sessions: [orcaSession('a', { engine: 'codex' }), orcaSession('b', { engine: 'codex', tab: 1 }),
      orcaSession('h', { engine: 'codex', tab: 2, held: true }), orcaSession('t', { engine: 'codex', tab: 3, tmux: true })],
    steps: [{ label: 'voice', kind: 'voice', transcript: WORDS, target }],
  } as unknown as Scenario
  const root = mkdtempSync(join(tmpdir(), 'dial-eval-voice-'))
  roots.push(root)
  machine.reset()
  const deliveries: Delivery[] = []
  const rules: Array<(argv: readonly string[]) => { code: number } | undefined> = []
  const world = {
    scenario: of, platform: 'darwin', machine, ports: { devices: { observed: () => true } },
    folders: { claudeProjects: join(root, 'projects'), codexSessions: join(root, 'codex', 'sessions'),
      cursorProjects: join(root, 'cursor', 'projects'), codexHomes: join(root, 'codex-homes') },
    session: (key: string) => of.sessions.find((s) => s.key === key)!,
    deliver: (d: Omit<Delivery, 'at'>) => { deliveries.push({ at: 600, ...d }) },
    answer: (rule: (typeof rules)[number]) => { rules.push(rule) },
  } as unknown as TierAWorld
  recordTyping(world)
  for (const session of ['a', 'b', 'h', 't']) await sessionsSteps.hook(world, { kind: 'hook', session, event: 'start' })
  /** Orca's send as the devices run it (cable/hosts/orca.ts). */
  const send = (handle: string) => {
    for (const rule of rules) rule(['/opt/eval/orca/resources/bin/orca-ide', 'terminal', 'send', '--terminal', handle, `--text=${WORDS}`,
      '--enter', '--wait-submit', '5', '--json'])
  }
  const seen = (): Seen => ({ frames: [], faces: [], commands: [], deliveries, steps: [{ at: 500, index: 0, kind: 'voice', label: 'voice' }] })
  return { of, deliveries, send, seen }
}

/** A handle no session's pane has. */
const NOBODYS = 'term_00000000-0000-4000-8d00-00000000ffff'

// The dial's refresh task runs on a timer: virtual, so none outlives the case.
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  expect(reached.splice(0)).toEqual([])
})

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

  it("a terminal send to a session's handle is a typed delivery to it, and to none for a handle no session owns", async () => {
    const { deliveries, send } = await orcaWorld()
    send(orcaTerminalHandle('a'))
    send(orcaTerminalHandle('b'))
    send(NOBODYS)
    // A held pane is the terminal another program was started in: words sent there reach no agent.
    send(orcaTerminalHandle('h'))
    expect(deliveries).toEqual([
      { at: 600, path: 'typed', target: 'a', text: WORDS }, { at: 600, path: 'typed', target: 'b', text: WORDS },
      { at: 600, path: 'typed', target: null, text: WORDS }, { at: 600, path: 'typed', target: null, text: WORDS },
    ])
  })

  it("the gate counts a send to another session's handle, and one to a handle no session owns, as wrong-session sends", async () => {
    const { of, send, seen } = await orcaWorld()
    send(orcaTerminalHandle('a'))
    expect(wrongSends(of, seen())).toEqual([])
    send(orcaTerminalHandle('b'))
    send(NOBODYS)
    expect(wrongSends(of, seen())).toEqual([
      { scenario: 'S2', target: 'a', got: 'b', path: 'typed', at: 600 }, { scenario: 'S2', target: 'a', got: null, path: 'typed', at: 600 },
    ])
  })

  it("a send to a tmux session's Orca handle is a wrong send, even to that session: the pane runs tmux's client, not the agent", async () => {
    const { of, deliveries, send, seen } = await orcaWorld('t')
    send(orcaTerminalHandle('t'))
    expect(deliveries).toEqual([{ at: 600, path: 'typed', target: null, text: WORDS }])
    expect(wrongSends(of, seen())).toEqual([{ scenario: 'S2', target: 't', got: null, path: 'typed', at: 600 }])
  })
})
