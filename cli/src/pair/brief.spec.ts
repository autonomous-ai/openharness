/**
 * P3 — the brief on return (daemons/BRAIN.md): the wording, an unreachable machine named, nothing for
 * an absence under 15 minutes, nothing after a restart, and one brief per desk however many clients
 * come back. Real sensors and journals on two machines, a fake link, a fake clock, a stubbed one-shot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PairJournal } from './journal.js'
import { PairSensor, type PairSubject } from './sensor.js'
import { PairFleet, type PairLinkOpener } from './fleet.js'
import { PairTriage, type PairOneShot } from './triage.js'
import { PairVoice, backLine } from './voice.js'
import { PairBrain } from './brain.js'
import { composeBrief, BRIEF_ITEMS_MAX } from './brief.js'
import type { DaemonSay } from './protocol.js'

type Frame = Record<string, unknown>
const MIN = 60_000
const SUBJECTS: Record<string, PairSubject> = {
  api: { name: 'api', engine: 'claude' },
  web: { name: 'web', engine: 'codex' },
  docs: { name: 'docs', engine: 'claude' },
}
const ask = (q: string) => [{ key: q, q, options: ['Yes', 'No'], multi: false }]

let dirs: string[] = []
function journalDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pair-brief-'))
  dirs.push(dir)
  return dir
}
function sensorAt(machineId: string, dir = journalDir()): PairSensor {
  const sensor = new PairSensor({ machineId: () => machineId, journal: new PairJournal({ dir }), describe: (id) => SUBJECTS[id] ?? null, now: Date.now })
  sensor.setPair('tim')
  return sensor
}

function world(opts: { oneshot?: PairOneShot; laptopHangs?: boolean; localDir?: string; remote?: PairSensor; laptopAsleep?: boolean } = {}) {
  const local = sensorAt('machine-a', opts.localDir)
  const remote = opts.remote ?? sensorAt('machine-b')
  const open: PairLinkOpener = async (_machineId, on) => {
    const connId = `relay-${Math.random()}`
    return {
      request: async (type, payload) => {
        if (type === 'pair_watch') return { snapshot: remote.watch(connId, (e) => { on.event(structuredClone(e)); return true }) }
        if (type === 'pair_journal') return opts.laptopHangs ? new Promise(() => {}) : { ...remote.journal(payload) }
        return { error: 'UNSUPPORTED' }
      },
      close: () => remote.unwatch(connId),
    }
  }
  const frames: Frame[] = []
  let brain: PairBrain | null = null
  const fleet = new PairFleet({
    local: { machineId: () => 'machine-a', name: () => 'desk', snapshot: () => local.snapshot(), subscribe: (l) => local.subscribe(l), journal: (p) => local.journal(p) },
    machines: () => [{ machineId: 'machine-b', name: 'laptop', linked: true, ...(opts.laptopAsleep ? { online: false } : {}) }],
    open, onChange: (c) => brain?.onFleetChange(c), now: Date.now,
  })
  const oneshot = opts.oneshot ? vi.fn(opts.oneshot) : null
  brain = new PairBrain({
    pairing: { enabled: () => true, pairedDaemon: () => 'tim' }, fleet,
    triage: new PairTriage({ oneshot, modelEnabled: () => true, now: Date.now }),
    voice: new PairVoice({ sendLocal: (f) => frames.push(f), now: Date.now }),
    sendLocal: (f) => frames.push(f), sendLocalTo: () => true,
    // The person chose `suggest` (the default is `watch`: nothing but [g]).
    answer: async () => ({ ok: true }), autonomy: () => 'suggest', now: Date.now,
  })
  const backs = () => frames.filter((f) => f.type === 'daemon_say' && (f.payload as DaemonSay).mood === 'back').map((f) => (f.payload as DaemonSay).line)
  const briefs = () => frames.filter((f) => f.type === 'daemon_brief').map((f) => f.payload as { line: string; items: Array<{ id: string; kind: string; line: string; actions?: Array<{ key: string; choice: string }> }> })
  return { local, remote, brain, fleet, frames, backs, briefs, oneshot }
}

const settle = async (ms = 1): Promise<void> => { await vi.advanceTimersByTimeAsync(ms) }

beforeEach(() => { vi.useFakeTimers({ now: 10_000_000 }) })
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

/** The daemon has been up a while, the window is open, then the person leaves (window goes inactive). */
async function upAndAway(w: ReturnType<typeof world>): Promise<void> {
  await settle(20 * MIN)
  w.brain.clientAttached('local:window')
  await settle()
  w.brain.onPresence('local:window', { active: false })
}

