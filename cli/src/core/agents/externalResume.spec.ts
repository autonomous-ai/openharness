import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { externalReservations, type ExternalResumeIntent } from '../../lib/externalResume.js'
import { externalUnavailable, type ExternalSessionAnswer, type ExternalSessionRequest } from '../../lib/externalSessionWire.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { claudeProvider } from '../../lib/sessionSearch/externals/claude.js'
import type { ProcessView, RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import { createExternalSessions } from '../../services/externalSessions.js'
import { createExternalResumes, type ExternalResumeDeps } from './externalResume.js'
import { stopExternalOwner } from './externalOwner.js'
vi.mock('./externalOwner.js', () => ({ stopExternalOwner: vi.fn(async () => false) }))

const cwd = mkdtempSync(join(tmpdir(), 'external-resume-'))
afterAll(() => rmSync(cwd, { recursive: true, force: true }))
const controllers: ReturnType<typeof createExternalResumes>[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { for (const controller of controllers.splice(0)) controller.stop(); vi.restoreAllMocks(); vi.useRealTimers() })
const fact = { sessionId: 'conversation', engine: 'claude' as const, cwd, title: 'Named conversation', origin: 'terminal' as const, mtime: 1, transcriptPath: join(cwd, 'conversation.jsonl') }
const processOwner = { pid: 7, engine: 'claude' as const, tty: '/dev/fixture-terminal', record: '/fixture/record' }
const free = (request: ExternalSessionRequest): ExternalSessionAnswer => ({ ok: true, request, session: { ...fact, sessionId: request.sessionId }, owner: null, generation: null, busy: false })
const held = (request: ExternalSessionRequest, busy = false): ExternalSessionAnswer => ({ ...free(request), owner: processOwner, generation: 'ps:1', busy,
  ...(busy ? { busyConfirmed: true } : {}) }) as ExternalSessionAnswer
const input = (extra = {}) => ({ engine: 'claude', cwd, bypassPermission: false, permissionMode: null, grid: null, codexHome: null, dsh: null,
  prompt: null, name: null, agent: null, resumeSessionId: 'conversation', takeOver: null, ...extra }) as Parameters<ReturnType<typeof createExternalResumes>['create']>[0]
const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

function setup() {
  const rows = new Map<string, RegisteredSession>(), panes = new Map<string, string>()
  let next = 0, cancelled = false
  const conflict: ExternalResumeDeps['registry']['externalConflict'] = (ids, except) => [...rows.values()].find(row => row.agentId !== except && externalReservations(row).some(id => ids.includes(id)))
  const registry: ExternalResumeDeps['registry'] = {
    byAgent: id => rows.get(id), list: () => [...rows.values()], externalConflict: conflict,
    openPendingAgent: vi.fn(given => {
      if (conflict(externalReservations({ sessionId: '', externalResume: given.externalResume }))) return null
      const row = { ...given, schemaVersion: 2, agentId: `agent-${++next}`, sessionId: '', registeredAt: 1,
        boundAt: null, processIdentity: null, active: false, launch: { state: 'held', service: 'search', detail: externalUnavailable().detail },
        tmuxPane: given.runtimes[0].backend === 'tmux' ? given.runtimes[0].paneId : '',
      } as RegisteredSession
      rows.set(row.agentId, row); return row
    }),
    setExternalResume: vi.fn((id, intent) => {
      const old = rows.get(id)
      if (!old || conflict(externalReservations({ sessionId: intent.phase === 'admitted' ? intent.session!.sessionId : '', externalResume: intent }), id)) return null
      const row = { ...old, externalResume: structuredClone(intent), ...(intent.phase === 'admitted' ? { sessionId: intent.session!.sessionId, cwd: intent.session!.cwd, resumeOnly: true as const } : {}) }
      rows.set(id, row); return row
    }),
    setLaunch: vi.fn((id, launch) => { const row = rows.get(id); if (!row) return null; row.launch = launch; return row }),
    finishExternalCancellation: vi.fn(id => rows.delete(id)),
  }
  let paneSequence = 0
  const create = vi.fn<NonNullable<ExternalResumeDeps['tmux']>['create']>(async request => {
    if (request.current?.() === false) return { state: 'failed', dispatch: 'not_started', reason: 'cancelled' }
    const paneId = `%${++paneSequence}`
    panes.set(paneId, request.command!.at(-1)!)
    return { state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId } }
  })
  const killHeld = vi.fn<NonNullable<ExternalResumeDeps['tmux']>['killHeld']>(async (runtime, token, current) => {
    if (!current() || panes.has(runtime.paneId) && panes.get(runtime.paneId) !== token) return { state: 'failed', dispatch: 'not_started', reason: 'pane changed' }
    panes.delete(runtime.paneId); return { state: 'succeeded', dispatch: 'executed' }
  })
  const inspect = vi.fn(async (request: ExternalSessionRequest) => free(request))
  const deps: ExternalResumeDeps = {
    registry, tmux: { create, killHeld }, inspect, generation: () => 1,
    stopped: vi.fn(() => []), cancelled: () => cancelled,
    waiting: vi.fn(async row => panes.get(row.tmuxPane) === row.externalResume?.token),
    preflight: vi.fn(async () => null), announce: vi.fn(), launch: vi.fn(),
    forget: vi.fn(id => { expect(rows.has(id)).toBe(false) }),
    stopOwner: vi.fn(async (_owner, control) => {
      if (!control.current() || !await control.same()) return false
      control.beforeSignal?.('SIGTERM'); control.afterSignal?.('SIGTERM')
      inspect.mockImplementation(async request => free(request))
      return true
    }),
  }
  const controller = createExternalResumes(deps); controllers.push(controller); controller.open()
  const stage = async (extra = {}) => {
    const result = await controller.create(input(extra))
    if (!result.ok) throw new Error(result.error)
    return result.session.agentId
  }
  return { deps, registry, rows, panes, inspect, create, killHeld, controller, stage, cancelWork: () => { cancelled = true } }
}

