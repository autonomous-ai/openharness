/**
 * The control interface's edges (pair/control.ts) beyond control.spec.ts: the started-harness record on disk,
 * reads while the fleet is not running and against machines that fail in every way, the arguments each write
 * requires, the proposal a write becomes (and what it is refused for before anything is shown), what a key on
 * it runs and reports, and the person-only lesson actions' challenge/nonce door. Fakes for the owner and the
 * fleet; a temp dir for every file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PairControl, SAY_MIN_GAP_MS, StartedHarnesses, type ControlDeps } from './control.js'
import { ApprovalNonces, type CallerVerdict } from '../shared/approval.js'
import { DIALOG_MAX, type DaemonSay } from './protocol.js'
import { backLine } from './voice.js'
import type { Autonomy } from './floor.js'

type Result = Record<string, unknown>

const TOKEN = 'a'.repeat(64)
const question = (over: Result = {}) => ({ requestId: 'q1', text: 'Approve Bash command: npm test', options: ['1. Yes', '2. No'], multi: false, deny: false, allow: true, permission: true, since: 0,
  dialog: 'Bash command\n\n  npm test\n\nDo you want to proceed?\n1. Yes\n2. No', ...over })

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pair-control-more-')); vi.useFakeTimers({ now: 1_000_000 }) })
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })

function world(opts: { autonomy?: Autonomy; fleet?: boolean; request?: (machineId: string, type: string, payload: Result) => Promise<Result>; daemonId?: string | null; voiceSays?: boolean } = {}) {
  let autonomy: Autonomy = opts.autonomy ?? 'suggest'
  const owner = {
    list: vi.fn(() => [{ agentId: 'api', name: 'api', engine: 'claude', status: 'idle' as const }]),
    read: vi.fn((agentId: string): Result => ({ ok: true, harness: null, row: { agentId, name: agentId, engine: 'claude', status: 'idle' } })),
    answer: vi.fn(async (): Promise<Result> => ({ ok: true, option: '1. Yes' })),
    send: vi.fn((): Result => ({ ok: true, deliveryId: 'd1' })),
    stop: vi.fn((): Result => ({ ok: true })),
    start: vi.fn(async (): Promise<Result> => ({ ok: true, agentId: 'new-1' })),
    pause: vi.fn(async (): Promise<Result> => ({ ok: true })),
    resume: vi.fn(async (): Promise<Result> => ({ ok: true })),
  }
  const requests: Array<{ machineId: string; type: string; payload: Result }> = []
  const fleet = {
    isRunning: opts.fleet !== false,
    machines: vi.fn(() => [
      { machineId: 'machine-a', name: 'desk', status: 'ok' as const, local: true },
      { machineId: 'machine-b', name: 'laptop', status: 'ok' as const, local: false },
    ]),
    harnesses: vi.fn(() => []),
    request: vi.fn(async (machineId: string, type: string, payload: Result): Promise<Result> => {
      requests.push({ machineId, type, payload })
      if (opts.request) return opts.request(machineId, type, payload)
      return { ok: true }
    }),
    journals: vi.fn(async () => []),
  }
  const said: DaemonSay[] = []
  const unsaid: Array<{ id: string; reason: string }> = []
  const changed = vi.fn()
  let seq = 0
  const localHarnesses = [{ agentId: 'api', name: 'api', engine: 'claude', working: false, question: null, failing: null, lastDoneAt: 999_000, recap: null }]
  const localJournal = vi.fn((_p: Result) => ({ epoch: 'e', seq: 1, entries: [
    { epoch: 'e', seq: 1, at: 999_000, kind: 'done' as const, agentId: 'api', name: 'api', engine: 'claude' },
    { epoch: 'e', seq: 2, at: 999_100, kind: 'act' as const, agentId: 'api', name: 'api', engine: 'claude', by: 'key' as const, action: 'send' as const, text: 'sent a prompt' },
  ] }))
  const deps: ControlDeps = {
    owner: owner as unknown as ControlDeps['owner'], fleet: fleet as unknown as ControlDeps['fleet'],
    local: { machineId: () => 'machine-a', name: () => 'desk', journal: localJournal, harnesses: () => localHarnesses },
    pairing: { enabled: () => true, pairedDaemon: () => opts.daemonId === undefined ? 'tim' : opts.daemonId },
    autonomy: () => autonomy,
    tokenMatches: (candidate) => candidate === TOKEN,
    voice: { say: (say) => { said.push(say); return opts.voiceSays !== false }, unsay: (id, reason) => { unsaid.push({ id, reason }); return true } },
    present: () => true,
    started: new StartedHarnesses(join(dir, 'started.json')),
    changed,
    now: Date.now,
    newId: () => `id${++seq}`,
  }
  const control = new PairControl(deps)
  const call = (verb: string, args: Result = {}, withToken = true): Promise<Result> =>
    control.local({ verb, ...args, ...(withToken ? { token: TOKEN } : {}) })
  return { control, call, owner, fleet, requests, said, unsaid, changed, deps, localJournal, setAutonomy: (a: Autonomy) => { autonomy = a } }
}

describe('StartedHarnesses: what the pair started, kept on disk', () => {
  it('without a file it is kept in memory only', () => {
    const s = new StartedHarnesses(null)
    s.add('m', 'a')
    s.add('m', 'a')
    expect(s.has('m', 'a')).toBe(true)
    expect(s.has('m', 'b')).toBe(false)
  })

  it('reads back only strings, keeps the newest `max`, and makes its folder (0600 file)', () => {
    const file = join(dir, 'nested', 'deeper', 'started.json')
    const s = new StartedHarnesses(file, 3)
    for (const id of ['a', 'b', 'c', 'd']) s.add('m', id)
    expect(s.has('m', 'a')).toBe(false)
    expect(s.has('m', 'd')).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(['m\u0000b', 'm\u0000c', 'm\u0000d'])

    writeFileSync(file, JSON.stringify(['m\u0000x', 7, null, { k: 1 }, 'm\u0000y', 'm\u0000z', 'm\u0000w']))
    const back = new StartedHarnesses(file, 3)
    expect(['x', 'y', 'z', 'w'].map((id) => back.has('m', id))).toEqual([false, true, true, true])

    // A file that is not an array, or not JSON, is no harness at all.
    writeFileSync(file, JSON.stringify({ 'm\u0000a': true }))
    expect(new StartedHarnesses(file).has('m', 'a')).toBe(false)
    writeFileSync(file, '{not json')
    expect(new StartedHarnesses(file).has('m', 'a')).toBe(false)
  })

  it('a save that fails is a warning, and the harness is still its own for this run', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const blocker = join(dir, 'a-file')
    writeFileSync(blocker, 'x')
    const s = new StartedHarnesses(join(blocker, 'started.json'))
    s.add('m', 'a')
    expect(s.has('m', 'a')).toBe(true)
    expect(warn.mock.calls[0]?.[0]).toMatch(/^\[pair\] could not save started harnesses: /)
    warn.mockRestore()
  })
})

describe('reads', () => {
  it('while the fleet is not running: this machine only, with a note; the brief from the local journal', async () => {
    const w = world({ fleet: false })
    expect(await w.call('list_machines', {}, false)).toEqual({ ok: true, machines: [{ machineId: 'machine-a', name: 'desk', status: 'ok', local: true }],
      note: 'Other machines are read while Harness is open on this computer.' })
    expect(w.fleet.machines).not.toHaveBeenCalled()
    const brief = await w.call('brief', {}, false)
    expect(brief).toMatchObject({ ok: true, sinceMinutes: 60, acted: [{ machineId: 'machine-a', machine: 'desk', agentId: 'api', by: 'key', action: 'send', text: 'sent a prompt', at: 999_100 }] })
    expect(brief.line).toBe(backLine('tim', brief.facts as Parameters<typeof backLine>[1]))
    expect(String(brief.line).length).toBeGreaterThan(0)
    expect(w.localJournal).toHaveBeenCalledWith({ at: 1_000_000 - 60 * 60_000 })
    expect(w.fleet.journals).not.toHaveBeenCalled()
  })

  it('brief clamps its window to a minute..a week; no paired daemon means no line', async () => {
    const w = world({ fleet: false, daemonId: null })
    expect((await w.call('brief', { sinceMinutes: 0 }, false)).sinceMinutes).toBe(1)
    expect((await w.call('brief', { sinceMinutes: 1e9 }, false)).sinceMinutes).toBe(7 * 24 * 60)
    expect((await w.call('brief', { sinceMinutes: Number.NaN }, false)).sinceMinutes).toBe(60)
    expect((await w.call('brief', { sinceMinutes: '30' }, false)).sinceMinutes).toBe(60)
    expect((await w.call('brief', {}, false)).line).toBe('')
  })

  it('list_harnesses for one machine; an unknown one is refused; a remote refusal, rubbish or throw is named per machine', async () => {
    let reply: () => Promise<Result> = async () => ({ error: 'PAIR_OFF' })
    const w = world({ request: () => reply() })
    expect(await w.call('list_harnesses', { machineId: 'machine-z' }, false)).toEqual({ ok: false, error: 'UNKNOWN_MACHINE' })
    expect(await w.call('list_harnesses', { machineId: 'machine-a' }, false)).toEqual({ ok: true, machines: [{ machineId: 'machine-a', machine: 'desk', harnesses: [expect.objectContaining({ agentId: 'api' })] }] })
    expect((await w.call('list_harnesses', { machineId: 'machine-b' }, false)).machines).toEqual([{ machineId: 'machine-b', machine: 'laptop', error: 'PAIR_OFF' }])
    reply = async () => ({ harnesses: 'not a list' })
    expect((await w.call('list_harnesses', { machineId: 'machine-b' }, false)).machines).toEqual([{ machineId: 'machine-b', machine: 'laptop', harnesses: [] }])
    const long = 'MACHINE_UNREACHABLE because the relay went away mid-request and never came back'
    reply = async () => { throw new Error(long) }
    const [only] = (await w.call('list_harnesses', { machineId: 'machine-b' }, false)).machines as Result[]
    expect(only).toEqual({ machineId: 'machine-b', machine: 'laptop', error: long.slice(0, 60) })
    expect(String(only!.error)).toHaveLength(60)
    reply = async () => { throw 'string' }
    expect((await w.call('list_harnesses', { machineId: 'machine-b' }, false)).machines).toEqual([{ machineId: 'machine-b', machine: 'laptop', error: 'unreachable' }])
    // A harness the pair started is marked, on either machine.
    reply = async () => ({ harnesses: [{ agentId: 'web' }] })
    w.deps.started.add('machine-b', 'web')
    expect((await w.call('list_harnesses', { machineId: 'machine-b' }, false)).machines).toEqual([{ machineId: 'machine-b', machine: 'laptop', harnesses: [{ agentId: 'web', startedByPair: true }] }])
  })

  it('read_harness needs an agent id; a refusal passes through; a remote refusal keeps its detail; a throw is unreachable', async () => {
    let reply: () => Promise<Result> = async () => ({ error: 'NOT_FOUND', detail: 'no such harness' })
    const w = world({ request: () => reply() })
    expect(await w.call('read_harness', {}, false)).toEqual({ ok: false, error: 'MISSING_AGENT_ID' })
    w.owner.read.mockReturnValueOnce({ ok: false, error: 'NOT_FOUND' })
    expect(await w.call('read_harness', { agentId: 'ghost' }, false)).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(await w.call('read_harness', { agentId: 'web', machineId: 'machine-b' }, false)).toEqual({ ok: false, error: 'NOT_FOUND', detail: 'no such harness' })
    reply = async () => ({ error: 'PAIR_OFF', detail: 42 })
    expect(await w.call('read_harness', { agentId: 'web', machineId: 'machine-b' }, false)).toEqual({ ok: false, error: 'PAIR_OFF' })
    reply = async () => { throw 'gone' }
    expect(await w.call('read_harness', { agentId: 'web', machineId: 'machine-b' }, false)).toEqual({ ok: false, error: 'UNREACHABLE' })
    reply = async () => { throw new Error('MACHINE_ASLEEP') }
    expect(await w.call('read_harness', { agentId: 'web', machineId: 'machine-b' }, false)).toEqual({ ok: false, error: 'MACHINE_ASLEEP' })
    reply = async () => ({ harness: null, row: { agentId: 'web' } })
    w.deps.started.add('machine-b', 'web')
    expect(await w.call('read_harness', { agentId: 'web', machineId: 'machine-b' }, false)).toEqual({ harness: null, row: { agentId: 'web' }, ok: true, machineId: 'machine-b', startedByPair: true })
  })

  it('a tool that throws is FAILED with its message (bounded); a non-Error throw has no detail', async () => {
    const w = world()
    w.owner.list.mockImplementationOnce(() => { throw new Error(`owner broke ${'x'.repeat(400)}`) })
    const failed = await w.call('list_harnesses', { machineId: 'machine-a' }, false)
    expect(failed).toMatchObject({ ok: false, error: 'FAILED' })
    expect(String(failed.detail).length).toBe(200)
    w.owner.list.mockImplementationOnce(() => { throw 42 })
    expect(await w.call('list_harnesses', { machineId: 'machine-a' }, false)).toEqual({ ok: false, error: 'FAILED' })
  })

  it('a verb may be written with dashes', async () => {
    const w = world()
    expect(await w.control.local({ verb: 'list-machines' })).toMatchObject({ ok: true })
  })
})

describe('say', () => {
  it('a line that is only a key prefix or blank is EMPTY; a voice over its own limit is RATE_LIMITED and does not count', async () => {
    const w = world({ voiceSays: false })
    expect(await w.call('say', { line: '[y/n] [g]  ' })).toEqual({ ok: false, error: 'EMPTY' })
    expect(await w.call('say', {})).toEqual({ ok: false, error: 'EMPTY' })
    expect(await w.call('say', { line: 'api is done' })).toMatchObject({ ok: false, error: 'RATE_LIMITED', detail: 'The voice is over its limit for this minute.' })
    // It did not count as said: the next attempt is not held by the 5 s gap.
    w.deps.voice.say = () => true
    expect(await w.call('say', { line: 'api is done' })).toEqual({ ok: true })
    expect(await w.call('say', { line: 'again' })).toMatchObject({ error: 'RATE_LIMITED', detail: `One line every ${SAY_MIN_GAP_MS / 1000} s.` })
  })
})

describe('writes: the arguments each takes', () => {
  it('refuses a write missing what it needs, before anything is proposed', async () => {
    const w = world()
    const cases: Array<[string, Result, string]> = [
      ['answer_question', { agentId: 'api', requestId: 'q1' }, 'agentId, requestId and choice'],
      ['send_prompt', { agentId: 'api', text: '   ' }, 'agentId and text'],
      ['send_prompt', { text: 'hi' }, 'agentId and text'],
      ['start_harness', { engine: 'codex' }, 'engine and cwd'],
      ['stop_turn', {}, 'agentId'],
      ['pause_harness', { agentId: 42 }, 'agentId'],
    ]
    for (const [verb, args, detail] of cases) expect(await w.call(verb, args)).toEqual({ ok: false, error: 'MISSING_ARGUMENT', detail })
    expect(w.said).toEqual([])
  })

  it('drops fields a write does not take, and bounds the ones it does', async () => {
    const w = world({ autonomy: 'act-on-key' })
    w.deps.started.add('machine-a', 'api')
    await w.call('send_prompt', { agentId: 'api', text: 'x'.repeat(9_000), by: 'key', bypassPermission: true })
    expect(w.owner.send).toHaveBeenCalledWith({ agentId: 'api', text: 'x'.repeat(8_001) }, 'pair')
  })
})

describe('proposals: what a write shows the person', () => {
  it('start_harness: the folder by its last part, the name and prompt in full; on another machine it is refused', async () => {
    const w = world()
    const p = await w.call('start_harness', { engine: 'claude', cwd: '/w/billing/', name: 'bills', prompt: 42 })
    expect(p).toMatchObject({ ok: true, proposed: true })
    expect(w.said.at(-1)).toMatchObject({ line: '[y/n] start claude in billing?', harness: { machineId: 'machine-a', machine: 'desk', agentId: null, name: 'bills' },
      detail: 'start claude (mode ask) on desk\nfolder: /w/billing/\nname: bills\n\nno first prompt', about: { machineId: 'machine-a', agentId: '' } })
    await w.control.act(String(p.id), 'y')
    expect(w.owner.start).toHaveBeenCalledWith({ engine: 'claude', cwd: '/w/billing/', prompt: null, name: 'bills' }, 'key')
    expect(w.deps.started.has('machine-a', 'new-1')).toBe(true)
    // A folder of only slashes is shown as it is.
    await w.call('start_harness', { engine: 'claude', cwd: '/' })
    expect(w.said.at(-1)!.line).toBe('[y/n] start claude in /?')
  })

  it('a start that fails, or answers with no agent id, marks nothing as the pair\'s', async () => {
    const w = world()
    w.owner.start.mockResolvedValueOnce({ ok: false, error: 'NO_SUCH_FOLDER', detail: '/nope' })
    const p = await w.call('start_harness', { engine: 'claude', cwd: '/nope' })
    expect(await w.control.act(String(p.id), 'y')).toEqual({ ok: false, results: [expect.objectContaining({ ok: false, error: 'NO_SUCH_FOLDER', machineId: 'machine-a', verb: 'start_harness' })], error: 'NO_SUCH_FOLDER', detail: '/nope' })
    w.owner.start.mockResolvedValueOnce({ ok: true })
    const q = await w.call('start_harness', { engine: 'claude', cwd: '/w' })
    expect(await w.control.act(String(q.id), 'y')).toMatchObject({ ok: true })
    expect(w.deps.started.has('machine-a', 'new-1')).toBe(false)
  })

  it('a harness that is not there, or unnamed, and a machine the list does not name', async () => {
    const w = world({ request: async () => ({ ok: false, error: 'NOT_FOUND' }) })
    w.owner.read.mockReturnValueOnce({ ok: false, error: 'NOT_FOUND' })
    expect(await w.call('stop_turn', { agentId: 'ghost' })).toEqual({ ok: false, error: 'NOT_FOUND', detail: 'That harness is not there.' })
    w.owner.read.mockReturnValueOnce({ ok: true, harness: null })
    expect(await w.call('stop_turn', { agentId: 'ghost' })).toEqual({ ok: false, error: 'GONE', detail: 'That harness is not there.' })
    w.owner.read.mockReturnValueOnce({ ok: true, harness: null, row: { agentId: 'abcdefghijk', name: '', engine: 'claude', status: 'idle' } })
    await w.call('resume_harness', { agentId: 'abcdefghijk' })
    expect(w.said.at(-1)).toMatchObject({ line: '[y/n] resume abcdefgh?', detail: 'resume abcdefgh on desk' })
    w.owner.read.mockReturnValueOnce({ ok: true, harness: null, row: { agentId: 'api', name: 'api', engine: 'claude', status: 'idle' } })
    await w.call('pause_harness', { agentId: 'api' })
    expect(w.said.at(-1)).toMatchObject({ line: '[y/n] pause api?', detail: 'pause api on desk: its process stops, its conversation is kept' })
  })

  it('an answer on another machine names it, and runs there as a sealed pair_answer after the key', async () => {
    const w = world({ request: async (_m, type) => type === 'pair_read'
      ? { ok: true, row: { agentId: 'web', name: 'web', engine: 'codex', status: 'waiting', question: question({ requestId: 'q9' }) } }
      : { error: 'STALE_QUESTION', detail: 'answered elsewhere' } })
    w.fleet.machines.mockReturnValue([
      { machineId: 'machine-a', name: 'desk', status: 'ok', local: true },
    ])
    const p = await w.call('answer_question', { agentId: 'web', requestId: 'q9', choice: 'yes', machineId: 'machine-b' })
    expect(p).toMatchObject({ ok: true, proposed: true })
    // The list does not name machine-b any more: it is named by its id.
    expect(w.said.at(-1)).toMatchObject({ line: '[y/n] answer web@machine-b: "Yes"?', harness: { machineId: 'machine-b', machine: 'machine-b', agentId: 'web', name: 'web' } })
    const out = await w.control.act(String(p.id), 'y')
    expect(w.requests.at(-1)).toEqual({ machineId: 'machine-b', type: 'pair_answer', payload: { agentId: 'web', expectRequestId: 'q9', choice: '1. Yes' } })
    expect(out).toEqual({ ok: false, results: [{ id: p.id, verb: 'answer_question', ok: false, error: 'STALE_QUESTION', detail: 'answered elsewhere', machineId: 'machine-b' }], error: 'STALE_QUESTION', detail: 'answered elsewhere' })
  })

  it('an answer is refused when the machine is too old to show the dialog, or the dialog is too long to show', async () => {
    const w = world()
    w.owner.read.mockReturnValueOnce({ ok: true, row: { agentId: 'api', name: 'api', engine: 'claude', status: 'waiting', question: question({ dialog: undefined }) } })
    expect(await w.call('answer_question', { agentId: 'api', requestId: 'q1', choice: 'Yes' })).toMatchObject({ ok: false, error: 'UNSUPPORTED' })
    w.owner.read.mockReturnValueOnce({ ok: true, row: { agentId: 'api', name: 'api', engine: 'claude', status: 'waiting', question: question({ dialog: 'x'.repeat(DIALOG_MAX + 1) }) } })
    expect(await w.call('answer_question', { agentId: 'api', requestId: 'q1', choice: 'Yes' })).toMatchObject({ ok: false, error: 'TOO_LONG_TO_SHOW' })
    w.owner.read.mockReturnValueOnce({ ok: true, row: { agentId: 'api', name: 'api', engine: 'claude', status: 'waiting' } })
    expect(await w.call('answer_question', { agentId: 'api', requestId: 'q1', choice: 'Yes' })).toMatchObject({ ok: false, error: 'STALE_QUESTION' })
    w.owner.read.mockReturnValueOnce({ ok: true, row: { agentId: 'api', name: 'api', engine: 'claude', status: 'waiting', question: question({ deny: true }) } })
    expect(await w.call('answer_question', { agentId: 'api', requestId: 'q1', choice: 'Yes' })).toMatchObject({ ok: false, error: 'DENY_CLASS' })
    expect(w.said).toEqual([])
  })

  it('every proposal tells the state it changed; has() and owns() follow it', async () => {
    const w = world()
    const p = await w.call('stop_turn', { agentId: 'api' })
    expect(w.changed).toHaveBeenCalledTimes(1)
    expect(w.control.has(String(p.id))).toBe(true)
    expect(w.control.owns(String(p.id))).toBe(true)
    expect(w.control.owns('say:1')).toBe(false)
    await w.control.act(String(p.id), 'n')
    expect(w.changed).toHaveBeenCalledTimes(2)
    expect(w.unsaid).toEqual([{ id: p.id, reason: 'declined' }])
    expect(w.control.has(String(p.id))).toBe(false)
  })
})

describe('a key on a proposal', () => {
  it('a key it did not offer is refused and the proposal keeps waiting', async () => {
    const w = world()
    const p = await w.call('stop_turn', { agentId: 'api' })
    expect(await w.control.act(String(p.id), 'g')).toEqual({ ok: false, error: 'NOT_OFFERED' })
    expect(w.control.has(String(p.id))).toBe(true)
    expect(w.owner.stop).not.toHaveBeenCalled()
  })

  it('a yes after the dial went to watch runs nothing', async () => {
    const w = world()
    const p = await w.call('stop_turn', { agentId: 'api' })
    w.setAutonomy('watch')
    expect(await w.control.act(String(p.id), 'y')).toEqual({ ok: false, error: 'AUTONOMY_WATCH' })
    expect(w.owner.stop).not.toHaveBeenCalled()
    expect(w.control.has(String(p.id))).toBe(false)
  })

  it('an owner reply with neither ok nor error counts as done; one with an error and no detail says FAILED-free', async () => {
    const w = world()
    w.owner.stop.mockReturnValueOnce({ deliveryId: 'x' })
    const p = await w.call('stop_turn', { agentId: 'api' })
    expect(await w.control.act(String(p.id), 'y')).toEqual({ ok: true, results: [{ id: p.id, verb: 'stop_turn', deliveryId: 'x', ok: true, machineId: 'machine-a' }] })
    w.owner.resume.mockResolvedValueOnce({ ok: false })
    const q = await w.call('resume_harness', { agentId: 'api' })
    expect(await w.control.act(String(q.id), 'y')).toEqual({ ok: false, results: [{ id: q.id, verb: 'resume_harness', ok: false, machineId: 'machine-a' }], error: 'FAILED' })
    w.owner.pause.mockResolvedValueOnce({ error: 'UNTOUCHABLE' })
    const r = await w.call('pause_harness', { agentId: 'api' })
    expect(await w.control.act(String(r.id), 'y')).toMatchObject({ ok: false, error: 'UNTOUCHABLE' })
  })
})

describe('lessons through the control interface', () => {
  function lessonsWorld(opts: { lessons?: ControlDeps['lessons'] | null; verdict?: CallerVerdict; person?: boolean } = {}) {
    const w = world()
    const lessons = opts.lessons === null ? undefined : (opts.lessons ?? vi.fn(async (p: Result): Promise<Result> =>
      p.action === 'export' && p.dryRun ? { ok: true, plan: ['/w/.claude/skills/x'] } : p.action === 'show' ? { ok: true, text: 'the lesson' } : { ok: true, done: p.action }))
    const nonces = new ApprovalNonces(Date.now)
    const control = new PairControl({
      ...w.deps, lessons,
      ...(opts.person === false ? {} : { person: { verify: async () => opts.verdict ?? { ok: true, pid: 77 }, nonces } }),
    })
    return { control, lessons, nonces }
  }

  it('a daemon without the learner answers UNSUPPORTED', async () => {
    const { control } = lessonsWorld({ lessons: null })
    expect(await control.local({ verb: 'lessons', action: 'list' })).toEqual({ ok: false, error: 'UNSUPPORTED' })
  })

  it('a learner that throws is FAILED, with its message or without one', async () => {
    const { control } = lessonsWorld({ lessons: async (p) => { if (p.action === 'list') throw new Error('disk full'); throw 42 } })
    expect(await control.local({ verb: 'lessons', action: 'list' })).toEqual({ ok: false, error: 'FAILED', detail: 'disk full' })
    expect(await control.local({ verb: 'lessons', action: 'skip', id: 'x' })).toEqual({ ok: false, error: 'FAILED' })
  })

  it('export: the challenge shows the dry run and binds a nonce to no lesson; the export runs confirmed with it', async () => {
    const { control, lessons } = lessonsWorld()
    const challenge = await control.local({ verb: 'lessons', action: 'challenge', for: 'export' }, 'term')
    expect(challenge).toMatchObject({ ok: true, plan: ['/w/.claude/skills/x'], nonce: expect.stringMatching(/^[0-9a-f]{32}$/), expiresInMs: 120_000 })
    // Not for a lesson id: a nonce for export does not approve a lesson.
    expect(await control.local({ verb: 'lessons', action: 'approve', id: 'beef', nonce: challenge.nonce }, 'term')).toMatchObject({ error: 'NONCE_REQUIRED' })
    const again = await control.local({ verb: 'lessons', action: 'challenge', for: 'export' }, 'term')
    expect(await control.local({ verb: 'lessons', action: 'export', nonce: again.nonce }, 'term')).toEqual({ ok: true, done: 'export' })
    expect(lessons).toHaveBeenLastCalledWith({ verb: 'lessons', action: 'export', confirmed: true })
    const refused = await control.local({ verb: 'lessons', action: 'export' }, 'term')
    expect(refused).toMatchObject({ error: 'NONCE_REQUIRED', detail: 'export needs the person: run `harness pair lessons export` in a terminal, or press [y] on the daemon\'s line' })
  })

  it('a challenge for a lesson the learner cannot show hands out no nonce', async () => {
    const { control } = lessonsWorld({ lessons: async () => ({ ok: false, error: 'NOT_FOUND' }) })
    expect(await control.local({ verb: 'lessons', action: 'challenge', for: 'restore', id: 'nope' }, 'term')).toEqual({ ok: false, error: 'NOT_FOUND' })
  })

  it('a nonce is bound to the process that asked for it', async () => {
    let pid = 77
    const w = world()
    const nonces = new ApprovalNonces(Date.now)
    const control = new PairControl({ ...w.deps, lessons: async () => ({ ok: true }), person: { verify: async () => ({ ok: true, pid }), nonces } })
    const c = await control.local({ verb: 'lessons', action: 'challenge', for: 'restore', id: 'beef' }, 'term')
    pid = 78
    expect(await control.local({ verb: 'lessons', action: 'restore', id: 'beef', nonce: c.nonce }, 'term')).toMatchObject({ error: 'NONCE_REQUIRED' })
  })
})

describe('the disk is never touched outside the temp dir', () => {
  it('StartedHarnesses writes only where it is told', () => {
    const file = join(dir, 'x', 'started.json')
    mkdirSync(join(dir, 'x'))
    chmodSync(join(dir, 'x'), 0o700)
    new StartedHarnesses(file).add('m', 'a')
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })
})
