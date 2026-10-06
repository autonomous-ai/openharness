import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReviewedInput } from './reviewedInput.js'
import { TerminalBackendCoordinator } from './terminalBackendCoordinator.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { RegisteredSession } from './registry.js'
import { terminalRouteKey } from './terminalRuntime.js'
import { AutonomousDeviceInput } from './autonomous-device/input.js'
import { SessionInputController } from './sessionInput.js'

const identity = { pid: 42, executable: 'claude', startMarker: 'Sat Aug 15 10:00:00 2026' }
function fixture() {
  const runtime = { backend: 'tmux' as const, paneId: '%1' }
  const row = { agentId: 'a', sessionId: 's', active: true, engine: 'claude', processIdentity: { ...identity },
    runtimes: [runtime], primaryRuntimeKey: terminalRouteKey(runtime) } as RegisteredSession
  const input = new SessionInputController({ getSession: () => row, validateRuntime: async () => true,
    inject: async () => true, sendKey: async () => true, onError: vi.fn() })
  const writer = new AutonomousDeviceInput({ getSession: () => row, validateRuntime: async () => true,
    inject: async () => true, sendKey: async () => true, capture: async () => '',
    acquireControl: id => input.acquireControl(id, { forAnswer: true }), legacySubmit: vi.fn(), legacyCancel: () => false,
    acquireReviewedControl: id => input.acquireControl(id),
    onDelivery: vi.fn(), onInputStatus: vi.fn() })
  const backend = { name: 'tmux', instanceId: 'tmux:default',
    validateReviewed: vi.fn(async () => ({ state: 'alive' as const })),
    submitText: vi.fn(),
    capture: vi.fn(async () => ({ state: 'succeeded', value: '────────────\n❯\n────────────\n? for shortcuts' })),
    submitReviewed: vi.fn(async (_runtime, _text, current) => await current('before-paste') && await current('before-enter')
      ? { state: 'succeeded', dispatch: 'executed' } : { state: 'failed', dispatch: 'not_started', reason: 'changed' }),
  } as unknown as TerminalBackend
  const terminals = new TerminalBackendCoordinator([backend], ['tmux'])
  const isTurnOpen = vi.fn(() => false)
  const forgetScope = vi.fn(), beforeSubmit = vi.fn(() => forgetScope)
  const service = new ReviewedInput({ session: id => id === 'a' ? row : undefined, terminals,
    acquire: id => writer.acquireReviewed(id), isTurnOpen, beforeSubmit, waitMs: 100 })
  return { row, backend, terminals, service, input, writer, isTurnOpen, beforeSubmit, forgetScope }
}
afterEach(() => vi.useRealTimers())

