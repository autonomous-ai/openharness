import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
// @ts-expect-error — the device script is plain ESM, run by Node inside the browser's container.
import { deviceScript, startDevice } from '../../../assets/browser/device-inject.mjs'

const DEVICE = { gpuVendor: 'Google Inc. (Apple)', gpuRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', cpuCores: 8, memoryGb: 16 }
type Message = { id: number; method: string; params: Record<string, unknown>; sessionId?: string }

const closers: (() => void)[] = []
afterEach(() => { for (const close of closers.splice(0)) close() })

/** A fake browser: `/json/version` names its WebSocket, which records every command and answers it as `answer` says:
 *  a result, an error, or nothing until `release()`. */
async function fakeCdp(answer: (m: Message) => 'ok' | 'error' | 'hold' = () => 'ok') {
  const http: Server = createServer((req, res) => {
    const { port } = http.address() as AddressInfo
    if (req.url !== '/json/version') return void res.writeHead(404).end()
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/b1` }))
  })
  const wss = new WebSocketServer({ server: http })
  const messages: Message[] = []
  const waiters: (() => void)[] = []
  const held: Message[] = []
  let peer: WebSocket | undefined
  const reply = (message: Message, answer: object) => peer!.send(JSON.stringify({ id: message.id, ...answer, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }))
  wss.on('connection', (socket) => {
    peer = socket
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as Message
      messages.push(message)
      const how = answer(message)
      if (how === 'ok') reply(message, { result: {} })
      else if (how === 'error') reply(message, { error: { code: -32000, message: 'Not allowed' } })
      else held.push(message)
      for (const wake of waiters.splice(0)) wake()
    })
  })
  await new Promise<void>(done => http.listen(0, '127.0.0.1', done))
  closers.push(() => { for (const client of wss.clients) client.terminate(); wss.close(); http.close() })
  const { port } = http.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    messages,
    event: (method: string, params: object) => peer!.send(JSON.stringify({ method, params })),
    release: () => { for (const message of held.splice(0)) reply(message, { result: {} }) },
    /** Resolves once a message matches. */
    until: async (match: (m: Message) => boolean) => {
      while (!messages.some(match)) await new Promise<void>(wake => waiters.push(wake))
    },
  }
}

/** Where the script says it attached, in a folder of its own. */
function readyFile() {
  const dir = mkdtempSync(join(tmpdir(), 'device-inject-'))
  closers.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'device-ready')
}

async function started() {
  const cdp = await fakeCdp()
  const socket = await startDevice(cdp.base, DEVICE, readyFile())
  closers.unshift(() => socket.destroy())
  await cdp.until(m => m.method === 'Target.setDiscoverTargets')
  return cdp
}

const ofSession = (messages: Message[], sessionId: string) => messages.filter(m => m.sessionId === sessionId).map(m => m.method)

describe('device script', () => {
  it('sets Target.setAutoAttach with waitForDebuggerOnStart', async () => {
    const cdp = await started()
    expect(cdp.messages[0]).toMatchObject({ method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } })
    expect(cdp.messages[0]!.sessionId).toBeUndefined()
    expect(cdp.messages[1]).toMatchObject({ method: 'Target.setDiscoverTargets', params: { discover: true } })
  })

  it('writes its ready file only once Target.setAutoAttach succeeded, so the browser is not ready before it', async () => {
    const cdp = await fakeCdp(m => (m.method === 'Target.setAutoAttach' && !m.sessionId ? 'hold' : 'ok'))
    const ready = readyFile()
    const start = startDevice(cdp.base, DEVICE, ready)
    await cdp.until(m => m.method === 'Target.setDiscoverTargets')
    expect(existsSync(ready)).toBe(false)
    cdp.release()
    const socket = await start
    closers.unshift(() => socket.destroy())
    expect(existsSync(ready)).toBe(true)
  })

  it('a refused Target.setAutoAttach fails the start and writes no ready file', async () => {
    const cdp = await fakeCdp(m => (m.method === 'Target.setAutoAttach' ? 'error' : 'ok'))
    const ready = readyFile()
    await expect(startDevice(cdp.base, DEVICE, ready)).rejects.toThrow('Target.setAutoAttach failed: Not allowed')
    expect(existsSync(ready)).toBe(false)
  })

  it('a new page gets Page.addScriptToEvaluateOnNewDocument and then Runtime.runIfWaitingForDebugger', async () => {
    const cdp = await started()
    cdp.event('Target.attachedToTarget', { sessionId: 'S1', targetInfo: { targetId: 'T1', type: 'page', url: 'about:blank' }, waitingForDebugger: true })
    await cdp.until(m => m.sessionId === 'S1' && m.method === 'Runtime.runIfWaitingForDebugger')
    expect(ofSession(cdp.messages, 'S1')).toEqual(['Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger'])
    expect(cdp.messages.find(m => m.method === 'Page.addScriptToEvaluateOnNewDocument')!.params).toEqual({ source: deviceScript(DEVICE), runImmediately: true })
    // Its frames in other processes are paused for the script too.
    expect(cdp.messages.find(m => m.sessionId === 'S1' && m.method === 'Target.setAutoAttach')!.params).toMatchObject({ waitForDebuggerOnStart: true })

    // The same target attached a second time is only let go.
    cdp.event('Target.attachedToTarget', { sessionId: 'S2', targetInfo: { targetId: 'T1', type: 'page', url: 'about:blank' } })
    await cdp.until(m => m.sessionId === 'S2')
    expect(ofSession(cdp.messages, 'S2')).toEqual(['Runtime.runIfWaitingForDebugger'])
  })

  it('a worker gets Runtime.evaluate and then runIfWaitingForDebugger', async () => {
    const cdp = await started()
    cdp.event('Target.attachedToTarget', { sessionId: 'W1', targetInfo: { targetId: 'T2', type: 'service_worker', url: 'https://example.test/sw.js' }, waitingForDebugger: true })
    await cdp.until(m => m.sessionId === 'W1' && m.method === 'Runtime.runIfWaitingForDebugger')
    expect(ofSession(cdp.messages, 'W1')).toEqual(['Runtime.evaluate', 'Runtime.runIfWaitingForDebugger'])
    expect(cdp.messages.find(m => m.method === 'Runtime.evaluate')!.params).toEqual({ expression: deviceScript(DEVICE) })
  })

  it('a page that existed before it started is attached too', async () => {
    const cdp = await started()
    cdp.event('Target.targetCreated', { targetInfo: { targetId: 'T0', type: 'page', url: 'about:blank', attached: false } })
    cdp.event('Target.targetCreated', { targetInfo: { targetId: 'T9', type: 'page', url: 'about:blank', attached: true } })
    await cdp.until(m => m.method === 'Target.attachToTarget')
    expect(cdp.messages.filter(m => m.method === 'Target.attachToTarget').map(m => m.params)).toEqual([{ targetId: 'T0', flatten: true }])
  })

  it('the script reports the device, with a deviceMemory Chrome could report', () => {
    const page = runInNewContext(`
      globalThis.self = globalThis
      globalThis.Navigator = class Navigator { get hardwareConcurrency() { return 2 } get deviceMemory() { return 4 } }
      globalThis.WebGLRenderingContext = class WebGLRenderingContext { getParameter(p) { return 'real ' + p } };
      ${deviceScript(DEVICE)}
      const nav = new Navigator()
      const gl = new WebGLRenderingContext()
      ;({
        cores: nav.hardwareConcurrency, memory: nav.deviceMemory, vendor: gl.getParameter(0x9245), renderer: gl.getParameter(0x9246),
        other: gl.getParameter(7936), shown: Function.prototype.toString.call(WebGLRenderingContext.prototype.getParameter),
      })`) as Record<string, unknown>
    // Chrome rounds deviceMemory down to a power of two and caps it at 8.
    expect({ ...page }).toEqual({
      cores: 8, memory: 8, vendor: DEVICE.gpuVendor, renderer: DEVICE.gpuRenderer, other: 'real 7936',
      shown: 'function getParameter() { [native code] }',
    })
    expect(runInNewContext(`globalThis.self = globalThis; globalThis.Navigator = class { get deviceMemory() { return 1 } }; ${deviceScript({ ...DEVICE, memoryGb: 6 })}; new Navigator().deviceMemory`)).toBe(4)
  })
})
