import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { InteractiveViewerCapture, InteractiveViewers, monitorHostActions, surfaceFrame, surfaceScale, type PushSink } from './interactiveViewer.js'

const frame = (extra = {}) => ({ surfaceId: 'one', agentId: 'agent', op: 'frame', width: 800, height: 600, dark: true, ...extra })
const pointer = { type: 'pointer', event: 'mousePressed', x: .5, y: .25, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 }

describe('interactive viewer input boundary', () => {
  it('allows only bounded monitor navigation, never executable input or lifecycle writes', () => {
    expect(monitorHostActions([{ action: 'open', machineId: 'm', agentId: 'a', script: 'ignored' },
      { action: 'assistant', chooseModel: true, prompt: 'ignored' }, { action: 'stop', agentId: 'a' }, null,
      { action: 'open', machineId: 'm', agentId: '' }])).toEqual([
      { action: 'open', machineId: 'm', agentId: 'a' }, { action: 'assistant', chooseModel: true },
    ])
    expect(monitorHostActions(Array(9).fill({ action: 'assistant' }))).toEqual([])
  })
  it('maps only ordinary pointer, keyboard, and text input to CDP', () => {
    const parsed = surfaceFrame(frame({ events: [pointer,
      { type: 'key', event: 'keyDown', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0 },
      { type: 'text', text: 'hello 世界' },
      { ...pointer, event: 'mouseWheel', deltaX: 0, deltaY: 80 },
    ] }))!
    expect(parsed.commands).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 399.5, y: 149.75, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r' } },
      { method: 'Input.insertText', params: { text: 'hello 世界' } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 399.5, y: 149.75, button: 'left', buttons: 1, clickCount: 1, modifiers: 0, deltaX: 0, deltaY: 80 } },
    ])
  })
  it.each([
    { width: Infinity }, { height: 9000 }, { dark: 'yes' }, { reload: 'yes' }, { events: {} },
    { events: Array(65).fill(pointer) }, { events: [null] }, { events: [{ type: 'Runtime.evaluate', expression: 'secrets' }] },
    { events: [{ ...pointer, x: NaN }] }, { events: [{ ...pointer, x: -1 }] },
    { events: [{ ...pointer, event: 'mouseWheel', deltaX: 0, deltaY: 9000 }] },
    { events: [{ type: 'text', text: 'a'.repeat(65_537) }] },
    { events: [{ type: 'key', event: 'keyDown', key: 'x', code: 'KeyX', keyCode: 88, modifiers: 999 }] },
  ])('rejects malformed or excessive input without executing it: %j', extra => {
    expect(surfaceFrame(frame(extra))).toBeNull()
  })
  it('reads v2 geometry and lowers the scale to the pixel cap', () => {
    expect(surfaceFrame(frame({ width: 390, height: 844, scale: 3, mobile: true, touch: true })))
      .toMatchObject({ width: 390, height: 844, scale: 3, mobile: true, touch: true, copy: null })
    expect(surfaceFrame(frame())).toMatchObject({ scale: 1, mobile: false, touch: false })
    expect(surfaceFrame(frame({ width: 3840, height: 2160, scale: 2 }))!.scale).toBe(surfaceScale(3840, 2160, 2))
    expect(surfaceScale(3840, 2160, 2)).toBeLessThan(1)
    expect(surfaceScale(3840, 2160, 2) ** 2 * 3840 * 2160).toBeLessThanOrEqual(4_200_000)
    expect(surfaceScale(800, 600, 2)).toBe(2)
    expect(surfaceScale(160, 120, 3)).toBe(3)
  })
  it('maps touch, key commands, printable key text, paste-sized text and copy', () => {
    const parsed = surfaceFrame(frame({ width: 400, height: 800, events: [
      { type: 'touch', event: 'touchStart', points: [{ x: .5, y: .5, id: 0 }], modifiers: 0 },
      { type: 'touch', event: 'touchEnd', points: [{ x: .5, y: .5, id: 0 }], modifiers: 0 },
      { type: 'touch', event: 'touchCancel', points: [], modifiers: 0 },
      { type: 'key', event: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 4, text: 'a', commands: ['selectAll'] },
      { type: 'text', text: 'x'.repeat(65_536) },
      { type: 'cut' },
    ] }))!
    expect(parsed.commands).toEqual([
      { method: 'Input.dispatchTouchEvent', params: { type: 'touchStart', touchPoints: [{ x: 199.5, y: 399.5, id: 0 }], modifiers: 0 } },
      { method: 'Input.dispatchTouchEvent', params: { type: 'touchEnd', touchPoints: [{ x: 199.5, y: 399.5, id: 0 }], modifiers: 0 } },
      { method: 'Input.dispatchTouchEvent', params: { type: 'touchCancel', touchPoints: [], modifiers: 0 } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, text: 'a', commands: ['selectAll'] } },
      { method: 'Input.insertText', params: { text: 'x'.repeat(65_536) } },
    ])
    expect(parsed.copy).toBe('cut')
  })
  it.each([
    { width: 3841 }, { height: 2401 }, { scale: 0 }, { scale: 4 }, { scale: '2' }, { mobile: 'yes' }, { touch: 1 },
    { events: [{ type: 'touch', event: 'touchStart', points: Array(6).fill({ x: 0, y: 0, id: 0 }), modifiers: 0 }] },
    { events: [{ type: 'touch', event: 'touchStart', points: [{ x: 2, y: 0, id: 0 }], modifiers: 0 }] },
    { events: [{ type: 'touch', event: 'touchStart', points: [{ x: 0, y: 0, id: 99 }], modifiers: 0 }] },
    { events: [{ type: 'touch', event: 'pinch', points: [], modifiers: 0 }] },
    { events: [{ type: 'touch', event: 'touchStart', points: [], modifiers: 0 }] },
    { events: [{ type: 'touch', event: 'touchMove', points: [], modifiers: 0 }] },
    { events: [{ type: 'key', event: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, commands: ['evaluate'] }] },
    ...['copy', 'cut', 'paste'].map(command =>
      ({ events: [{ type: 'key', event: 'keyDown', key: 'c', code: 'KeyC', keyCode: 67, modifiers: 4, commands: [command] }] })),
    { events: [{ type: 'key', event: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, text: 'too long text' }] },
    { events: [{ type: 'key', event: 'keyUp', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, text: 'a' }] },
    { events: [{ type: 'text', text: 'a'.repeat(65_537) }] },
  ])('rejects malformed v2 input without executing it: %j', extra => {
    expect(surfaceFrame(frame(extra))).toBeNull()
  })
  it('applies viewport/theme changes once, with input before the image', async () => {
    const capture = new InteractiveViewerCapture()
    const command = vi.spyOn(capture as any, 'call').mockResolvedValue({})
    const screenshot = vi.spyOn(capture, 'capture').mockResolvedValue('jpeg')
    await capture.frame(surfaceFrame(frame())!)
    await capture.frame(surfaceFrame(frame({ events: [{ type: 'text', text: 'hi' }] }))!)
    expect(command.mock.calls.map(call => call[0])).toEqual([
      'Emulation.setDeviceMetricsOverride', 'Emulation.setEmulatedMedia', 'Input.insertText',
    ])
    expect(screenshot).toHaveBeenCalledTimes(2)
    await capture.frame(surfaceFrame(frame({ width: 900, reload: true }))!)
    expect(command.mock.calls.slice(-3).map(call => call[0])).toEqual([
      'Emulation.setDeviceMetricsOverride', 'Page.reload', 'Emulation.setEmulatedMedia',
    ])
  })
})