it('persists an inert held intent during search outage, then admits and launches the exact conversation', async () => {
  const test = setup(); test.inspect.mockResolvedValue(externalUnavailable('Reader unavailable.'))
  const id = await test.stage({ name: 'Mine', codexHome: '/fixture/profile' })
  await test.controller.settled()
  expect(test.rows.get(id)).toMatchObject({ sessionId: '', cwd: null, defaultName: 'Mine', launch: { state: 'held', detail: 'Reader unavailable.' }, externalResume: { phase: 'waiting' } })
  expect(test.deps.preflight).not.toHaveBeenCalled(); expect(test.deps.launch).not.toHaveBeenCalled()
  test.inspect.mockImplementation(async request => free(request))
  await vi.advanceTimersByTimeAsync(2000); await test.controller.settled()
  expect(test.rows.get(id)).toMatchObject({ sessionId: 'conversation', cwd, resumeOnly: true, externalResume: { phase: 'admitted' } })
  expect(test.deps.launch).toHaveBeenCalledOnce()
  test.inspect.mockRejectedValue(new Error('search died again'))
  await vi.advanceTimersByTimeAsync(4000)
  expect(test.deps.launch).toHaveBeenCalledOnce()
  expect(await test.controller.cancel(test.rows.get(id)!)).toBe(false)
})

it('preserves known refusals before creating a pane, but holds thrown or malformed observations', async () => {
  for (const value of [externalUnavailable(), { nonsense: true }, new Error('search failed')]) {
    const test = setup()
    if (value instanceof Error) test.inspect.mockRejectedValue(value)
    else test.inspect.mockResolvedValue(value as ExternalSessionAnswer)
    const id = await test.stage(); await test.controller.settled()
    expect(test.rows.get(id)?.launch?.state).toBe('held')
  }
  const test = setup(); test.inspect.mockImplementation(async request => ({ ...free(request), session: null }))
  expect(await test.controller.create(input())).toMatchObject({ ok: false, error: 'SESSION_NOT_FOUND' })
  expect(test.create).not.toHaveBeenCalled()
  expect(await test.controller.create(input({ engine: 'terminal' }))).toMatchObject({ error: 'INVALID_SESSION' })
  test.deps.tmux = null
  expect(await test.controller.create(input())).toMatchObject({ error: 'TMUX_UNAVAILABLE' })
})

