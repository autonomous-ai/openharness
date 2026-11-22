// Tier A's fake extension (editor.ts) on a fake world: what a window tells the devices' listener as it opens its stream
// and reports its shells, and what the eval records of each line the devices write back. Every folder is a temp one.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REFUSED, type ListenerStream } from '../../../../services/devicesListener.js'
import { editorSession } from '../../catalog.js'
import type { Delivery, Scenario, Seen, SessionKey, StepOf } from '../../types.js'
import { machine } from '../machine.js'
import type { TierAWorld } from '../world.js'
import { editorSteps } from './editor.js'
import { sessionsSteps, shellOf } from './sessions.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Two terminals in w1, one in w2, and a panel session, which runs in no terminal. */
const vscode: Scenario = {
  id: 'E1', app: 'vscode', title: 'Eval windows', dims: ['D3'], platforms: ['darwin', 'win32', 'linux'], tiers: ['a'],
  heldOut: false, steps: [], checks: [], probes: [],
  sessions: [editorSession('a', 'vscode'), editorSession('b', 'vscode'), editorSession('c', 'vscode', { window: 'w2' }),
    editorSession('d', 'vscode', { place: 'panel' })],
}

/** A world whose listener records each stream opened and each state, and refuses what the test says it does. */
function fakeWorld(of: Scenario = vscode) {
  const root = mkdtempSync(join(tmpdir(), 'dial-eval-editor-'))
  roots.push(root)
  machine.reset()
  const opened: Array<{ message: Record<string, unknown>; stream: ListenerStream }> = []
  const states: Array<Record<string, unknown>> = []
  const refuse = { open: false, state: false }
  const deliveries: Array<Omit<Delivery, 'at'>> = []
  const streams: NonNullable<Seen['streams']> = []
  const world = {
    scenario: of, platform: 'darwin', machine, streams,
    // The hooks are told nothing back, and the mod's poll is never answered.
    ports: { devices: { observed: () => true, inboxPoll: () => new Promise(() => {}), inboxGone: () => {} } },
    folders: { claudeProjects: join(root, 'projects'), codexSessions: join(root, 'codex', 'sessions'),
      cursorProjects: join(root, 'cursor', 'projects'), codexHomes: join(root, 'codex-homes') },
    listener: {
      vscode: { maxBytes: 96, perSecond: 1, open: (message: Record<string, unknown>, stream: ListenerStream) => {
        opened.push({ message, stream })
        return refuse.open ? REFUSED : undefined
      } },
      'vscode-state': { maxBytes: 1024, perSecond: 8, handle: (message: Record<string, unknown>) => {
        states.push(message)
        return refuse.state ? REFUSED : undefined
      } },
    },
    session: (key: SessionKey) => of.sessions.find((s) => s.key === key)!,
    deliver: (d: Omit<Delivery, 'at'>) => { deliveries.push(d) },
  } as unknown as TierAWorld
  const start = async (...keys: SessionKey[]) => {
    for (const session of keys) await sessionsSteps.hook(world, { kind: 'hook', session, event: 'start' })
  }
  const window = (step: Omit<StepOf<'editor.window'>, 'kind'>) => editorSteps['editor.window'](world, { kind: 'editor.window', ...step })
  const shell = (key: SessionKey) => shellOf(world, key)!
  /** The record without its times: the windows and lines alone. */
  const lines = () => streams.map(({ window: id, line }) => ({ window: id, line }))
  return { world, opened, states, refuse, deliveries, start, window, shell, lines }
}

describe("tier A's fake extension", () => {
  it("editor.window opens the devices' vscode stream with its id, then reports its shells, the active one and focused, as the extension's loop does", async () => {
    const w = fakeWorld()
    await w.start('a', 'b', 'c', 'd')
    await w.window({ window: 'w1', active: 'b', focused: true })
    expect(w.opened.map((o) => o.message)).toEqual([{ type: 'vscode', window: 'eval-w1-1' }])
    // The window's own terminals alone: c's is in w2, and the panel runs in none.
    expect(w.states).toEqual([
      { type: 'vscode-state', window: 'eval-w1-1', terminals: [w.shell('a'), w.shell('b')], active: w.shell('b'), focused: true },
    ])
    expect(w.lines()).toEqual([
      { window: 'eval-w1-1', line: { type: 'vscode', window: 'eval-w1-1' } },
      { window: 'eval-w1-1', line: { type: 'vscode-state', terminals: ['a', 'b'], active: 'b', focused: true } },
    ])
  })

  it('a second open of the same window is eval-w1-2', async () => {
    const w = fakeWorld()
    await w.start('a', 'c')
    await w.window({ window: 'w1', active: 'a', focused: true })
    await w.window({ window: 'w2', active: null, focused: false, terminals: ['c'] })
    await w.window({ window: 'w1', active: null, focused: false })
    expect(w.opened.map((o) => o.message.window)).toEqual(['eval-w1-1', 'eval-w2-1', 'eval-w1-2'])
    expect(w.states.map((s) => s.window)).toEqual(['eval-w1-1', 'eval-w2-1', 'eval-w1-2'])
  })

  it('with extension false no stream opens', async () => {
    const w = fakeWorld({ ...vscode, world: { extension: false } })
    await w.start('a')
    await w.window({ window: 'w1', active: 'a', focused: true })
    expect(w.opened).toEqual([])
    expect(w.states).toEqual([])
    expect(w.lines()).toEqual([])
  })

  it("each line the devices write is recorded with its shells named by their sessions' keys, and no pid of the machine's is in the record", async () => {
    const w = fakeWorld()
    await w.start('a', 'b', 'c')
    await w.window({ window: 'w1', active: 'a', focused: true })
    const { stream } = w.opened[0]!
    expect(stream.write({ show: w.shell('a'), raise: true })).toBe(true)
    expect(stream.write({ scroll: -3, pid: w.shell('b') })).toBe(true)
    // A shell no session of the scenario runs in.
    expect(stream.write({ show: 99_999 })).toBe(true)
    expect(w.lines().slice(2)).toEqual([
      { window: 'eval-w1-1', line: { show: 'a', raise: true } },
      { window: 'eval-w1-1', line: { scroll: -3, pid: 'b' } },
      { window: 'eval-w1-1', line: { show: 'other' } },
    ])
    const record = JSON.stringify(w.lines())
    for (const pid of machine.processes.keys()) expect(record).not.toContain(String(pid))
    // None of these carries words.
    expect(w.deliveries).toEqual([])
  })

  it("a line with words is a typed delivery to its shell's session, and to none for a shell no session owns", async () => {
    const w = fakeWorld()
    await w.start('a', 'b')
    await w.window({ window: 'w1', active: 'a', focused: true })
    const { stream } = w.opened[0]!
    stream.write({ text: 'Eval words for alpha.', pid: w.shell('a') })
    stream.write({ text: 'Eval words for nobody.', pid: 99_999 })
    expect(w.deliveries).toEqual([
      { path: 'typed', target: 'a', text: 'Eval words for alpha.' },
      { path: 'typed', target: null, text: 'Eval words for nobody.' },
    ])
  })

  it('an open or a state the devices refuse fails the step', async () => {
    const w = fakeWorld()
    await w.start('a')
    w.refuse.state = true
    await expect(w.window({ window: 'w1', active: 'a', focused: true })).rejects.toThrow(/refused/)
    w.refuse.open = true
    await expect(w.window({ window: 'w1', active: 'a', focused: true })).rejects.toThrow(/refused/)
  })
})
