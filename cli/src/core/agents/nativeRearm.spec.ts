import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentCreationReceipts, creationFingerprint, type CreationAuthority } from '../../lib/agentCreationReceipt.js'
import { nativeRearmRequest, nativeTurnTarget, nativeTurnTransition, type NativeTurnIntent } from '../../lib/nativeTurnIntent.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import { appendNativeAllocation } from '../../lib/nativeAllocation.js'
import { createNativeRearm, type NativeRearmDeps, type NativeRearmDispatch, type NativeRearmOptions } from './nativeRearm.js'

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
const request = (source: 'live' | 'saved' = 'live', n = 0): NativeRearmOptions => ({ agentId: `agent-${n}`, source,
  creationId: `original-rearm-request-${n}`, operation: source === 'live' ? 'restart' : 'resume' })
function session(agentId: string, active: boolean): RegisteredSession {
  const row = { schemaVersion: 3, agentId, engine: 'cursor', sessionId: `session-${agentId}`, registeredAt: 1, boundAt: 2,
    active, cwd: '/fixture/project', transcriptPath: null, tmuxPane: '%1', primaryRuntimeKey: terminalRouteKey({ backend: 'tmux', paneId: '%1' }),
    runtimes: [{ backend: 'tmux', paneId: '%1' }], permissionMode: 'ask',
    processIdentity: { pid: 42, executable: '<cursor>', startMarker: 'original-birth' } } as RegisteredSession
  row.nativeControl = { version: 1, cancel: { processKey: null, target: nativeTurnTarget(row), request: {
    requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId, conversationId: row.sessionId,
    frontier: { index: -1, digest: null },
  } } }
  return row
}
function fixture(source: 'live' | 'saved' = 'live') {
  const root = mkdtempSync(join(tmpdir(), 'native-rearm-')); roots.push(root)
  const receipts = new AgentCreationReceipts(join(root, 'receipts'))
  const occupied = new Set<string>()
  const rows = { live: new Map<string, RegisteredSession>(), saved: new Map<string, RegisteredSession>() }
  for (let n = 0; n < 8; n++) {
    rows.live.set(`agent-${n}`, session(`agent-${n}`, true))
    rows.saved.set(`agent-${n}`, session(`agent-${n}`, false))
  }
  if (source === 'saved') rows.live.clear()
  const proof = (source: 'live' | 'saved', input: RegisteredSession) => {
    const original = structuredClone(input)
    const verify = () => {
      const current = rows[source].get(input.agentId)
      if (!current || nativeTurnTarget(current) !== nativeTurnTarget(original)
        || JSON.stringify(current.nativeControl) !== JSON.stringify(original.nativeControl)) throw Error('Original control changed')
    }
    verify()
    return { intent: original.nativeControl, verify }
  }
  const commit = (source: 'live' | 'saved', row: RegisteredSession, next: NativeTurnIntent, fence: () => void) => {
    proof(source, row).verify(); fence()
    if (!nativeTurnTransition(row, next)) throw Error('Invalid transition')
    const result = { ...structuredClone(row), nativeControl: next }
    rows[source].set(row.agentId, result)
    return result
  }
  const prepare = vi.fn<NativeRearmDeps['prepare']>(async () => null), held = vi.fn()
  const deps: NativeRearmDeps = {
    registry: {
      byAgent: id => rows.live.get(id), readNativeControl: row => proof('live', row),
      readNativeAbsence: id => {
        const verify = () => { if (occupied.has(id)) throw Error('durable handoff changed') }
        verify(); return { verify }
      },
      commitNativeControl: (row, next, fence) => commit('live', row, next, fence),
    },
    saved: {
      get: id => rows.saved.get(id) ?? null, readNativeControl: row => proof('saved', row),
      commitNativeControl: (row, next, fence) => commit('saved', row, next, () => { fence.verify(); fence.current() }),
    },
    receipts, prepare, held,
  }
  const controller = createNativeRearm(deps)
  const current = (source: 'live' | 'saved' = 'live', n = 0) => rows[source].get(`agent-${n}`)!
  return { root, rows, occupied, receipts, deps, prepare, held, controller, current }
}