it('holds busy waits outside the shared restore queue, pins ownership and journals actual interruption', async () => {
  const test = setup(); test.inspect.mockImplementation(async request => held(request, true))
  const id = await test.stage({ takeOver: 'wait' }); await test.controller.settled()
  expect(test.rows.get(id)?.launch).toMatchObject({ state: 'held', detail: expect.stringContaining('current turn') })
  expect(test.deps.stopOwner).not.toHaveBeenCalled()
  test.inspect.mockImplementation(async request => held(request, false))
  await vi.advanceTimersByTimeAsync(2000); await test.controller.settled()
  expect(test.rows.get(id)?.externalResume).toMatchObject({ phase: 'admitted', signal: 'sent' })
  expect(test.rows.get(id)?.externalResume?.continue).toBeUndefined()
  const now = setup(); now.inspect.mockImplementation(async request => held(request, true))
  const busy = await now.stage({ takeOver: 'now' }); await now.controller.settled()
  expect(now.rows.get(busy)?.externalResume).toMatchObject({ phase: 'admitted', signal: 'sent', continue: true })
})

it('never transfers takeover permission to a replacement owner or interrupts work under idle consent', async () => {
  const test = setup(), waiting = defer<null>()
  test.inspect.mockImplementation(async request => held(request))
  vi.mocked(test.deps.preflight).mockReturnValueOnce(waiting.promise)
  const id = await test.stage({ takeOver: 'idle' })
  await vi.waitFor(() => expect(test.deps.preflight).toHaveBeenCalled())
  test.inspect.mockImplementation(async request => held(request, true))
  waiting.resolve(null); await test.controller.settled()
  expect(test.rows.get(id)?.externalResume?.signal).toBeUndefined()
  expect(test.rows.get(id)?.externalResume?.phase).toBe('quitting')
  expect(test.deps.launch).not.toHaveBeenCalled()
  test.inspect.mockImplementation(async request => ({ ...held(request), owner: { ...processOwner, pid: 8 }, generation: 'ps:2' }) as ExternalSessionAnswer)
  await vi.advanceTimersByTimeAsync(2000); await test.controller.settled()
  expect(test.rows.get(id)?.launch).toMatchObject({ detail: expect.stringContaining('another process') })
  expect(test.deps.stopOwner).toHaveBeenCalledTimes(1)
})

it('explicit takeover of unknown activity never manufactures a continuation prompt', async () => {
  const test = setup()
  test.inspect.mockImplementation(async request => ({ ...held(request), busy: true }))
  const id = await test.stage({ takeOver: 'now' }); await test.controller.settled()
  expect(test.rows.get(id)?.externalResume).toMatchObject({ phase: 'admitted', signal: 'sent' })
  expect(test.rows.get(id)?.externalResume?.continue).toBeUndefined()
})

it.each([null, 'idle', 'wait'] as const)('holds unknown activity with %s consent and names the missing evidence', async takeOver => {
  const test = setup(); test.inspect.mockImplementation(async request => ({ ...held(request), busy: true }))
  const id = await test.stage({ takeOver }); await test.controller.settled()
  expect(test.rows.get(id)?.launch).toMatchObject({ state: 'held', detail: expect.stringContaining('verify whether') })
  expect(test.deps.stopOwner).not.toHaveBeenCalled(); expect(test.deps.launch).not.toHaveBeenCalled()
  test.inspect.mockImplementation(async request => held(request, true))
  if (takeOver !== 'wait') expect(await test.controller.create(input({ resumeSessionId: 'another', takeOver }))).toMatchObject({ error: 'SESSION_BUSY_IN_TERMINAL' })
})

it.each(['pane', 'cancelled-pane', 'unavailable', 'missing'] as const)('withholds every signal when the last %s observation cannot prove ownership', async point => {
  const test = setup(); test.inspect.mockImplementation(async request => held(request))
  vi.mocked(test.deps.stopOwner!).mockImplementation(async (_owner, control) => {
    if (point === 'pane') vi.mocked(test.deps.waiting).mockResolvedValue(false)
    else if (point === 'cancelled-pane') vi.mocked(test.deps.waiting).mockImplementation(async () => { test.cancelWork(); return true })
    else test.inspect.mockImplementation(async request => point === 'unavailable' ? externalUnavailable() : { ...free(request), session: null })
    expect(await control.same()).toBe(false)
    return false
  })
  const id = await test.stage({ takeOver: 'idle' }); await test.controller.settled()
  expect(test.rows.get(id)?.externalResume?.signal).toBeUndefined()
  expect(test.deps.launch).not.toHaveBeenCalled()
})