describe('brief on return', () => {
  it('says the back line in the paired daemon\'s words, its {summary} filled: done, waiting and how long', async () => {
    const w = world()
    await upAndAway(w)
    w.local.turnStarted('web'); w.local.turnEnded('web'); w.local.recap('web', 'Fixed the login redirect.')
    await settle(MIN)
    w.remote.turnStarted('docs'); w.remote.turnEnded('docs')
    await settle(4 * MIN)
    w.remote.question('api', 'q_1', ask('Bash: npm run migrate'))
    await settle(40 * MIN)
    w.brain.onPresence('local:window', { active: true, awayMs: 45 * MIN })
    await settle(10)
    expect(w.backs()).toEqual(['reattached. 2 done, 1 waiting 40m.'])
    // Not a permission prompt, so nothing is answered for the person: "open" is its key, first in the line.
    expect(w.briefs()[0].items.map((i) => [i.kind, i.line])).toEqual([
      ['waiting', '[g] api@laptop: Bash: npm run migrate (40m)'],
      ['done', 'docs@laptop finished.'],
      ['done', 'web finished: Fixed the login redirect.'],
    ])
  })

  it('a waiting item\'s keys work while the brief is up, on the machine that owns it', async () => {
    const w = world()
    await upAndAway(w)
    // A permission prompt that is not allow-class (a read outside the project): its decline works.
    w.local.question('api', 'q_1', ask('Read /etc/hosts?'), { permission: true, dialog: 'Read file\n\n  /etc/hosts\n\nDo you want to proceed?\n1. Yes\n2. No' })
    await settle(20 * MIN)
    w.brain.onPresence('local:window', { active: true, awayMs: 20 * MIN })
    await settle(10)
    const item = w.briefs()[0].items[0]
    expect(item.actions?.map((a) => a.key)).toEqual(['n', 'g'])
    const replies: Frame[] = []
    await w.brain.onAct({ requestId: 'r1', id: item.id, choice: 'n' }, (f) => replies.push(f))
    expect(replies[0].payload).toMatchObject({ ok: true, machineId: 'machine-a' })
  })

  it('shows at most five items, what needs you first', async () => {
    const w = world()
    await upAndAway(w)
    for (const id of ['api', 'web', 'docs']) { w.local.turnStarted(id); w.local.turnEnded(id) }
    for (const id of ['api', 'web', 'docs']) { w.remote.turnStarted(id); w.remote.turnEnded(id) }
    w.local.question('api', 'q_1', ask('Read src/auth.ts?'))
    await settle(20 * MIN)
    w.brain.onPresence('local:window', { active: true, awayMs: 20 * MIN })
    await settle(10)
    const items = w.briefs()[0].items
    expect(items).toHaveLength(BRIEF_ITEMS_MAX)
    expect(items[0].kind).toBe('waiting')
  })

  it('names a sleeping machine calmly, as asleep — never as unreachable or a failure', async () => {
    const w = world({ laptopAsleep: true })
    await upAndAway(w)
    w.local.turnStarted('web'); w.local.turnEnded('web')
    await settle(20 * MIN)
    w.brain.onPresence('local:window', { active: true, awayMs: 20 * MIN })
    await settle(10)
    expect(w.backs()).toEqual(['reattached. 1 done, laptop asleep.'])
    expect(w.briefs()[0].items.map((i) => [i.kind, i.line])).toEqual([['asleep', 'laptop is asleep.'], ['done', 'web finished.']])
    expect((w.brain.state().machines as Array<{ name: string; status: string }>).find((m) => m.name === 'laptop')?.status).toBe('asleep')
    expect(w.brain.state().failing).toEqual([])
  })

  it('names a machine whose journal does not answer in 3 s', async () => {
    const w = world({ laptopHangs: true })
    await upAndAway(w)
    w.local.turnStarted('web'); w.local.turnEnded('web')
    await settle(30 * MIN)
    w.brain.onPresence('local:window', { active: true, awayMs: 30 * MIN })
    await settle(2_999)
    expect(w.backs()).toEqual([])
    await settle(2)
    expect(w.backs()).toEqual(['reattached. 1 done, laptop unreachable.'])
    expect(w.briefs()[0].items.map((i) => i.kind)).toEqual(['unreachable', 'done'])
  })

  it('says nothing for an absence under 15 minutes', async () => {
    const w = world()
    await upAndAway(w)
    w.local.turnStarted('web'); w.local.turnEnded('web')
    await settle(14 * MIN)
    w.brain.onPresence('local:window', { active: true, awayMs: 14 * MIN })
    await settle(4_000)
    expect(w.backs()).toEqual([])
    expect(w.briefs()).toEqual([])
  })

  it('says nothing after a restart: an absence that began before this daemon did is a baseline', async () => {
    const localDir = journalDir()
    const before = sensorAt('machine-a', localDir)
    before.turnStarted('web'); before.turnEnded('web')
    await settle(40 * MIN)
    // The daemon restarts; the window reconnects to it and reports the person was away for 40 minutes.
    const w = world({ localDir })
    w.brain.clientAttached('local:window')
    w.brain.onPresence('local:window', { active: true, awayMs: 40 * MIN })
    await settle(4_000)
    expect(w.backs()).toEqual([])
    expect(w.briefs()).toEqual([])
  })

  it('briefs a desk once: a second client coming back, or a reconnect, does not repeat it', async () => {
    const w = world()
    await upAndAway(w)
    w.local.turnStarted('web'); w.local.turnEnded('web')
    await settle(20 * MIN)
    w.brain.onPresence('local:window', { active: true, awayMs: 20 * MIN })
    w.brain.clientAttached('local:hn')
    w.brain.onPresence('local:hn', { active: true, awayMs: 20 * MIN })
    await settle(4_000)
    expect(w.backs()).toHaveLength(1)
  })

  it('a window reconnecting after 15 minutes or more is a return', async () => {
    const w = world()
    await settle(20 * MIN)
    w.brain.clientAttached('local:window')
    await settle()
    w.brain.clientDetached('local:window')
    w.remote.turnStarted('docs'); w.remote.turnEnded('docs')
    await settle(16 * MIN)
    w.brain.clientAttached('local:window')
    await settle(4_000)
    expect(w.backs()).toEqual(['reattached. 1 done.'])
  })

  it('never asks a model: a brief is the template facts, whatever it holds', async () => {
    const w = world({ oneshot: async () => '{"items": []}' })
    await upAndAway(w)
    w.local.failed('web', 'the engine exited')
    w.local.turnStarted('api'); w.local.turnEnded('api')
    w.local.turnStarted('docs'); w.local.turnEnded('docs')
    await settle(20 * MIN)
    w.brain.onPresence('local:window', { active: true, awayMs: 20 * MIN })
    await settle(4_000)
    expect(w.oneshot).not.toHaveBeenCalled()
    expect(w.backs()).toEqual(['reattached. 2 done, web failed.'])
    expect(w.briefs()[0].items.map((i) => i.line)).toEqual(['web failed: the engine exited', 'api finished.', 'docs finished.'])
  })
})