it.each(['live', 'saved'] as const)('holds full %s allocation history before reservation, preparation or dispatch', async source => {
  const p = fixture(source), input = request(source), row = p.current(source)
  const choice = { kind: 'native-rearm', agentId: row.agentId, operation: 'resume', source }
  for (let n = 0; n < 4; n++) row.nativeAllocation = appendNativeAllocation(row.nativeAllocation, {
    fingerprint: creationFingerprint(choice), request: { ...choice, creationId: `prior-request-id-${n}`,
      launchToken: `prior-launch-token-${n}`, target: 'a'.repeat(64), sourceProcess: { processKey: null } },
  })
  row.schemaVersion = 4
  const original = structuredClone(row)
  expect(await p.controller.start(input)).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('physical accounting') } })
  expect(p.current(source)).toEqual(original); expect(p.prepare).not.toHaveBeenCalled()
  expect(p.receipts.status(input.creationId)).toEqual({ state: 'missing' })
  // A malformed imported R must not bypass the effect-side capacity fence.
  row.nativeControl = { ...row.nativeControl!, rearm: { requestId: input.creationId, agentId: row.agentId, source,
    operation: input.operation, target: nativeTurnTarget(row), launchToken: 'fresh-original-launch-token', sourceProcess: { processKey: null } } }
  expect(await createNativeRearm(p.deps).start(input)).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('physical accounting') } })
  expect(p.prepare).not.toHaveBeenCalled(); expect(p.receipts.status(input.creationId)).toEqual({ state: 'missing' })
})

it.each(['live', 'saved'] as const)('holds a persisted %s R which reuses an earlier pane token before preparation or receipt claim', async source => {
  const p = fixture(source), input = request(source), row = p.current(source)
  const choice = { kind: 'native-rearm', agentId: row.agentId, operation: 'resume', source }
  const token = 'retained-original-launch-token'
  row.nativeAllocation = appendNativeAllocation(undefined, { fingerprint: creationFingerprint(choice), request: {
    ...choice, creationId: 'earlier-creation-request', launchToken: token, target: 'a'.repeat(64), sourceProcess: { processKey: null },
  } })
  row.schemaVersion = 4
  row.nativeControl = { ...row.nativeControl!, rearm: { requestId: input.creationId, agentId: row.agentId, source,
    operation: input.operation, target: nativeTurnTarget(row), launchToken: token, sourceProcess: { processKey: null } } }
  const before = structuredClone(row)
  expect(await p.controller.start(input)).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('physical accounting') } })
  expect(p.prepare).not.toHaveBeenCalled(); expect(p.receipts.status(input.creationId)).toEqual({ state: 'missing' })
  expect(p.current(source)).toEqual(before)
})

it.each(['live', 'saved'] as const)('reserves complete %s control before dependencies and executes only the claimed operation', async source => {
  const p = fixture(source), input = { ...request(source), ...(source === 'saved' ? { permissionMode: 'full' as const } : {}) }
  const effect = vi.fn(async (guard: NativeRearmDispatch) => { expect(guard.current()).toBe(true); guard.begin() })
  p.prepare.mockImplementation(async supplied => {
    expect(supplied.source).toBe(source)
    const control = p.current(source).nativeControl!
    expect(control.rearm).toMatchObject({ source, requestId: input.creationId, sourceProcess: { processKey: null },
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}) })
    expect(supplied.receipt.request).toEqual(nativeRearmRequest(control))
    expect(p.receipts.has(input.creationId, supplied.receipt.fingerprint)).toBe(true)
    expect(supplied.authority.current()).toBe(true)
    supplied.authority.hold({ service: 'fixture', detail: 'Waiting for the original model.' })
    return effect
  })
  expect(await p.controller.start(input)).toEqual({ state: 'unconfirmed' })
  const retained = structuredClone(p.current(source).nativeControl)
  expect(await p.controller.start(input)).toEqual({ state: 'unconfirmed' })
  expect(await createNativeRearm(p.deps).start(input)).toEqual({ state: 'unconfirmed' })
  expect(p.current(source).nativeControl).toEqual(retained)
  expect(p.current(source).permissionMode).toBe('ask')
  expect(p.prepare).toHaveBeenCalledOnce(); expect(effect).toHaveBeenCalledOnce()
})

