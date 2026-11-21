// Tier A's live sessions (sessions.ts) on a fake world: what each hook tells the devices, the process the machine model
// runs for it, and the Claude mod's inbox poll, recorded rather than run on the real devices. Every folder is a temp one.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLastAnswer } from '../../../../cable/hosts/lastAnswer.js'
import type { InboxAnswer, InboxPoll } from '../../../../core/deviceHookCalls.js'
import type { ObservedEvent, ObservedHookEvent } from '../../../../core/observedHook.js'
import { claudeSession, thread } from '../../catalog.js'
import type { Delivery, Platform, Scenario, SessionKey, StepOf } from '../../types.js'
import { machine } from '../machine.js'
import type { TierAWorld } from '../world.js'
import { sessionsSteps } from './sessions.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const scenario: Scenario = {
  id: 'S1', app: 'claude', title: 'Eval sessions', dims: ['D4'], platforms: ['darwin', 'win32', 'linux'], tiers: ['a'],
  heldOut: false, steps: [], checks: [], probes: [],
  sessions: [claudeSession('a', 60_000), claudeSession('b', 120_000), thread('t1', 60_000), thread('c1', 180_000, { cli: true }),
    // A folder with a control character, which the core takes as forged.
    claudeSession('x', 60_000, { cwd: '/work/eval-\u0007' })],
}

/** A world whose devices record what they are told, and hold each mod poll until the test answers it. */
function fakeWorld(platform: Platform) {
  const root = mkdtempSync(join(tmpdir(), 'dial-eval-sessions-'))
  roots.push(root)
  machine.reset()
  const told: ObservedEvent[] = []
  const polls: Array<{ poll: InboxPoll; answer(a: InboxAnswer): void; open: boolean }> = []
  const gone: string[] = []
  const deliveries: Array<Omit<Delivery, 'at'>> = []
  const devices = {
    observed: (event: ObservedEvent) => { told.push(event); return true },
    inboxPoll: (poll: InboxPoll) => new Promise<InboxAnswer>((resolve) => {
      const held = { poll, open: true, answer: (a: InboxAnswer) => { held.open = false; resolve(a) } }
      polls.push(held)
    }),
    // As the devices' inbox does: the poll it names is answered with nothing.
    inboxGone: (pollId: string) => {
      gone.push(pollId)
      polls.find((p) => p.open && p.poll.pollId === pollId)?.answer({})
    },
  }
  const world = {
    scenario, platform, machine,
    ports: { devices },
    folders: { claudeProjects: join(root, 'projects'), codexSessions: join(root, 'codex', 'sessions') },
    session: (key: SessionKey) => scenario.sessions.find((s) => s.key === key)!,
    deliver: (d: Omit<Delivery, 'at'>) => { deliveries.push(d) },
  } as unknown as TierAWorld
  const hook = (session: SessionKey, event: StepOf<'hook'>['event'], more: Partial<StepOf<'hook'>> = {}) =>
    sessionsSteps.hook(world, { kind: 'hook', session, event, ...more })
  const open = () => polls.filter((p) => p.open).map((p) => p.poll.sessionId)
  return { world, told, polls, gone, deliveries, hook, open }
}

/** The mod's next poll comes on the answer's own turn of the loop. */
const landed = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

const a = scenario.sessions[0]!
const b = scenario.sessions[1]!
const t1 = scenario.sessions[2]!
const CLAUDE_APP = 'com.anthropic.claudefordesktop'
const CHATGPT_APP = 'com.openai.codex'