describe('dense screencast shots', () => {
  const setup = (scale: number, shot: () => Promise<string>) => {
    const capture = new InteractiveViewerCapture() as any
    const call = vi.spyOn(capture, 'call').mockResolvedValue({})
    const screenshot = vi.spyOn(capture, 'capture').mockImplementation(shot)
    capture.casting = true
    capture.size = { width: 400, height: 300, scale }
    capture.onEvent('Page.screencastFrame', { sessionId: 7, data: 'cast' })
    return { capture: capture as InteractiveViewerCapture, call, screenshot }
  }
  it('hands out a fresh screenshot at scale 2 and still acks the screencast frame', async () => {
    const { capture, call, screenshot } = setup(2, async () => 'dense')
    expect((await capture.next(0, 100))?.data).toBe('dense')
    expect(screenshot).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 7 })
  })
  it('hands out the screencast frame at scale 1 without a screenshot', async () => {
    const { capture, screenshot } = setup(1, async () => 'dense')
    expect((await capture.next(0, 100))?.data).toBe('cast')
    expect(screenshot).not.toHaveBeenCalled()
  })
  it('falls back to the screencast frame when the screenshot fails', async () => {
    const { capture } = setup(2, async () => { throw new Error('gone') })
    expect((await capture.next(0, 100))?.data).toBe('cast')
  })
})