it('rechecks reservations and metadata before signalling and before committing a free admission', async () => {
  for (const mode of ['reserved', 'archived', 'cwd', 'record', 'args', 'busy', 'unavailable'] as const) {
    const test = setup(), waiting = defer<null>()
    test.inspect.mockImplementation(async request => held(request))
    vi.mocked(test.deps.preflight).mockReturnValueOnce(waiting.promise)
    const id = await test.stage({ takeOver: 'idle' })
    await vi.waitFor(() => expect(test.deps.preflight).toHaveBeenCalled())
    if (mode === 'reserved') test.rows.set('other', { agentId: 'other', sessionId: 'conversation' } as RegisteredSession)
    else test.inspect.mockImplementation(async request => mode === 'unavailable' ? externalUnavailable() : ({ ...held(request),
      busy: mode === 'busy', session: { ...fact, ...(mode === 'archived' ? { archived: true } : {}),
        ...(mode === 'cwd' ? { cwd: join(cwd, 'changed') } : {}), ...(mode === 'record' ? { transcriptPath: '/fixture/other' } : {}),
        ...(mode === 'args' ? { launchArgs: ['--unapproved'] } : {}) } }) as ExternalSessionAnswer)
    waiting.resolve(null); await test.controller.settled()
    expect(test.rows.get(id)?.externalResume?.phase).not.toBe('admitted')
    expect(test.rows.get(id)?.externalResume?.signal).toBeUndefined()
    expect(test.deps.launch).not.toHaveBeenCalled()
    test.controller.stop()
  }
  for (const mode of ['owner', 'metadata', 'archived', 'unavailable'] as const) {
    const test = setup(), waiting = defer<null>()
    vi.mocked(test.deps.preflight).mockReturnValueOnce(waiting.promise)
    const id = await test.stage()
    await vi.waitFor(() => expect(test.deps.preflight).toHaveBeenCalled())
    test.inspect.mockImplementation(async request => mode === 'unavailable' ? externalUnavailable() : mode === 'owner' ? held(request) :
      ({ ...free(request), session: { ...fact, ...(mode === 'metadata' ? { transcriptPath: '/fixture/changed' } : { archived: true }) } }))
    waiting.resolve(null); await test.controller.settled()
    expect(test.rows.get(id)?.externalResume?.phase).toBe('waiting')
    expect(test.deps.launch).not.toHaveBeenCalled()
    test.controller.stop()
  }
})

it.each(['binding', 'stopped'] as const)('a new %s fences signals even after the final owner read, and holds without another service read', async kind => {
  const test = setup(); test.inspect.mockImplementation(async request => held(request))
  vi.mocked(test.deps.stopOwner!).mockImplementation(async (_owner, control) => {
    expect(await control.same()).toBe(true)
    if (kind === 'binding') test.rows.set('other', { agentId: 'other', sessionId: 'conversation' } as RegisteredSession)
    else vi.mocked(test.deps.stopped).mockReturnValue([{ sessionId: 'conversation' }])
    expect(control.current()).toBe(false)
    expect(() => control.beforeSignal?.('SIGTERM')).toThrow('Signal intent could not be saved')
    return false
  })
  const id = await test.stage({ takeOver: 'idle' }); await test.controller.settled()
  expect(test.rows.get(id)?.externalResume?.signal).toBeUndefined()
  test.inspect.mockClear()
  await vi.advanceTimersByTimeAsync(4000); await test.controller.settled()
  expect(test.inspect).not.toHaveBeenCalled()
  expect(test.rows.get(id)?.launch).toMatchObject({ state: 'held', detail: expect.stringContaining('another harness') })
  expect(test.deps.launch).not.toHaveBeenCalled()
})

it('Stop cancels a slow read without waiting, closes only its inert pane and durably removes before forgetting', async () => {
  const test = setup(), reading = defer<ExternalSessionAnswer>()
  test.inspect.mockResolvedValueOnce(externalUnavailable()).mockReturnValueOnce(reading.promise)
  const id = await test.stage()
  await vi.waitFor(() => expect(test.inspect).toHaveBeenCalledTimes(2))
  expect(await test.controller.cancel(test.rows.get(id)!)).toBe(true)
  expect(test.registry.finishExternalCancellation).toHaveBeenCalledWith(id)
  expect(test.deps.forget).toHaveBeenCalledWith(id)
  reading.resolve(free({ sessionId: 'conversation', engine: 'claude' })); await test.controller.settled()
  expect(test.rows.size).toBe(0); expect(test.deps.launch).not.toHaveBeenCalled(); expect(test.deps.stopOwner).not.toHaveBeenCalled()
})

