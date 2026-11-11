import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnEnd } from '../core/api.js'
import type { WatchedAgent } from './githubMentions.js'
import type { GitHubGet, GitHubSend } from './githubRest.js'
import { IDLE_ASK_MS, IDLE_BACK_MS, INBOX_MAX, NEXT_SETTLE_MS, NEXT_TIMES, NextThing, START_LOOK_MS } from './nextThing.js'
import { SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>
const root = mkdtempSync(join(tmpdir(), 'super-tab-next-thing-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let files = 0

const PIP: WatchedAgent = { tabId: 'tab', agentId: 'pip', harnessId: 'h-pip', chat: 'chat-pip', names: ['Pip'], label: 'builder:pip', repos: ['acme/app'] }
const TAKE = 'harness super-tab take'
const HEAD = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0'
/** A reader's comment on a pull request, as a teammate's verdict reads on GitHub. */
const said = (text: string, at = '2026-11-11T05:00:00Z'): Json => ({ body: text, user: { login: 'juno-gh' }, author_association: 'MEMBER', created_at: at })

/** A task of acme/app labelled for Pip, taken or not; a pull request when [pull]. */
const item = (number: number, title: string, labels: string[] = [], pull = false): Json => ({ number, title,
  labels: ['builder:pip', ...labels].map(name => ({ name })), ...pull ? { pull_request: {} } : {} })

/** Pip, a builder of acme/app on this computer, whose turns end; GitHub answers its open labelled tasks and pull requests. */
function setup(options: { items?: Json[]; working?: boolean | null; watched?: WatchedAgent[]; file?: string } = {}) {
  const state = { items: options.items ?? [item(12, 'Fix the login bug')], working: options.working ?? false as boolean | null,
    watched: options.watched ?? [PIP], down: false,
    // Each pull request as GitHub details it, its comments, and its head's check runs; a pull request listed and not here is
    // clean and read by nobody yet.
    pulls: {} as Record<number, Json>, comments: {} as Record<number, Json[]>, runs: {} as Record<string, Json[]>,
    owed: [] as Array<{ number: number; sha: string }>,
    // The team's builder labels, and who the backend recorded as each verdict comment's writer, by its id.
    team: new Set<string>(), recorded: {} as Record<number, string>, recordsDown: false }
  const pullOf = (number: number): Json => ({ number, state: 'open', draft: false, body: '', user: { login: 'dee' },
    head: { sha: HEAD, ref: `pip/${number}` }, base: { ref: 'main' }, mergeable_state: 'clean', ...state.pulls[number] })
  const listeners = new Set<(end: TurnEnd) => void>()
  const onEnd = vi.fn((listener: (end: TurnEnd) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } })
  const calls: string[] = []
  const get: GitHubGet = async path => {
    calls.push(path)
    if (state.down) throw new SuperTabHostError('GITHUB_UNAVAILABLE', 'No answer.', 503)
    const ok = (body: unknown) => ({ status: 200, etag: null, body, resetAt: null })
    const url = new URL(`https://api.github.com${path}`)
    if (url.pathname === '/repos/acme/app/issues') return ok(state.items)
    const pull = /^\/repos\/acme\/app\/pulls\/(\d+)$/.exec(url.pathname)
    if (pull) return ok(pullOf(Number(pull[1])))
    const talk = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(url.pathname)
    if (talk) return ok(state.comments[Number(talk[1])] ?? [])
    if (/^\/repos\/acme\/app\/pulls\/\d+\/reviews$/.test(url.pathname)) return ok([])
    const runs = /^\/repos\/acme\/app\/commits\/(\w+)\/check-runs$/.exec(url.pathname)
    if (runs) return ok({ check_runs: state.runs[runs[1]!] ?? [] })
    if (/^\/repos\/acme\/app\/commits\/\w+\/status$/.test(url.pathname)) return ok({ statuses: [] })
    throw new Error(`not a read of this test: ${path}`)
  }
  const tell = vi.fn(async (_agent: WatchedAgent, _operationId: string, _text: string) => ({}))
  const say = vi.fn(async (_agent: WatchedAgent, _operationId: string, _text: string) => ({}))
  const log = vi.fn()
  const file = options.file ?? join(root, `next-${files++}.json`)
  const owed = vi.fn((_agent: WatchedAgent, _repo: string) => state.owed)
  // What it writes to GitHub, each answered as [refuse] says by its path's end, else 200.
  const refuse = new Map<string, number>()
  const written: string[] = []
  const send = vi.fn<GitHubSend>(async (method, path, body) => {
    written.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`)
    const status = [...refuse].find(([end]) => path.endsWith(end))?.[1] ?? 200
    return { status, etag: null, body: null, resetAt: null }
  })
  const team = vi.fn(async (_agent: WatchedAgent) => state.team)
  const named = vi.fn(async (_agent: WatchedAgent, _repo: string, comments: Json[]) => state.recordsDown ? null
    : comments.map(c => state.recorded[Number(c.id)] ? { ...c, recorded: state.recorded[Number(c.id)] } : c))
  const make = () => new NextThing({ onEnd, watched: async () => state.watched, owed, working: async () => state.working, get, send, tell, say, file, log,
    team, named })
  let turns = 0
  /** A turn of [harnessId] ending, then the settle after it. */
  const end = async (extra: Partial<TurnEnd> = {}) => {
    const event: TurnEnd = { agentId: 'h-pip', sessionId: 's-pip', aborted: false, prompt: 'p', turnId: ++turns, ...extra }
    for (const listener of listeners) listener(event)
    await vi.advanceTimersByTimeAsync(NEXT_SETTLE_MS)
  }
  const told = () => tell.mock.calls.map(([, , text]) => text)
  return { state, listeners, onEnd, calls, tell, say, log, file, owed, send, written, refuse, make, end, told, team, named, next: make() }
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

  // A task whose pieces others build (githubSplit.ts) is not one its builder sits idle on: the first review of the split found it
  // asked about the task at 20 minutes, the task taken from it at the hour, and its next task never typed.
  it('types its next task while the one it took waits on pieces cut off it, and watches that one again once they are done', async () => {
    const f = setup({ items: [{ ...item(12, 'Sync the settings', ['status:taken']), sub_issues_summary: { total: 3, completed: 1, percent_completed: 33 } }, item(14, 'Add the export')] })
    f.next.start()
    await f.end()
    expect(f.told()).toEqual([`Next: acme/app#14 Add the export. It is given to you and nobody has taken it: ${TAKE} acme/app#14`])
    await vi.advanceTimersByTimeAsync(IDLE_BACK_MS)
    expect(f.tell).toHaveBeenCalledTimes(1)
    expect(f.written).toEqual([])
    // Its pieces done, it is its builder's own work again: nothing else is typed, and it is asked about it at 20 minutes.
    f.state.items[0] = { ...item(12, 'Sync the settings', ['status:taken']), sub_issues_summary: { total: 3, completed: 3, percent_completed: 100 } }
    await f.end()
    expect(f.tell).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(IDLE_ASK_MS)
    expect(f.told().at(-1)).toMatch(/^You hold acme\/app#12 \(Sync the settings\) and have done nothing on it for 20 minutes/)
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

  // lampOS's order: findings on one's own pull requests first, then rebases, then the next task. The merger says each once on the
  // pull request and GitHub news brings it (githubMerge.ts); an agent that ended its turn on it slept on it.
  it('says a reader\'s HOLD on its pull request\'s head before its next task; one on an earlier head waits for its reader', async () => {
    const f = setup({ items: [item(12, 'Add the export'), item(30, 'Fix the login bug', [], true)] })
    f.state.comments[30] = [said(`Juno, 05:00: HOLD ${HEAD.slice(0, 7)}: src/login.ts:12 checks the old token. Use the new one.`)]
    f.next.start()
    await f.end()
    expect(f.told()).toEqual([`Your acme/app#30 has a HOLD from Juno at ${HEAD.slice(0, 7)}: fix what it asks and push, and it is read again. `
      + 'Read it: gh pr view 30 --repo acme/app --comments'])
    // It pushed its fix: the HOLD is on the head before, and its reader's to read again. Its next task, then.
    f.state.pulls[30] = { head: { sha: 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1' } }
    await f.end()
    expect(f.told().at(-1)).toBe(`Next: acme/app#12 Add the export. It is given to you and nobody has taken it: ${TAKE} acme/app#12`)
    f.next.stop()
  })

  it('says its checks failed at its head, then its branch behind or conflicting with its base, each with the command that helps', async () => {
    const f = setup({ items: [item(30, 'Fix the login bug', [], true)] })
    f.state.runs[HEAD] = [{ name: 'ci/required', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'success' }]
    f.next.start()
    await f.end()
    f.state.runs[HEAD] = [{ name: 'ci/required', status: 'completed', conclusion: 'success' }]
    for (const mergeable of ['behind', 'dirty', 'clean']) {
      f.state.pulls[30] = { mergeable_state: mergeable }
      await f.end()
    }
    expect(f.told()).toEqual([
      `Your acme/app#30 failed its checks at ${HEAD.slice(0, 7)}: ci/required. Fix them and push: gh pr checks 30 --repo acme/app`,
      'Your acme/app#30 is behind main: merge main into it and push: git fetch origin main && git merge origin/main && git push',
      'Your acme/app#30 conflicts with main: merge main into it, fix the conflicts and push: git fetch origin main && git merge origin/main'])
    f.next.stop()
  })

  // Finn, 2026-11-11: "fix and push" every minute on #4055, held, whose failing check needed a Mac it did not have.
  it('says nothing of a pull request on hold, which waits for a person, and its checks once it is lifted', async () => {
    const f = setup({ items: [item(30, 'Fix the login bug', [], true)] })
    f.state.runs[HEAD] = [{ name: 'ci/required', status: 'completed', conclusion: 'failure' }, { name: 'ci/required', status: 'completed', conclusion: 'failure' }]
    f.state.pulls[30] = { labels: [{ name: 'Hold' }] }
    f.next.start()
    await f.end()
    expect(f.told()).toEqual([])
    f.state.pulls[30] = { labels: [{ name: 'size:s' }] }
    await f.end()
    // Each failed check named once, however GitHub lists it.
    expect(f.told()).toEqual([`Your acme/app#30 failed its checks at ${HEAD.slice(0, 7)}: ci/required. Fix them and push: gh pr checks 30 --repo acme/app`])
    f.next.stop()
  })

  it('says nothing of a draft, which is work going on, nor of a pull request GitHub gives no head or base, nor of one it says nothing of', async () => {
    const f = setup({ items: [30, 31, 32, 33].map(number => item(number, 'Fix the login bug', [], true)) })
    f.state.pulls[30] = { draft: true, mergeable_state: 'dirty' }
    f.state.pulls[31] = { head: {}, mergeable_state: 'dirty' }
    f.state.pulls[32] = { base: {}, mergeable_state: 'dirty' }
    // No words, no check runs read, and no mergeable state yet (GitHub works it out after the first read).
    f.state.pulls[33] = { body: undefined, mergeable_state: undefined }
    f.state.runs[HEAD] = {} as unknown as Json[]
    f.next.start()
    await f.end()
    expect(f.tell).not.toHaveBeenCalled()
    f.next.stop()
  })

  // anh Dee, 2026-11-11: "never spam agents because we burn user token". Said once; the next turn's end with nothing changed goes
  // to its person, once, and the agent is typed it no more.
  it('says the same HOLD once, then to its person once; a push starts it over', async () => {
    const f = setup({ items: [item(30, 'Fix the login bug', [], true)] })
    f.state.comments[30] = [said(`Juno, 05:00: HOLD ${HEAD.slice(0, 7)}: src/login.ts:12.`)]
    f.next.start()
    for (let i = 0; i <= NEXT_TIMES; i++) await f.end()
    expect(f.tell).toHaveBeenCalledTimes(NEXT_TIMES)
    expect(f.say.mock.calls.map(([, , text]) => text)).toEqual([`Harness told Pip that its acme/app#30 has a HOLD from Juno at ${HEAD.slice(0, 7)} `
      + 'as its turn ended, and nothing changed by its next. Harness says it no more: tell Pip what to do.'])
    const pushed = 'd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2'
    f.state.pulls[30] = { head: { sha: pushed } }
    f.state.comments[30] = [said(`Juno, 05:30: HOLD ${pushed.slice(0, 7)}: still the old token.`, '2026-11-11T05:30:00Z')]
    await f.end()
    expect(f.told().at(-1)).toContain(`has a HOLD from Juno at ${pushed.slice(0, 7)}`)
    f.next.stop()
  })

  // "A read it owes" comes before "its next task" in the plan's order: v4's sandbox #27 waited 4 hours on two readers who never
  // answered, then was read in a minute (docs/research/2026-11-10-swarm-study/README.md).
  it('types a read Harness asked of it, at the head it was asked, before its next task and even while it holds a task', async () => {
    const f = setup({ items: [item(12, 'Add the export'), item(14, 'Mine', ['status:taken'])] })
    f.state.owed = [{ number: 24, sha: HEAD.slice(0, 7) }]
    f.next.start()
    await f.end()
    expect(f.told()).toEqual([`Read acme/app#24 at ${HEAD.slice(0, 7)}, as Harness asked you: harness super-tab read ok acme/app#24 ${HEAD.slice(0, 7)} `
      + '\'what you found\' (or read hold, with the file, line and fix)'])
    expect(f.owed).toHaveBeenCalledWith(PIP, 'acme/app')
    f.next.stop()
  })

  // Code review of #4060: a read owed for a pull request since put on hold, or whose checks failed, waits as the pull request does.
  it('types no read of a pull request on hold or failing its checks, and types it once it is lifted and passing', async () => {
    const f = setup({ items: [] })
    f.state.owed = [{ number: 24, sha: HEAD.slice(0, 7) }]
    f.state.pulls[24] = { labels: [{ name: 'hold' }] }
    f.next.start()
    await f.end()
    f.state.pulls[24] = {}
    f.state.runs[HEAD] = [{ name: 'ci/required', status: 'completed', conclusion: 'failure' }]
    await f.end()
    expect(f.told()).toEqual([])
    f.state.runs[HEAD] = [{ name: 'ci/required', status: 'completed', conclusion: 'success' }]
    await f.end()
    expect(f.told()).toEqual([expect.stringMatching(/^Read acme\/app#24 at /)])
    f.next.stop()
  })

  it('types no read it made on that head, nor one whose pull request moved on or closed, and does not read those again', async () => {
    const f = setup({ items: [item(12, 'Add the export')] })
    f.state.owed = [{ number: 24, sha: HEAD.slice(0, 7) }, { number: 25, sha: 'abcdef1' }, { number: 26, sha: HEAD.slice(0, 7) }]
    // Its READ-OK on 24's head; 25's head is not the one it was asked (Harness asks again on the new one); 26 is merged.
    f.state.comments[24] = [said(`Pip, 05:10: READ-OK ${HEAD.slice(0, 7)}: reads well.`)]
    f.state.pulls[26] = { state: 'closed' }
    f.next.start()
    await f.end()
    expect(f.told()).toEqual([`Next: acme/app#12 Add the export. It is given to you and nobody has taken it: ${TAKE} acme/app#12`])
    const reads = f.calls.length
    await f.end()
    expect(f.calls.filter(path => /pulls\/2[456]$/.test(path))).toHaveLength(3)
    expect(f.calls.length - reads).toBe(1)
    f.next.stop()
  })

  it('reads a pull request with no words as any other, and one with no head as gone', async () => {
    const f = setup({ items: [] })
    f.state.owed = [{ number: 27, sha: HEAD.slice(0, 7) }, { number: 28, sha: HEAD.slice(0, 7) }]
    f.state.pulls[27] = { head: {} }
    f.state.pulls[28] = { body: undefined }
    f.next.start()
    await f.end()
    expect(f.told()).toEqual([expect.stringMatching(/^Read acme\/app#28 at /)])
    f.next.stop()
  })

  it('remembers an ask found answered while GitHub news keeps it, and reads it again once it is asked anew', async () => {
    const f = setup({ items: [] })
    f.state.owed = [{ number: 24, sha: HEAD.slice(0, 7) }]
    f.state.pulls[24] = { state: 'closed' }
    f.next.start()
    await f.end()
    await f.end()
    const pullReads = () => f.calls.filter(path => path === '/repos/acme/app/pulls/24').length
    expect(pullReads()).toBe(1)
    // GitHub news let it go, then it was asked of again: read once more.
    f.state.owed = []
    await f.end()
    f.state.owed = [{ number: 24, sha: HEAD.slice(0, 7) }]
    await f.end()
    expect(pullReads()).toBe(2)
    f.next.stop()
  })

  // "An agent with work that is idle 20 minutes is asked once; at an hour its person is told and its work is free to take."
  it('asks an agent idle 20 minutes with a task in hand once, and at the hour tells its person and gives the task back', async () => {
    const f = setup({ items: [item(14, 'Add the export', ['status:taken']), item(20, 'Next one')] })
    f.next.start()
    await f.end()
    expect(f.tell).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(IDLE_ASK_MS)
    expect(f.told()).toEqual(['You hold acme/app#14 (Add the export) and have done nothing on it for 20 minutes: go on with it, or say on it what '
      + 'holds it: gh issue view 14 --repo acme/app'])
    await vi.advanceTimersByTimeAsync(IDLE_BACK_MS - IDLE_ASK_MS)
    expect(f.written.slice(0, 3)).toEqual(['DELETE /repos/acme/app/issues/14/labels/status%3Ataken', 'DELETE /repos/acme/app/issues/14/labels/builder%3Apip',
      'DELETE /repos/acme/app/issues/14/labels/status%3Ataken'])
    expect(f.written[3]).toMatch(/^POST \/repos\/acme\/app\/issues\/14\/comments \{"body":"Harness, \d\d:\d\d: Pip held it with nothing done for an hour, so this task goes to the builder who can start it next\."\}$/)
    expect(f.say.mock.calls.map(([, , text]) => text)).toEqual(['Pip held acme/app#14 (Add the export) with nothing done on it for an hour, so Harness '
      + 'gave it back for the builder who can start it next.'])
    // Nothing more: the watch ends with it.
    await vi.advanceTimersByTimeAsync(IDLE_BACK_MS)
    expect(f.tell).toHaveBeenCalledTimes(1)
    f.next.stop()
  })

  it('starts the 20 minutes over at each turn of its, and says nothing while it works or once the task moved on', async () => {
    const f = setup({ items: [item(14, '', ['status:taken'])] })
    f.next.start()
    await f.end()
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    await f.end({ aborted: true })
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(f.tell).not.toHaveBeenCalled()
    // A turn that ran on: its end will look again.
    await f.end()
    f.state.working = true
    await vi.advanceTimersByTimeAsync(IDLE_ASK_MS)
    expect(f.tell).not.toHaveBeenCalled()
    // Its pull request opened since, or the task is not taken now: nothing.
    f.state.working = false
    for (const items of [[item(14, '', ['status:taken']), item(31, 'Its pull request', [], true)], [item(14, '')]]) {
      await f.end()
      f.state.items = items
      await vi.advanceTimersByTimeAsync(IDLE_ASK_MS)
      f.state.items = [item(14, '', ['status:taken'])]
    }
    expect(f.told().filter(text => text.startsWith('You hold'))).toEqual([])
    // Asked of an untitled task, by its number; a stop ends the watch.
    await f.end()
    await vi.advanceTimersByTimeAsync(IDLE_ASK_MS)
    expect(f.told().at(-1)).toBe('You hold acme/app#14 and have done nothing on it for 20 minutes: go on with it, or say on it what holds it: gh issue view 14 --repo acme/app')
    f.next.stop()
    await vi.advanceTimersByTimeAsync(IDLE_BACK_MS)
    expect(f.say).not.toHaveBeenCalled()
  })

  // A pull request says which task it closes (lib/swarmSkills.ts: "its pull request says Closes #N"): with two taken and one
  // pull request, the one it holds with nothing open for it is the one no pull request closes, not the oldest.
  it('watches the task it holds that no pull request of its closes', async () => {
    const f = setup({ items: [item(12, 'Fix the login bug', ['status:taken']), item(14, 'Add the export', ['status:taken']),
      { ...item(30, 'Fix the login bug', [], true), body: 'Fixes the redirect.\n\nCloses #12' }] })
    f.next.start()
    await f.end()
    await vi.advanceTimersByTimeAsync(IDLE_ASK_MS)
    expect(f.told()).toEqual([expect.stringMatching(/^You hold acme\/app#14 \(Add the export\) and have done nothing/)])
    // A pull request that names no task may be for either: nothing is asked.
    const g = setup({ items: [item(12, 'Fix the login bug', ['status:taken']), item(30, 'Fix the login bug', [], true)] })
    g.next.start()
    await g.end()
    await vi.advanceTimersByTimeAsync(IDLE_BACK_MS)
    expect(g.tell).not.toHaveBeenCalled()
    f.next.stop(); g.next.stop()
  })

  it('watches the oldest of the tasks it holds, and says an ask that could not be typed by its code', async () => {
    const f = setup({ items: [item(16, 'Later', ['status:taken']), { number: 14, labels: [{ name: 'builder:pip' }, { name: 'status:taken' }] }] })
    f.tell.mockRejectedValueOnce(new SuperTabHostError('TIMEOUT', 'No answer.', 503))
    f.next.start()
    await f.end()
    await vi.advanceTimersByTimeAsync(IDLE_ASK_MS)
    expect(f.tell.mock.calls[0]![2]).toMatch(/^You hold acme\/app#14 and have done nothing/)
    expect(f.log).toHaveBeenCalledWith('[super-tab] next thing of agent pip: TIMEOUT.')
    f.next.stop()
  })

  it('says a give-back GitHub refuses, or a mark it kept, by its status, and a read that fails by its code', async () => {
    const f = setup({ items: [item(14, 'Add the export', ['status:taken'])] })
    f.refuse.set('labels/builder%3Apip', 403)
    f.next.start()
    await f.end()
    await vi.advanceTimersByTimeAsync(IDLE_BACK_MS)
    expect(f.log).toHaveBeenCalledWith('[super-tab] next thing of agent pip: acme/app#14 not given back: GitHub answered 403.')
    expect(f.say).not.toHaveBeenCalled()
    f.refuse.clear()
    let clears = 0
    f.send.mockImplementation(async (method, path) => ({ status: method === 'DELETE' && path.endsWith('status%3Ataken') && clears++ === 1 ? 500 : 200,
      etag: null, body: null, resetAt: null }))
    await f.end()
    await vi.advanceTimersByTimeAsync(IDLE_BACK_MS)
    expect(f.log).toHaveBeenCalledWith('[super-tab] next thing of agent pip: acme/app#14 kept status:taken: GitHub answered 500.')
    expect(f.say).toHaveBeenCalledTimes(1)
    await f.end()
    f.state.down = true
    await vi.advanceTimersByTimeAsync(IDLE_ASK_MS)
    expect(f.log).toHaveBeenCalledWith('[super-tab] next thing of agent pip: UNREACHABLE.')
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
  it('gives the same task once, then tells its person once, and types it no more; another task starts over', async () => {
    const f = setup()
    f.next.start()
    for (let i = 0; i < NEXT_TIMES + 2; i++) await f.end()
    expect(f.tell).toHaveBeenCalledTimes(NEXT_TIMES)
    expect(new Set(f.tell.mock.calls.map(([, id]) => id)).size).toBe(NEXT_TIMES)
    expect(f.say.mock.calls.map(([, , text]) => text)).toEqual([
      'Harness gave Pip acme/app#12 (Fix the login bug) as its next task as its turn ended, and nothing changed by its next. Harness says it no more: tell Pip what to do.'])
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
    const next = new NextThing({ onEnd: f.onEnd, watched: async () => { await slow; return watched }, owed: () => [], working: async () => false, send: f.send,
      get: async () => ({ status: 200, etag: null, body: f.state.items, resetAt: null }), tell: f.tell, say: f.say, file: f.file, team: f.team, named: f.named, log: f.log })
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
    expect(f.say.mock.calls[0]![2]).toBe('Harness gave Pip acme/app#12 as its next task as its turn ended, and nothing changed by its next. '
      + 'Harness says it no more: tell Pip what to do.')
    f.next.stop()
  })

  it('says a failure to read its agents by the terminal, in the daemon\'s log when it has none of its own', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = setup()
    const next = new NextThing({ onEnd: f.onEnd, watched: async () => { throw new Error('offline') }, owed: () => [], working: async () => false, send: f.send,
      get: async () => ({ status: 200, etag: null, body: [], resetAt: null }), tell: f.tell, say: f.say, file: f.file, team: f.team, named: f.named })
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

  // Swarm plan, step 1, item 2: "Harness types it once after a restart". A turn that ended while the daemon was down (an update,
  // a restart) was never heard, and its agent slept with its next thing until something else woke it.
  it('looks at each of its agents once as it starts: an idle one is typed its next thing, a busy one is left to its turn', async () => {
    const f = setup({ items: [item(12, 'Fix the login bug')] })
    f.next.start()
    await vi.advanceTimersByTimeAsync(START_LOOK_MS - 1)
    expect(f.tell).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.told()).toEqual([`Next: acme/app#12 Fix the login bug. It is given to you and nobody has taken it: ${TAKE} acme/app#12`])
    // Once: started again while running, it looks no more.
    f.next.start()
    await vi.advanceTimersByTimeAsync(START_LOOK_MS)
    expect(f.tell).toHaveBeenCalledOnce()
    f.next.stop()
    // Busy, or one whose turn just ended and is looked at by that: nothing more.
    const busy = setup({ working: true })
    busy.next.start()
    await vi.advanceTimersByTimeAsync(START_LOOK_MS)
    expect(busy.tell).not.toHaveBeenCalled()
    busy.next.stop()
    const ended = setup()
    ended.next.start()
    await vi.advanceTimersByTimeAsync(START_LOOK_MS - NEXT_SETTLE_MS)
    await ended.end()
    expect(ended.tell).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(START_LOOK_MS)
    expect(ended.tell).toHaveBeenCalledOnce()
    ended.next.stop()
    // Stopped before it looked: nothing; and a failure to list its agents is said.
    const stopped = setup()
    stopped.next.start()
    stopped.next.stop()
    await vi.advanceTimersByTimeAsync(START_LOOK_MS)
    expect(stopped.tell).not.toHaveBeenCalled()
    const failing = new NextThing({ onEnd: f.onEnd, watched: async () => { throw new Error('offline') }, owed: () => [], working: async () => false,
      send: f.send, get: async () => ({ status: 200, etag: null, body: [], resetAt: null }), tell: f.tell, say: f.say, file: f.file, team: f.team, named: f.named, log: f.log })
    failing.start()
    await vi.advanceTimersByTimeAsync(START_LOOK_MS)
    expect(f.log).toHaveBeenCalledWith('[super-tab] next things as Harness started: Error.')
    failing.stop()
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

// Swarm plan, step 1, item 2: "One command, harness inbox, lists what waits for an agent." Each line is what its turns' ends type
// it, one at a time, in the same order: a compaction or a restart loses nothing it can read again.
describe('what waits for an agent, as harness super-tab inbox lists it (nextThing.ts inbox)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('lists its own pull requests\' HOLD and branch behind, the reads it owes and the task it holds, and types nothing', async () => {
    const f = setup({ items: [item(14, 'Tidy the docs', ['status:taken']), item(15, 'Next one'),
      { ...item(30, 'Fix the login bug', [], true), body: 'Closes #12' }, item(12, 'Fix the login bug', ['status:taken']),
      { ...item(31, 'Add the export', [], true), body: 'Closes #13' }, item(13, 'Add the export', ['status:taken'])] })
    f.state.comments[30] = [said(`Juno, 05:00: HOLD ${HEAD.slice(0, 7)}: src/login.ts:12 checks the old token.`)]
    f.state.pulls[31] = { mergeable_state: 'behind' }
    f.state.owed = [{ number: 40, sha: HEAD.slice(0, 7) }]
    expect(await f.next.inbox('h-pip')).toEqual([
      `Your acme/app#30 has a HOLD from Juno at ${HEAD.slice(0, 7)}: fix what it asks and push, and it is read again. Read it: gh pr view 30 --repo acme/app --comments`,
      'Your acme/app#31 is behind main: merge main into it and push: git fetch origin main && git merge origin/main && git push',
      `Read acme/app#40 at ${HEAD.slice(0, 7)}, as Harness asked you: harness super-tab read ok acme/app#40 ${HEAD.slice(0, 7)} 'what you found' (or read hold, with the file, line and fix)`,
      'You hold acme/app#14 (Tidy the docs): go on with it: gh issue view 14 --repo acme/app',
    ])
    expect(f.tell).not.toHaveBeenCalled()
    expect(f.say).not.toHaveBeenCalled()
  })

  it('lists its next task when it holds none, and nothing when nothing waits or the terminal is no Swarm agent of its person\'s', async () => {
    const f = setup({ items: [item(15, 'Next one'), item(12, 'Fix the login bug')] })
    const next = `Next: acme/app#12 Fix the login bug. It is given to you and nobody has taken it: ${TAKE} acme/app#12`
    for (let i = 0; i <= NEXT_TIMES; i++) expect(await f.next.inbox('h-pip')).toEqual([next])
    // Listed, it was not typed: its turn's end types it as the first time.
    f.next.start()
    await f.end()
    expect(f.told()).toEqual([next])
    expect(await f.next.inbox('h-other')).toEqual([])
    f.state.items = []
    expect(await f.next.inbox('h-pip')).toEqual([])
    f.next.stop()
  })

  // "Harness types it once after a compaction": what it was told before is a summary now (core/turns/ends.ts TurnEnd.compacted).
  it('types an agent whose context was compacted all that waits for it, once it is idle, then its next thing as before', async () => {
    const BEHIND = 'Your acme/app#30 is behind main: merge main into it and push: git fetch origin main && git merge origin/main && git push'
    const NEXT = `Next: acme/app#15 Next one. It is given to you and nobody has taken it: ${TAKE} acme/app#15`
    const ALL = 'Your context was compacted. What waits for you, as Harness reads it now (harness super-tab inbox lists it again):\n'
    const f = setup({ working: true, items: [item(15, 'Next one'), { ...item(30, 'Fix the login bug', [], true), body: 'Closes #12' },
      item(12, 'Fix the login bug', ['status:taken'])] })
    f.state.pulls[30] = { mergeable_state: 'behind' }
    f.next.start()
    // Compacted in a turn that ended busy, or that its person stopped: typed at the end that finds it idle.
    await f.end({ compacted: true })
    await f.end({ aborted: true })
    expect(f.tell).not.toHaveBeenCalled()
    f.state.working = false
    await f.end()
    expect(f.told()).toEqual([`${ALL}- ${BEHIND}\n- ${NEXT}`])
    await f.end()
    expect(f.told()).toEqual([`${ALL}- ${BEHIND}\n- ${NEXT}`, BEHIND])
    // Nothing waits: nothing is typed, and its next end types nothing either.
    f.state.items = []
    await f.end({ compacted: true, aborted: true })
    await f.end()
    await f.end()
    expect(f.tell).toHaveBeenCalledTimes(2)
    f.next.stop()
    // A terminal that is no agent of its person's here keeps nothing for later.
    const g = setup({ watched: [] })
    g.next.start()
    await g.end({ compacted: true })
    g.state.watched = [PIP]
    await g.end()
    expect(g.told()).toEqual([`Next: acme/app#12 Fix the login bug. It is given to you and nobody has taken it: ${TAKE} acme/app#12`])
    g.next.stop()
  })

  // The sandbox, 2026-11-11: every agent of a person posts as its person's login, and so did the pull request's opener. Read
  // with no team and no records, a reader's HOLD read as "from deehw", and a read made by command was asked for again.
  it('reads verdicts as the merger does where every comment is one login\'s: the backend\'s record, and the team\'s names', async () => {
    const f = setup({ items: [item(30, 'Fix the login bug', [], true)] })
    const short = HEAD.slice(0, 7)
    f.state.team = new Set(['builder:pip', 'builder:amari'])
    f.state.pulls[30] = { user: { login: 'juno-gh' } }
    f.state.comments[30] = [said(`Amari, 05:00, to **Pip**: HOLD ${short}: README.md: say it there too.`)]
    // Pip owes a read of #24, and made it by command: its record names it.
    f.state.owed = [{ number: 24, sha: short }]
    f.state.pulls[24] = { user: { login: 'juno-gh' }, head: { sha: HEAD, ref: 'juno/24' } }
    f.state.comments[24] = [{ ...said(`Pip, 05:10, to **Juno**: READ-OK ${short}`), id: 901 }]
    f.state.recorded = { 901: 'Pip' }
    const held = `Your acme/app#30 has a HOLD from Amari at ${short}: fix what it asks and push, and it is read again. Read it: `
      + 'gh pr view 30 --repo acme/app --comments'
    expect(await f.next.inbox('h-pip')).toEqual([held])
    // A HOLD stands typed or by command, so it is still said while the records cannot be read, by the team's signature.
    f.state.recordsDown = true
    expect(await f.make().inbox('h-pip')).toEqual([held])
    // Typed, not made by command, it is no read: still owed.
    const g = setup({ items: [] })
    g.state.owed = [{ number: 24, sha: short }]
    g.state.pulls[24] = { user: { login: 'juno-gh' }, head: { sha: HEAD, ref: 'juno/24' } }
    g.state.comments[24] = [{ ...said(`Pip, 05:10, to **Juno**: READ-OK ${short}`), id: 902 }]
    expect(await g.next.inbox('h-pip')).toEqual([expect.stringMatching(/^Read acme\/app#24 at /)])
    // The records cannot be read: whether it read is not known, so it is not asked, and asked once they can be.
    g.state.recordsDown = true
    expect(await g.make().inbox('h-pip')).toEqual([])
    g.state.recordsDown = false
    expect(await g.make().inbox('h-pip')).toEqual([expect.stringMatching(/^Read acme\/app#24 at /)])
  })

  it('lists at most INBOX_MAX, and fails by GitHub\'s code when GitHub cannot be read', async () => {
    const f = setup({ items: [] })
    f.state.owed = Array.from({ length: INBOX_MAX + 3 }, (_, i) => ({ number: 40 + i, sha: HEAD.slice(0, 7) }))
    expect(await f.next.inbox('h-pip')).toHaveLength(INBOX_MAX)
    f.state.down = true
    // A new one, as the one before holds what it read this instant.
    await expect(f.make().inbox('h-pip')).rejects.toMatchObject({ code: expect.any(String) })
  })
})
