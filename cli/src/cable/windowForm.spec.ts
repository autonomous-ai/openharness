import { afterEach, expect, it, vi } from 'vitest'
import { WindowForm } from './windowForm.js'

function fixture() {
  let focus: { connId: string; machineId: string } | undefined = { connId: 'desk', machineId: 'local' }
  const frames: { connId: string; payload: Record<string, unknown> }[] = []
  let writable = true
  const form = new WindowForm({ focus: () => focus, timeoutMs: 100,
    send: (connId, payload) => { frames.push({ connId, payload }); return writable } })
  return { form, frames, focus: (value: typeof focus) => { focus = value }, offline: () => { writable = false },
    answer: (extra: Record<string, unknown> = {}, connId = 'desk', machineId = 'local') => {
      const p = frames.at(-1)!.payload
      form.reply(connId, machineId, { requestId: p.requestId, formId: p.formId,
        ok: true, active: true, revision: 1, position: 4, total: 4,
        title: 'New Harness', label: 'New Harness', detail: 'Codex\nM2:~/project',
        busy: false, enabled: true, action: 'start', ...extra })
    },
  }
}
const open = { op: 'open' as const, formId: 'form-one' }
afterEach(() => vi.useRealTimers())

it('pins an empty or populated window; choosing a remote project does not move the route', async () => {
  const f = fixture(), result = f.form.command(open)
  f.answer(); expect(await result).toMatchObject({ active: true, label: 'New Harness' })
  f.focus({ connId: 'other', machineId: 'remote' })
  const moved = f.form.command({ ...open, op: 'move', revision: 1, delta: 1 })
  expect(f.frames.at(-1)?.connId).toBe('desk')
  f.answer({ revision: 2 }); expect(await moved).toMatchObject({ revision: 2 })
})
it('ignores another socket, machine, form or request and serializes actions', async () => {
  const f = fixture(), result = f.form.command(open)
  f.answer({}, 'other'); f.answer({}, 'desk', 'remote')
  f.answer({ formId: 'stale' }); f.answer({ requestId: 'stale' })
  expect(await f.form.command(open)).toMatchObject({ ok: false })
  expect(f.frames).toHaveLength(1)
  f.answer(); expect(await result).toMatchObject({ ok: true })
})
it('times out without retrying activation or dismissing an uncertain launch', async () => {
  vi.useFakeTimers()
  const f = fixture(), opening = f.form.command(open); f.answer(); await opening
  const launching = f.form.command({ ...open, op: 'activate', revision: 1 })
  await vi.advanceTimersByTimeAsync(101)
  expect(await launching).toMatchObject({ ok: false, error: expect.stringContaining('Check') })
  expect(f.frames.map(f => f.payload.op)).toEqual(['open', 'activate'])
  const state = f.form.command({ ...open, op: 'state', revision: 1 })
  f.answer({ action: 'check status' }); expect(await state).toMatchObject({ action: 'check status' })
})
it('bounds UTF-8 output and rejects malformed state', async () => {
  const f = fixture(), p = f.form.command(open)
  f.answer({ detail: '猫'.repeat(200) })
  const r = await p
  expect(Buffer.byteLength(r.detail!)).toBeLessThanOrEqual(383)
  expect(r.detail).toBe('猫'.repeat(127))
  const bad = f.form.command({ ...open, op: 'state', revision: 1 })
  f.answer({ revision: -1 }); expect(await bad).toMatchObject({ ok: false, active: false })
})
it('rejects invalid commands and obsolete identities without sending', async () => {
  const f = fixture()
  expect(await f.form.command({ ...open, op: 'activate', revision: 1 })).toMatchObject({ ok: false })
  expect(await f.form.command({ ...open, op: 'move', delta: 0, revision: 1 })).toMatchObject({ ok: false })
  expect(await f.form.command({ ...open, op: 'move', delta: 100, revision: 1 })).toMatchObject({ ok: false })
  expect(await f.form.command({ ...open, formId: 'bad/id' })).toMatchObject({ ok: false })
  expect(f.frames).toHaveLength(0)
})
it('handles disconnect and a missing desktop without navigating it', async () => {
  const f = fixture(), opening = f.form.command(open)
  f.form.clear(); expect(await opening).toMatchObject({ ok: false })
  f.answer(); expect(f.frames).toHaveLength(1)
  f.focus(undefined); expect(await f.form.command(open)).toMatchObject({ ok: false })
  f.focus({ connId: 'desk', machineId: 'local' }); f.offline()
  expect(await f.form.command(open)).toMatchObject({ ok: false })
})

