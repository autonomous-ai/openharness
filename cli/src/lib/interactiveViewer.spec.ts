import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InteractiveViewerCapture, InteractiveViewers, monitorHostActions, surfaceFrame } from './interactiveViewer.js'

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
    { events: [{ type: 'text', text: 'a'.repeat(4097) }] },
    { events: [{ type: 'key', event: 'keyDown', key: 'x', code: 'KeyX', keyCode: 88, modifiers: 999 }] },
  ])('rejects malformed or excessive input without executing it: %j', extra => {
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

describe('owner viewer sessions', () => {
  let viewers: InteractiveViewers, target: string | null
  let captures: Array<{ start: ReturnType<typeof vi.fn>; frame: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>
  beforeEach(() => {
    vi.useFakeTimers(); captures = []; target = 'http://127.0.0.1:8000/'
    viewers = new InteractiveViewers(() => target, () => {
      const capture = { start: vi.fn(async () => {}), frame: vi.fn(async () => 'jpeg'), takeHostActions: vi.fn(async () => []), stop: vi.fn(async () => {}) }
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
    expect(await viewers.request('one', frame())).toHaveProperty('error', 'VIEWER_BUSY')
    viewers.closeConnection('one'); finish('old frame')
    expect(await pending).toHaveProperty('error', 'VIEWER_CLOSED')
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