it('keeps cancellation durable when the pane was replaced, and cleans it after a crash without asking search', async () => {
  const test = setup(); test.inspect.mockResolvedValue(externalUnavailable())
  const id = await test.stage(); await test.controller.settled()
  const row = test.rows.get(id)!; test.panes.set(row.tmuxPane, 'replacement')
  await expect(test.controller.cancel(row)).rejects.toThrow('stays cancelled')
  expect(test.rows.get(id)?.externalResume?.phase).toBe('cancelled')
  test.inspect.mockClear(); test.controller.stop()
  test.panes.delete(row.tmuxPane)
  const reboot = createExternalResumes(test.deps); controllers.push(reboot); reboot.open(); await reboot.settled()
  expect(test.inspect).not.toHaveBeenCalled(); expect(test.rows.has(id)).toBe(false)
})

it('four held requests cannot starve a later free conversation', async () => {
  const test = setup(); test.inspect.mockImplementation(async request => request.sessionId.startsWith('busy') ? held(request, true) : free(request))
  for (let i = 0; i < 4; i++) await test.stage({ resumeSessionId: `busy-${i}`, takeOver: 'wait' })
  const ready = await test.stage({ resumeSessionId: 'free-later' })
  await vi.advanceTimersByTimeAsync(4000); await test.controller.settled()
  expect(test.rows.get(ready)?.externalResume?.phase).toBe('admitted')
  for (const row of test.rows.values()) if (row.agentId !== ready) expect(row.externalResume?.phase).toBe('waiting')
})

it('fences Stop, changed routes, permission changes, unexpected processes and a replaced waiting shell', async () => {
  for (const change of ['stop', 'route', 'permission', 'process', 'pane'] as const) {
    const test = setup(), waiting = defer<null>()
    vi.mocked(test.deps.preflight).mockReturnValueOnce(waiting.promise)
    const id = await test.stage()
    await vi.waitFor(() => expect(test.deps.preflight).toHaveBeenCalled())
    const row = test.rows.get(id)!
    if (change === 'stop') test.cancelWork()
    if (change === 'route') row.runtimes = [{ backend: 'tmux', paneId: '%99' }]
    if (change === 'permission') row.permissionMode = 'auto'
    if (change === 'process') row.processIdentity = { pid: 8, executable: 'other', startMarker: 'ps:2' }
    if (change === 'pane') test.panes.set(row.tmuxPane, 'replacement')
    waiting.resolve(null); await test.controller.settled()
    expect(test.deps.launch).not.toHaveBeenCalled()
    test.controller.stop()
  }
})

it('does no admission before readiness or after shutdown, including an already-running create read', async () => {
  const test = setup(), ready = createExternalResumes(test.deps); controllers.push(ready)
  expect(await ready.create(input())).toMatchObject({ error: 'CORE_NOT_READY' })
  ready.wake(); expect(test.create).not.toHaveBeenCalled()
  const reading = defer<ExternalSessionAnswer>(); test.inspect.mockReturnValue(reading.promise)
  const creating = test.controller.create(input()); await Promise.resolve()
  test.controller.stop(); reading.resolve(free({ sessionId: 'conversation', engine: 'claude' }))
  expect(await creating).toMatchObject({ error: 'CORE_NOT_READY' })
  expect(test.create).not.toHaveBeenCalled()
})

it('holds storage/preflight failures and known late refusals without launching or losing intent', async () => {
  for (const mode of ['storage', 'null-commit', 'preflight', 'throws', 'late-missing'] as const) {
    const test = setup()
    if (mode === 'storage') vi.mocked(test.registry.setExternalResume).mockImplementation(() => { throw new Error('disk full') })
    if (mode === 'null-commit') vi.mocked(test.registry.setExternalResume).mockReturnValue(null)
    if (mode === 'preflight') vi.mocked(test.deps.preflight).mockResolvedValue({ detail: 'Engine unavailable.' })
    if (mode === 'throws') vi.mocked(test.deps.preflight).mockRejectedValue(new Error('preparation unreadable'))
    if (mode === 'late-missing') test.inspect.mockImplementationOnce(async request => free(request)).mockImplementation(async request => ({ ...free(request), session: null }))
    const id = await test.stage(); await test.controller.settled()
    expect(test.rows.get(id)?.externalResume?.phase).toBe('waiting'); expect(test.deps.launch).not.toHaveBeenCalled()
    test.controller.stop()
  }
})

