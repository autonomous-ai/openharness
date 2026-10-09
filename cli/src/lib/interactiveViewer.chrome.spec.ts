import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { viewerBrowser } from '../sharing/viewer.js'
import { InteractiveViewerCapture, surfaceFrame } from './interactiveViewer.js'

// A page that turns green when clicked: proof that input reached Chrome and the stream moved on.
const PAGE = `<!doctype html><body style="margin:0;background:#c00" onclick="document.body.style.background='#0c0'">
<input id=f autofocus style="position:fixed;inset:0;width:100%;height:100%;opacity:0"></body>`

// Opt-in like the real tmux suites: CI runners ship Chrome, and the fast PR shards must not launch it.
const real = process.env.RUN_REAL_CHROME_VIEWER === '1' && viewerBrowser() ? describe : describe.skip

real('interactive viewer against real Chrome', () => {
  let server: Server, url = ''
  const capture = new InteractiveViewerCapture()
  beforeAll(async () => {
    server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
    await capture.start(url)
  }, 30_000)
  afterAll(async () => { await capture.stop(); server.close() })

  const frame = (extra = {}) => surfaceFrame({ width: 400, height: 300, dark: false, scale: 2, ...extra })!
  const size = (jpeg: string) => {
    const bytes = Buffer.from(jpeg, 'base64')
    for (let i = 2; i < bytes.length;) {          // walk JPEG segments to the SOF0/SOF2 header
      const marker = bytes[i + 1], length = bytes.readUInt16BE(i + 2)
      if (marker === 0xc0 || marker === 0xc2) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) }
      i += 2 + length
    }
    throw new Error('no JPEG size')
  }

  it('streams at twice the pixels for scale 2, and a tap changes the next frame', async () => {
    await capture.apply(frame())
    const first = (await capture.next(0, 3000))!
    expect(size(first.data)).toEqual({ width: 800, height: 600 })
    await capture.apply(frame({ events: [
      { type: 'pointer', event: 'mousePressed', x: .5, y: .5, buttons: 1, button: 'left', clickCount: 1, modifiers: 0 },
      { type: 'pointer', event: 'mouseReleased', x: .5, y: .5, buttons: 0, button: 'left', clickCount: 1, modifiers: 0 },
    ] }))
    const next = (await capture.next(first.seq, 3000))!
    expect(next.seq).toBeGreaterThan(first.seq)
    expect(next.data).not.toBe(first.data)
    expect(await capture.editable()).toBe(true)
  }, 30_000)
})