it.each([false, true])('reserves before receipt publication so a later Cancel tombstones a crash (receipt already cancelled: %s)', async alreadyCancelled => {
  const p = fixture(), input = request()
  const original = p.receipts.runIntent.bind(p.receipts)
  const run = vi.spyOn(p.receipts, 'runIntent').mockImplementationOnce(() => { throw Error('Core crashed before receipt creation') })
  expect((await p.controller.start(input)).state).toBe('pending')
  const reserved = p.current(), control = reserved.nativeControl!, before = nativeRearmRequest(control)
  expect(control.rearm?.requestId).toBe(input.creationId)
  expect(p.receipts.status(input.creationId)).toEqual({ state: 'missing' })
  const revoked: NativeTurnIntent = { ...control, cancel: { ...control.cancel, processKey: null, target: nativeTurnTarget(reserved),
    request: { ...control.cancel.request, requestId: 'later-cancel-request' } }, rearm: { ...control.rearm!, revoked: true } }
  p.deps.registry.commitNativeControl(reserved, revoked, () => {})
  if (alreadyCancelled) p.controller.revoke(input.creationId)
  run.mockImplementation(original)
  expect(await createNativeRearm(p.deps).start(input)).toEqual({ state: 'cancelled' })
  expect(p.receipts.status(input.creationId)).toEqual({ state: 'cancelled' })
  expect(nativeRearmRequest(p.current().nativeControl!)).toEqual(before)
  expect(p.prepare).not.toHaveBeenCalled()
})

it('recovers the exact reserved request after a crash before its receipt without new defaults', async () => {
  const p = fixture('saved'), input = { ...request('saved'), permissionMode: 'full' as const }
  const original = p.receipts.runIntent.bind(p.receipts)
  const run = vi.spyOn(p.receipts, 'runIntent').mockImplementationOnce(() => { throw Error('Crash') })
  await p.controller.start(input)
  const before = structuredClone(p.current('saved').nativeControl)
  run.mockImplementation(original)
  p.prepare.mockResolvedValue(async guard => { guard.begin() })
  expect(await createNativeRearm(p.deps).start(input)).toEqual({ state: 'unconfirmed' })
  expect(p.current('saved').nativeControl).toEqual(before)
  expect(p.prepare.mock.calls[0][0].receipt.request.permissionMode).toBe('full')
})

it('refuses an existing conflicting receipt before changing a durable reservation', async () => {
  const p = fixture(), input = request(), before = structuredClone(p.current())
  await p.receipts.run(input.creationId, creationFingerprint({ different: true }), async () => ({ state: 'created', agentId: 'other' }))
  expect(await p.controller.start(input)).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('CREATION_CONFLICT') } })
  expect(p.current()).toEqual(before); expect(p.prepare).not.toHaveBeenCalled()
})

it('does not coalesce different request IDs or resurrect a lost reservation', async () => {
  const p = fixture(), input = request()
  await p.controller.start(input)
  expect(await p.controller.start({ ...input, creationId: 'different-rearm-request' })).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('different original launch') } })
  const reserved = p.current().nativeControl!
  p.rows.live.set(input.agentId, { ...p.current(), nativeControl: { version: 1, cancel: reserved.cancel } })
  expect(await p.controller.start(input)).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('reservation is missing') } })
  expect(p.prepare).toHaveBeenCalledOnce()
})

it.each(['process', 'pane', 'conversation', 'permission', 'control'])('revokes an executing operation when its original %s changes', async kind => {
  const p = fixture(), observed: boolean[] = [], physical = vi.fn()
  p.prepare.mockResolvedValue(async guard => {
    guard.begin(); physical()
    if (kind === 'process') p.current().processIdentity = { ...p.current().processIdentity!, pid: 43 }
    if (kind === 'pane') p.current().tmuxPane = '%2'
    if (kind === 'conversation') p.current().sessionId = 'successor-conversation'
    if (kind === 'permission') p.current().permissionMode = 'full'
    if (kind === 'control') p.current().nativeControl = { ...p.current().nativeControl!,
      rearm: { ...p.current().nativeControl!.rearm!, revoked: true } }
    await Promise.resolve()
    observed.push(guard.current())
    if (guard.current()) physical()
  })
  expect(await p.controller.start(request())).toEqual({ state: 'unconfirmed' })
  expect(observed).toEqual([false]); expect(physical).toHaveBeenCalledOnce()
})