it('does not begin stopping an owner when the quitting journal cannot commit', async () => {
  const test = setup(); test.inspect.mockImplementation(async request => held(request))
  const save = test.registry.setExternalResume
  test.registry.setExternalResume = (id, intent) => intent.phase === 'quitting' ? null : save(id, intent)
  const id = await test.stage({ takeOver: 'idle' }); await test.controller.settled()
  expect(test.rows.get(id)?.externalResume?.phase).toBe('waiting')
  expect(test.deps.stopOwner).not.toHaveBeenCalled()
  expect(test.deps.launch).not.toHaveBeenCalled()
})

it('reserves stopped conversations before any pane exists and cleans up an allocation whose durable claim fails', async () => {
  const test = setup()
  vi.mocked(test.deps.stopped).mockReturnValue([{ sessionId: 'conversation' }])
  expect(await test.controller.create(input())).toMatchObject({ error: 'SESSION_IN_HARNESS' })
  expect(test.create).not.toHaveBeenCalled()
  vi.mocked(test.deps.stopped).mockReturnValue([])
  vi.mocked(test.registry.openPendingAgent).mockReturnValue(null)
  expect(await test.controller.create(input())).toMatchObject({ ok: false })
  expect(test.panes.size).toBe(0)
  expect(test.killHeld).toHaveBeenCalledTimes(3)
  expect(test.deps.launch).not.toHaveBeenCalled()
})

it('refuses every unverified cancellation boundary without forgetting or archiving its intent', async () => {
  for (const failure of ['changed', 'save', 'tmux', 'route', 'commit', 'replaced-during-close'] as const) {
    const test = setup(); test.inspect.mockResolvedValue(externalUnavailable())
    const id = await test.stage(); await test.controller.settled()
    const row = test.rows.get(id)!
    if (failure === 'save') vi.mocked(test.registry.setExternalResume).mockReturnValue(null)
    if (failure === 'tmux') test.deps.tmux = null
    if (failure === 'route') row.runtimes = []
    if (failure === 'commit') vi.mocked(test.registry.finishExternalCancellation).mockReturnValue(false)
    if (failure === 'replaced-during-close') test.killHeld.mockImplementation(async () => {
      test.rows.get(id)!.runtimes = [{ backend: 'tmux', paneId: '%99' }]
      return { state: 'succeeded', dispatch: 'executed' }
    })
    await expect(test.controller.cancel(row, () => failure !== 'changed')).rejects.toThrow()
    expect(test.deps.forget).not.toHaveBeenCalled()
    expect(test.rows.has(id)).toBe(true)
    test.controller.stop()
  }
})

it('requires an inert pane before any observation and discards a check after Stop or a newer route', async () => {
  for (const kind of ['unverified', 'cancelled-during-check', 'process-already-found', 'no-longer-held', 'lost-row'] as const) {
    const test = setup(); test.inspect.mockResolvedValue(externalUnavailable())
    const id = await test.stage(); await test.controller.settled()
    const row = test.rows.get(id)!
    if (kind === 'process-already-found') row.processIdentity = { pid: 8, executable: 'fixture', startMarker: 'fixture' }
    if (kind === 'no-longer-held') row.launch = { state: 'starting' }
    if (kind === 'unverified' || kind === 'lost-row') vi.mocked(test.deps.waiting).mockResolvedValue(false)
    if (kind === 'lost-row') vi.mocked(test.registry.setLaunch).mockReturnValue(null)
    if (kind === 'cancelled-during-check') vi.mocked(test.deps.waiting).mockImplementation(async () => { test.cancelWork(); return true })
    test.inspect.mockClear()
    await vi.advanceTimersByTimeAsync(2000); await test.controller.settled()
    expect(test.inspect).not.toHaveBeenCalled()
    expect(test.deps.launch).not.toHaveBeenCalled()
    test.controller.stop()
  }
})

