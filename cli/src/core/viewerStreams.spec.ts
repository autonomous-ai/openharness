import { describe, expect, it, vi } from 'vitest'
import { VIEWERS_UNAVAILABLE } from './api.js'
import { createViewerStreams, NOT_SERVED } from './viewerStreams.js'

function setup(taken = true) {
  const viewers = {
    stream: vi.fn(() => taken),
    surface: vi.fn(async () => ({ data: 'jpeg' })),
    closed: vi.fn(),
  }
  let on: typeof viewers | null = viewers
  const send = vi.fn(() => true)
  const streams = createViewerStreams(() => on, send)
  return { viewers, send, streams, off: () => { on = null } }
}

describe('this machine\'s viewers, served to a client over its connection', () => {
  it('hands each frame of a stream to the viewers, and says nothing itself when they take it', () => {
    const { viewers, send, streams } = setup()
    streams.frame('c1', 'viewer_request', { streamId: 's1', agentId: 'a1' })
    expect(viewers.stream).toHaveBeenCalledWith('c1', 'viewer_request', { streamId: 's1', agentId: 'a1' })
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a stream at once when the viewers do not take it, so the client never waits out its timeout', () => {
    const { send, streams } = setup(false)
    streams.frame('c1', 'viewer_request', { streamId: 's1' })
    streams.frame('c1', 'viewer_data', { streamId: 's1', data: 'AA==' })
    expect(send.mock.calls).toEqual([
      ['c1', 'viewer_close', { streamId: 's1', error: NOT_SERVED }],
      ['c1', 'viewer_close', { streamId: 's1', error: NOT_SERVED }],
    ])
    // A close needs no answer, and a frame of no stream has nobody to tell.
    streams.frame('c1', 'viewer_close', { streamId: 's1' })
    streams.frame('c1', 'viewer_request', { streamId: '../bad id' })
    streams.frame('c1', 'viewer_request', {})
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('refuses every stream while the viewers are off, and answers a surface unavailable', async () => {
    const { viewers, send, streams, off } = setup()
    off()
    streams.frame('c1', 'viewer_request', { streamId: 's1' })
    expect(send).toHaveBeenCalledWith('c1', 'viewer_close', { streamId: 's1', error: NOT_SERVED })
    await expect(streams.surface('c1', { surfaceId: 'v' })).resolves.toEqual(VIEWERS_UNAVAILABLE)
    streams.closed('c1')
    streams.closedAll()
    expect(viewers.stream).not.toHaveBeenCalled()
    expect(viewers.closed).not.toHaveBeenCalled()
  })

  it('answers a pushed surface\'s frames with VIEWERS_UNAVAILABLE while nobody serves them, so the client falls back', () => {
    const { send, streams, off } = setup(false)
    const surfaceId = 'a'.repeat(32)
    streams.frame('c1', 'surface_open', { surfaceId, open: 'o1', agentId: 'a1' })
    off()
    streams.frame('c1', 'surface_ack', { surfaceId, seq: 3, open: 'o1' })
    streams.frame('c1', 'surface_input', { surfaceId, input: 'i1', open: 'o1' })
    const error = { surfaceId, error: 'VIEWERS_UNAVAILABLE', detail: NOT_SERVED, open: 'o1' }
    expect(send.mock.calls).toEqual([
      // The input never reached a surface: unapplied, so the client sends it again over WS. Only an input says so.
      ['c1', 'surface_error', error], ['c1', 'surface_error', error], ['c1', 'surface_error', { ...error, input: 'i1', unapplied: true }],
    ])
    // A close needs no answer, and a frame naming no surface or a bad open has nothing to echo.
    streams.frame('c1', 'surface_close', { surfaceId })
    streams.frame('c1', 'surface_open', { surfaceId: '../x' })
    streams.frame('c1', 'surface_ack', { surfaceId, open: 'x'.repeat(65), input: 7 })
    expect(send).toHaveBeenCalledTimes(4)
    expect(send).toHaveBeenLastCalledWith('c1', 'surface_error', { surfaceId, error: 'VIEWERS_UNAVAILABLE', detail: NOT_SERVED })
  })

  it('asks the viewers for a client\'s rendered frame', async () => {
    const { viewers, streams } = setup()
    await expect(streams.surface('c1', { surfaceId: 'v' })).resolves.toEqual({ data: 'jpeg' })
    expect(viewers.surface).toHaveBeenCalledWith('c1', { surfaceId: 'v' })
  })

  it('tells the viewers a connection went, or that every one did', () => {
    const { viewers, streams } = setup()
    streams.closed('c1')
    streams.closedAll()
    expect(viewers.closed.mock.calls).toEqual([['c1'], []])
  })
})