it('revokes the dispatch guard before a callback can dispatch after returning', async () => {
  const p = fixture(), physical = vi.fn(), observed: boolean[] = [], refused: unknown[] = []
  p.prepare.mockResolvedValue(async guard => {
    queueMicrotask(() => queueMicrotask(() => {
      observed.push(guard.current())
      try { guard.begin(); physical() } catch (error) { refused.push(error) }
    }))
  })
  expect(await p.controller.start(request())).toMatchObject({ state: 'failed', error: 'NATIVE_REARM_NOT_DISPATCHED' })
  expect(observed).toEqual([false]); expect(refused).toHaveLength(1)
  expect(physical).not.toHaveBeenCalled()
})

it.each(['close', 'revoke', 'target', 'control'])('ends the final receipt proof with a fresh local check after %s', async kind => {
  const p = fixture(), run = p.receipts.runIntent.bind(p.receipts), read = p.deps.registry.readNativeControl
  const observed: boolean[] = [], physical = vi.fn()
  let armed = false, afterControl = false
  p.deps.registry.readNativeControl = row => {
    const proof = read(row)
    return { ...proof, verify: () => { proof.verify(); if (armed) afterControl = true } }
  }
  vi.spyOn(p.receipts, 'runIntent').mockImplementation((id, fingerprint, value, held, prepare) =>
    run(id, fingerprint, value, held, (recorded, authority) => prepare(recorded, { ...authority, current: () => {
      const answer = authority.current()
      if (armed && afterControl) {
        armed = false
        if (kind === 'close') p.controller.close()
        if (kind === 'revoke') p.controller.revoke(request().creationId)
        if (kind === 'target') p.current().permissionMode = 'full'
        if (kind === 'control') p.current().nativeControl = { ...p.current().nativeControl!,
          rearm: { ...p.current().nativeControl!.rearm!, revoked: true } }
      }
      return answer
    } })))
  p.prepare.mockResolvedValue(async guard => {
    guard.begin(); physical()
    armed = true; afterControl = false
    observed.push(guard.current())
    if (guard.current()) physical()
  })
  expect(await p.controller.start(request())).toEqual({ state: 'unconfirmed' })
  expect(observed).toEqual([false]); expect(physical).toHaveBeenCalledOnce()
})

it.each(['first', 'last'])('refuses a peer cancellation before the %s receipt proof without asking dependencies', async phase => {
  const p = fixture(), run = p.receipts.runIntent.bind(p.receipts), read = p.deps.registry.readNativeControl
  const peer = new AgentCreationReceipts(join(p.root, 'receipts'))
  let armed = false
  p.deps.registry.readNativeControl = row => {
    const proof = read(row)
    return { ...proof, verify: () => {
      proof.verify()
      if (armed && phase === 'last') { armed = false; peer.cancelIntent(request().creationId) }
    } }
  }
  vi.spyOn(p.receipts, 'runIntent').mockImplementation((id, fingerprint, value, held, prepare) =>
    run(id, fingerprint, value, held, (recorded, authority) => {
      armed = true
      if (phase === 'first') peer.cancelIntent(id)
      return prepare(recorded, authority)
    }))
  expect(await p.controller.start(request())).toEqual({ state: 'cancelled' })
  expect(p.prepare).not.toHaveBeenCalled()
})

it.each(['live', 'saved'] as const)('retains an immutable %s reservation when a delayed receipt failure follows an in-place successor', async source => {
  const p = fixture(source), input = request(source)
  let reject!: (error: Error) => void
  vi.spyOn(p.receipts, 'runIntent').mockImplementation(() => new Promise((_, fail) => { reject = fail }))
  const pending = p.controller.start(input)
  const successor = p.current(source)
  successor.sessionId = 'successor-conversation'
  successor.nativeControl = { ...successor.nativeControl!, cancel: { ...successor.nativeControl!.cancel,
    request: { ...successor.nativeControl!.cancel.request, requestId: 'successor-cancellation' } } }
  reject(Error('Original receipt unavailable'))
  expect(await pending).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('Original receipt unavailable') } })
  expect(p.held).not.toHaveBeenCalled(); expect(p.prepare).not.toHaveBeenCalled()
})