describe("tier A's live sessions", () => {
  it('start puts the process in the machine, tells the devices and opens the mod\'s poll', async () => {
    const w = fakeWorld('darwin')
    await w.hook('a', 'start')
    expect(machine.processes.get(41000)).toMatchObject({ pid: 41000, app: 'claude' })
    expect(machine.owners.get(a.id)).toMatchObject({ engine: 'claude', pid: 41000, cwd: a.cwd })
    expect(w.told).toEqual([{
      engine: 'claude', sessionId: a.id, event: 'session-start', cwd: a.cwd, callerPid: 41000,
      transcriptPath: machine.owners.get(a.id)!.transcriptPath,
      hostHints: { __CFBundleIdentifier: CLAUDE_APP, CLAUDE_CODE_HOST_SESSION_ID: a.localId, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' },
      title: 'Eval Alpha',
    }])
    expect(machine.owners.get(a.id)!.transcriptPath!.startsWith(w.world.folders.claudeProjects)).toBe(true)
    expect(w.open()).toEqual([a.id])
  })

  it('each platform names the app as its hook and its process table do, and only Claude runs the mod', async () => {
    const hints = async (platform: Platform) => {
      const w = fakeWorld(platform)
      await w.hook('a', 'start')
      await w.hook('t1', 'start')
      await w.hook('c1', 'start')
      return { told: w.told.map((e) => (e as ObservedHookEvent).hostHints), apps: [...machine.processes.values()].map((p) => p.app),
        open: w.open(), codexTranscript: machine.owners.get(t1.id)!.transcriptPath!.startsWith(w.world.folders.codexSessions) }
    }
    const claude = { CLAUDE_CODE_HOST_SESSION_ID: a.localId, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }
    // The ChatGPT app's Codex inherits the app's bundle id on macOS, and the hook finds the app among its parents on
    // Windows; a Codex CLI names its terminal.
    const chatgpt = { __CFBundleIdentifier: CHATGPT_APP }
    const terminal = { TERM_PROGRAM: 'ghostty' }
    expect(await hints('darwin')).toEqual({ told: [{ __CFBundleIdentifier: CLAUDE_APP, ...claude }, chatgpt, terminal],
      apps: ['claude', 'codex', undefined], open: [a.id], codexTranscript: true })
    expect(await hints('linux')).toEqual({ told: [claude, {}, terminal], apps: ['claude', 'codex', undefined], open: [a.id],
      codexTranscript: true })
    expect(await hints('win32')).toEqual({ told: [{ __CFBundleIdentifier: CLAUDE_APP, ...claude }, chatgpt, terminal],
      apps: [undefined, undefined, undefined], open: [a.id], codexTranscript: true })
  })

  it('an answered poll is a mod delivery to that session, and the mod polls again', async () => {
    const w = fakeWorld('darwin')
    await w.hook('a', 'start')
    w.polls[0]!.answer({ text: 'Eval words for alpha.' })
    await landed()
    expect(w.deliveries).toEqual([{ path: 'mod', target: 'a', text: 'Eval words for alpha.' }])
    expect(w.open()).toEqual([a.id])
    // A hold that ran out is answered with nothing: nothing is delivered, and the mod asks again at once.
    w.polls[1]!.answer({})
    await landed()
    expect(w.deliveries).toHaveLength(1)
    expect(w.open()).toEqual([a.id])
    expect(new Set(w.polls.map((p) => p.poll.pollId)).size).toBe(3)
  })

  it('turn-stop writes the last answer where readLastAnswer reads it', async () => {
    const w = fakeWorld('darwin')
    await w.hook('a', 'start')
    await w.hook('a', 'turn-start')
    await w.hook('a', 'turn-stop', { lastAnswer: 'Eval answer one.' })
    await w.hook('t1', 'start')
    await w.hook('t1', 'turn-start')
    await w.hook('t1', 'turn-stop', { lastAnswer: 'Eval codex answer.' })
    const stop = (sessionId: string) =>
      w.told.find((e): e is ObservedHookEvent => e.sessionId === sessionId && e.event === 'turn-stop')
    expect(stop(a.id)).toMatchObject({ engine: 'claude', callerPid: 41000, transcriptPath: machine.owners.get(a.id)!.transcriptPath })
    expect(stop(t1.id)).toMatchObject({ engine: 'codex', callerPid: machine.owners.get(t1.id)!.pid, transcriptPath: machine.owners.get(t1.id)!.transcriptPath })
    const read = (engine: 'claude' | 'codex', path: string, root: string) =>
      readLastAnswer(engine, path, { roots: [root], maxBytes: 262_144, deadlineMs: 1_000 })
    expect(await read('claude', stop(a.id)!.transcriptPath!, w.world.folders.claudeProjects)).toBe('Eval answer one.')
    expect(await read('codex', stop(t1.id)!.transcriptPath!, w.world.folders.codexSessions)).toBe('Eval codex answer.')
  })

  it("turn-start writes the person's line, so a turn's last answer is that turn's alone", async () => {
    const w = fakeWorld('darwin')
    for (const key of ['a', 't1']) {
      await w.hook(key, 'start')
      await w.hook(key, 'turn-start')
      await w.hook(key, 'turn-stop', { lastAnswer: 'Eval answer one.' })
      // A second turn that ends with no answer of its own.
      await w.hook(key, 'turn-start')
      await w.hook(key, 'turn-stop')
    }
    const read = (engine: 'claude' | 'codex', sessionId: string, root: string) =>
      readLastAnswer(engine, machine.owners.get(sessionId)!.transcriptPath!, { roots: [root], maxBytes: 262_144, deadlineMs: 1_000 })
    expect(await read('claude', a.id, w.world.folders.claudeProjects)).toBeUndefined()
    expect(await read('codex', t1.id, w.world.folders.codexSessions)).toBeUndefined()
  })

  it('a hook the core would refuse fails its step, and the devices are told nothing', async () => {
    const w = fakeWorld('darwin')
    await expect(w.hook('x', 'start')).rejects.toThrow(/the core refuses/)
    expect(w.told).toEqual([])
  })

  it('needs-input tells the devices, and a permission in the Claude app is also the mod\'s asked', async () => {
    const w = fakeWorld('darwin')
    await w.hook('a', 'start')
    await w.hook('a', 'turn-start')
    await w.hook('a', 'needs-input', { asks: 'permission' })
    expect(w.told.slice(2).map((e) => ({ event: e.event, sessionId: e.sessionId }))).toEqual([
      { event: 'needs-input', sessionId: a.id }, { event: 'asked', sessionId: a.id },
    ])
  })

  it('quit ends the app\'s sessions and relaunch starts them again, each in a process of its own', async () => {
    const w = fakeWorld('darwin')
    await w.hook('a', 'start')
    await w.hook('b', 'start')
    await w.hook('t1', 'start')
    w.told.length = 0
    await sessionsSteps.quit(w.world, { kind: 'quit', app: 'claude' })
    await landed()
    expect(w.told.map((e) => [e.sessionId, e.event])).toEqual([[a.id, 'session-end'], [b.id, 'session-end']])
    expect([...machine.processes.keys()]).toEqual([41002])
    expect([...machine.owners.keys()]).toEqual([t1.id])
    expect(w.gone).toHaveLength(2)
    expect(w.open()).toEqual([])
    w.told.length = 0
    await sessionsSteps.relaunch(w.world, { kind: 'relaunch', app: 'claude' })
    // A process that ended is not back: the relaunched sessions' are new ones.
    expect(w.told.map((e) => [e.sessionId, e.event, (e as ObservedHookEvent).callerPid])).toEqual([
      [a.id, 'session-start', 41003], [b.id, 'session-start', 41004],
    ])
    expect([...machine.processes.keys()].sort()).toEqual([41002, 41003, 41004])
    expect(w.open()).toEqual([a.id, b.id])
  })
})
