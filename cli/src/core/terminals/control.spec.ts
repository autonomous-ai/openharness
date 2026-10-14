import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { TerminalActionResult } from '../../lib/terminalTypes.js'
import { createTerminalControl, type TerminalControlBackend } from './control.js'

const ok: TerminalActionResult = { state: 'succeeded', dispatch: 'executed' }
const lost: TerminalActionResult = { state: 'unknown', dispatch: 'possibly_executed', reason: 'pane went away' }

/** A backend whose leases are numbered, so a test can tell a reused lease from a new one. */
function backend() {
  let issued = 0
  const calls: string[] = []
  const fake = {
    calls,
    acquire: true,
    valid: true,
    action: ok,
    captured: { state: 'succeeded', value: 'screen' } as { state: 'succeeded'; value: string } | { state: 'failed'; reason: string },
    alive: true,
  }
  const terminals = {
    acquireLease: vi.fn(async () => {
      if (!fake.acquire) return { state: 'failed', reason: 'busy' }
      issued++
      calls.push(`acquire ${issued}`)
      return { state: 'succeeded', value: { id: issued } }
    }),
    validateLease: vi.fn(async (lease: { id: number }) => { calls.push(`validate ${lease.id}`); return fake.valid }),
    capture: vi.fn(async (_session: RegisteredSession, options?: { historyLines?: number }) => {
      calls.push(`capture ${options?.historyLines ?? '-'}`)
      return fake.captured
    }),
    captureLease: vi.fn(async (lease: { id: number }) => { calls.push(`captureLease ${lease.id}`); return fake.captured }),
    submitText: vi.fn(async () => ok),
    submitTextLease: vi.fn(async (lease: { id: number }, text: string) => { calls.push(`submitTextLease ${lease.id} ${text}`); return fake.action }),
    submitTextForLease: vi.fn(async (_session: RegisteredSession, lease: { id: number }, text: string) => {
      calls.push(`submitTextForLease ${lease.id} ${text}`)
      return fake.action
    }),
    typeLiteralLease: vi.fn(async (lease: { id: number }, text: string) => { calls.push(`type ${lease.id} ${text}`); return fake.action }),
    sendLegacyKeyLease: vi.fn(async (lease: { id: number }, key: string) => { calls.push(`key ${lease.id} ${key}`); return fake.action }),
    validate: vi.fn(async () => fake.alive ? { state: 'alive' } : { state: 'gone', reason: 'exited' }),
  }
  return { fake, terminals: terminals as unknown as TerminalControlBackend }
}

const session = { agentId: 'agent-1', sessionId: 'session-1' } as RegisteredSession
const resolve = (target: string): RegisteredSession | undefined =>
  target === 'agent-1' || target === 'session-1' ? session : undefined

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

it.each(['acquire', 'validate'] as const)('revokes a retained pin while %s is pending, without unpinning the old driver', async phase => {
  const { terminals } = backend(), control = createTerminalControl({ resolve, terminals })
  const release = control.pinTerminalControl('agent-1')!
  if (phase === 'validate') await control.keyTerminal('agent-1', 'Down')
  let finish!: () => void
  if (phase === 'validate') vi.mocked(terminals.validateLease).mockImplementationOnce(() => new Promise(done => { finish = () => done(true) }))
  else vi.mocked(terminals.acquireLease).mockImplementationOnce(() => new Promise(done => {
    finish = () => done({ state: 'succeeded', value: { id: 1 } } as never)
  }))
  const writes = vi.mocked(terminals.sendLegacyKeyLease).mock.calls.length
  const sending = control.keyTerminal('agent-1', 'Enter')
  control.invalidateTerminalControl('agent-1')
  finish()
  await expect(sending).resolves.toBe(false)
  await expect(control.keyTerminal('agent-1', 'Escape')).resolves.toBe(false)
  expect(terminals.sendLegacyKeyLease).toHaveBeenCalledTimes(writes)
  expect(control.pinnedControls.has('agent-1')).toBe(true)
  expect(control.pinTerminalControl('agent-1')).toBeNull()
  release()
})