it('keeps exact signal intent and receipt failures from admitting an external conversation', async () => {
  for (const failure of ['before', 'after', 'cancel-before', 'cancel-then-false', 'cancel-then-true', 'kill'] as const) {
    const test = setup(); test.inspect.mockImplementation(async request => held(request))
    vi.mocked(test.deps.stopOwner!).mockImplementation(async (_owner, control) => {
      expect(await control.same()).toBe(true)
      if (failure === 'kill') { control.beforeSignal?.('SIGKILL'); control.afterSignal?.('SIGKILL'); return false }
      if (failure === 'cancel-then-false' || failure === 'cancel-then-true') { test.cancelWork(); return failure === 'cancel-then-true' }
      if (failure === 'before') vi.mocked(test.registry.setExternalResume).mockReturnValue(null)
      if (failure === 'cancel-before') test.cancelWork()
      control.beforeSignal?.('SIGTERM')
      if (failure === 'after') vi.mocked(test.registry.setExternalResume).mockReturnValue(null)
      control.afterSignal?.('SIGTERM')
      return true
    })
    const id = await test.stage({ takeOver: 'idle' }); await test.controller.settled()
    expect(test.rows.get(id)?.externalResume?.phase).toBe('quitting')
    expect(test.deps.launch).not.toHaveBeenCalled()
    if (failure === 'after') expect(test.rows.get(id)?.externalResume?.signal).toBe('prepared')
    test.controller.stop()
  }
  const test = setup(); test.inspect.mockImplementation(async request => held(request)); test.deps.stopOwner = undefined
  await test.stage({ takeOver: 'idle' }); await test.controller.settled()
  expect(stopExternalOwner).toHaveBeenCalled()
  expect(test.deps.launch).not.toHaveBeenCalled()
})

it('fences the last read, the last pane check, and a failed final durable admission', async () => {
  for (const point of ['read', 'pane', 'commit'] as const) {
    const test = setup()
    let calls = 0
    test.inspect.mockImplementation(async request => { if (++calls === 3 && point === 'read') test.cancelWork(); return free(request) })
    let paneChecks = 0
    vi.mocked(test.deps.waiting).mockImplementation(async () => { if (++paneChecks === 2 && point === 'pane') test.cancelWork(); return true })
    const persist = test.registry.setExternalResume
    if (point === 'commit') test.registry.setExternalResume = (id, intent) => intent.phase === 'admitted' ? null : persist(id, intent)
    await test.stage(); await test.controller.settled()
    expect(test.deps.launch).not.toHaveBeenCalled()
    test.controller.stop()
  }
})

it('limits concurrent intents after reboot and lets later ones proceed after the reads finish', async () => {
  const test = setup(); test.inspect.mockResolvedValue(externalUnavailable())
  const id = await test.stage(); await test.controller.settled(); test.controller.stop()
  const sample = test.rows.get(id)!
  for (let i = 1; i <= 5; i++) {
    const agentId = `saved-${i}`, pane = `%${i + 10}`
    const intent = { ...sample.externalResume!, request: { engine: 'claude' as const, sessionId: `saved-conversation-${i}` } }
    test.rows.set(agentId, { ...sample, agentId, tmuxPane: pane, runtimes: [{ backend: 'tmux', paneId: pane }], externalResume: intent })
    test.panes.set(pane, intent.token)
  }
  const reads: Array<() => void> = []
  test.inspect.mockClear().mockImplementation(request => new Promise(resolve => { reads.push(() => resolve(free(request))) }))
  const reboot = createExternalResumes(test.deps); controllers.push(reboot); reboot.open()
  await vi.waitFor(() => expect(reads.length).toBe(4))
  reboot.wake()
  expect(test.inspect).toHaveBeenCalledTimes(4)
  test.inspect.mockImplementation(async request => free(request))
  for (const finish of reads) finish()
  await reboot.settled()
  await vi.advanceTimersByTimeAsync(2000); await reboot.settled()
  expect([...test.rows.values()].every(row => row.externalResume?.phase === 'admitted')).toBe(true)
})

it('ignores a late preparation exception after shutdown', async () => {
  const test = setup()
  let reject!: (error: Error) => void
  vi.mocked(test.deps.preflight).mockImplementation(() => new Promise((_resolve, no) => { reject = no }))
  const id = await test.stage()
  await vi.waitFor(() => expect(test.deps.preflight).toHaveBeenCalled())
  test.controller.stop(); reject(new Error('late failure')); await test.controller.settled()
  expect(test.rows.get(id)?.externalResume?.phase).toBe('waiting')
  expect(test.deps.launch).not.toHaveBeenCalled()
})