it('does not reserve or prepare another saved Resume while a live handoff remains', async () => {
  const p = fixture('saved'), input = request('saved'), before = structuredClone(p.current('saved'))
  p.rows.live.set(input.agentId, session(input.agentId, false))
  expect(await p.controller.start(input)).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('live handoff must finish') } })
  expect(p.current('saved')).toEqual(before); expect(p.prepare).not.toHaveBeenCalled()
})

it.each(['preparation', 'effect', 'final-control'])('revokes saved dispatch when a live retirement appears during %s', async phase => {
  const p = fixture('saved'), input = request('saved'), physical = vi.fn()
  const occupy = () => p.rows.live.set(input.agentId, session(input.agentId, false))
  let armed = false
  if (phase === 'final-control') {
    const get = p.deps.saved.get
    p.deps.saved.get = id => {
      const saved = get(id)
      if (armed) occupy()
      return saved
    }
  }
  p.prepare.mockImplementation(async () => {
    if (phase === 'preparation') occupy()
    return async guard => {
      if (phase === 'effect') occupy()
      if (phase === 'final-control') armed = true
      expect(guard.current()).toBe(false)
      expect(() => guard.begin()).toThrow()
      if (guard.current()) physical()
    }
  })
  expect((await p.controller.start(input)).state).not.toBe('created')
  expect(physical).not.toHaveBeenCalled()
})

it.each(['reservation', 'preparation', 'effect', 'final-control'])('retains durable absence through saved %s', async phase => {
  const p = fixture('saved'), input = request('saved'), physical = vi.fn()
  const occupy = () => p.occupied.add(input.agentId)
  if (phase === 'reservation') {
    const commit = p.deps.saved.commitNativeControl
    p.deps.saved.commitNativeControl = (row, next, fence) => { occupy(); return commit(row, next, fence) }
  }
  let armed = false
  if (phase === 'final-control') {
    const get = p.deps.saved.get
    p.deps.saved.get = id => { const row = get(id); if (armed) occupy(); return row }
  }
  p.prepare.mockImplementation(async () => {
    if (phase === 'preparation') occupy()
    return async guard => {
      if (phase === 'effect') occupy()
      if (phase === 'final-control') armed = true
      guard.begin(); physical()
    }
  })
  const status = await p.controller.start(input)
  expect(status.state).toBe(phase === 'effect' || phase === 'final-control' ? 'failed' : 'pending')
  expect(p.rows.live.has(input.agentId)).toBe(false)
  expect(physical).not.toHaveBeenCalled()
  if (phase === 'reservation') expect(p.current('saved').nativeControl?.rearm).toBeUndefined()
})

it.each(['control', 'target'])('rechecks saved %s after the final retained absence proof', async changed => {
  const p = fixture('saved'), input = request('saved'), physical = vi.fn()
  const absent = p.deps.registry.readNativeAbsence
  let armed = false, reads = 0
  p.deps.registry.readNativeAbsence = id => {
    const proof = absent(id)
    return { verify: () => {
      proof.verify()
      if (armed && ++reads === 2) {
        if (changed === 'target') p.current('saved').cwd = '/fixture/changed'
        else p.current('saved').nativeControl = { ...p.current('saved').nativeControl!,
          rearm: { ...p.current('saved').nativeControl!.rearm!, revoked: true } }
      }
    } }
  }
  const results: boolean[] = []
  p.prepare.mockResolvedValue(async guard => {
    armed = true
    results.push(guard.current())
    if (guard.current()) { guard.begin(); physical() }
  })
  expect((await p.controller.start(input)).state).toBe('failed')
  expect(results).toEqual([false])
  expect(p.rows.live.has(input.agentId)).toBe(false)
  expect(physical).not.toHaveBeenCalled()
})

it('refuses receipt bytes which disagree with the durable reservation even when their semantic fingerprint matches', async () => {
  const p = fixture(), run = p.receipts.runIntent.bind(p.receipts)
  vi.spyOn(p.receipts, 'runIntent').mockImplementation((id, fingerprint, value, held, prepare) =>
    run(id, fingerprint, { ...value, launchToken: 'other-original-launch-token' }, held, prepare))
  expect(await p.controller.start(request())).toMatchObject({ state: 'pending', held: {
    detail: 'The receipt differs from the original reserved launch.',
  } })
  expect(p.prepare).not.toHaveBeenCalled()
})

