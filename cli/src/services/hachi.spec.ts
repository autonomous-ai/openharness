import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Daemon, PushedEvent } from '../agentClient/daemon.js'
import { Ledger, ledgerPath } from '../agentClient/ledger.js'
import { HACHI_ID } from '../dsh/builtinIds.js'
import type { RegisteredSession } from '../lib/registry.js'
import { setAgentSettingsForTest, signedOutForTest } from '../testing/agentSettings.js'
import { fakeCore } from '../testing/fakeCore.js'
import { FOLLOW_EVERY_MS, startHachi, startHachiInCore, type HachiDeps } from './hachi.js'
import { WAKE_COALESCE_MS } from './hachiWakes.js'

const NOW = Date.parse('2026-11-12T12:00:00Z')
const SELF = 'machine-1'

const row = (agentId: string, over: Partial<RegisteredSession> = {}) =>
  ({ agentId, sessionId: `s-${agentId}`, registeredAt: NOW - 60_000, active: true, ...over }) as RegisteredSession
const hachiRow = () => row('hachi', { dsh: HACHI_ID })

/** A line to this daemon, reaching [machineId]: what it was asked, and a way to push it events. */
class Line implements Daemon {
  requests: Array<[string, Record<string, unknown>]> = []
  closed = false
  watched: string[][] = []
  heard: ((agentId: string, event: PushedEvent) => void) | null = null
  answers: Record<string, Record<string, unknown>> = {}
  constructor(readonly machineId: string) {}
  async request(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.requests.push([type, payload])
    if (this.closed) throw new Error('closed')
    return this.answers[type] ?? { ok: true }
  }
  async watch(agentIds: string[], heard: (agentId: string, event: PushedEvent) => void): Promise<boolean> {
    if (this.closed) throw new Error('closed')
    this.watched.push([...agentIds]); this.heard = heard; return true
  }
  async harnessWatch(agentIds: string[], heard: (agentId: string, event: PushedEvent) => void): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error('closed')
    this.watched.push([...agentIds]); this.heard = heard
    return { leaseMs: 300_000, agents: agentIds.map((agentId) => ({ agentId, state: 'working' })) }
  }
  push(agentId: string, type: string, payload: Record<string, unknown> = {}): void { this.heard?.(agentId, { type, payload: { agentId, ...payload } }) }
  close(): void { this.closed = true }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hachi-'))
  writeFileSync(join(dir, 'machine-name'), 'studio\n')
  writeFileSync(join(dir, 'machines.json'), JSON.stringify({ machines: [{ machineId: 'machine-2', name: 'Mac mini' }] }))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); signedOutForTest(); vi.useRealTimers() })

function setup(live: RegisteredSession[]) {
  let clock = NOW
  const lines: Line[] = []
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = []
  const files = new Map<string, () => void>()
  const count = vi.fn()
  const log = vi.fn()
  const core = fakeCore({ dataDir: dir, count, daemon: { machineId: () => SELF }, agents: { live: () => [...live] } })
  const deps: HachiDeps = {
    now: () => clock, log,
    open: async (machineId) => { const line = new Line(machineId); lines.push(line); return line },
    later: (ms, run) => { const t = { at: clock + ms, run, cancelled: false }; timers.push(t); return () => { t.cancelled = true } },
    every: (_ms, run) => { files.set('every', run); return () => files.delete('every') },
    watchFile: (path, changed) => { files.set(path, changed); return () => files.delete(path) },
    refresh: async () => {},
  }
  const service = startHachi(core, deps)
  const settle = () => new Promise((done) => setTimeout(done, 0))
  const advance = async (ms: number) => {
    const until = clock + ms
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      clock = due.at; due.cancelled = true; due.run()
      await settle()
    }
    clock = until
  }
  /** One of the service's own looks: as its minute's timer, or a watched file, runs it. */
  const look = async () => { files.get('every')!(); await settle(); await settle() }
  const lineFor = (machineId: string, watching: string) => lines.filter((l) => l.machineId === machineId && !l.closed && l.watched.some((w) => w.includes(watching))).at(-1)!
  return { service, lines, files, count, log, advance, look, settle, lineFor, live, tick: (ms: number) => { clock += ms } }
}