describe('owner viewer sessions', () => {
  let viewers: InteractiveViewers, target: string | null
  let captures: Array<Record<'start' | 'frame' | 'apply' | 'next' | 'wake' | 'editable' | 'selection' | 'deleteSelection' | 'takeHostActions' | 'stop', ReturnType<typeof vi.fn>>>
  beforeEach(() => {
    vi.useFakeTimers(); captures = []; target = 'http://127.0.0.1:8000/'
    viewers = new InteractiveViewers(() => target, () => {
      const capture = { start: vi.fn(async () => {}), frame: vi.fn(async () => 'jpeg'), apply: vi.fn(async () => {}),
        next: vi.fn(async (_after: number) => ({ seq: 1, data: 'cast' }) as { seq: number; data: string } | null),
        wake: vi.fn(), frameSeq: 1, editable: vi.fn(async () => false), selection: vi.fn(async () => 'picked'),
        deleteSelection: vi.fn(async () => {}), takeHostActions: vi.fn(async () => []), stop: vi.fn(async () => {}) }
      captures.push(capture)
      return capture as unknown as InteractiveViewerCapture
    })
  })
  afterEach(() => { viewers.closeAll(); vi.useRealTimers() })

  it('reuses a connection-owned renderer and closes only the caller’s session', async () => {
    expect(await viewers.request('one', frame())).toMatchObject({ data: 'jpeg', width: 800 })
    await viewers.request('one', frame())
    expect(captures[0].start).toHaveBeenCalledTimes(1)
    expect(captures[0].start).toHaveBeenCalledWith(target)
    await viewers.request('two', frame())
    await viewers.request('one', frame({ op: 'close' }))
    expect(captures[0].stop).toHaveBeenCalledOnce()
    expect(captures[1].stop).not.toHaveBeenCalled()
    viewers.closeConnection('two')
    expect(captures[1].stop).toHaveBeenCalledOnce()
  })
  it('never accepts an arbitrary URL, another agent, or an invalid action', async () => {
    expect(await viewers.request('one', frame({ surfaceId: '../bad' }))).toHaveProperty('error', 'INVALID_VIEWER_REQUEST')
    await viewers.request('one', frame({ url: 'http://attacker.invalid' }))
    expect(captures[0].start).toHaveBeenCalledWith(target)
    expect(await viewers.request('one', frame({ agentId: 'other' }))).toHaveProperty('error', 'INVALID_VIEWER_REQUEST')
    expect(await viewers.request('one', frame({ op: 'evaluate' }))).toHaveProperty('error', 'INVALID_VIEWER_REQUEST')
    expect(await viewers.request('one', frame({ width: -1 }))).toHaveProperty('error', 'INVALID_VIEWER_REQUEST')
    target = 'https://external.invalid'
    expect(await viewers.request('one', frame())).toHaveProperty('error', 'VIEWER_UNAVAILABLE')
    expect(captures[0].stop).toHaveBeenCalledOnce()
  })
  it('bounds per-client renderers and expires abandoned surfaces', async () => {
    for (let i = 0; i < 4; i++) await viewers.request('one', frame({ surfaceId: `s-${i}` }))
    expect(await viewers.request('one', frame({ surfaceId: 'fifth' }))).toHaveProperty('error', 'VIEWER_LIMIT')
    for (let i = 0; i < 4; i++) await viewers.request('two', frame({ surfaceId: `s-${i}` }))
    expect(await viewers.request('three', frame())).toHaveProperty('error', 'VIEWER_LIMIT')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(captures.every(capture => capture.stop.mock.calls.length === 1)).toBe(true)
  })
  it('discards an old target before another process can reuse its port', async () => {
    await viewers.request('one', frame())
    target = 'http://127.0.0.1:9000/'
    viewers.refresh('agent')
    expect(captures[0].stop).toHaveBeenCalledOnce()
    await viewers.request('one', frame())
    expect(captures[1].start).toHaveBeenCalledWith(target)
  })
  it('refuses overlapping captures and never returns a frame after disconnect', async () => {
    await viewers.request('one', frame())
    let finish!: (value: string) => void
    captures[0].frame.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve }))
    const pending = viewers.request('one', frame())
    await vi.advanceTimersByTimeAsync(0) // the frame now waits its turn on the command chain
    expect(await viewers.request('one', frame())).toHaveProperty('error', 'VIEWER_BUSY')
    viewers.closeConnection('one'); finish('old frame')
    expect(await pending).toHaveProperty('error', 'VIEWER_CLOSED')
  })
  it('keeps v1 semantics without after, and says its seq and scale', async () => {
    expect(await viewers.request('one', frame())).toEqual({ data: 'jpeg', mime: 'image/jpeg', width: 800, height: 600, scale: 1, seq: 1, hostActions: [] })
    expect(captures[0].frame).toHaveBeenCalledOnce()
    expect(captures[0].next).not.toHaveBeenCalled()
  })
  it('counts the frame bytes it serves over WS', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await viewers.request('one', frame())
    await viewers.request('one', frame({ after: 0 }))
    expect(viewers.viewerWsBytes).toBe('jpeg'.length + 'cast'.length)
    await viewers.request('two', frame())
    expect(viewers.viewerWsBytes).toBe(12)
    viewers.closeConnection('one')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[viewer-ws\] one closed bytes=8 total=12/))
    viewers.closeConnection('one')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
  it('long-polls with after and reports the scale it applied', async () => {
    expect(await viewers.request('one', frame({ after: 0, width: 3840, height: 2160, scale: 2 })))
      .toMatchObject({ data: 'cast', seq: 1, width: 3840, height: 2160, scale: expect.any(Number) })
    const reply = await viewers.request('one', frame({ after: 0, width: 3840, height: 2160, scale: 2 }))
    expect(reply.scale).toBeLessThan(1)
    expect(captures[0].next).toHaveBeenCalledWith(0, 1000)
    captures[0].next.mockResolvedValueOnce(null)
    expect(await viewers.request('one', frame({ after: 1 }))).toEqual({ seq: 1, unchanged: true })
  })
  it('a newer poll ends the older one; input runs while a poll waits', async () => {
    await viewers.request('one', frame({ after: 0 }))
    let release!: (shot: { seq: number; data: string } | null) => void
    captures[0].next.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const older = viewers.request('one', frame({ after: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    const input = await viewers.request('one', frame({ op: 'input', events: [{ type: 'text', text: 'hi' }] }))
    expect(input).toEqual({ ok: true, seq: 1, editable: false })
    expect(captures[0].apply).toHaveBeenLastCalledWith(expect.objectContaining({ commands: [{ method: 'Input.insertText', params: { text: 'hi' } }] }))
    const newer = viewers.request('one', frame({ after: 1 }))
    expect(captures[0].wake).toHaveBeenCalled()
    release({ seq: 2, data: 'late' })
    expect(await older).toEqual({ seq: 1, unchanged: true })
    expect(await newer).toMatchObject({ data: 'cast' })
  })
  it('copies and cuts the selection, deleting only in an editable field', async () => {
    await viewers.request('one', frame({ after: 0 }))
    expect(await viewers.request('one', frame({ op: 'input', events: [{ type: 'copy' }] }))).toMatchObject({ clipboard: 'picked' })
    expect(captures[0].deleteSelection).not.toHaveBeenCalled()
    captures[0].editable.mockResolvedValue(true)
    expect(await viewers.request('one', frame({ op: 'input', events: [{ type: 'cut' }] }))).toMatchObject({ clipboard: 'picked', editable: true })
    expect(captures[0].deleteSelection).toHaveBeenCalledOnce()
  })
  it('leaves the clipboard and the text alone when nothing is selected', async () => {
    await viewers.request('one', frame({ after: 0 }))
    captures[0].selection.mockResolvedValue('')
    captures[0].editable.mockResolvedValue(true)
    for (const type of ['copy', 'cut']) {
      expect(await viewers.request('one', frame({ op: 'input', events: [{ type }] }))).not.toHaveProperty('clipboard')
    }
    expect(captures[0].deleteSelection).not.toHaveBeenCalled()
  })
  it('refuses input only when too much is queued', async () => {
    await viewers.request('one', frame({ after: 0 }))
    captures[0].apply.mockImplementation(() => new Promise(() => {}))
    const sixtyFour = Array(64).fill({ type: 'text', text: 'x' })
    for (let i = 0; i < 4; i++) void viewers.request('one', frame({ op: 'input', events: sixtyFour }))
    expect(await viewers.request('one', frame({ op: 'input', events: [{ type: 'text', text: 'x' }] }))).toHaveProperty('error', 'VIEWER_BUSY')
  })
  it('a waiting poll ends when its surface closes', async () => {
    await viewers.request('one', frame({ after: 0 }))
    captures[0].next.mockImplementationOnce(() => new Promise(resolve => { captures[0].wake.mockImplementationOnce(() => resolve(null)) }))
    const waiting = viewers.request('one', frame({ after: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    viewers.closeConnection('one')
    expect(await waiting).toHaveProperty('error', 'VIEWER_CLOSED')
    expect(captures[0].stop).toHaveBeenCalledOnce()
  })
  it('clamps a stale after to the new capture’s sequence', async () => {
    await viewers.request('one', frame({ after: 500 }))
    expect(captures[0].next).toHaveBeenCalledWith(1, 1000)
  })
  it('hands over host actions on an unchanged reply, and only when there are some', async () => {
    captures[0] ?? await viewers.request('one', frame())
    captures[0].next.mockResolvedValueOnce(null)
    captures[0].takeHostActions.mockResolvedValueOnce([{ action: 'assistant', chooseModel: false }])
    expect(await viewers.request('one', frame({ after: 1 }))).toEqual({ seq: 1, unchanged: true, hostActions: [{ action: 'assistant', chooseModel: false }] })
    await vi.advanceTimersByTimeAsync(500)
    captures[0].next.mockResolvedValueOnce(null)
    expect(await viewers.request('one', frame({ after: 1 }))).toEqual({ seq: 1, unchanged: true })
  })
  it('a close during apply answers VIEWER_CLOSED', async () => {
    await viewers.request('one', frame({ after: 0 }))
    let fail!: (error: Error) => void
    captures[0].apply.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    const pending = viewers.request('one', frame({ after: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    viewers.closeConnection('one'); fail(new Error('stopped'))
    expect(await pending).toEqual({ error: 'VIEWER_CLOSED' })
  })
  it('does not wait for frames on a poll that a newer one superseded while it applied', async () => {
    await viewers.request('one', frame({ after: 0 }))
    captures[0].next.mockClear()
    let release!: () => void
    captures[0].apply.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const older = viewers.request('one', frame({ after: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    const newer = viewers.request('one', frame({ after: 1 }))
    release()
    expect(await older).toEqual({ seq: 1, unchanged: true })
    await newer
    expect(captures[0].next).toHaveBeenCalledTimes(1)
  })
  it('releases a failed renderer and reports a useful error', async () => {
    await viewers.request('one', frame())
    captures[0].frame.mockRejectedValueOnce(new Error('Chrome stopped'))
    expect(await viewers.request('one', frame())).toMatchObject({ error: 'VIEWER_UNAVAILABLE', detail: 'Chrome stopped' })
    expect(captures[0].stop).toHaveBeenCalledOnce()
    await viewers.request('one', frame())
    expect(captures).toHaveLength(2)
  })
})

describe('pushed viewer surfaces', () => {
  const id = 'a'.repeat(32)
  const open = (extra = {}) => ({ surfaceId: id, agentId: 'agent', width: 800, height: 600, dark: true, after: 0, open: 'o1', ...extra })
  const jpeg = (seq: number) => Buffer.from(`frame ${seq}`)
  let viewers: InteractiveViewers, target: string | null
  // A page that keeps painting by default: every next() is a newer frame. still() makes it a static page:
  // next() then waits like the real one (its wait, or wake()) and answers null when nothing new was painted.
  const fakeCapture = () => {
    let seq = 0, animating = true
    const waiters = new Set<() => void>()
    const wakeAll = () => { for (const done of [...waiters]) done() }
    return { still: () => { animating = false }, paint: () => { seq++; wakeAll() }, waiting: () => waiters.size,
      start: vi.fn(() => startGate ?? Promise.resolve()), apply: vi.fn(async () => {}), frame: vi.fn(async () => 'jpeg'),
      next: vi.fn(async (after: number, wait: number): Promise<{ seq: number; data: string } | null> => {
        if (animating) seq++
        if (seq <= after) {
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); waiters.delete(done); resolve() }
            const timer = setTimeout(done, wait)
            waiters.add(done)
          })
        }
        return seq > after ? { seq, data: jpeg(seq).toString('base64') } : null
      }),
      wake: vi.fn(wakeAll), get frameSeq() { return seq }, editable: vi.fn(async () => false), selection: vi.fn(async () => 'picked'),
      deleteSelection: vi.fn(async () => {}), takeHostActions: vi.fn(async (): Promise<Record<string, unknown>[]> => []), stop: vi.fn(async () => {}) }
  }
  let captures: Array<ReturnType<typeof fakeCapture>>
  let startGate: Promise<void> | undefined  // holds start() pending, like a renderer still launching
  let sink: { frame: Mock<PushSink['frame']>; state: Mock<PushSink['state']> }
  const settle = () => vi.advanceTimersByTimeAsync(0)
  beforeEach(() => {
    vi.useFakeTimers(); captures = []; target = 'http://127.0.0.1:8000/'; startGate = undefined
    viewers = new InteractiveViewers(() => target, () => {
      const capture = fakeCapture()
      captures.push(capture)
      return capture as unknown as InteractiveViewerCapture
    })
    sink = { frame: vi.fn<PushSink['frame']>(() => true), state: vi.fn<PushSink['state']>() }
  })
  afterEach(() => { viewers.closeAll(); vi.useRealTimers() })

  it('streams after surface_open', async () => {
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    expect(captures[0].start).toHaveBeenCalledWith(target)
    expect(captures[0].apply).toHaveBeenCalledWith(expect.objectContaining({ width: 800, height: 600, dark: true }))
    expect(sink.frame).toHaveBeenNthCalledWith(1, 'one', id, { seq: 1, jpeg: jpeg(1), width: 800, height: 600, scale: 1 })
    expect(captures[0].next).toHaveBeenNthCalledWith(1, 0, 1000)
    expect(captures[0].next).toHaveBeenNthCalledWith(2, 1, 1000)
  })
  it('never more than two frames in flight; an ack returns credit up to the frame it names', async () => {
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    expect(sink.frame).toHaveBeenCalledTimes(2)
    viewers.push('one', 'surface_ack', { surfaceId: id, seq: 1 }, sink)
    await settle()
    expect(sink.frame).toHaveBeenCalledTimes(3)
    // A repeated ack returns nothing; a later one also covers the frames before it.
    viewers.push('one', 'surface_ack', { surfaceId: id, seq: 1 }, sink)
    await settle()
    expect(sink.frame).toHaveBeenCalledTimes(3)
    viewers.push('one', 'surface_ack', { surfaceId: id, seq: 3 }, sink)
    await settle()
    expect(sink.frame).toHaveBeenCalledTimes(5)
    expect(sink.frame.mock.calls.map(call => call[2].seq)).toEqual([1, 2, 3, 4, 5])
  })
  it('surface_open and five silent seconds restore the credit of frames that were never acked', async () => {
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(sink.frame).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(sink.frame).toHaveBeenCalledTimes(4)
    viewers.push('one', 'surface_open', open({ after: 4 }), sink)
    await settle()
    expect(sink.frame).toHaveBeenCalledTimes(6)
    expect(captures).toHaveLength(1)
    expect(captures[0].start).toHaveBeenCalledOnce()
  })
  it('surface_input applies through the chain and answers surface_state', async () => {
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    viewers.push('one', 'surface_input', open({ input: 'i-1', events: [{ type: 'text', text: 'hi' }] }), sink)
    await settle()
    expect(captures[0].apply).toHaveBeenLastCalledWith(expect.objectContaining({ commands: [{ method: 'Input.insertText', params: { text: 'hi' } }] }))
    expect(sink.state).toHaveBeenLastCalledWith('one', { type: 'surface_state', surfaceId: id, input: 'i-1', seq: 2, editable: false, open: 'o1' })
    captures[0].editable.mockResolvedValue(true)
    viewers.push('one', 'surface_input', open({ input: 'i-2', events: [{ type: 'cut' }] }), sink)
    await settle()
    expect(sink.state).toHaveBeenLastCalledWith('one', { type: 'surface_state', surfaceId: id, input: 'i-2', seq: 2, editable: true, clipboard: 'picked', open: 'o1' })
    expect(captures[0].deleteSelection).toHaveBeenCalledOnce()
    captures[0].selection.mockResolvedValue('')
    viewers.push('one', 'surface_input', open({ input: 'i-3', events: [{ type: 'cut' }] }), sink)
    await settle()
    expect(sink.state.mock.lastCall![1]).not.toHaveProperty('clipboard')
    expect(captures[0].deleteSelection).toHaveBeenCalledOnce()
  })
  it('surface_close and closeConnection end the push, leaving no timer behind', async () => {
    const baseline = vi.getTimerCount()
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    viewers.push('one', 'surface_close', { surfaceId: id }, sink)
    expect(captures[0].stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(baseline)
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    viewers.closeConnection('one')
    expect(captures[1].stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(baseline)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sink.frame).toHaveBeenCalledTimes(4)
    expect(sink.state).not.toHaveBeenCalled()
  })
  it('a frame the sink refuses ends the push loop; the surface stays for the WS long-poll', async () => {
    const baseline = vi.getTimerCount()
    sink.frame.mockReturnValue(false)
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sink.frame).toHaveBeenCalledOnce()
    expect(captures[0].next).toHaveBeenCalledOnce()
    expect(captures[0].stop).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(baseline + 1) // the surface's idle timer, nothing of the push
    expect(await viewers.request('one', { ...open({ after: 1 }), op: 'frame' })).toMatchObject({ seq: 2, data: jpeg(2).toString('base64') })
    expect(captures).toHaveLength(1)
  })
  it('shares the surface a WS long-poll made, and its limits', async () => {
    await viewers.request('one', { ...open(), op: 'frame' })
    viewers.push('one', 'surface_open', open({ after: 1 }), sink)
    await settle()
    expect(captures).toHaveLength(1)
    expect(captures[0].start).toHaveBeenCalledOnce()
    expect(sink.frame.mock.calls[0][2].seq).toBe(2)
    for (const s of ['b', 'c', 'd']) viewers.push('one', 'surface_open', open({ surfaceId: s.repeat(32) }), sink)
    viewers.push('one', 'surface_open', open({ surfaceId: 'e'.repeat(32) }), sink)
    expect(sink.state).toHaveBeenLastCalledWith('one', expect.objectContaining({ type: 'surface_error', surfaceId: 'e'.repeat(32), error: 'VIEWER_LIMIT' }))
  })
  it('owner rules and validation are the same', async () => {
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    const invalid = async (type: Parameters<InteractiveViewers['push']>[1], payload: Record<string, unknown>) => {
      sink.state.mockClear()
      viewers.push('one', type, payload, sink)
      await settle()
      expect(sink.state).toHaveBeenCalledWith('one', expect.objectContaining({ type: 'surface_error', error: 'INVALID_VIEWER_REQUEST' }))
    }
    for (const bad of [{ surfaceId: 'one' }, { surfaceId: 'A'.repeat(32) }, { surfaceId: 'b'.repeat(32), width: -1 },
      { surfaceId: 'b'.repeat(32), events: [{ type: 'Runtime.evaluate', expression: 'secrets' }] },
      { surfaceId: 'b'.repeat(32), after: -1 }, { agentId: 'other' }]) await invalid('surface_open', open(bad))
    expect(sink.state).toHaveBeenCalledWith('one', { type: 'surface_error', surfaceId: id, error: 'INVALID_VIEWER_REQUEST', open: 'o1' })
    await invalid('surface_input', open({ events: [] }))
    await invalid('surface_input', open({ input: 'x'.repeat(65) }))
    // The core's id rule (viewerStreamId), as for the open: a space or a slash is no id a client mints.
    for (const input of ['i 1', 'i/1']) {
      await invalid('surface_input', open({ input, events: [] }))
      expect(sink.state.mock.lastCall![1]).not.toHaveProperty('input')
    }
    await invalid('surface_input', open({ input: 'i', events: [{ type: 'Runtime.evaluate' }] }))
    expect(sink.state).toHaveBeenCalledWith('one', { type: 'surface_error', surfaceId: id, input: 'i', error: 'INVALID_VIEWER_REQUEST', open: 'o1' })
    await invalid('surface_ack', { surfaceId: id, seq: 'x' })
    await invalid('surface_close', { surfaceId: 'nope' })
    expect(captures).toHaveLength(1)
  })
  it('hands over host actions in surface_state, only when there are some', async () => {
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    expect(captures[0].takeHostActions).toHaveBeenCalledWith(target)
    expect(sink.state).not.toHaveBeenCalled()
    captures[0].takeHostActions.mockResolvedValueOnce([{ action: 'assistant', chooseModel: false }])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sink.state).toHaveBeenCalledWith('one', { type: 'surface_state', surfaceId: id, seq: expect.any(Number), hostActions: [{ action: 'assistant', chooseModel: false }], open: 'o1' })
  })
  it('a new viewer target ends the push: refresh() tells the client, a reopen just moves to it', async () => {
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    target = 'http://127.0.0.1:9000/'
    viewers.refresh('agent')
    expect(sink.state).toHaveBeenCalledWith('one', { type: 'surface_error', surfaceId: id, error: 'VIEWER_CLOSED', open: 'o1' })
    expect(captures[0].stop).toHaveBeenCalledOnce()
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    sink.state.mockClear(); sink.frame.mockClear()
    target = 'http://127.0.0.1:9100/'
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    expect(sink.state).not.toHaveBeenCalled()
    expect(captures[2].start).toHaveBeenCalledWith(target)
    expect(sink.frame).toHaveBeenCalledTimes(2)
  })
  it('an ack while surface_open is still starting neither pumps early nor tears the surface down', async () => {
    const baseline = vi.getTimerCount()
    let started!: () => void
    startGate = new Promise<void>(resolve => { started = resolve })
    viewers.push('one', 'surface_open', open(), sink)
    viewers.push('one', 'surface_ack', { surfaceId: id, seq: 0 }, sink)
    await settle()
    expect(captures[0].next).not.toHaveBeenCalled()
    expect(captures[0].stop).not.toHaveBeenCalled()
    expect(sink.state).not.toHaveBeenCalled()
    started()
    await settle()
    expect(captures[0].apply.mock.invocationCallOrder[0]).toBeLessThan(captures[0].next.mock.invocationCallOrder[0])
    expect(sink.frame).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(baseline + 2) // the idle timer and one ack timeout
  })
  it('a static page stays open while the client repeats its ack, and closes 30 s after the acks stop', async () => {
    const baseline = vi.getTimerCount()
    viewers.push('one', 'surface_open', open(), sink)
    captures[0].still(); captures[0].paint()
    await settle()
    expect(sink.frame).toHaveBeenCalledOnce()
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(10_000)
      viewers.push('one', 'surface_ack', { surfaceId: id, seq: 1 }, sink)
    }
    expect(captures[0].stop).not.toHaveBeenCalled()
    expect(sink.state).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sink.state).toHaveBeenCalledWith('one', { type: 'surface_error', surfaceId: id, error: 'VIEWER_CLOSED', open: 'o1' })
    expect(sink.frame).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(baseline)
  })
  it('a stale ack does not postpone the ack timeout', async () => {
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    await vi.advanceTimersByTimeAsync(3_000)
    viewers.push('one', 'surface_ack', { surfaceId: id, seq: 0 }, sink)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sink.frame).toHaveBeenCalledTimes(4)
  })
  it('a WS long-poll or v1 frame on a pushed surface ends the push: the client switched paths', async () => {
    const baseline = vi.getTimerCount()
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    expect(await viewers.request('one', { ...open({ after: 2 }), op: 'frame' })).toMatchObject({ seq: 3 })
    expect(vi.getTimerCount()).toBe(baseline + 1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sink.frame).toHaveBeenCalledTimes(2)
    captures[0].takeHostActions.mockResolvedValueOnce([{ action: 'assistant', chooseModel: false }])
    expect(await viewers.request('one', { ...open({ after: 3 }), op: 'frame' })).toMatchObject({ hostActions: [{ action: 'assistant', chooseModel: false }] })
    expect(sink.state).not.toHaveBeenCalled()
    viewers.push('one', 'surface_open', open({ after: 4 }), sink)
    await settle()
    const { after: _, ...v1 } = open()
    expect(await viewers.request('one', { ...v1, op: 'frame' })).toMatchObject({ data: 'jpeg' })
    expect(vi.getTimerCount()).toBe(baseline + 1)
  })
  it('an invalid reopen leaves the working push alone; an unknown type opens nothing', async () => {
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    viewers.push('one', 'surface_open', open({ width: -1 }), sink)
    expect(sink.state).toHaveBeenLastCalledWith('one', { type: 'surface_error', surfaceId: id, error: 'INVALID_VIEWER_REQUEST', open: 'o1' })
    viewers.push('one', 'surface_ack', { surfaceId: id, seq: 2 }, sink)
    await settle()
    expect(sink.frame).toHaveBeenCalledTimes(4)
    viewers.push('one', 'surface_bogus' as 'surface_open', open({ surfaceId: 'b'.repeat(32) }), sink)
    expect(sink.state).toHaveBeenLastCalledWith('one', { type: 'surface_error', surfaceId: 'b'.repeat(32), error: 'INVALID_VIEWER_REQUEST', open: 'o1' })
    expect(captures).toHaveLength(1)
  })
  it('a reopen wakes the replaced loop out of its wait, leaving one loop', async () => {
    viewers.push('one', 'surface_open', open(), sink)
    captures[0].still(); captures[0].paint()
    await settle()
    expect(captures[0].waiting()).toBe(1)
    viewers.push('one', 'surface_open', open({ after: 1 }), sink)
    await settle()
    expect(captures[0].wake).toHaveBeenCalled()
    expect(captures[0].waiting()).toBe(1)
    captures[0].paint()
    await settle()
    expect(sink.frame.mock.calls.map(call => call[2].seq)).toEqual([1, 2])
  })
  it('a sink that throws on an input answer does not leave an unhandled rejection', async () => {
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    sink.state.mockImplementation(() => { throw new Error('sink gone') })
    viewers.push('one', 'surface_input', open({ input: 'i', events: [] }), sink)
    await settle()
    expect(sink.state).toHaveBeenCalled()
  })
  it('an ack or input for a stopped push or a missing surface answers VIEWER_CLOSED, naming the open it carried', async () => {
    sink.frame.mockReturnValue(false)
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    // The refusal itself is told too: the client may be waiting on a frame that will never come.
    expect(sink.state).toHaveBeenCalledWith('one', expect.objectContaining({ type: 'surface_error', surfaceId: id, error: 'VIEWER_CLOSED', open: 'o1' }))
    sink.state.mockClear()
    viewers.push('one', 'surface_ack', { surfaceId: id, seq: 1, open: 'o1' }, sink)
    expect(sink.state).toHaveBeenLastCalledWith('one', expect.objectContaining({ type: 'surface_error', surfaceId: id, error: 'VIEWER_CLOSED', open: 'o1' }))
    viewers.push('one', 'surface_input', open({ input: 'i', events: [] }), sink)
    await settle()
    expect(sink.state).toHaveBeenLastCalledWith('one', expect.objectContaining({ type: 'surface_error', surfaceId: id, input: 'i', error: 'VIEWER_CLOSED', open: 'o1' }))
    expect(captures[0].apply).toHaveBeenCalledOnce() // the open's, not the input's
    // A viewers process that restarted holds no surface at all.
    viewers.push('one', 'surface_ack', { surfaceId: 'b'.repeat(32), seq: 3 }, sink)
    expect(sink.state).toHaveBeenLastCalledWith('one', expect.objectContaining({ type: 'surface_error', surfaceId: 'b'.repeat(32), error: 'VIEWER_CLOSED' }))
    expect(sink.state.mock.lastCall![1]).not.toHaveProperty('open')
    // Another agent's ids on this surface are refused as before, not told it closed.
    viewers.push('one', 'surface_input', open({ input: 'j', events: [], agentId: 'other' }), sink)
    await settle()
    expect(sink.state).toHaveBeenLastCalledWith('one', expect.objectContaining({ input: 'j', error: 'INVALID_VIEWER_REQUEST' }))
    expect(captures).toHaveLength(1)
  })
  it('surface_open names its open, 1 to 64 letters, digits or dashes, echoed on every answer about that push', async () => {
    // The core's rule for ids it echoes (viewerStreamId): a space or a slash is no id a client mints.
    for (const bad of [undefined, '', 'x'.repeat(65), 7, 'o 1', 'o/1']) {
      viewers.push('one', 'surface_open', open({ open: bad }), sink)
      expect(sink.state).toHaveBeenLastCalledWith('one', { type: 'surface_error', surfaceId: id, error: 'INVALID_VIEWER_REQUEST' })
    }
    expect(captures).toHaveLength(0)
    viewers.push('one', 'surface_open', open({ open: 'o2' }), sink)
    captures[0].takeHostActions.mockResolvedValueOnce([{ action: 'assistant', chooseModel: false }])
    await settle()
    expect(sink.state).toHaveBeenLastCalledWith('one', expect.objectContaining({ type: 'surface_state', hostActions: expect.any(Array), open: 'o2' }))
    viewers.push('one', 'surface_input', open({ input: 'i', events: [], open: 'o2' }), sink)
    await settle()
    expect(sink.state).toHaveBeenLastCalledWith('one', expect.objectContaining({ type: 'surface_state', input: 'i', open: 'o2' }))
  })
  it('marks an input refused before it was applied unapplied, and only that one, so the client replays only it', async () => {
    // No push: refused before request() runs, so the client may send it again over WS.
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    viewers.push('one', 'surface_close', { surfaceId: id }, sink)
    viewers.push('one', 'surface_open', { ...open(), surfaceId: 'b'.repeat(32) }, sink)
    await settle()
    viewers.push('one', 'surface_input', open({ input: 'i0', events: [] }), sink)
    expect(sink.state).toHaveBeenLastCalledWith('one', expect.objectContaining({ input: 'i0', error: 'VIEWER_CLOSED', unapplied: true }))
    // Removed while its commands were applied: they reached Chrome, so a replay would apply them twice.
    const b = { surfaceId: 'b'.repeat(32) }
    let release!: () => void
    captures[1].apply.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    viewers.push('one', 'surface_input', open({ ...b, input: 'i1', events: [{ type: 'text', text: 'hi' }] }), sink)
    await settle()
    viewers.push('one', 'surface_close', b, sink)
    release()
    await settle()
    expect(sink.state).toHaveBeenLastCalledWith('one', expect.objectContaining({ input: 'i1', error: 'VIEWER_CLOSED' }))
    expect(sink.state.mock.lastCall![1]).not.toHaveProperty('unapplied')
    // Failed after apply began, with the surface closed meanwhile: the catch's VIEWER_CLOSED is not unapplied either.
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    let fail!: (error: Error) => void
    captures[2].apply.mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject }))
    viewers.push('one', 'surface_input', open({ input: 'i2', events: [{ type: 'text', text: 'hi' }] }), sink)
    await settle()
    viewers.push('one', 'surface_close', { surfaceId: id }, sink)
    fail(new Error('target closed'))
    await settle()
    expect(sink.state).toHaveBeenLastCalledWith('one', expect.objectContaining({ input: 'i2', error: 'VIEWER_CLOSED' }))
    expect(sink.state.mock.lastCall![1]).not.toHaveProperty('unapplied')
  })
  it('tells the client when the machine ends its surface', async () => {
    const baseline = vi.getTimerCount()
    viewers.push('one', 'surface_open', open(), sink)
    await settle()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sink.state).toHaveBeenCalledWith('one', { type: 'surface_error', surfaceId: id, error: 'VIEWER_CLOSED', open: 'o1' })
    expect(captures[0].stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(baseline)
    viewers.push('one', 'surface_open', open(), sink)
    captures[1].next.mockRejectedValue(new Error('Chrome stopped'))
    await settle()
    expect(sink.state).toHaveBeenLastCalledWith('one', { type: 'surface_error', surfaceId: id, error: 'VIEWER_UNAVAILABLE', detail: 'Chrome stopped', open: 'o1' })
    expect(captures[1].stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(baseline)
  })
})

