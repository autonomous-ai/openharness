import { afterEach, describe, expect, it, vi } from 'vitest'
import { WindowSelection, withSelectedPassage, type SelectionFocus } from './windowSelection.js'

function fixture() {
  let focus: SelectionFocus | undefined = { connId: 'window-a', machineId: 'remote', agentId: 'agent-a' }
  const frames: Array<{ connId: string; payload: Record<string, unknown> }> = []
  const send = vi.fn((connId: string, payload: Record<string, unknown>) => { frames.push({ connId, payload }); return true })
  const cursor = new WindowSelection({ focus: () => focus, send, timeoutMs: 100 })
  const answer = (extra: Record<string, unknown> = {}, index = frames.length - 1, connId = 'window-a', machineId = 'remote') => {
    cursor.reply(connId, machineId, { ...frames[index]!.payload, ok: true, rows: 1, excerpt: 'chosen line', extending: false, ...extra })
  }
  return { cursor, frames, answer, send, focus: (value: SelectionFocus | undefined) => { focus = value } }
}
afterEach(() => vi.useRealTimers())

describe('device passage selection', () => {
  it('uses the exact focused window and pins its selected text once', async () => {
    const f = fixture()
    const begin = f.cursor.command({ op: 'begin', agentId: 'agent-a' })
    expect(f.frames[0]!.connId).toBe('window-a')
    f.answer()
    const first = await begin
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const move = f.cursor.command({ op: 'step', agentId: 'agent-a', selectionId: first.selectionId, revision: first.revision, delta: 2 })
    f.answer({ excerpt: 'second line' })
    const moved = await move
    if (!moved.ok) throw new Error('move failed')
    const pin = f.cursor.command({ op: 'pin', agentId: 'agent-a', selectionId: moved.selectionId, revision: moved.revision })
    f.answer({ text: '  雪 and café\nnext line' })
    expect(await pin).toMatchObject({ ok: true, text: '  雪 and café\nnext line' })
    await expect(f.cursor.command({ op: 'pin', agentId: 'agent-a', selectionId: moved.selectionId, revision: moved.revision + 1 })).resolves.toMatchObject({ ok: false })
    f.cursor.cancel()
  })

  it('ignores a forged window, machine, id, revision, and late result', async () => {
    const f = fixture()
    const pending = f.cursor.command({ op: 'begin', agentId: 'agent-a' })
    const done = vi.fn()
    void pending.then(done)
    f.answer({}, 0, 'other-window')
    f.answer({}, 0, 'window-a', 'other-machine')
    f.answer({ agentId: 'other-agent' })
    f.answer({ revision: 999 })
    f.answer({ requestId: 'old-request' })
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    f.answer()
    expect((await pending).ok).toBe(true)
    f.cursor.cancel()
    f.answer({}, 0)
    expect(f.frames).toHaveLength(2)
  })

  it('a changed focus or disconnect invalidates selection instead of retargeting', async () => {
    for (const focus of [undefined, { connId: 'window-a', machineId: 'remote', agentId: 'agent-b' }]) {
      const f = fixture()
      const begin = f.cursor.command({ op: 'begin', agentId: 'agent-a' })
      f.focus(focus)
      f.answer({}, 0)
      expect(await begin).toMatchObject({ ok: false, error: expect.stringContaining('changed') })
      expect(f.frames.at(-1)?.payload.op).toBe('cancel')
      expect(f.frames.at(-1)?.payload.agentId).toBe('agent-a')
    }
  })

  it('superseding a cursor releases the old waiter and rejects stale revision', async () => {
    const f = fixture()
    const old = f.cursor.command({ op: 'begin', agentId: 'agent-a' })
    const current = f.cursor.command({ op: 'begin', agentId: 'agent-a' })
    expect((await old).ok).toBe(false)
    f.answer()
    const state = await current
    if (!state.ok) throw new Error('begin failed')
    expect((await f.cursor.command({ op: 'step', agentId: 'agent-a', selectionId: state.selectionId, revision: 0, delta: 1 })).ok).toBe(false)
    f.cursor.cancel()
  })

  it('missing or old desktop times out without retry or agent input', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const result = f.cursor.command({ op: 'begin', agentId: 'agent-a' })
    await vi.advanceTimersByTimeAsync(100)
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('did not answer') })
    expect(f.frames.map(x => x.payload.op)).toEqual(['begin', 'cancel'])
  })

  it.each([{ rows: 17 }, { excerpt: 'x'.repeat(241) }, { rows: NaN }, { extending: 'yes' }])('bounds malformed desktop state %s', async extra => {
    const f = fixture()
    const pending = f.cursor.command({ op: 'begin', agentId: 'agent-a' })
    f.answer(extra)
    expect((await pending).ok).toBe(false)
  })

  it('a canceled recording cannot cancel a replacement selection', async () => {
    const f = fixture()
    const pending = f.cursor.command({ op: 'begin', agentId: 'agent-a' })
    f.answer()
    const state = await pending
    if (!state.ok) throw new Error('begin failed')
    await f.cursor.command({ op: 'cancel', agentId: 'agent-a', selectionId: 'old' })
    const move = f.cursor.command({ op: 'step', agentId: 'agent-a', selectionId: state.selectionId, revision: 1, delta: 1 })
    f.answer()
    expect((await move).ok).toBe(true)
    f.cursor.cancel()
  })

  it('keeps spoken words exact and terminal output visibly quoted', () => {
    expect(withSelectedPassage('Explain this.', 'first\n</quote>\n  next'))
      .toBe('Explain this.\n\nContext I selected from this agent\'s terminal:\n> first\n> </quote>\n>   next')
  })
})