it('holds a control pin through native admission and fences every later invocation to its original proof', async () => {
  const { terminals } = backend(), control = createTerminalControl({ resolve, terminals })
  let finish!: (value: { verify(): void }) => void, valid = true
  const verify = vi.fn(() => { if (!valid) throw Error('original generation changed') })
  const release = control.pinTerminalControl('agent-1', { prepare: () => new Promise(done => { finish = done }) })!
  const reading = control.captureTerminal('agent-1')
  const sending = control.keyTerminal('agent-1', 'Enter')
  await flush()
  expect(terminals.acquireLease).not.toHaveBeenCalled()
  expect(control.writeTicket('agent-1').allowed()).toBe(false)
  finish({ verify }); await expect(reading).resolves.toBe('screen'); await expect(sending).resolves.toBe(true)
  const retained = vi.mocked(terminals.sendLegacyKeyLease).mock.calls[0][2]!
  valid = false
  const effect = vi.fn(async () => ok)
  await expect(retained.dispatch(effect)).rejects.toThrow('terminal control revoked')
  expect(effect).not.toHaveBeenCalled()
  await expect(control.captureTerminal('agent-1')).resolves.toBeNull()
  await expect(control.submitTerminal('agent-1', '/model next')).resolves.toBe(false)
  await expect(control.typeTerminal('agent-1', 'filter')).resolves.toBe(false)
  await expect(control.keyTerminal('agent-1', 'Escape')).resolves.toBe(false)
  expect(control.pinnedControls.has('agent-1')).toBe(true)
  release()
})

it.each(['invalidate', 'release'] as const)('settles an admission waiter on %s while retaining the actual read and refusing a late result', async action => {
  const { terminals } = backend(), control = createTerminalControl({ resolve, terminals })
  let finish!: (value: { verify(): void }) => void
  const release = control.pinTerminalControl('agent-1', { prepare: () => new Promise(done => { finish = done }) })!
  const key = control.keyTerminal('agent-1', 'Enter')
  await flush()
  if (action === 'invalidate') control.invalidateTerminalControl('agent-1')
  else release()
  await expect(key).resolves.toBe(false)
  release()
  const replacement = control.pinTerminalControl('agent-1')!
  const oldVerify = vi.fn()
  finish({ verify: oldVerify }); await flush()
  expect(oldVerify).not.toHaveBeenCalled()
  await expect(control.keyTerminal('agent-1', 'Down')).resolves.toBe(true)
  expect(terminals.sendLegacyKeyLease).toHaveBeenCalledOnce()
  replacement()
})

it.each(['pending', 'replaced'] as const)('refuses failed native admission without falling back to a lease (%s)', async phase => {
  const { terminals } = backend(), control = createTerminalControl({ resolve, terminals })
  let fail!: (error: Error) => void
  const release = control.pinTerminalControl('agent-1', { prepare: () => new Promise((_done, reject) => { fail = reject }) })!
  const key = control.keyTerminal('agent-1', 'Enter'); await flush()
  if (phase === 'replaced') release()
  fail(Error('native evidence unavailable')); await flush()
  await expect(key).resolves.toBe(false)
  expect(terminals.acquireLease).not.toHaveBeenCalled()
  if (phase === 'pending') expect(control.pinnedControls.has('agent-1')).toBe(true)
  release()
})

it('does not start admission for a pin released in the same tick or install authority revoked by its verifier', async () => {
  const { terminals } = backend(), control = createTerminalControl({ resolve, terminals })
  const prepare = vi.fn(async () => ({ verify() {} }))
  control.pinTerminalControl('agent-1', { prepare })!()
  await flush(); expect(prepare).not.toHaveBeenCalled()
  const release = control.pinTerminalControl('agent-1', { prepare: async () => ({
    verify: () => control.invalidateTerminalControl('agent-1'),
  }) })!
  await expect(control.keyTerminal('agent-1', 'Enter')).resolves.toBe(false)
  expect(terminals.acquireLease).not.toHaveBeenCalled()
  release()
})

it('rechecks the same pin after its full verifier and never borrows a replacement conversation', async () => {
  const { terminals } = backend(), row = { ...session }
  const control = createTerminalControl({ resolve: () => row, terminals })
  let revoke = false
  const release = control.pinTerminalControl('agent-1', { prepare: async () => ({ verify: () => {
    if (revoke) control.invalidateTerminalControl('agent-1')
  } }) })!
  await expect(control.keyTerminal('agent-1', 'Down')).resolves.toBe(true)
  revoke = true
  expect(control.writeTicket('agent-1').allowed()).toBe(false)
  release()
  const next = control.pinTerminalControl('agent-1')!
  row.sessionId = 'replacement'
  await expect(control.keyTerminal('agent-1', 'Enter')).resolves.toBe(false)
  expect(terminals.sendLegacyKeyLease).toHaveBeenCalledOnce()
  next()
})