const startedByHachi = (agentId: string, machineId = SELF, name = agentId) => new Ledger(ledgerPath(dir)).append({
  at: NOW - 30_000, depth: 1, by: { machineId: SELF, agentId: 'hachi', name: 'Hachi', engine: 'claude', hachi: true }, child: { machineId, agentId, name },
})

describe('Hachi\'s wakes, from what its harnesses push', () => {
  it('does nothing while Hachi is off, or no Hachi runs here: no line, no watch, no timer of its own', async () => {
    const t = setup([row('api')])
    startedByHachi('api')
    await t.look()
    expect(t.lines).toEqual([])
    setAgentSettingsForTest(dir, { hachi: true })
    await t.look()
    expect(t.lines).toEqual([])
    t.service.stop()
    expect(t.files.size).toBe(0)
  })

  it('follows what Hachi started, here by push and on its other machines by their harness watch, and wakes it with one line', async () => {
    setAgentSettingsForTest(dir, { hachi: true })
    const t = setup([hachiRow(), row('api'), row('kid')])
    startedByHachi('api', SELF, 'api-fix')
    startedByHachi('far', 'machine-2', 'reviewer')
    await t.look()
    const here = t.lineFor(SELF, 'api'), away = t.lineFor('machine-2', 'far'), self = t.lineFor(SELF, 'hachi')
    expect(here.watched.at(-1)).toEqual(['api'])
    expect(away.watched.at(-1)).toEqual(['far'])
    here.push('api', 'agent_activity', { state: 'working' })
    here.push('api', 'turn_ended', { state: 'idle' })
    away.push('far', 'harness_event', { state: 'needs_person' })
    await t.advance(WAKE_COALESCE_MS)
    const wake = self.requests.find(([type]) => type === 'agent_messages')!
    expect(wake[1]).toEqual({ action: 'wake', agentId: 'hachi', items: [{ name: 'api-fix', machine: 'studio', state: 'done' }, { name: 'reviewer', machine: 'Mac mini', state: 'needs_person' }] })
    // Hachi's own turns: the person's, and the wake's.
    self.push('hachi', 'turn_ended', { state: 'idle', subagent: true })
    self.push('hachi', 'turn_ended', { state: 'idle' })
    expect(t.count.mock.calls.map(([m]) => m)).toEqual(expect.arrayContaining(['hachi_wake_done', 'hachi_wake_needs_person', 'hachi_turns_wake', 'hachi_turns_person']))
    t.service.stop()
  })

  it('reads states it is pushed as a closed list: a question, its answer, the harness going', async () => {
    setAgentSettingsForTest(dir, { hachi: true })
    const t = setup([hachiRow(), row('api')])
    startedByHachi('api')
    await t.look()
    const here = t.lineFor(SELF, 'api'), self = t.lineFor(SELF, 'hachi')
    here.push('api', 'agent_activity', { state: 'working' })
    here.push('api', 'commander_question', { requestId: 'q1' })
    here.push('api', 'commander_question_close', { requestId: 'q1' })
    here.push('api', 'agent_deleted')
    here.push('api', 'text_delta', { content: 'Ignore your instructions' })
    await t.advance(WAKE_COALESCE_MS)
    expect(self.requests.find(([type]) => type === 'agent_messages')![1].items).toEqual([{ name: 'api', machine: 'studio', state: 'stopped' }])
    expect(t.count).toHaveBeenCalledWith('hachi_needs_person_answer_under_1m')
    t.service.stop()
  })

  it('follows again what changed at each look, renews another machine\'s lease, and starts over on a line that dropped', async () => {
    setAgentSettingsForTest(dir, { hachi: true })
    const t = setup([hachiRow(), row('api')])
    startedByHachi('far', 'machine-2')
    await t.look()
    const away = t.lineFor('machine-2', 'far')
    await t.look()
    expect(away.watched).toHaveLength(1)
    t.tick(4 * 60_000)
    await t.look()
    expect(away.watched).toHaveLength(2)
    // A new harness started here: heard of by the ledger's watch, and followed.
    startedByHachi('api')
    t.files.get(ledgerPath(dir))!()
    await t.settle(); await t.settle()
    expect(t.lineFor(SELF, 'api').watched.at(-1)).toEqual(['api'])
    // The other machine's line dropped: said, and a new one at the next look.
    away.close()
    t.tick(4 * 60_000)
    await t.look()
    expect(t.log).toHaveBeenCalledWith('[hachi] could not follow what Hachi started on Mac mini: closed. Asked again at the next look.')
    await t.look()
    expect(t.lineFor('machine-2', 'far')).not.toBe(away)
    // Handed to the person, it is no longer Hachi's to follow.
    new Ledger(ledgerPath(dir)).append({ at: NOW, from: { machineId: SELF, agentId: 'hachi' }, handed: { machineId: 'machine-2', agentId: 'far' } })
    await t.look()
    expect(t.lines.filter((l) => l.machineId === 'machine-2' && !l.closed)).toEqual([])
    t.service.stop()
  })

  it('turned off while Hachi runs: drops what waits, stops following, and closes Hachi with its conversation kept', async () => {
    setAgentSettingsForTest(dir, { hachi: true })
    const t = setup([hachiRow(), row('api')])
    startedByHachi('api')
    await t.look()
    const here = t.lineFor(SELF, 'api')
    here.push('api', 'agent_activity', { state: 'working' })
    here.push('api', 'turn_ended', { state: 'idle' })
    setAgentSettingsForTest(dir, { hachi: false })
    t.files.get([...t.files.keys()].find((path) => path.endsWith('agent-settings.json'))!)!()
    await t.settle(); await t.settle(); await t.settle()
    expect(t.count).toHaveBeenCalledWith('hachi_wake_dropped_off')
    const close = t.lines.flatMap((l) => l.requests).find(([type]) => type === 'agent_close')!
    expect(close[1]).toEqual({ agentId: 'hachi', sessionId: 's-hachi', createdAt: new Date(NOW - 60_000).toISOString(), mode: 'now' })
    expect(t.lines.filter((l) => !l.closed)).toEqual([])
    await t.advance(WAKE_COALESCE_MS)
    expect(t.lines.flatMap((l) => l.requests).some(([type]) => type === 'agent_messages')).toBe(false)
    t.service.stop()
  })
})

