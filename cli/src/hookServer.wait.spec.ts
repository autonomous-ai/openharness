/**
 * A session's follow-up hooks that arrive while its admission is unsettled wait behind it, then run as they arrived
 * (docs/plans/2026-11-25-win-hook-admission-design.md, C): Claude Code on Windows sends SessionStart 2-3 s before its
 * transcript exists, and every Stop, tool and wait hook of those seconds was refused `UNBOUND_HOOK`, never sent again.
 * On the real registry and a real hook server: an agent bound to an old conversation, whose SessionStart for a new one
 * names a transcript not written yet, so it is held `DURABLE_ADMISSION_WAIT` until the test writes it and runs the 1 s
 * retry.
 */
import type { Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { HookServerHandlers } from './hookServer.js'
import type { SessionHookWaitBounds } from './core/engines/sessionHookWait.js'

// An evidence read's work budget is the host's clock: a loaded machine must not turn a read into a hold.
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
vi.mock('./lib/bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))
// Loads the module graph once, warm for each test's fresh import (vi.resetModules).
await import('./lib/registry.js'); await import('./hookServer.js')

const OLD = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const NEW = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', N = 'aaaaaaaa'
const CURSOR = 'cccccccc-3333-4333-8333-cccccccccccc'

let root: string, server: Server | undefined, agentId: string
let registry: typeof import('./lib/registry.js')['registry']
let lines: string[]
let wakers: Array<() => void> = []
/** Something was logged or a handler was called: whoever waits looks again. */
const wake = () => { for (const waker of wakers.splice(0)) waker() }
/** Until [done], looked at each time something was logged or a handler was called. */
async function until(done: () => boolean): Promise<void> {
  while (!done()) await new Promise<void>(resolve => wakers.push(resolve))
}
/** One turn of the loop: a drain starts by `setImmediate` after the call that settled its admission. */
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const firedAt = (at: number) => ({ 'x-harness-hook-fired-at': String(at) })
const transcript = (sessionId: string) => join(root, `${sessionId}.jsonl`)
const session = (sessionId: string, hookEvent = 'SessionStart', pane = '%1') => ({ engine: 'claude', sessionId,
  transcriptPath: transcript(sessionId), tmuxPane: pane, cwd: root, hookEvent })
const followUp = (extra: Record<string, unknown> = {}) => ({ engine: 'claude', sessionId: NEW, tmuxPane: '%1', cwd: root, ...extra })
const held = { status: 200, body: { pending: true } }
const unboundLine = (route: string) => `[hooks] ${N} ${route} refused · unbound`

beforeEach(async () => {
  // setImmediate stays real: replies flow, and a drain starts on it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  lines = []; wakers = []
  const say = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); wake() }
  vi.spyOn(console, 'log').mockImplementation(say)
  vi.spyOn(console, 'warn').mockImplementation(say)
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'hook-wait-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  vi.stubEnv('CLAUDE_PROJECTS_DIR', root)
  ;({ registry } = await import('./lib/registry.js'))
  agentId = (await registry.openProcessAgent({ engine: 'claude', tmuxPane: '%1', cwd: root,
    processIdentity: { pid: 5101, startMarker: 'fixture-start', executable: '<claude>' } }))!.entry.agentId
  writeFileSync(transcript(OLD), '{}\n')
  await registry.flush()
})
afterEach(async () => {
  vi.useRealTimers()
  if (server) await new Promise<void>(done => server!.close(() => done()))
  server = undefined
  await registry.flush().catch(() => {})
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

type Handlers = HookServerHandlers & Record<'onRegistered' | 'onSessionEnd' | 'onTurnStop' | 'onPersonWait' | 'onSubagent'
  | 'onToolStart' | 'onTurnStart' | 'onPromptHook', Mock>

/** A hook server whose agent is bound to OLD, as its engine's first SessionStart binds it. */
async function start(overrides: Partial<HookServerHandlers> = {}, hookWait?: Partial<SessionHookWaitBounds>) {
  const handlers = {
    onRegistered: vi.fn(wake), onSessionEnd: vi.fn(wake), onTurnStop: vi.fn(wake), onPersonWait: vi.fn(wake),
    onSubagent: vi.fn(wake), onToolStart: vi.fn(wake), onTurnStart: vi.fn(wake), onPromptHook: vi.fn(wake), ...overrides,
  } as Handlers
  const { startHookServer } = await import('./hookServer.js')
  const { readHookCredential } = await import('./lib/hookAuth.js')
  const started = await startHookServer(0, handlers, { peerAccount: async () => true, hookWait })
  server = started.server
  const token = readHookCredential(root)!
  const post = async (route: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${started.port}/api/hook/${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-harness-hook-token': token, ...headers }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as unknown }
  }
  expect(await post('session-start', session(OLD), firedAt(100))).toEqual({ status: 200, body: { ok: true } })
  handlers.onRegistered.mockClear()
  return { handlers, post }
}

type Post = Awaited<ReturnType<typeof start>>['post']

/** The new conversation's SessionStart, held until its transcript is written. */
async function holdStart(post: Post, headers: Record<string, string> = {}) {
  expect(await post('session-start', session(NEW), { ...firedAt(500), ...headers })).toEqual(held)
  expect(lines).toContain(`[hooks] ${N} SessionStart held · DURABLE_ADMISSION_WAIT · IdentityReadUnavailable IDENTITY_UNAVAILABLE`)
}

/** Drops the agent's admission receipts, as they are when its process changes, here changed and changed back: a delivery
 *  sent again then reaches the queue instead of its pending receipt. */
async function dropReceipts(post: Post) {
  await registry.openProcessAgent({ engine: 'claude', tmuxPane: '%2', cwd: root,
    processIdentity: { pid: 5102, startMarker: 'fixture-start', executable: '<claude>' } })
  const other = 'dddddddd-4444-4444-8444-dddddddddddd'
  writeFileSync(transcript(other), '{}\n')
  const real = registry.byAgent.bind(registry)
  const changed = vi.spyOn(registry, 'byAgent').mockImplementation(id => {
    const row = real(id)
    return id === agentId && row ? { ...row, processIdentity: { ...row.processIdentity!, pid: 9_999 } } : row
  })
  // Another agent's hook while this one's process reads as another: this one's receipts go.
  expect(await post('session-start', session(other, 'SessionStart', '%2'), firedAt(600))).toEqual({ status: 200, body: { ok: true } })
  changed.mockRestore()
}

/** The transcript is written and the held SessionStart's retry runs: the agent binds NEW. */
async function bind(handlers: Handlers) {
  writeFileSync(transcript(NEW), '{}\n')
  await vi.advanceTimersByTimeAsync(1_000)
  await until(() => handlers.onRegistered.mock.calls.some(([entry]) => entry.sessionId === NEW))
  expect(handlers.onRegistered).toHaveBeenCalledWith(expect.objectContaining({ sessionId: NEW }), expect.objectContaining({ rebound: OLD }))
}

const ROUTES = [
  ['turn-stop', { status: 'completed' }, 'onTurnStop',
    (at: number) => [{ sessionId: NEW, status: 'completed', transcriptPath: undefined, firedAt: at }]],
  ['wait', { hookEvent: 'PermissionRequest' }, 'onPersonWait', (at: number) => [{ sessionId: NEW, firedAt: at }]],
  ['subagent', { hookEvent: 'SubagentStart' }, 'onSubagent', (at: number) => [{ sessionId: NEW, started: true, firedAt: at }]],
  ['tool-start', { toolUseId: 'tool-1', toolName: 'Read', input: { file: '<file>' } }, 'onToolStart',
    () => [{ sessionId: NEW, toolUseId: 'tool-1', toolName: 'Read', input: { file: '<file>' } }]],
  ['turn-start', {}, 'onTurnStart', () => [{ sessionId: NEW }]],
  ['session-end', { reason: 'clear' }, 'onSessionEnd', () => [NEW, 'clear']],
] as const

describe('a follow-up hook of a session being admitted', () => {
  it.each(ROUTES)('a %s hook of a session whose SessionStart is held waits, then runs after the session is bound', async (route, extra, name, expected) => {
    const { handlers, post } = await start()
    await holdStart(post)
    expect(await post(route, followUp(extra), firedAt(1_000))).toEqual(held)
    await turn()
    expect(handlers[name]).not.toHaveBeenCalled()
    expect(lines).toContain(`[hooks] ${N} ${route} waits for its session's admission`)
    await bind(handlers)
    await until(() => handlers[name].mock.calls.length > 0)
    expect(handlers[name].mock.calls).toEqual([expected(1_000)])
    // After the bind's announcement: a Stop replayed while the old conversation is still being forgotten ends the new one.
    expect(handlers[name].mock.invocationCallOrder[0]).toBeGreaterThan(handlers.onRegistered.mock.invocationCallOrder[0]!)
    await until(() => lines.includes(`[hooks] ${N} waiting hooks ran · 1`))
  })

  it('waits during the process-record wait', async () => {
    let record: Promise<void> | undefined, recorded!: () => void
    const resolveHookAgent = vi.fn(async ({ onWait }: { onWait?: () => void }) => {
      if (onWait && record) { onWait(); await record }
      return registry.byPaneEngine('%1', 'claude') ?? null
    })
    const { handlers, post } = await start({ resolveHookAgent })
    writeFileSync(transcript(NEW), '{}\n')
    record = new Promise<void>(resolve => { recorded = resolve })
    const started = await post('session-start', session(NEW), firedAt(500))
    expect(started).toMatchObject({ status: 202, body: { pending: false, retry: true } })
    expect(await post('turn-stop', followUp(), firedAt(1_000))).toEqual(held)
    await turn()
    expect(handlers.onTurnStop).not.toHaveBeenCalled()
    recorded()
    await until(() => handlers.onTurnStop.mock.calls.length > 0)
    expect(handlers.onTurnStop).toHaveBeenCalledWith({ sessionId: NEW, status: undefined, transcriptPath: undefined, firedAt: 1_000 })
    expect(handlers.onTurnStop.mock.invocationCallOrder[0]).toBeGreaterThan(handlers.onRegistered.mock.invocationCallOrder[0]!)
  })

  it('runs a session\'s waiting hooks in arrival order, each with its own fired-at', async () => {
    const { handlers, post } = await start()
    await holdStart(post)
    expect(await post('wait', followUp({ hookEvent: 'PermissionRequest' }), firedAt(1_000))).toEqual(held)
    expect(await post('subagent', followUp({ hookEvent: 'SubagentStop' }), firedAt(1_001))).toEqual(held)
    expect(await post('turn-stop', followUp(), firedAt(1_002))).toEqual(held)
    // One line for the three: they wait behind the same admission.
    expect(lines.filter(line => line.includes('waits for its session\'s admission'))).toEqual([`[hooks] ${N} wait waits for its session's admission`])
    await bind(handlers)
    await until(() => lines.includes(`[hooks] ${N} waiting hooks ran · 3`))
    expect(handlers.onPersonWait).toHaveBeenCalledWith({ sessionId: NEW, firedAt: 1_000 })
    expect(handlers.onSubagent).toHaveBeenCalledWith({ sessionId: NEW, started: false, firedAt: 1_001 })
    expect(handlers.onTurnStop).toHaveBeenCalledWith({ sessionId: NEW, status: undefined, transcriptPath: undefined, firedAt: 1_002 })
    const order = [handlers.onPersonWait, handlers.onSubagent, handlers.onTurnStop].map(handler => handler.mock.invocationCallOrder[0]!)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('admits a later prompt while an earlier Stop waits', async () => {
    const { handlers, post } = await start()
    await holdStart(post)
    expect(await post('turn-stop', followUp(), firedAt(1_000))).toEqual(held)
    // Its own delivery: queued behind the SessionStart of its conversation, never behind the Stop.
    expect(await post('session-start', { ...session(NEW, 'UserPromptSubmit'), prompt: 'go on' }, firedAt(1_001))).toEqual(held)
    await bind(handlers)
    await until(() => handlers.onPromptHook.mock.calls.length > 0 && handlers.onTurnStop.mock.calls.length > 0)
    expect(handlers.onPromptHook).toHaveBeenCalledWith(NEW, 1_001)
    // The turn layer orders the two by when their engine ran them (core/turns/turnHooks.ts).
    expect(handlers.onTurnStop).toHaveBeenCalledWith({ sessionId: NEW, status: undefined, transcriptPath: undefined, firedAt: 1_000 })
  })

  it('refuses the waiting hooks of a rejected admission with the once-a-minute line', async () => {
    const { handlers, post } = await start()
    await holdStart(post)
    expect(await post('turn-stop', followUp(), firedAt(1_000))).toEqual(held)
    expect(await post('wait', followUp({ hookEvent: 'PermissionRequest' }), firedAt(1_001))).toEqual(held)
    // The agent left: the held SessionStart's retry rejects it `stale_hook`, as a Codex subagent's child is rejected.
    registry.setActive(agentId, false)
    await vi.advanceTimersByTimeAsync(1_000)
    await until(() => lines.includes(`[hooks] ${N} waiting hooks ran · 2`))
    expect(lines).toContain(`[hooks] ${N} SessionStart ignored · stale_hook`)
    expect(lines.filter(line => line.includes('refused · unbound'))).toEqual([unboundLine('turn-stop')])
    expect(handlers.onTurnStop).not.toHaveBeenCalled()
    expect(handlers.onPersonWait).not.toHaveBeenCalled()
  })

  it('runs at once over the session\'s bound, and says so', async () => {
    const { handlers, post } = await start({}, { perSession: 1 })
    await holdStart(post)
    expect(await post('turn-stop', followUp(), firedAt(1_000))).toEqual(held)
    expect(await post('wait', followUp({ hookEvent: 'PermissionRequest' }), firedAt(1_001))).toEqual({ status: 403, body: { error: 'UNBOUND_HOOK' } })
    expect(lines).toContain(`[hooks] ${N} wait runs unheld · session_full`)
    expect(lines).toContain(unboundLine('wait'))
    expect(handlers.onPersonWait).not.toHaveBeenCalled()
  })

  it('runs a hook past its time at once', async () => {
    const { handlers, post } = await start({}, { maxWaitMs: 2_000 })
    await holdStart(post)
    expect(await post('turn-stop', followUp(), firedAt(1_000))).toEqual(held)
    await vi.advanceTimersByTimeAsync(2_000)
    await until(() => lines.includes(unboundLine('turn-stop')))
    expect(lines).toContain(`[hooks] ${N} turn-stop runs unheld · timed_out`)
    expect(handlers.onTurnStop).not.toHaveBeenCalled()
  })

  it('runs a bound session\'s hook at once while its prompt is re-admitted', async () => {
    let blocked = false
    const { handlers, post } = await start({ hookAdmissionBlocked: () => blocked })
    blocked = true
    expect(await post('session-start', { ...session(OLD, 'UserPromptSubmit'), prompt: 'go on' }, firedAt(900))).toEqual(held)
    expect(lines).toContain('[hooks] bbbbbbbb UserPromptSubmit held · STOP_SETTLING')
    expect(await post('turn-stop', { ...followUp(), sessionId: OLD }, firedAt(1_000))).toEqual({ status: 200, body: { ok: true } })
    expect(handlers.onTurnStop).toHaveBeenCalledWith({ sessionId: OLD, status: undefined, transcriptPath: undefined, firedAt: 1_000 })
    expect(lines.filter(line => line.includes('waits for'))).toEqual([])
  })

  it('refuses at once a hook of an unbound session with nothing being admitted', async () => {
    const { handlers, post } = await start()
    expect(await post('turn-stop', followUp(), firedAt(1_000))).toEqual({ status: 403, body: { error: 'UNBOUND_HOOK' } })
    expect(lines).toContain(unboundLine('turn-stop'))
    expect(lines.filter(line => line.includes('waits for'))).toEqual([])
    expect(handlers.onTurnStop).not.toHaveBeenCalled()
  })

  it('treats a SessionStart sent again with the same delivery id as the same admission', async () => {
    const { handlers, post } = await start()
    const delivery = { 'x-harness-hook-delivery-id': 'fixture-delivery-0001' }
    await holdStart(post, delivery)
    // Answered from its pending receipt.
    expect(await post('session-start', session(NEW), { ...firedAt(500), ...delivery })).toEqual(held)
    expect(await post('turn-stop', followUp(), firedAt(1_000))).toEqual(held)
    await turn()
    expect(handlers.onTurnStop).not.toHaveBeenCalled()
    await bind(handlers)
    await until(() => lines.includes(`[hooks] ${N} waiting hooks ran · 1`))
    expect(handlers.onTurnStop).toHaveBeenCalledOnce()
    expect(handlers.onTurnStop.mock.invocationCallOrder[0]).toBeGreaterThan(handlers.onRegistered.mock.invocationCallOrder[0]!)
  })

  // pendingAdmission keeps a delivery's older job while it is current and drops the newer request, whose callbacks then
  // never run: the kept job's end settles the delivery.
  it('settles a SessionStart sent again whose older job was kept by that job\'s end', async () => {
    const { handlers, post } = await start()
    // The process change drops the queue's watermark too, so the next look orders against the binding's own time.
    const delivery = { ...firedAt(Date.now() + 60_000), 'x-harness-hook-delivery-id': 'fixture-delivery-0002' }
    await holdStart(post, delivery)
    expect(await post('turn-stop', followUp(), firedAt(1_000))).toEqual(held)
    await dropReceipts(post)
    expect(await post('session-start', session(NEW), delivery)).toEqual(held)
    // Kept, not replaced: a new job would have been inspected and held on its own.
    expect(lines.filter(line => line.includes(`${N} SessionStart held`))).toHaveLength(1)
    await bind(handlers)
    await until(() => handlers.onTurnStop.mock.calls.length > 0)
    expect(handlers.onTurnStop).toHaveBeenCalledWith({ sessionId: NEW, status: undefined, transcriptPath: undefined, firedAt: 1_000 })
  })

  // Rejected `stale_hook`, as a replaced job ends, it still ends its delivery: unsettled, every later unbound hook of the
  // session would wait out its time limit and be refused then.
  it('settles a SessionStart sent again whose kept older job ends stale_hook', async () => {
    const { handlers, post } = await start({}, { maxWaitMs: 60_000 })
    const delivery = { ...firedAt(Date.now() + 60_000), 'x-harness-hook-delivery-id': 'fixture-delivery-0002' }
    await holdStart(post, delivery)
    expect(await post('turn-stop', followUp(), firedAt(1_000))).toEqual(held)
    await dropReceipts(post)
    expect(await post('session-start', session(NEW), delivery)).toEqual(held)
    expect(lines.filter(line => line.includes(`${N} SessionStart held`))).toHaveLength(1)
    // The agent left: the kept job's retry rejects it `stale_hook`.
    registry.setActive(agentId, false)
    await vi.advanceTimersByTimeAsync(1_000)
    await until(() => lines.includes(`[hooks] ${N} SessionStart ignored · stale_hook`))
    await turn(); await turn()
    // Refused at its replay, long before its time limit, and the next hook at once.
    expect(lines).toContain(unboundLine('turn-stop'))
    expect(lines.filter(line => line.includes('runs unheld'))).toEqual([])
    expect(await post('turn-stop', followUp(), firedAt(2_000))).toEqual({ status: 403, body: { error: 'UNBOUND_HOOK' } })
    expect(handlers.onTurnStop).not.toHaveBeenCalled()
  })

  it('keeps the Cursor linked Stop on its own path', async () => {
    let blocked = false
    const { post } = await start({ hookAdmissionBlocked: () => blocked })
    await registry.openProcessAgent({ engine: 'cursor', tmuxPane: '%3', cwd: root,
      processIdentity: { pid: 5103, startMarker: 'fixture-start', executable: '<cursor>' } })
    blocked = true
    const delivery = { 'x-harness-hook-delivery-id': 'fixture-delivery-0003' }
    const stop = { engine: 'cursor', sessionId: CURSOR, tmuxPane: '%3', cwd: root, status: 'completed' }
    expect(await post('session-start', { ...stop, hookEvent: 'stop' }, { ...firedAt(700), ...delivery })).toEqual(held)
    // Parked by its registration, which claims it once admitted.
    expect(await post('turn-stop', stop, { ...firedAt(700), ...delivery })).toEqual(held)
    expect(lines.filter(line => line.includes('waits for'))).toEqual([])
  })

  it('names no body text in its lines', async () => {
    const { handlers, post } = await start()
    await holdStart(post)
    expect(await post('tool-start', followUp({ toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'cat sentinel-file' } }),
      firedAt(1_000))).toEqual(held)
    expect(await post('turn-stop', followUp({ transcriptPath: join(root, 'sentinel-dir', 'x.jsonl') }), firedAt(1_001))).toEqual(held)
    expect(await post('session-start', { ...session(NEW, 'UserPromptSubmit'), prompt: 'a sentinel prompt' }, firedAt(1_002))).toEqual(held)
    await bind(handlers)
    await until(() => lines.includes(`[hooks] ${N} waiting hooks ran · 2`) && handlers.onPromptHook.mock.calls.length > 0)
    expect(handlers.onToolStart).toHaveBeenCalledOnce()
    expect(lines.join('\n')).not.toContain('sentinel')
  })
})