it('settles only the disconnected window and never replays its pending action', async () => {
  const f = fixture(), opened = f.form.command(open)
  f.answer(); await opened
  const activating = f.form.command({ ...open, op: 'activate', revision: 1 })
  f.form.disconnected('background')
  f.answer(); expect(await activating).toMatchObject({ ok: true })
  const pending = f.form.command({ ...open, op: 'activate', revision: 1 })
  f.form.disconnected('desk')
  expect(await pending).toMatchObject({ ok: false, active: false, error: expect.stringContaining('disconnected') })
  f.answer() // A reply already in flight cannot restore the old picker.
  expect(await f.form.command({ ...open, op: 'state', revision: 1 })).toMatchObject({ ok: false })
  expect(f.frames.map(frame => frame.payload.op)).toEqual(['open', 'activate', 'activate'])
  f.focus({ connId: 'replacement', machineId: 'local' })
  const fresh = f.form.command({ ...open, formId: 'find-reopened', surface: 'find' })
  expect(f.frames.at(-1)?.connId).toBe('replacement')
  f.answer({ canQuery: true }, 'replacement')
  expect(await fresh).toMatchObject({ ok: true, canQuery: true })
})

it('logs loading and refusal flags without picker contents', async () => {
  const log = vi.fn(), frames: Record<string, unknown>[] = []
  const form = new WindowForm({ focus: () => ({ connId: 'desk', machineId: 'local' }), log,
    send: (_conn, payload) => { frames.push(payload); return true } })
  const pending = form.command({ ...open, surface: 'find' })
  form.reply('desk', 'local', { ...frames[0], ok: false, active: false,
    label: 'private harness name', query: 'private spoken query', error: 'Return to the Harness window first.' })
  expect(await pending).toMatchObject({ ok: false })
  expect(log).toHaveBeenCalledExactlyOnceWith('picker open reply ok=0 active=0 query=0 busy=0 reason=foreground-required')
})

it('pins a voice query to the form and cancels even while its reply is pending', async () => {
  const f = fixture(), opening = f.form.command(open); f.answer(); await opening
  const command = { ...open, op: 'query.begin' as const, queryId: 'upload', revision: 1 }
  const pending = f.form.command(command)
  f.answer({ canQuery: true, queryId: 'wrong' })
  expect(await pending).toMatchObject({ ok: false })
  const pinned = f.form.command(command)
  f.answer({ canQuery: true, queryId: 'upload' })
  expect(await pinned).toMatchObject({ ok: true, queryId: 'upload' })
  const applying = f.form.command({ ...command, op: 'query', text: 'Codex' })
  await f.form.command({ ...command, op: 'query.cancel' })
  expect(await applying).toMatchObject({ ok: false })
  expect(f.frames.at(-1)?.payload).toMatchObject({ op: 'query.cancel', queryId: 'upload' })
})

it('keeps Finder bound to its window and refuses changing a live surface identity', async () => {
  const f = fixture(), opening = f.form.command({ ...open, surface: 'find' })
  expect(f.frames.at(-1)?.payload).toMatchObject({ surface: 'find' })
  f.answer({ title: 'Find Harness', label: 'Agent 69', action: 'open', canQuery: true })
  expect(await opening).toMatchObject({ title: 'Find Harness' })
  f.focus({ connId: 'other', machineId: 'remote' })
  expect(await f.form.command({ ...open, surface: 'new' })).toMatchObject({ ok: false })
  expect(f.frames).toHaveLength(1)
  const state = f.form.command({ ...open, op: 'state', revision: 1 })
  expect(f.frames.at(-1)?.connId).toBe('desk')
  f.answer(); expect(await state).toMatchObject({ ok: true })
})