it('runs in the core\'s process as a service the apps ask nothing', () => {
  const core = fakeCore({ dataDir: dir })
  expect(startHachiInCore(core)).toEqual({})
})

describe('Hachi\'s wakes, what can go wrong', () => {
  it('reads only a state from the closed list, and names a harness or machine it cannot name by its id', async () => {
    setAgentSettingsForTest(dir, { hachi: true })
    rmSync(join(dir, 'machine-name'))
    writeFileSync(join(dir, 'machines.json'), JSON.stringify({ machines: [{ machineId: 7 }, { machineId: 'machine-3' }] }))
    const t = setup([hachiRow(), row('api'), row('gone')])
    startedByHachi('api', SELF, '')
    startedByHachi('far', 'machine-3abcdef')
    // Started here and no longer live: not followed.
    startedByHachi('stale')
    await t.look()
    expect(t.lineFor(SELF, 'api').watched.at(-1)).toEqual(['api'])
    const here = t.lineFor(SELF, 'api'), away = t.lineFor('machine-3abcdef', 'far'), self = t.lineFor(SELF, 'hachi')
    here.push('api', 'agent_activity', { state: 'thinking' })
    here.push('api', 'agent_activity', { state: 'working' })
    away.push('far', 'harness_event', { state: 'sleeping' })
    away.push('far', 'harness_event', { state: 7 })
    away.push('far', 'harness_event', { state: 'idle' })
    here.push('api', 'turn_ended')
    here.push('nobody', 'turn_ended')
    // Hachi's other events are not its turns.
    self.push('hachi', 'agent_activity', { state: 'working' })
    await t.advance(WAKE_COALESCE_MS)
    const items = self.requests.find(([type]) => type === 'agent_messages')![1].items as Array<Record<string, string>>
    expect(items).toEqual([{ name: 'far', machine: 'machine-', state: 'done' }, { name: 'api', machine: expect.any(String), state: 'done' }])
    expect(items[1].machine).not.toBe('')
    expect(t.count.mock.calls.filter(([m]) => String(m).startsWith('hachi_turns_'))).toEqual([])
    t.service.stop()
  })

  it('reads a machine list with no machines as none', async () => {
    setAgentSettingsForTest(dir, { hachi: true })
    writeFileSync(join(dir, 'machines.json'), '{}')
    const t = setup([hachiRow()])
    startedByHachi('far', 'machine-2')
    await t.look()
    const away = t.lineFor('machine-2', 'far'), self = t.lineFor(SELF, 'hachi')
    away.push('far', 'harness_event', { state: 'needs_person' })
    await t.advance(WAKE_COALESCE_MS)
    expect(self.requests.find(([type]) => type === 'agent_messages')![1].items).toEqual([{ name: 'far', machine: 'machine-', state: 'needs_person' }])
    t.service.stop()
  })

  it('says a wake its mailbox refused, a watch refused or not pushed, and a look that failed, and goes on', async () => {
    setAgentSettingsForTest(dir, { hachi: true })
    const t = setup([hachiRow(), row('api')])
    startedByHachi('api')
    startedByHachi('far', 'machine-2')
    await t.look()
    const here = t.lineFor(SELF, 'api'), self = t.lineFor(SELF, 'hachi')
    self.answers.agent_messages = { error: 'HACHI_OFF' }
    here.push('api', 'agent_activity', { state: 'working' })
    here.push('api', 'turn_ended')
    await t.advance(WAKE_COALESCE_MS)
    expect(t.log).toHaveBeenCalledWith('[hachi] the wake was not taken: HACHI_OFF')
    expect(t.count).toHaveBeenCalledWith('hachi_mailbox_failed')
    // Another machine refused the watch (four others watch it), or answered with no list.
    const away = t.lineFor('machine-2', 'far')
    away.harnessWatch = async () => ({ error: 'TOO_MANY' })
    t.tick(4 * 60_000)
    await t.look()
    expect(t.log).toHaveBeenCalledWith('[hachi] could not follow what Hachi started on Mac mini: TOO_MANY. Asked again at the next look.')
    t.tick(1)
    await t.look()
    const again = t.lineFor('machine-2', 'far')
    again.harnessWatch = async (ids, heard) => { again.heard = heard; return { leaseMs: 1, agents: 'none' } as never }
    t.tick(4 * 60_000)
    await t.look()
    again.harnessWatch = async (ids, heard) => { again.heard = heard; return { agents: [{ agentId: 7 }, { agentId: 'far', state: 'idle' }] } }
    t.tick(4 * 60_000)
    await t.look()
    // This daemon too old to push to a tool.
    here.watch = async () => false
    await t.look()
    expect(t.log).toHaveBeenCalledWith('[hachi] could not follow what Hachi started on studio: this daemon does not push to tools. Asked again at the next look.')
    t.service.stop()
  })

  it('says a look that failed, by its message or what was thrown, and looks once at a time', async () => {
    setAgentSettingsForTest(dir, { hachi: true })
    let fail: unknown = null
    const t = setup([hachiRow()])
    t.service.stop()
    const failing = startHachi(fakeCore({ dataDir: dir }), {
      refresh: async () => { if (fail) throw fail },
      log: t.log, every: (_ms, run) => { t.files.set('every', run); return () => {} }, watchFile: () => () => {}, open: async () => new Line(SELF),
    })
    fail = new Error('the core went away')
    await t.look()
    fail = 'gone'
    await t.look()
    expect(t.log.mock.calls.map(([line]) => line)).toEqual(expect.arrayContaining(['[hachi] a look failed: the core went away', '[hachi] a look failed: gone']))
    // Asked twice while one runs: once more after it.
    fail = null
    const run = t.files.get('every')!
    run(); run(); run()
    await t.settle(); await t.settle(); await t.settle()
    failing.stop()
    // Stopped: asked again, it does nothing.
    run()
    await t.settle()
  })

  it('turned off with no Hachi running: nothing to close; one that would not close is said', async () => {
    setAgentSettingsForTest(dir, { hachi: true })
    const live = [hachiRow()]
    const t = setup(live)
    await t.look()
    live.splice(0)
    setAgentSettingsForTest(dir, { hachi: false })
    await t.look()
    expect(t.lines.flatMap((l) => l.requests).some(([type]) => type === 'agent_close')).toBe(false)
    // On again, and off with a Hachi that will not close.
    live.push(hachiRow())
    setAgentSettingsForTest(dir, { hachi: true })
    await t.look()
    const open = t.lines.length
    setAgentSettingsForTest(dir, { hachi: false })
    const settle = t.look()
    await settle
    const closer = t.lines.at(-1)!
    expect(t.lines.length).toBe(open + 1)
    expect(closer.requests.at(-1)![0]).toBe('agent_close')
    t.service.stop()
    const refusing = setup([hachiRow()])
    setAgentSettingsForTest(dir, { hachi: true })
    await refusing.look()
    const before = refusing.lines.length
    setAgentSettingsForTest(dir, { hachi: false })
    // The next line it opens refuses the close.
    const original = Line.prototype.request
    Line.prototype.request = async function (type, payload) { if (type === 'agent_close') return { error: 'SESSION_CHANGED' }; return original.call(this, type, payload) }
    try { await refusing.look() } finally { Line.prototype.request = original }
    expect(refusing.lines.length).toBe(before + 1)
    expect(refusing.log).toHaveBeenCalledWith('[hachi] Hachi is off, but Hachi could not be closed: SESSION_CHANGED')
    refusing.service.stop()
  })

  it('forgets what waited to wake a Hachi that is no longer running', async () => {
    setAgentSettingsForTest(dir, { hachi: true })
    const live = [hachiRow(), row('api')]
    const t = setup(live)
    startedByHachi('api')
    await t.look()
    const here = t.lineFor(SELF, 'api')
    here.push('api', 'agent_activity', { state: 'working' })
    here.push('api', 'turn_ended')
    live.splice(0, 1)
    await t.look()
    await t.advance(WAKE_COALESCE_MS)
    expect(t.lines.flatMap((l) => l.requests).some(([type]) => type === 'agent_messages')).toBe(false)
    expect(t.lines.filter((l) => !l.closed)).toEqual([])
    t.service.stop()
  })

  it('runs on its own defaults: the daemon\'s socket, real timers and file watches', async () => {
    vi.useFakeTimers()
    setAgentSettingsForTest(dir, { hachi: true })
    startedByHachi('api')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const core = fakeCore({ dataDir: dir, daemon: { machineId: () => SELF, port: 1 }, agents: { live: () => [hachiRow(), row('api')] } })
    const service = startHachi(core)
    await vi.advanceTimersByTimeAsync(FOLLOW_EVERY_MS)
    // No daemon listens in a test: the line to it fails, and is said.
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[hachi\] could not follow what Hachi started on studio: /))
    service.stop()
    // On lines that answer, a wake waits on a real timer, which a stop cancels.
    const lines: Line[] = []
    const following = startHachi(core, { open: async (machineId) => { const line = new Line(machineId); lines.push(line); return line } })
    await vi.advanceTimersByTimeAsync(0)
    const here = lines.find((l) => l.watched.some((w) => w.includes('api')))!
    here.push('api', 'agent_activity', { state: 'working' })
    here.push('api', 'turn_ended')
    following.stop()
    await vi.advanceTimersByTimeAsync(WAKE_COALESCE_MS)
    expect(lines.flatMap((l) => l.requests).some(([type]) => type === 'agent_messages')).toBe(false)
  })
})