it('does not interrupt without its own fresh terminal lease, even while an old driver retains a pin', async () => {
  const { terminals, fake } = backend(), control = createTerminalControl({ resolve, terminals })
  const release = control.pinTerminalControl('agent-1')!
  fake.acquire = false
  const result = await control.writer.interrupt('agent-1', write => control.interruptTerminalAction('agent-1', write.allowed, write))
  expect(result).toMatchObject({ dispatch: 'not_started', reason: 'terminal control lease is unavailable or changed' })
  expect(control.pinnedControls.has('agent-1')).toBe(true)
  expect(terminals.sendLegacyKeyLease).not.toHaveBeenCalled()
  release()
})

describe('terminal control', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('answers nothing for a pane it cannot find', async () => {
    const { terminals } = backend()
    const control = createTerminalControl({ resolve, terminals })
    expect(await control.captureTerminal('nobody')).toBeNull()
    expect(await control.submitTerminalAction('nobody', 'hi')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'terminal agent is unavailable' })
    expect(await control.submitTerminal('nobody', 'hi')).toBe(false)
    expect(await control.typeTerminal('nobody', 'hi')).toBe(false)
    expect(await control.keyTerminalAction('nobody', 'enter')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'terminal session is unavailable' })
    expect(await control.keyTerminal('nobody', 'enter')).toBe(false)
    expect(control.pinTerminalControl('nobody')).toBeNull()
  })

  it('reads a pane without a lease until one is taken, then through it while it lasts', async () => {
    const { fake, terminals } = backend()
    const control = createTerminalControl({ resolve, terminals })
    expect(await control.captureTerminal('agent-1', 40)).toBe('screen')
    expect(await control.submitTerminal('agent-1', 'one')).toBe(true)
    expect(await control.captureTerminal('session-1')).toBe('screen')
    // Quiet for longer than the lease's idle time: the lease lapses and reads go back to plain capture.
    vi.advanceTimersByTime(15_001)
    expect(await control.captureTerminal('agent-1')).toBe('screen')
    fake.captured = { state: 'failed', reason: 'no pane' }
    expect(await control.captureTerminal('agent-1')).toBeNull()
    expect(fake.calls).toEqual([
      'capture 40',
      'acquire 1', 'submitTextForLease 1 one',
      'validate 1', 'captureLease 1',
      'capture -',
      'capture -',
    ])
  })

  it.each([false, true])('discards an old pane after its binding changes while capture is pending (leased: %s)', async leased => {
    for (const change of ['session', 'route', 'process', 'replacement', 'removed'] as const) {
      const { terminals } = backend()
      let current: RegisteredSession | undefined = { ...session, engine: 'codex', boundAt: 1,
        tmuxPane: '%1', primaryRuntimeKey: 'tmux\u0000%1', runtimes: [{ backend: 'tmux', paneId: '%1' }],
        processIdentity: { pid: 123, startMarker: 'before', executable: 'codex' } }
      const control = createTerminalControl({ resolve: () => current, terminals })
      if (leased) await control.submitTerminal(current.agentId, 'first')
      let finish!: (result: { state: 'succeeded'; value: string }) => void
      const pending = new Promise<{ state: 'succeeded'; value: string }>(resolve => { finish = resolve })
      const capture = vi.mocked(leased ? terminals.captureLease : terminals.capture).mockReturnValueOnce(pending)
      const reading = control.captureTerminal(current.agentId)
      await vi.waitFor(() => expect(capture).toHaveBeenCalled())
      if (change === 'session') { current.sessionId = 'session-2'; current.boundAt = 2 }
      if (change === 'route') current.runtimes[0]!.paneId = '%2'
      if (change === 'process') current.processIdentity!.startMarker = 'after'
      if (change === 'replacement') current = { ...current, engine: 'claude' }
      if (change === 'removed') current = undefined
      finish({ state: 'succeeded', value: 'old pane' })
      await expect(reading, change).resolves.toBeNull()
    }
  })

  it('does not begin a capture after the binding changes during lease validation', async () => {
    const { terminals } = backend()
    const current = { ...session }
    const control = createTerminalControl({ resolve: () => current, terminals })
    await control.submitTerminal(current.agentId, 'first')
    vi.mocked(terminals.validateLease).mockImplementationOnce(async () => {
      current.sessionId = 'session-2'
      return true
    })
    expect(await control.captureTerminal(current.agentId)).toBeNull()
    expect(terminals.captureLease).not.toHaveBeenCalled()
    expect(terminals.capture).not.toHaveBeenCalled()
  })

  it('keeps a lease while it is used, and takes a new one once it lapses or stops validating', async () => {
    const { fake, terminals } = backend()
    const control = createTerminalControl({ resolve, terminals })
    await control.submitTerminal('agent-1', 'a')
    vi.advanceTimersByTime(10_000)
    await control.typeTerminal('agent-1', 'b') // within 15 s: the same lease, and its clock starts over
    vi.advanceTimersByTime(10_000)
    await control.keyTerminal('agent-1', 'enter') // 20 s after the first use, 10 s after the last
    vi.advanceTimersByTime(15_001)
    await control.submitTerminal('agent-1', 'c') // lapsed: a new lease
    fake.valid = false
    // No longer valid: this action fails rather than land in a pane that changed, and the lease goes…
    expect(await control.submitTerminal('agent-1', 'd')).toBe(false)
    fake.valid = true
    // …so the next action takes a new one.
    expect(await control.submitTerminal('agent-1', 'e')).toBe(true)
    expect(fake.calls).toEqual([
      'acquire 1', 'submitTextForLease 1 a',
      'validate 1', 'type 1 b',
      'validate 1', 'key 1 enter',
      'acquire 2', 'submitTextForLease 2 c',
      'validate 2',
      'acquire 3', 'submitTextForLease 3 e',
    ])
  })

  it('reports when no lease can be had', async () => {
    const { fake, terminals } = backend()
    const control = createTerminalControl({ resolve, terminals })
    fake.acquire = false
    expect(await control.submitTerminalAction('agent-1', 'x')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'terminal control lease is unavailable or changed' })
    expect(await control.typeTerminal('agent-1', 'x')).toBe(false)
    expect(await control.keyTerminalAction('agent-1', 'enter')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'terminal control lease is unavailable or changed' })
    expect(fake.calls).toEqual([])
  })

  it('holds a pinned pane on one lease for as long as it is pinned, however long it is quiet', async () => {
    const { fake, terminals } = backend()
    const control = createTerminalControl({ resolve, terminals })
    const release = control.pinTerminalControl('agent-1')!
    expect(release).toBeTypeOf('function')
    expect(control.pinTerminalControl('agent-1'), 'a pane is pinned once at a time').toBeNull()
    expect(control.pinnedControls.has('agent-1')).toBe(true)
    expect(await control.captureTerminal('agent-1')).toBe('screen') // pinned: read through a lease
    vi.advanceTimersByTime(60_000)
    expect(await control.submitTerminal('agent-1', 'go')).toBe(true) // still the same lease, through the pinned path
    release()
    expect(control.pinnedControls.has('agent-1')).toBe(false)
    expect(await control.submitTerminal('agent-1', 'after')).toBe(true) // the pinned lease went with the pin
    expect(fake.calls).toEqual([
      'acquire 1', 'captureLease 1',
      'validate 1', 'submitTextLease 1 go',
      'acquire 2', 'submitTextForLease 2 after',
    ])
  })

  it('fails every action on a pinned pane whose lease stopped validating, until it is unpinned', async () => {
    const { fake, terminals } = backend()
    const control = createTerminalControl({ resolve, terminals })
    const release = control.pinTerminalControl('agent-1')!
    await control.submitTerminal('agent-1', 'first')
    fake.valid = false
    expect(await control.submitTerminal('agent-1', 'second')).toBe(false)
    fake.valid = true
    // Never quietly replaced: the pane may have changed under the sequence.
    expect(await control.captureTerminal('agent-1')).toBeNull()
    expect(await control.typeTerminal('agent-1', 'third')).toBe(false)
    release()
    expect(await control.typeTerminal('agent-1', 'fourth')).toBe(true)
    expect(fake.calls).toEqual(['acquire 1', 'submitTextLease 1 first', 'validate 1', 'acquire 2', 'type 2 fourth'])
  })

  it('a pinned pane that cannot get a lease cannot be read either', async () => {
    const { fake, terminals } = backend()
    const control = createTerminalControl({ resolve, terminals })
    control.pinTerminalControl('agent-1')
    fake.acquire = false
    expect(await control.captureTerminal('agent-1')).toBeNull()
    expect(fake.calls).toEqual([])
  })

  it('stops a pinned sequence after any action that did not go through', async () => {
    for (const act of ['submit', 'type', 'key'] as const) {
      const { fake, terminals } = backend()
      const control = createTerminalControl({ resolve, terminals })
      control.pinTerminalControl('agent-1')
      fake.action = lost
      const first = act === 'submit' ? await control.submitTerminalAction('agent-1', 'x')
        : act === 'type' ? await control.typeTerminal('agent-1', 'x')
        : await control.keyTerminalAction('agent-1', 'enter')
      expect(first === lost || first === false, act).toBe(true)
      fake.action = ok
      expect(await control.submitTerminal('agent-1', 'next'), `${act}: the next action fails`).toBe(false)
    }
  })

  it('lets an unpinned pane go on after an action that did not go through', async () => {
    const { fake, terminals } = backend()
    const control = createTerminalControl({ resolve, terminals })
    fake.action = lost
    expect(await control.submitTerminalAction('agent-1', 'x')).toBe(lost)
    expect(await control.typeTerminal('agent-1', 'x')).toBe(false)
    expect(await control.keyTerminalAction('agent-1', 'enter')).toBe(lost)
    fake.action = ok
    expect(await control.submitTerminal('agent-1', 'next')).toBe(true)
  })

  it('invalidates a pane on request: an unpinned one just takes a new lease, a pinned one stops', async () => {
    const { terminals, fake } = backend()
    const control = createTerminalControl({ resolve, terminals })
    await control.submitTerminal('agent-1', 'a')
    control.invalidateTerminalControl('agent-1')
    expect(await control.submitTerminal('agent-1', 'b')).toBe(true)
    control.pinTerminalControl('agent-1')
    control.invalidateTerminalControl('agent-1')
    expect(await control.submitTerminal('agent-1', 'c')).toBe(false)
    expect(fake.calls).toEqual(['acquire 1', 'submitTextForLease 1 a', 'acquire 2', 'submitTextForLease 2 b'])
  })

  it('says whether a pane is alive', async () => {
    const { fake, terminals } = backend()
    const control = createTerminalControl({ resolve, terminals })
    expect(await control.validateTerminal(session)).toBe(true)
    fake.alive = false
    expect(await control.validateTerminal(session)).toBe(false)
  })

  it('calls a terminal gone only when it is known to be, never on a probe that could not answer', async () => {
    const { fake, terminals } = backend()
    const control = createTerminalControl({ resolve, terminals })
    expect(await control.terminalGone(session)).toBe(false)
    fake.alive = false
    expect(await control.terminalGone(session)).toBe(true)
    // A probe that timed out at a wake: no reason to write to the pane, and no evidence it is gone.
    vi.mocked(terminals.validate).mockResolvedValueOnce({ state: 'unknown', reason: 'tmux runtime probe failed' })
    expect(await control.terminalGone(session)).toBe(false)
    vi.mocked(terminals.validate).mockResolvedValueOnce({ state: 'unknown', reason: 'tmux runtime probe failed' })
    expect(await control.validateTerminal(session)).toBe(false)
  })
})

