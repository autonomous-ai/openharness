import { describe, expect, it } from 'vitest'
// @ts-expect-error — the tool server's helpers are plain ESM, run by Node inside the browser's container.
import { answer, connectWithRetry, roleSnapshot, setWindow, withTimeout } from '../../../assets/browser/browser-tools-lib.mjs'

describe('roleSnapshot', () => {
  it('gives each interactive line a ref', () => {
    const aria = ['- main:', '  - heading "Mail" [level=1]', '  - button "Send"', '  - button "Send"', '  - textbox "To"', '  - text: hello'].join('\n')
    const { text, refs } = roleSnapshot(aria)
    expect(text).toBe([
      '- main:', '  - heading "Mail" [level=1]', '  - button "Send" [ref=e1]', '  - button "Send" [ref=e2]', '  - textbox "To" [ref=e3]',
      '  - text: hello',
    ].join('\n'))
    expect(refs).toEqual({
      e1: { role: 'button', name: 'Send', nth: 0 },
      e2: { role: 'button', name: 'Send', nth: 1 },
      e3: { role: 'textbox', name: 'To', nth: 0 },
    })
  })

  it('an unnamed ref counts every element of its role; escaped quotes in a name are read', () => {
    const { text, refs } = roleSnapshot(['- link', '- link "Say \\"hi\\""', '- link', '- checkbox [checked]'].join('\n'))
    expect(text).toBe(['- link [ref=e1]', '- link "Say \\"hi\\"" [ref=e2]', '- link [ref=e3]', '- checkbox [ref=e4] [checked]'].join('\n'))
    expect(refs).toEqual({
      e1: { role: 'link', nth: 0 },
      e2: { role: 'link', name: 'Say "hi"', nth: 0 },
      // getByRole('link') without a name also matches the named link before it.
      e3: { role: 'link', nth: 2 },
      e4: { role: 'checkbox', nth: 0 },
    })
  })
})

describe('connectWithRetry', () => {
  it('tries 3 times with timeouts 5000, 7000, 9000 and sleeps 250, 500', async () => {
    const timeouts: number[] = []
    const sleeps: number[] = []
    const connect = async (timeoutMs: number) => { timeouts.push(timeoutMs); throw new Error('refused') }
    await expect(connectWithRetry(connect, async (ms: number) => { sleeps.push(ms) })).rejects.toThrow('Browser is not reachable')
    expect(timeouts).toEqual([5000, 7000, 9000])
    expect(sleeps).toEqual([250, 500])
  })

  it('returns the first connection that works', async () => {
    let tries = 0
    const connect = async () => { tries += 1; if (tries < 2) throw new Error('refused'); return 'browser' }
    await expect(connectWithRetry(connect, async () => {})).resolves.toBe('browser')
    expect(tries).toBe(2)
  })

  it('concurrent connects share one attempt', async () => {
    let tries = 0
    const connect = async () => { tries += 1; return { id: tries } }
    const [a, b] = await Promise.all([connectWithRetry(connect, async () => {}), connectWithRetry(connect, async () => {})])
    expect(tries).toBe(1)
    expect(a).toBe(b)
    // Once it settles, the next call connects again (the server keeps the connection, not the helper).
    await connectWithRetry(connect, async () => {})
    expect(tries).toBe(2)
  })
})

describe('withTimeout', () => {
  it('rejects with "<what> timed out"', async () => {
    await expect(withTimeout(new Promise(() => {}), 5, 'browser_click')).rejects.toThrow('browser_click timed out')
  })

  it('passes the work\'s own answer and failure through', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'x')).resolves.toBe(7)
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom')
  })
})

describe('answer', () => {
  const handlers = () => ({
    call: async (params: unknown) => ({ called: params }),
    window: async (params: unknown) => ({ sized: params }),
  })

  it('routes tools/call to call and window to window', async () => {
    const params = { name: 'browser_click', arguments: { ref: 'e1' }, _harness: { human: 'auto' } }
    await expect(answer({ id: 1, method: 'tools/call', params }, handlers())).resolves.toEqual({ called: params })
    await expect(answer({ id: 2, method: 'window', params: { width: 1280, height: 800 } }, handlers()))
      .resolves.toEqual({ sized: { width: 1280, height: 800 } })
  })

  it('initialize, tools/list and ping are unknown methods', async () => {
    for (const method of ['initialize', 'tools/list', 'ping', 'resources/list']) {
      await expect(answer({ id: 3, method, params: {} }, handlers()), method).resolves.toBeNull()
    }
  })
})

describe('setWindow', () => {
  it('asks for the window, sets it at 0,0 with the size and windowState normal, and answers the bounds Chrome reports', async () => {
    const sent: Array<[string, unknown]> = []
    const send = async (method: string, params?: unknown) => {
      sent.push([method, params])
      if (method === 'Browser.getWindowForTarget') return { windowId: 7, bounds: { left: 40, top: 30, width: 1920, height: 1080, windowState: 'maximized' } }
      if (method === 'Browser.getWindowBounds') return { bounds: { left: 0, top: 0, width: 1920, height: 1040, windowState: 'normal' } }
      return {}
    }
    // Chrome keeps the window inside the screen: the answer is its size, not the one asked for.
    await expect(setWindow(send, { width: 2400, height: 1400 })).resolves.toEqual({ width: 1920, height: 1040 })
    expect(sent).toEqual([
      ['Browser.getWindowForTarget', undefined],
      ['Browser.setWindowBounds', { windowId: 7, bounds: { left: 0, top: 0, width: 2400, height: 1400, windowState: 'normal' } }],
      ['Browser.getWindowBounds', { windowId: 7 }],
    ])
  })

  it('passes a CDP failure on', async () => {
    const send = async (method: string) => {
      if (method === 'Browser.setWindowBounds') throw new Error('Protocol error (Browser.setWindowBounds): Browser window not found')
      return { windowId: 7, bounds: {} }
    }
    await expect(setWindow(send, { width: 1280, height: 800 })).rejects.toThrow('Browser window not found')
  })
})
