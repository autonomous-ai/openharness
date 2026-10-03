import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowVisit } from './windowVisit.js'
import type { SelectionFocus } from './windowSelection.js'

function fixture() {
  let focus: SelectionFocus | undefined = { connId: 'first', machineId: 'local', agentId: 'origin' }
  const frames: { connId: string; payload: Record<string, unknown> }[] = []
  let writable = true
  const visit = new WindowVisit({ focus: () => focus, timeoutMs: 100,
    send: (connId, payload) => { frames.push({ connId, payload }); return writable } })
  return { visit, frames, focus: (f: SelectionFocus | undefined) => { focus = f }, offline: () => { writable = false },
    answer: (extra: Record<string, unknown> = {}, connId = 'first', machineId = 'local') => {
      const p = frames.at(-1)!.payload
      visit.reply(connId, machineId, { requestId: p.requestId, visitId: p.visitId,
        ok: true, active: p.op === 'open', agentId: p.op === 'open' ? p.agentId : 'origin', label: 'My work', ...extra })
    },
  }
}
const open = { op: 'open' as const, visitId: 'visit-one', machineId: 'remote', agentId: 'help' }
afterEach(() => vi.useRealTimers())

describe('attention visit at this desk', () => {
  it('latest output is pinned to the focused pane and keeps the original return socket', async () => {
    const f = fixture()
    const command = { op: 'latest' as const, visitId: 'visit-reading', machineId: 'local', agentId: 'origin' }
    const first = f.visit.command(command)
    expect(f.frames[0]).toMatchObject({ connId: 'first', payload: {
      op: 'latest', fromMachineId: 'local', fromAgentId: 'origin', machineId: 'local', agentId: 'origin' } })
    f.answer({ active: true, agentId: 'origin', label: 'Your reading' })
    expect(await first).toMatchObject({ ok: true, active: true })
    const detour = f.visit.command({ ...open, visitId: command.visitId })
    f.answer(); await detour
    f.focus({ connId: 'remote-socket', machineId: 'remote', agentId: 'help' })
    const next = f.visit.command({ ...command, machineId: 'remote', agentId: 'help' })
    expect(f.frames.at(-1)).toMatchObject({ connId: 'first', payload: { op: 'latest', agentId: 'help' } })
    f.answer({ active: true, agentId: 'help', label: 'Your reading' }); await next
    const back = f.visit.command({ op: 'back', visitId: command.visitId })
    expect(f.frames.at(-1)?.connId).toBe('first')
    f.answer()
    expect(await back).toMatchObject({ ok: true, agentId: 'origin', active: false })
  })

  it('a stale Latest request cannot change panes or discard an existing return', async () => {
    const f = fixture()
    const command = { op: 'latest' as const, visitId: 'visit-reading', machineId: 'local', agentId: 'origin' }
    const first = f.visit.command(command)
    f.answer({ active: true, agentId: 'origin', label: 'Your reading' }); await first
    const count = f.frames.length
    expect(await f.visit.command({ ...command, agentId: 'wrong-pane' })).toMatchObject({ ok: false, active: true })
    expect(f.frames).toHaveLength(count)
    const back = f.visit.command({ op: 'back', visitId: command.visitId }); f.answer()
    expect((await back).ok).toBe(true)
  })

  it('returns through the original window socket after a cross-machine visit', async () => {
    const f = fixture()
    const pending = f.visit.command(open)
    expect(f.frames[0]).toMatchObject({ connId: 'first', payload: {
      fromMachineId: 'local', fromAgentId: 'origin', machineId: 'remote', agentId: 'help' } })
    f.answer()
    expect(await pending).toMatchObject({ ok: true, active: true })
    f.focus({ connId: 'remote-socket', machineId: 'remote', agentId: 'help' })
    const back = f.visit.command({ op: 'back', visitId: 'visit-one' })
    expect(f.frames.at(-1)?.connId).toBe('first')
    f.answer()
    expect(await back).toMatchObject({ ok: true, active: false, agentId: 'origin' })
    expect(f.frames.at(-1)?.payload.op).toBe('cancel')
  })

  it('ignores replies from another window, machine, request or visit', async () => {
    const f = fixture()
    const pending = f.visit.command(open)
    const finish = vi.fn(); void pending.then(finish)
    f.answer({}, 'other-window')
    f.answer({}, 'first', 'remote')
    f.answer({ requestId: 'old' })
    f.answer({ visitId: 'old' })
    await Promise.resolve()
    expect(finish).not.toHaveBeenCalled()
    f.answer()
    expect((await pending).ok).toBe(true)
    f.visit.cancel()
  })

  it('keeps a return available when the desktop asks to close a picker', async () => {
    const f = fixture()
    const pending = f.visit.command(open); f.answer(); await pending
    const back = f.visit.command({ op: 'back', visitId: 'visit-one' })
    f.answer({ ok: false, active: true, error: 'Close the picker.' })
    expect(await back).toMatchObject({ ok: false, active: true, label: 'My work' })
    const retry = f.visit.command({ op: 'back', visitId: 'visit-one' }); f.answer()
    expect((await retry).ok).toBe(true)
  })

  it('a missing window times out once and cannot be revived by a late reply', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const pending = f.visit.command(open)
    const frame = f.frames[0].payload
    await vi.advanceTimersByTimeAsync(101)
    expect(await pending).toMatchObject({ ok: false, active: false })
    expect(f.frames.map(f => f.payload.op)).toEqual(['open', 'cancel'])
    f.visit.reply('first', 'local', { ...frame, ok: true, active: true, label: 'late', agentId: 'help' })
    expect((await f.visit.command({ op: 'back', visitId: 'visit-one' })).ok).toBe(false)
  })

  it.each([{ agentId: 'wrong-pane' }, { label: 'x'.repeat(193) }, { active: 'true' }])('rejects malformed app state %s', async extra => {
    const f = fixture()
    const pending = f.visit.command(open); f.answer(extra)
    expect(await pending).toMatchObject({ ok: false, active: false })
  })

  it('old cancellation cannot close a replacement visit', async () => {
    const f = fixture()
    const first = f.visit.command(open); f.answer(); await first
    const next = f.visit.command({ ...open, visitId: 'visit-two' }); f.answer(); await next
    await f.visit.command({ op: 'cancel', visitId: 'visit-one' })
    const back = f.visit.command({ op: 'back', visitId: 'visit-two' }); f.answer()
    expect((await back).ok).toBe(true)
  })

  it('disconnect completes the waiter and releases the local bookmark', async () => {
    const f = fixture()
    const pending = f.visit.command(open)
    f.visit.cancel()
    expect(await pending).toMatchObject({ ok: false, active: false })
    expect(f.frames.at(-1)?.payload.op).toBe('cancel')
    f.offline()
    expect((await f.visit.command(open)).ok).toBe(false)
  })
})