describe('interactive viewer screen', () => {
  const v2 = (extra = {}) => surfaceFrame(frame({ width: 400, height: 300, scale: 2, ...extra }))!
  const cast = (capture: InteractiveViewerCapture, data: string, sessionId: number) =>
    (capture as any).onEvent('Page.screencastFrame', { data, sessionId, metadata: {} })

  it('streams at the pane’s size and density, and acks a frame only when it is taken', async () => {
    const capture = new InteractiveViewerCapture()
    const call = vi.spyOn(capture as any, 'call').mockResolvedValue({})
    await capture.apply(v2({ mobile: true, touch: true }))
    const waiting = capture.next(0, 1000)
    await Promise.resolve()
    expect(call.mock.calls.map(c => c[0])).toEqual([
      'Emulation.setDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled', 'Emulation.setEmulatedMedia', 'Page.startScreencast',
    ])
    expect(call.mock.calls[0][1]).toEqual({ width: 400, height: 300, deviceScaleFactor: 2, mobile: true })
    expect(call.mock.calls[3][1]).toMatchObject({ format: 'jpeg', quality: 75, maxWidth: 800, maxHeight: 600 })
    cast(capture, 'one', 7)
    expect(await waiting).toEqual({ seq: 1, data: 'one' })
    expect(call).toHaveBeenLastCalledWith('Page.screencastFrameAck', { sessionId: 7 })
    expect(capture.frameSeq).toBe(1)
  })
  it('answers at once when a newer frame is already there, and null after the wait', async () => {
    vi.useFakeTimers()
    const capture = new InteractiveViewerCapture()
    vi.spyOn(capture as any, 'call').mockResolvedValue({})
    await capture.apply(v2())
    void capture.next(0, 1000); await Promise.resolve()
    cast(capture, 'one', 1)
    expect(await capture.next(0, 1000)).toEqual({ seq: 1, data: 'one' })
    const later = capture.next(1, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await later).toBeNull()
    vi.useRealTimers()
  })
  it('falls back to a screenshot when no screencast frame comes', async () => {
    vi.useFakeTimers()
    const capture = new InteractiveViewerCapture()
    vi.spyOn(capture as any, 'call').mockResolvedValue({})
    vi.spyOn(capture, 'capture').mockResolvedValue('still')
    await capture.apply(v2())
    const first = capture.next(0, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await first).toEqual({ seq: 1, data: 'still' })
    vi.useRealTimers()
  })
  it('restarts the screencast when the size changes, and wake() ends a waiting poll', async () => {
    const capture = new InteractiveViewerCapture()
    const call = vi.spyOn(capture as any, 'call').mockResolvedValue({})
    await capture.apply(v2())
    const waiting = capture.next(0, 60_000)
    await Promise.resolve()
    await capture.apply(v2({ width: 500 }))
    expect(call.mock.calls.slice(-3).map(c => c[0])).toEqual(['Emulation.setDeviceMetricsOverride', 'Page.stopScreencast', 'Page.startScreencast'])
    capture.wake()
    expect(await waiting).toBeNull()
  })
  it('drops an oversized frame but keeps the stream moving', async () => {
    const capture = new InteractiveViewerCapture()
    const call = vi.spyOn(capture as any, 'call').mockResolvedValue({})
    cast(capture, 'x'.repeat(2 * 1024 * 1024 + 1), 3)
    expect(capture.frameSeq).toBe(0)
    expect(call).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 3 })
  })
  it('reads focus and selection through bounded expressions only', async () => {
    const capture = new InteractiveViewerCapture()
    const call = vi.spyOn(capture as any, 'call')
      .mockResolvedValueOnce({ result: { value: true } })
      .mockResolvedValueOnce({ result: { value: 'y'.repeat(1_000_100) } })
      .mockResolvedValue({})
    expect(await capture.editable()).toBe(true)
    expect(await capture.selection()).toHaveLength(1_000_000)
    await capture.deleteSelection()
    expect(call.mock.calls.slice(-2).map(c => (c[1] as any).type)).toEqual(['keyDown', 'keyUp'])
  })
  it('retries Page.startScreencast on the next poll when a restart on resize failed', async () => {
    const capture = new InteractiveViewerCapture()
    let starts = 0
    const call = vi.spyOn(capture as any, 'call').mockImplementation((async (m: string) => {
      if (m === 'Page.startScreencast' && ++starts === 2) throw new Error('boom')
      return {}
    }) as any)
    vi.spyOn(capture, 'capture').mockResolvedValue('still')
    await capture.apply(v2())
    void capture.next(0, 10); await Promise.resolve()
    await expect(capture.apply(v2({ width: 500 }))).rejects.toThrow('boom')
    cast(capture, 'one', 1)
    await capture.next(0, 10)
    expect(call.mock.calls.filter(c => c[0] === 'Page.startScreencast')).toHaveLength(3)
  })
  it('shows a screenshot after a resize on a page that paints nothing new', async () => {
    vi.useFakeTimers()
    const capture = new InteractiveViewerCapture()
    vi.spyOn(capture as any, 'call').mockResolvedValue({})
    vi.spyOn(capture, 'capture').mockResolvedValue('resized')
    await capture.apply(v2())
    void capture.next(0, 1000); await Promise.resolve()
    cast(capture, 'old', 1)
    await capture.apply(v2({ width: 500 }))
    const after = capture.frameSeq
    const poll = capture.next(after, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await poll).toEqual({ seq: after + 1, data: 'resized' })
    vi.useRealTimers()
  })
  it('keeps a real frame that lands while the fallback screenshot is pending', async () => {
    vi.useFakeTimers()
    const capture = new InteractiveViewerCapture()
    vi.spyOn(capture as any, 'call').mockResolvedValue({})
    let release!: (v: string) => void
    vi.spyOn(capture, 'capture').mockReturnValue(new Promise<string>(r => { release = r }))
    await capture.apply(v2({ scale: 1 }))
    const poll = capture.next(0, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    cast(capture, 'real', 2)
    release('still')
    expect(await poll).toEqual({ seq: 1, data: 'real' })
    vi.useRealTimers()
  })
  it('shows the screencast frame it has when the fallback screenshot fails, and throws only with none', async () => {
    vi.useFakeTimers()
    const capture = new InteractiveViewerCapture()
    vi.spyOn(capture as any, 'call').mockResolvedValue({})
    vi.spyOn(capture, 'capture').mockRejectedValue(new Error('This viewer frame is too large.'))
    await capture.apply(v2({ scale: 1 }))
    const empty = capture.next(0, 1000)
    const failed = expect(empty).rejects.toThrow('too large')
    await vi.advanceTimersByTimeAsync(1000); await failed
    cast(capture, 'old', 1)
    await capture.apply(v2({ scale: 1, width: 500 }))
    const poll = capture.next(0, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await poll).toEqual({ seq: 1, data: 'old' })
    vi.useRealTimers()
  })
  it('ends a waiting poll at once on stop(), without a screenshot', async () => {
    const capture = new InteractiveViewerCapture()
    vi.spyOn(capture as any, 'call').mockResolvedValue({})
    const shot = vi.spyOn(capture, 'capture').mockResolvedValue('still')
    const waiting = capture.next(0, 60_000)
    await Promise.resolve(); await Promise.resolve()
    await capture.stop()
    expect(await waiting).toBeNull()
    expect(shot).not.toHaveBeenCalled()
  })
})