it('refuses missing lifetime authority before asking any dependency', async () => {
  const p = fixture(), run = p.receipts.runIntent.bind(p.receipts)
  vi.spyOn(p.receipts, 'runIntent').mockImplementation((id, fingerprint, value, held, prepare) =>
    run(id, fingerprint, value, held, (recorded, authority) => prepare(recorded, { ...authority, settled: undefined })))
  expect(await p.controller.start(request())).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('lifetime authority') } })
  expect(p.prepare).not.toHaveBeenCalled()
})

it.each(['closed', 'before-prepare', 'before-dispatch'])('refuses %s authority without a physical effect', async kind => {
  const p = fixture(), run = p.receipts.runIntent.bind(p.receipts), physical = vi.fn()
  p.prepare.mockResolvedValue(async guard => { guard.begin(); physical() })
  if (kind === 'closed') p.controller.close()
  else vi.spyOn(p.receipts, 'runIntent').mockImplementation((id, fingerprint, value, held, prepare) =>
    run(id, fingerprint, value, held, async (recorded, authority) => {
      if (kind === 'before-prepare') p.current().permissionMode = 'full'
      const effect = await prepare(recorded, authority)
      return effect && (async () => { p.current().sessionId = 'successor-conversation'; return effect() })
    }))
  const status = await p.controller.start(request())
  expect(status.state).toBe(kind === 'before-dispatch' ? 'failed' : 'pending')
  expect(physical).not.toHaveBeenCalled()
  expect(p.prepare).toHaveBeenCalledTimes(kind === 'before-dispatch' ? 1 : 0)
  expect(p.held).not.toHaveBeenCalled()
})

it('refuses a store adapter that returns without reserving the original control', async () => {
  const p = fixture()
  p.deps.registry.commitNativeControl = row => row
  expect(await p.controller.start(request())).toMatchObject({ state: 'pending', held: {
    detail: expect.stringContaining('complete original reservation is unavailable'),
  } })
  expect(p.prepare).not.toHaveBeenCalled()
  expect(p.receipts.status(request().creationId)).toEqual({ state: 'missing' })
})

it('holds a non-Error storage rejection on the original row', async () => {
  const p = fixture()
  vi.spyOn(p.receipts, 'runIntent').mockRejectedValue('Storage unavailable')
  expect(await p.controller.start(request())).toMatchObject({ state: 'pending', held: {
    detail: expect.stringContaining('Storage unavailable'),
  } })
  expect(p.held).toHaveBeenCalledWith(request().agentId, expect.stringContaining('Storage unavailable'))
  expect(p.prepare).not.toHaveBeenCalled()
})

it('retains capacity for actual physical work after its reply and revokes all retained guards on settlement', async () => {
  vi.useFakeTimers()
  const p = fixture(), finish: Array<() => void> = [], guards: NativeRearmDispatch[] = []
  const authorities: CreationAuthority[] = []
  p.prepare.mockImplementation(async supplied => {
    authorities.push(supplied.authority)
    return async guard => {
      guard.begin(); guards.push(guard)
      await new Promise<void>(resolve => finish.push(resolve))
    }
  })
  const jobs = Array.from({ length: 5 }, (_, n) => p.controller.start(request('live', n)))
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await Promise.all(jobs)).every(value => value.state === 'pending')).toBe(true)
  expect(guards.map(guard => guard.current())).toEqual([true, true, true, true])
  expect(p.prepare).toHaveBeenCalledTimes(4)
  finish.splice(0).forEach(done => done())
  await vi.advanceTimersByTimeAsync(0)
  expect(guards.map(guard => guard.current())).toEqual([false, false, false, false])
  expect(authorities.map(authority => authority.current())).toEqual([false, false, false, false])
  p.prepare.mockResolvedValue(async guard => { guard.begin() })
  expect(await p.controller.start(request('live', 4))).toEqual({ state: 'unconfirmed' })
  expect(p.prepare).toHaveBeenCalledTimes(5)
})