it.each(['key', 'submit'] as const)('checks revoked %s authority after awaited terminal validation', async kind => {
  const { terminals } = backend()
  const control = createTerminalControl({ resolve, terminals })
  const release = control.pinTerminalControl('agent-1')!
  await control.keyTerminal('agent-1', 'Enter')
  let permitted = true
  vi.mocked(terminals.validateLease).mockImplementationOnce(async () => { permitted = false; return true })
  const result = kind === 'key'
    ? await control.keyTerminalAction('agent-1', 'Enter', () => permitted)
    : await control.submitTerminalAction('agent-1', '/model next', { allowed: () => permitted })
  expect(result).toMatchObject({ state: 'failed', dispatch: 'not_started', reason: 'terminal control revoked' })
  expect(terminals.sendLegacyKeyLease).toHaveBeenCalledTimes(1)
  expect(terminals.submitTextLease).not.toHaveBeenCalled()
  release()
})

it('passes a live submission guard through to paste/Enter, and permits a guarded key', async () => {
  const { terminals } = backend(), control = createTerminalControl({ resolve, terminals }), allowed = () => true
  expect(await control.submitTerminal('agent-1', '/model next', { allowed })).toBe(true)
  expect(terminals.submitTextForLease).toHaveBeenCalledWith(session, expect.anything(), '/model next', {
    allowed: expect.any(Function), dispatch: expect.any(Function),
  })
  const write = vi.mocked(terminals.submitTextForLease).mock.calls[0][3]!
  expect(write.allowed!()).toBe(true)
  await control.writer.interrupt('agent-1', async () => {})
  expect(write.allowed!()).toBe(false)
  expect(await control.keyTerminal('agent-1', 'Enter', allowed)).toBe(true)
  expect(terminals.sendLegacyKeyLease).toHaveBeenCalledWith(expect.anything(), 'Enter', expect.objectContaining({ allowed: expect.any(Function), dispatch: expect.any(Function) }))
})