it.each(['idle', 'wait'] as const)('does not signal a turn that starts during the pane probe under %s consent', async takeOver => {
  const test = setup(), pane = defer<boolean>()
  test.inspect.mockImplementation(async request => held(request, false))
  vi.mocked(test.deps.waiting).mockResolvedValueOnce(true).mockReturnValueOnce(pane.promise)
  const id = await test.stage({ takeOver })
  await vi.waitFor(() => expect(test.deps.waiting).toHaveBeenCalledTimes(2))
  test.inspect.mockImplementation(async request => held(request, true))
  pane.resolve(true); await test.controller.settled()
  expect(test.rows.get(id)?.externalResume).toMatchObject({ phase: 'quitting' })
  expect(test.rows.get(id)?.externalResume?.signal).toBeUndefined()
  expect(test.deps.launch).not.toHaveBeenCalled()
})

it('does not admit a conversation acquired externally while its final pane probe waits', async () => {
  const test = setup(), pane = defer<boolean>()
  vi.mocked(test.deps.waiting).mockResolvedValueOnce(true).mockReturnValueOnce(pane.promise)
  const id = await test.stage()
  await vi.waitFor(() => expect(test.deps.waiting).toHaveBeenCalledTimes(2))
  test.inspect.mockImplementation(async request => held(request, false))
  pane.resolve(true); await test.controller.settled()
  expect(test.rows.get(id)?.externalResume?.phase).toBe('waiting')
  expect(test.rows.get(id)?.sessionId).toBe('')
  expect(test.deps.launch).not.toHaveBeenCalled()
})

it('launches a conversation held behind a record-less Claude in its folder once that process goes, and never waits on one elsewhere', async () => {
  // CLI 0.3.70: "[restore] held · search · launched 0 of 4 · 4 still waiting" behind two old TUIs with no record.
  // The real search reader answers here, over a private Claude home and a fake process table.
  const home = mkdtempSync(join(tmpdir(), 'external-resume-claude-'))
  try {
    const project = join(home, 'project'), elsewhere = join(home, 'elsewhere'), conversation = '33333333-3333-4333-8333-333333333333'
    mkdirSync(project); mkdirSync(elsewhere); mkdirSync(join(home, 'projects', 'project'), { recursive: true })
    writeFileSync(join(home, 'projects', 'project', `${conversation}.jsonl`), JSON.stringify({
      type: 'user', sessionId: conversation, cwd: project, entrypoint: 'cli', message: { role: 'user', content: 'Fixture' } }) + '\n')
    const tui = (pid: number): RunningProcess => ({ pid, ppid: 1, executable: 'claude', args: 'claude --append-system-prompt "be brief"', started: 1 })
    let processes = [tui(201), tui(202)]
    const cwds = new Map([[201, elsewhere], [202, project]])
    const reader = createExternalSessions({ providers: [claudeProvider({ projectsDir: join(home, 'projects'), home })], generation: () => null,
      open: { ttys: async () => new Map(), harnessTtys: async () => new Set(), view: (): ProcessView => {
        const listed = processes
        return { list: async () => listed, alive: pid => listed.some(row => row.pid === pid), openFiles: async () => new Map(),
          openFilesOf: async () => new Map(), cwds: async pids => new Map([...cwds].filter(([pid]) => pids.includes(pid))) }
      } } })
    const test = setup(); test.inspect.mockImplementation(request => reader.inspect(request))
    const id = await test.stage({ resumeSessionId: conversation, cwd: project })
    await test.controller.settled()
    expect(test.rows.get(id)).toMatchObject({ launch: { state: 'held', service: 'search', detail: "The conversation's current owner could not be verified." },
      externalResume: { phase: 'waiting' } })
    expect(test.deps.launch).not.toHaveBeenCalled()
    // The one in the conversation's folder quits; the one elsewhere runs on and holds nothing here.
    processes = [tui(201)]
    await vi.advanceTimersByTimeAsync(2000); await test.controller.settled()
    expect(test.rows.get(id)).toMatchObject({ sessionId: conversation, cwd: project, resumeOnly: true, externalResume: { phase: 'admitted' } })
    expect(test.deps.launch).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(4000)
    expect(test.deps.launch).toHaveBeenCalledOnce()
  } finally { rmSync(home, { recursive: true, force: true }) }
})