it.each(['missing', 'engine', 'control', 'options', 'id', 'incomplete', 'replacement'])('holds %s original state without invoking dependencies', async kind => {
  const p = fixture(), input = request()
  if (kind === 'missing') p.rows.live.delete(input.agentId)
  if (kind === 'engine') p.current().engine = 'codex'
  if (kind === 'control') delete p.current().nativeControl
  if (kind === 'options') input.permissionMode = 'full'
  if (kind === 'id') input.creationId = 'short'
  if (kind === 'incomplete' || kind === 'replacement') {
    await p.controller.start(input); p.prepare.mockClear()
    const old = p.current().nativeControl!
    p.current().nativeControl = { ...old, rearm: { ...old.rearm!, ...(kind === 'incomplete'
      ? { source: undefined } : { replacement: { processKey: 'replacement', sessionId: p.current().sessionId } }) } }
  }
  expect((await p.controller.start(input)).state).toBe('pending')
  expect(p.prepare).not.toHaveBeenCalled()
})

it('retains four actual dependency slots past bounded replies and releases only settled work', async () => {
  vi.useFakeTimers()
  const p = fixture(), finish: Array<() => void> = []
  p.prepare.mockImplementation(async () => { await new Promise<void>(resolve => finish.push(resolve)); return null })
  const jobs = Array.from({ length: 5 }, (_, n) => p.controller.start(request('live', n)))
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await Promise.all(jobs)).every(value => value.state === 'pending')).toBe(true)
  expect(p.prepare).toHaveBeenCalledTimes(4)
  expect(await p.controller.start(request('live', 4))).toMatchObject({ state: 'pending', held: { detail: expect.stringContaining('capacity') } })
  expect(p.prepare).toHaveBeenCalledTimes(4)
  finish.splice(0).forEach(done => done())
  await vi.advanceTimersByTimeAsync(0)
  p.prepare.mockResolvedValue(async guard => { guard.begin() })
  expect(await p.controller.start(request('live', 4))).toEqual({ state: 'unconfirmed' })
  expect(p.prepare).toHaveBeenCalledTimes(5)
})

it.each(['cancel', 'close', 'permission', 'binding', 'read-error'])('revokes a prepared operation on %s and does not publish its late hold', async kind => {
  const p = fixture(), input = request()
  const effect = vi.fn(async (guard: NativeRearmDispatch) => { guard.begin() })
  p.prepare.mockImplementation(async supplied => {
    if (kind === 'cancel') p.controller.revoke(input.creationId)
    if (kind === 'close') p.controller.close()
    if (kind === 'permission') p.current().permissionMode = 'full'
    if (kind === 'binding') p.current().sessionId = 'successor'
    if (kind === 'read-error') p.deps.registry.readNativeControl = () => { throw Error('Storage unavailable') }
    expect(supplied.authority.current()).toBe(false)
    supplied.authority.hold({ service: 'stale', detail: 'This must not replace current status.' })
    return effect
  })
  expect((await p.controller.start(input)).state).toBe(kind === 'cancel' ? 'cancelled' : 'pending')
  expect(effect).not.toHaveBeenCalled()
  expect(p.receipts.status(input.creationId)).not.toMatchObject({ held: { service: 'stale' } })
})

it.each(['unused', 'throws-before', 'throws-after', 'twice'])('records %s dispatch conservatively without a second launch', async kind => {
  const p = fixture(), input = request(), physical = vi.fn()
  p.prepare.mockResolvedValue(async guard => {
    if (kind === 'unused') return
    if (kind === 'throws-before') throw Error('Before mutation')
    guard.begin(); physical()
    if (kind === 'twice') { guard.begin(); physical() }
    throw Error('After mutation')
  })
  const status = await p.controller.start(input)
  const attempted = kind === 'throws-after' || kind === 'twice'
  expect(status).toEqual(attempted ? { state: 'unconfirmed' } : { state: 'failed', error: 'NATIVE_REARM_NOT_DISPATCHED', detail: expect.any(String) })
  expect(await p.controller.start(input)).toEqual(status)
  expect(physical).toHaveBeenCalledTimes(attempted ? 1 : 0)
  expect(p.prepare).toHaveBeenCalledOnce()
})