it.each(['binding', 'native proof'] as const)('preserves the original %s through a deferred key backend', async change => {
  const { terminals } = backend(), current = { ...session }
  const control = createTerminalControl({ resolve: () => current, terminals })
  let finish!: () => void, native = true
  const key = vi.mocked(terminals.sendLegacyKeyLease).mockImplementation(async (_lease, _key, allowed) => {
    await new Promise<void>(done => { finish = done })
    return allowed!.allowed() ? ok : { state: 'failed', dispatch: 'not_started', reason: 'revoked' }
  })
  const sending = control.keyTerminalAction('agent-1', 'C-c', () => native)
  await vi.waitFor(() => expect(key).toHaveBeenCalled())
  if (change === 'binding') current.sessionId = 'replacement'
  else native = false
  finish()
  await expect(sending).resolves.toMatchObject({ dispatch: 'not_started' })
})

it('retains refusal for an unknown owner and for a released pin at actual dispatch', async () => {
  const { terminals } = backend(), control = createTerminalControl({ resolve, terminals }), operation = vi.fn(async () => {})
  const unknown = control.writeTicket('nobody')
  expect(unknown.allowed()).toBe(false)
  await expect(unknown.dispatch(operation)).rejects.toThrow('terminal control revoked')
  const release = control.pinTerminalControl('agent-1')!
  await control.keyTerminal('agent-1', 'Enter')
  const retained = vi.mocked(terminals.sendLegacyKeyLease).mock.calls[0][2]!
  release()
  await expect(retained.dispatch(operation)).rejects.toThrow('terminal control revoked')
  expect(operation).not.toHaveBeenCalled()
})

it.each(['acquire', 'validate'] as const)('a late %s cannot replace or invalidate the next pin\'s lease', async phase => {
  const { terminals } = backend(), control = createTerminalControl({ resolve, terminals })
  const releaseA = control.pinTerminalControl('agent-1')!
  const oldLease = await terminals.acquireLease(session)
  let finish!: () => void
  if (phase === 'validate') {
    await control.keyTerminal('agent-1', 'Enter')
    vi.mocked(terminals.validateLease).mockImplementationOnce(() => new Promise(done => { finish = () => done(false) }))
  } else vi.mocked(terminals.acquireLease).mockImplementationOnce(() => new Promise(done => { finish = () => done(oldLease) }))
  const old = control.typeTerminal('agent-1', 'filter')
  releaseA(); const releaseB = control.pinTerminalControl('agent-1')!
  await expect(control.keyTerminal('agent-1', 'Enter')).resolves.toBe(true)
  const count = vi.mocked(terminals.acquireLease).mock.calls.length
  finish(); await expect(old).resolves.toBe(false)
  await expect(control.keyTerminal('agent-1', 'Enter')).resolves.toBe(true)
  expect(terminals.acquireLease).toHaveBeenCalledTimes(count)
  releaseB()
})