describe('reviewed Goal/Loop with production coordinator and input writer', () => {
  it.each(['goal', 'loop'] as const)('preserves /%s and deduplicates without adapting or legacy submission', async intent => {
    const f = fixture(), pin = await f.service.prepare('a', intent)
    expect(pin.ok).toBe(true); if (!pin.ok) return
    const one = pin.submit('Keep the exact words.'), two = pin.submit('Different retry')
    expect(one).toBe(two)
    expect(await one).toEqual({ state: 'submitted' })
    expect(f.backend.submitReviewed).toHaveBeenCalledOnce()
    expect(vi.mocked(f.backend.submitReviewed!).mock.calls[0][1]).toBe(`/${intent} Keep the exact words.`)
    expect(f.backend.submitText).not.toHaveBeenCalled()
  })
  it.each(['engine', 'process', 'session', 'runtime', 'inactive'] as const)('rejects a %s change to the same mutable registry row', async field => {
    const f = fixture(), pin = await f.service.prepare('a', 'goal'); if (!pin.ok) throw Error('pin')
    if (field === 'engine') f.row.engine = 'codex'
    if (field === 'process') f.row.processIdentity!.startMarker += 'changed'
    if (field === 'session') f.row.sessionId = 'replacement'
    if (field === 'runtime') f.row.runtimes[0].paneId = '%2'
    if (field === 'inactive') f.row.active = false
    expect(await pin.submit('Never retarget.')).toMatchObject({ state: 'rejected' })
    expect(f.backend.submitReviewed).not.toHaveBeenCalled()
  })
  it('rejects a change while acquiring the original lease', async () => {
    const f = fixture()
    vi.mocked(f.backend.validateReviewed!).mockImplementationOnce(async () => { f.row.sessionId = 'new'; return { state: 'alive' } })
    expect(await f.service.prepare('a', 'goal')).toMatchObject({ ok: false })
  })
  it('revalidates after the existing writer queue drains', async () => {
    const f = fixture(), pin = await f.service.prepare('a', 'goal'); if (!pin.ok) throw Error('pin')
    let done!: () => void
    const legacy = f.writer.legacyWrite('a', () => new Promise<void>(r => { done = r }))
    const sending = pin.submit('Do not follow the new engine.')
    await vi.waitFor(() => expect(done).toBeTypeOf('function'))
    f.row.engine = 'pi'; done(); await legacy
    expect(await sending).toMatchObject({ state: 'rejected' })
    expect(f.backend.submitReviewed).not.toHaveBeenCalled()
  })
  it('holds legacy writes until the reviewed receipt settles', async () => {
    const f = fixture(), pin = await f.service.prepare('a', 'goal'); if (!pin.ok) throw Error('pin')
    let finish!: () => void
    vi.mocked(f.backend.submitReviewed!).mockImplementationOnce(() => new Promise(r => { finish = () => r({ state: 'succeeded', dispatch: 'executed' }) }))
    const sending = pin.submit('Once.')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const other = vi.fn(async () => true), waiting = f.writer.legacyWrite('a', other)
    expect(other).not.toHaveBeenCalled(); finish(); await sending; await waiting
    expect(other).toHaveBeenCalledOnce()
  })
  it('checks identity after asynchronous question capture and again after validation', async () => {
    const f = fixture(), pin = await f.service.prepare('a', 'loop'); if (!pin.ok) throw Error('pin')
    vi.mocked(f.backend.capture).mockImplementationOnce(async () => {
      f.row.processIdentity!.pid++; return { state: 'succeeded', value: '❯' }
    })
    expect(await pin.submit('Every five minutes.')).toMatchObject({ state: 'rejected' })
    expect(f.backend.submitText).not.toHaveBeenCalled()
    const g = fixture(), other = await g.service.prepare('a', 'goal'); if (!other.ok) throw Error('pin')
    vi.mocked(g.backend.validateReviewed!).mockImplementationOnce(async () => { g.row.engine = 'pi'; return { state: 'alive' } })
    expect(await other.submit('No fallback.')).toMatchObject({ state: 'rejected' })
    expect(g.backend.submitReviewed).not.toHaveBeenCalled()
  })
  it('retains uncertainty and never calls a fallback or retries', async () => {
    const f = fixture(), pin = await f.service.prepare('a', 'goal'); if (!pin.ok) throw Error('pin')
    vi.mocked(f.backend.submitReviewed!).mockResolvedValueOnce({ state: 'unknown', dispatch: 'possibly_executed', reason: 'lost' })
    expect(await pin.submit('Once.')).toMatchObject({ state: 'uncertain' })
    await pin.submit('Again.')
    expect(f.backend.submitReviewed).toHaveBeenCalledOnce(); expect(f.backend.submitText).not.toHaveBeenCalled()
    expect(f.beforeSubmit).toHaveBeenCalledExactlyOnceWith('a', '/goal Once.')
    expect(f.forgetScope).not.toHaveBeenCalled()
  })
  it('waits for an idle turn rather than claiming the question-answer reservation', async () => {
    const f = fixture(), pin = await f.service.prepare('a', 'loop'); if (!pin.ok) throw Error('pin')
    f.input.setTurnOpen('a', true)
    const sending = pin.submit('Every five minutes.')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(f.backend.submitReviewed).not.toHaveBeenCalled()
    f.input.setTurnOpen('a', false)
    expect(await sending).toEqual({ state: 'submitted' })
    expect(f.beforeSubmit).toHaveBeenCalledExactlyOnceWith('a', '/loop Every five minutes.')
    expect(f.forgetScope).not.toHaveBeenCalled()
  })
  it('bounds the wait for a busy turn without interrupting or typing', async () => {
    const f = fixture(), pin = await f.service.prepare('a', 'goal'); if (!pin.ok) throw Error('pin')
    f.input.setTurnOpen('a', true)
    expect(await pin.submit('Later.')).toMatchObject({ state: 'rejected', error: expect.stringContaining('busy') })
    expect(f.backend.submitReviewed).not.toHaveBeenCalled(); expect(f.beforeSubmit).not.toHaveBeenCalled()
  })
  it('rolls prompt provenance back only when no input was attempted', async () => {
    const f = fixture(), pin = await f.service.prepare('a', 'goal'); if (!pin.ok) throw Error('pin')
    vi.mocked(f.backend.submitReviewed!).mockResolvedValueOnce({ state: 'failed', dispatch: 'not_started', reason: 'gone' })
    expect(await pin.submit('No input.')).toMatchObject({ state: 'rejected' })
    expect(f.beforeSubmit).toHaveBeenCalledExactlyOnceWith('a', '/goal No input.')
    expect(f.forgetScope).toHaveBeenCalledOnce()
  })
  it.each(['❯ Unsent human words', '❯\n  second-line human draft', 'Working (esc to interrupt)\n❯', 'unrecognized screen'])
    ('preserves a nonempty, busy or unknown composer without injecting: %s', async capture => {
      const f = fixture(), pin = await f.service.prepare('a', 'goal'); if (!pin.ok) throw Error('pin')
      vi.mocked(f.backend.capture).mockResolvedValue({ state: 'succeeded', value: capture })
      expect(await pin.submit('Do not append.')).toMatchObject({ state: 'rejected' })
      expect(f.backend.capture).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%1' }, { mode: 'visible', ansi: true })
      expect(f.backend.submitText).not.toHaveBeenCalled()
      expect(f.forgetScope).toHaveBeenCalledOnce()
    })
  it('rechecks known turn state after asynchronous capture and before Enter, but not after Enter', async () => {
    const f = fixture(), pin = await f.service.prepare('a', 'goal'); if (!pin.ok) throw Error('pin')
    vi.mocked(f.backend.capture).mockImplementationOnce(async () => {
      f.isTurnOpen.mockReturnValue(true); return { state: 'succeeded', value: '❯' }
    })
    expect(await pin.submit('No new turn.')).toMatchObject({ state: 'rejected' })
    const g = fixture(), other = await g.service.prepare('a', 'goal'); if (!other.ok) throw Error('pin')
    vi.mocked(g.backend.submitReviewed!).mockImplementationOnce(async (_runtime, _text, current) => {
      expect(await current('before-paste')).toBe(true)
      g.isTurnOpen.mockReturnValue(true)
      expect(await current('before-enter')).toBe(false)
      expect(await current('identity')).toBe(true)
      return { state: 'unknown', dispatch: 'possibly_executed', reason: 'busy after paste' }
    })
    expect(await other.submit('Pasted only.')).toMatchObject({ state: 'uncertain' })
  })
  it('does not turn a post-write generation change into success', async () => {
    const f = fixture(), pin = await f.service.prepare('a', 'goal'); if (!pin.ok) throw Error('pin')
    vi.mocked(f.backend.submitReviewed!).mockImplementationOnce(async () => { f.row.sessionId = 'new'; return { state: 'succeeded', dispatch: 'executed' } })
    expect(await pin.submit('Once.')).toMatchObject({ state: 'uncertain' })
  })
  it('never lends the pinned runtime object to the live registry during awaited validation', async () => {
    const f = fixture(), pin = await f.service.prepare('a', 'goal'); if (!pin.ok) throw Error('pin')
    vi.mocked(f.backend.validateReviewed!).mockImplementationOnce(async runtime => {
      f.row.runtimes[0].paneId = '%replacement'
      expect(runtime.paneId).toBe('%1')
      return { state: 'alive' }
    })
    expect(await pin.submit('Keep the locator.')).toMatchObject({ state: 'rejected' })
    expect(f.backend.submitReviewed).not.toHaveBeenCalled()
  })
  it('cancels a queued draft and refuses unavailable identities/intents', async () => {
    const f = fixture(), pin = await f.service.prepare('a', 'goal'); if (!pin.ok) throw Error('pin')
    pin.cancel(); expect(await pin.submit('Cancelled.')).toMatchObject({ state: 'rejected' })
    f.row.engine = 'codex'; expect(await f.service.prepare('a', 'loop')).toMatchObject({ ok: false })
    f.row.processIdentity = null; expect(await f.service.prepare('a', 'goal')).toMatchObject({ ok: false })
    expect(await f.service.prepare('unknown', 'goal')).toMatchObject({ ok: false })
  })
})