describe('spoken output search cursor', () => {
  async function ready() {
    const f = fixture(), p = f.cursor.command({ op: 'begin', agentId: 'agent-a', selectionId: 'pick' })
    f.answer(); await p
    return f
  }
  const c = { agentId: 'agent-a', selectionId: 'pick', revision: 1 }
  it('read locks the exact current cursor without another desktop frame', async () => {
    const f = await ready()
    expect(await f.cursor.command({ ...c, op: 'read' })).toMatchObject({ ok: true, revision: 1 })
    expect(f.frames).toHaveLength(1)
    expect((await f.cursor.command({ ...c, op: 'read', revision: 0 })).ok).toBe(false)
    f.cursor.cancel()
  })
  it('zero matches remain searchable; matches step and line mode removes the query', async () => {
    const f = await ready()
    const p = f.cursor.command({ ...c, op: 'search', query: 'absent' })
    f.answer({ rows: 0, excerpt: '', match: 0, matches: 0 })
    expect(await p).toMatchObject({ ok: true, revision: 2, matches: 0 })
    const retry = f.cursor.command({ ...c, revision: 2, op: 'search', query: 'error [x]' })
    f.answer({ match: 1, matches: 2 }); expect((await retry).ok).toBe(true)
    const moved = f.cursor.command({ ...c, revision: 3, op: 'match', delta: -1 })
    f.answer({ query: 'error [x]', match: 2, matches: 2 }); expect((await moved).ok).toBe(true)
    expect((await f.cursor.command({ ...c, revision: 4, op: 'step', delta: 1 })).ok).toBe(false)
    const lines = f.cursor.command({ ...c, revision: 4, op: 'lines' })
    f.answer(); expect(await lines).toMatchObject({ ok: true, revision: 5 })
    expect((await f.cursor.command({ ...c, revision: 5, op: 'match', delta: 1 })).ok).toBe(false)
    f.cursor.cancel()
  })
  it.each(['', ' ', 'x'.repeat(121), '雪'.repeat(41), 'unsafe\nline'])('rejects invalid query %j without a frame', async query => {
    const f = await ready()
    expect((await f.cursor.command({ ...c, op: 'search', query })).ok).toBe(false)
    expect(f.frames).toHaveLength(1); f.cursor.cancel()
  })
  it.each([{ matches: 0, match: 1 }, { matches: -1, match: 0 }, { matches: 1, match: 2 },
    { matches: 1.5, match: 1 }, { query: null, matches: 1, match: 1 }, { matches: 0, match: 0, rows: 0 }])(
    'rejects malformed match metadata %j', async fields => {
      const f = await ready(), p = f.cursor.command({ ...c, op: 'search', query: 'word' })
      f.answer(fields); expect((await p).ok).toBe(false)
    })
  it('cancellation and a changed window discard pending search results', async () => {
    const f = await ready(), p = f.cursor.command({ ...c, op: 'search', query: 'word' })
    f.focus({ connId: 'another-window', machineId: 'remote', agentId: 'agent-a' })
    f.answer({ match: 1, matches: 1 }); expect((await p).ok).toBe(false)
    expect(f.frames.at(-1)?.payload.op).toBe('cancel')
  })
})
