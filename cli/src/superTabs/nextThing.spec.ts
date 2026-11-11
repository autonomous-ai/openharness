import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnEnd } from '../core/api.js'
import type { WatchedAgent } from './githubMentions.js'
import type { GitHubGet } from './githubRest.js'
import { NEXT_SETTLE_MS, NEXT_TIMES, NextThing } from './nextThing.js'
import { SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>
const root = mkdtempSync(join(tmpdir(), 'super-tab-next-thing-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let files = 0

const PIP: WatchedAgent = { tabId: 'tab', agentId: 'pip', harnessId: 'h-pip', chat: 'chat-pip', names: ['Pip'], label: 'builder:pip', repos: ['acme/app'] }
const TAKE = 'harness super-tab take'

/** A task of acme/app labelled for Pip, taken or not; a pull request when [pull]. */
const item = (number: number, title: string, labels: string[] = [], pull = false): Json => ({ number, title,
  labels: ['builder:pip', ...labels].map(name => ({ name })), ...pull ? { pull_request: {} } : {} })

/** Pip, a builder of acme/app on this computer, whose turns end; GitHub answers its open labelled tasks and pull requests. */
function setup(options: { items?: Json[]; working?: boolean | null; watched?: WatchedAgent[]; file?: string } = {}) {
  const state = { items: options.items ?? [item(12, 'Fix the login bug')], working: options.working ?? false as boolean | null,
    watched: options.watched ?? [PIP], down: false }
  const listeners = new Set<(end: TurnEnd) => void>()
  const onEnd = vi.fn((listener: (end: TurnEnd) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } })
  const calls: string[] = []
  const get: GitHubGet = async path => {
    calls.push(path)
    if (state.down) throw new SuperTabHostError('GITHUB_UNAVAILABLE', 'No answer.', 503)
    return { status: 200, etag: null, body: state.items, resetAt: null }
  }
  const tell = vi.fn(async (_agent: WatchedAgent, _operationId: string, _text: string) => ({}))
  const say = vi.fn(async (_agent: WatchedAgent, _operationId: string, _text: string) => ({}))
  const log = vi.fn()
  const file = options.file ?? join(root, `next-${files++}.json`)
  const make = () => new NextThing({ onEnd, watched: async () => state.watched, working: async () => state.working, get, tell, say, file, log })
  let turns = 0
  /** A turn of [harnessId] ending, then the settle after it. */
  const end = async (extra: Partial<TurnEnd> = {}) => {
    const event: TurnEnd = { agentId: 'h-pip', sessionId: 's-pip', aborted: false, prompt: 'p', turnId: ++turns, ...extra }
    for (const listener of listeners) listener(event)
    await vi.advanceTimersByTimeAsync(NEXT_SETTLE_MS)
  }
  const told = () => tell.mock.calls.map(([, , text]) => text)
  return { state, listeners, onEnd, calls, tell, say, log, file, make, end, told, next: make() }
}

describe('an agent\'s next thing, typed as its turn ends (nextThing.ts)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // Swarm plan, step 1, item 1: "When an agent's turn ends, Harness types its next thing at once"; v4 asked about a quiet task
  // only after 4 hours (githubAssign.ts), and an agent with work left slept until then.
  it('types a free agent its oldest task given and not taken, ending with the command that takes it', async () => {
    const f = setup({ items: [item(14, 'Add the export'), item(12, 'Fix the login bug')] })
    f.next.start()
    await f.end()
    expect(f.told()).toEqual([`Next: acme/app#12 Fix the login bug. It is given to you and nobody has taken it: ${TAKE} acme/app#12`])
    expect(f.tell.mock.calls[0]![0]).toBe(PIP)
    expect(f.calls).toEqual(['/repos/acme/app/issues?state=open&labels=builder%3Apip&per_page=100'])
    f.next.stop()
  })

  it('types nothing while it holds a task it took with no pull request yet: its own work comes first', async () => {
    const f = setup({ items: [item(12, 'Fix the login bug', ['status:taken']), item(14, 'Add the export')] })
    f.next.start()
    await f.end()
    expect(f.tell).not.toHaveBeenCalled()
    // Its pull request opened: it waits on its readers, and takes its next task meanwhile, as lampOS's builders did.
    f.state.items.push(item(30, 'Fix the login bug', [], true))
    await f.end()
    expect(f.told()).toEqual([`Next: acme/app#14 Add the export. It is given to you and nobody has taken it: ${TAKE} acme/app#14`])
    f.next.stop()
  })

  it('types nothing when nothing waits for it, when it is busy again, or when its person stopped its turn', async () => {
    const f = setup({ items: [item(12, 'Fix the login bug', ['status:taken']), item(30, 'Fix the login bug', [], true)] })
    f.next.start()
    await f.end()
    f.state.items = [item(12, 'Fix the login bug')]
    // A message typed the moment its turn ended: that comes first. And one nobody can say.
    for (const working of [true, null]) {
      f.state.working = working
      await f.end()
    }
    f.state.working = false
    await f.end({ aborted: true })
    expect(f.tell).not.toHaveBeenCalled()
    // Someone else's agent, or one not running here: not this computer's to give anything.
    await f.end({ agentId: 'h-someone' })
    expect(f.tell).not.toHaveBeenCalled()
    f.next.stop()
  })

  it('waits for its turns to settle: two ends close together are one look', async () => {
    const f = setup()
    f.next.start()
    for (const listener of f.listeners) listener({ agentId: 'h-pip', sessionId: 's', aborted: false, prompt: 'p', turnId: 1 })
    await vi.advanceTimersByTimeAsync(NEXT_SETTLE_MS / 2)
    await f.end()
    expect(f.tell).toHaveBeenCalledTimes(1)
    f.next.stop()
  })

  // "The same next thing, typed three times with no change, goes to its person and is not typed a fourth time."
  it('gives the same task three times, then tells its person once, and types it no more; another task starts over', async () => {
    const f = setup()
    f.next.start()
    for (let i = 0; i < NEXT_TIMES + 2; i++) await f.end()
    expect(f.tell).toHaveBeenCalledTimes(NEXT_TIMES)
    expect(new Set(f.tell.mock.calls.map(([, id]) => id)).size).toBe(NEXT_TIMES)
    expect(f.say.mock.calls.map(([, , text]) => text)).toEqual([
      'Harness gave Pip acme/app#12 (Fix the login bug) as its next task 3 times as its turns ended, and it has not taken it. Harness stops giving it: tell Pip what to do.'])
    expect(f.say.mock.calls[0]![0]).toBe(PIP)
    f.state.items = [item(15, 'Write the docs')]
    await f.end()
    expect(f.told().at(-1)).toBe(`Next: acme/app#15 Write the docs. It is given to you and nobody has taken it: ${TAKE} acme/app#15`)
    f.next.stop()
  })

  it('keeps its counts over a restart', async () => {
    const f = setup()
    f.next.start()
    for (let i = 0; i < NEXT_TIMES; i++) await f.end()
    f.next.stop()
    const again = f.make()
    again.start()
    await f.end()
    expect(f.tell).toHaveBeenCalledTimes(NEXT_TIMES)
    expect(f.say).toHaveBeenCalledTimes(1)
    again.stop()
  })

  it('says a failure by its name and types it at the next end; one it could not type is tried again under the same operation', async () => {
    const f = setup()
    f.next.start()
    f.state.down = true
    await f.end()
    expect(f.log).toHaveBeenCalledWith('[super-tab] next thing of agent pip: UNREACHABLE.')
    f.state.down = false
    f.tell.mockRejectedValueOnce(new SuperTabHostError('TIMEOUT', 'No answer.', 503))
    await f.end()
    await f.end()
    expect(f.tell).toHaveBeenCalledTimes(2)
    expect(f.tell.mock.calls[0]![1]).toBe(f.tell.mock.calls[1]![1])
    // Its count went up once, for the one that went in.
    for (let i = 0; i < NEXT_TIMES; i++) await f.end()
    expect(f.tell).toHaveBeenCalledTimes(NEXT_TIMES + 1)
    f.next.stop()
  })

  it('looks once at a time: an end heard while a slow read goes on reads nothing more, and an untitled task is named by its number', async () => {
    const f = setup({ items: [{ number: 'not one', labels: [{ name: 'builder:pip' }] }, item(12, '')] })
    let answer: (() => void) | null = null
    const slow = new Promise<void>(resolve => { answer = resolve })
    const watched = f.state.watched
    const next = new NextThing({ onEnd: f.onEnd, watched: async () => { await slow; return watched }, working: async () => false,
      get: async () => ({ status: 200, etag: null, body: f.state.items, resetAt: null }), tell: f.tell, say: f.say, file: f.file, log: f.log })
    next.start()
    await f.end()
    await f.end()
    answer!()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.told()).toEqual([`Next: acme/app#12. It is given to you and nobody has taken it: ${TAKE} acme/app#12`])
    next.stop()
  })

  it('names a task with no title by its number, to its agent and to its person', async () => {
    const f = setup({ items: [{ number: 12, labels: [{ name: 'builder:pip' }] }] })
    f.next.start()
    for (let i = 0; i <= NEXT_TIMES; i++) await f.end()
    expect(f.told()[0]).toBe(`Next: acme/app#12. It is given to you and nobody has taken it: ${TAKE} acme/app#12`)
    expect(f.say.mock.calls[0]![2]).toBe('Harness gave Pip acme/app#12 as its next task 3 times as its turns ended, and it has not taken it. '
      + 'Harness stops giving it: tell Pip what to do.')
    f.next.stop()
  })

  it('says a failure to read its agents by the terminal, in the daemon\'s log when it has none of its own', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = setup()
    const next = new NextThing({ onEnd: f.onEnd, watched: async () => { throw new Error('offline') }, working: async () => false,
      get: async () => ({ status: 200, etag: null, body: [], resetAt: null }), tell: f.tell, say: f.say, file: f.file })
    next.start()
    await f.end()
    expect(warn).toHaveBeenCalledWith('[super-tab] next thing of agent h-pip: Error.')
    next.stop()
    warn.mockRestore()
  })

  it('keeps the newest thousand agents\' counts, reads what it can of its file, and says a save that fails', async () => {
    const dir = mkdtempSync(join(root, 'kept-'))
    const file = join(dir, 'next.json')
    writeFileSync(file, JSON.stringify({ ...Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`old-${i}`, { key: 'acme/app#1', times: 1, told: false }])),
      broken: { key: 7 }, '': { key: 'acme/app#2', times: 1, told: false } }))
    const f = setup({ file })
    f.next.start()
    await f.end()
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(Object.keys(saved)).toHaveLength(1_000)
    expect(Object.keys(saved)[0]).toBe('old-1')
    expect(saved.pip).toEqual({ key: 'acme/app#12', times: 1, told: false })
    expect(saved.broken).toBeUndefined()
    f.next.stop()
    const g = setup({ file: join(file, 'under-a-file.json') })
    g.next.start()
    await g.end()
    expect(g.told()).toHaveLength(1)
    expect(g.log).toHaveBeenCalledWith(expect.stringMatching(/^\[super-tab\] could not save the next things: Error: E[A-Z]+/))
    g.next.stop()
  })

  it('hears turn ends once however often it is started, and none once stopped', async () => {
    const f = setup()
    f.next.start()
    f.next.start()
    expect(f.onEnd).toHaveBeenCalledTimes(1)
    for (const listener of f.listeners) listener({ agentId: 'h-pip', sessionId: 's', aborted: false, prompt: 'p', turnId: 1 })
    f.next.stop()
    expect(f.listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(NEXT_SETTLE_MS)
    expect(f.tell).not.toHaveBeenCalled()
    f.next.stop()
  })
})