describe('brief wording', () => {
  it('composes facts from journals and the fleet, and every daemon says them', () => {
    const now = 100 * MIN
    const { facts, items } = composeBrief({
      journals: [
        { machineId: 'a', machine: 'desk', local: true, entries: [
          { epoch: 'e', seq: 1, at: now - 30 * MIN, kind: 'done', agentId: 'web', name: 'web', engine: 'codex' },
          { epoch: 'e', seq: 2, at: now - 20 * MIN, kind: 'done', agentId: 'web', name: 'web', engine: 'codex' },
          { epoch: 'e', seq: 3, at: now - 20 * MIN, kind: 'done', agentId: 'api', name: 'api', engine: 'claude', text: 'interrupted' },
        ] },
        { machineId: 'b', machine: 'laptop', local: false, entries: [], error: 'unreachable' },
      ],
      harnesses: [], machines: [{ machineId: 'a', name: 'desk', status: 'ok', local: true }, { machineId: 'b', name: 'laptop', status: 'ok', local: false }],
      awayMs: 45 * MIN, now,
    })
    expect(facts).toMatchObject({ done: 1, waiting: 0, failed: [], unreachable: ['laptop'], asleep: [], machines: 2 })
    expect(items.map((i) => i.line)).toEqual(['laptop did not answer.', 'web finished 2 turns.'])
    // Every daemon fills its own {summary}, keeping its own case and spacing.
    expect(backLine('tim', facts)).toBe('reattached. 1 done, laptop unreachable.')
    expect(backLine('ping', facts)).toBe("you're back. 1 done, laptop unreachable.")
    expect(backLine('vim', facts)).toBe(':earlier  1 done, laptop unreachable.')
    expect(backLine('tldr', facts)).toBe('tl;dr 1 done, laptop unreachable.')
    // A back line with no {summary} slot still carries the facts.
    expect(backLine('grue', facts)).toBe('you have moved into a dark place. 1 done, laptop unreachable.')
    expect(backLine('nobody', { ...facts, done: 0, unreachable: [] })).toBe('welcome back. nothing new.')
  })
})
