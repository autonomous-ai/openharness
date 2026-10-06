import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleCommandBarHttp, routedCommandBar, type CommandBarDoor } from './commandBarHttp.js'

let server: Server | null = null
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  server = null
})

/** The door on a loopback server of its own, as the hook server and the experiment server serve it. */
async function serve(door?: CommandBarDoor): Promise<string> {
  server = createServer((req, res) => {
    void handleCommandBarHttp(req, res, door).then((handled) => { if (!handled) { res.writeHead(404); res.end() } })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/command-bar`
}
const LOCAL = { 'x-adapter-local': '1', 'content-type': 'application/json' }
const read = async (response: Response) => ({ status: response.status, body: await response.json() })

describe('the command bar\'s HTTP door', () => {
  it('asks the command bar on a connection of its own, and answers with what it said', async () => {
    const ask = vi.fn(async (payload: Record<string, unknown>, _connection: string) => payload.route === 'status'
      ? { status: 200, body: { success: true, data: { configured: false } } }
      : { status: 503, body: { success: false, error: { code: 'OPENROUTER_REQUIRED', message: 'Connect OpenRouter.' } } })
    const closed = vi.fn()
    const base = await serve({ ask, closed })
    expect(await read(await fetch(`${base}/status`, { headers: LOCAL }))).toEqual({ status: 200, body: { success: true, data: { configured: false } } })
    expect(await read(await fetch(`${base}/resolve`, { method: 'POST', headers: LOCAL, body: '{"prompt":"x"}' })))
      .toEqual({ status: 503, body: { success: false, error: { code: 'OPENROUTER_REQUIRED', message: 'Connect OpenRouter.' } } })
    expect(ask.mock.calls[0][0]).toEqual({ route: 'status' })
    expect(ask.mock.calls[1][0]).toEqual({ route: 'resolve', body: { prompt: 'x' } })
    // Each HTTP request its own connection, and none said to close once answered.
    expect(ask.mock.calls[0][1]).toMatch(/^http:/)
    expect(ask.mock.calls[1][1]).not.toBe(ask.mock.calls[0][1])
    expect(closed).not.toHaveBeenCalled()
    expect((await fetch(`${base.replace('/command-bar', '')}/other`)).status).toBe(404)
  })

  it('says plainly when the command bar is off or down, and answers anything else it cannot read as unavailable', async () => {
    const ask = vi.fn()
      .mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE', service: 'commandBar', retryable: true })
      .mockResolvedValueOnce({ error: 'SERVICE_FAILED', service: 'commandBar' })
      .mockRejectedValueOnce(new Error('router gone'))
    const base = await serve({ ask, closed: vi.fn() })
    expect(await read(await fetch(`${base}/status`, { headers: LOCAL }))).toEqual({ status: 503, body: { success: false, error: { code: 'UNAVAILABLE', message: 'The command bar is off or restarting. Choose an action below, or try again in a moment.' } } })
    for (let i = 0; i < 2; i++) {
      expect(await read(await fetch(`${base}/status`, { headers: LOCAL }))).toEqual({ status: 502, body: { success: false, error: { code: 'UNAVAILABLE', message: 'Command bar unavailable.' } } })
    }
  })

  it('tells the command bar when a client goes before its answer', async () => {
    let answer!: (value: Record<string, unknown>) => void
    const ask = vi.fn((_payload: Record<string, unknown>, _connection: string) => new Promise<Record<string, unknown>>((resolve) => { answer = resolve }))
    const closed = vi.fn()
    const base = await serve({ ask, closed })
    const going = new AbortController()
    const request = fetch(`${base}/resolve`, { method: 'POST', headers: LOCAL, body: '{}', signal: going.signal }).catch(() => null)
    await vi.waitFor(() => expect(ask).toHaveBeenCalled())
    going.abort()
    await request
    await vi.waitFor(() => expect(closed).toHaveBeenCalledWith(ask.mock.calls[0][1]))
    // Its answer, when it comes, goes nowhere.
    answer({ status: 200, body: { success: true, data: {} } })
  })

  it('without a command bar, says to start one', async () => {
    const base = await serve()
    expect(await read(await fetch(`${base}/status`, { headers: LOCAL }))).toEqual({ status: 503, body: { success: false, error: { code: 'UNAVAILABLE', message: 'Start the command bar experiment server or updated daemon.' } } })
  })
})

describe('the daemon\'s door to the command bar', () => {
  it('routes as a process on this computer, on the door\'s connection, and is told when that connection closes', async () => {
    const socket = {
      serviceRouter: vi.fn((_type: string, _payload: Record<string, unknown>, _asker: unknown, reply: (result: Record<string, unknown>) => void) => { reply({ status: 200, body: {} }); return true }),
      onConnectionClosed: vi.fn(),
    }
    const door = routedCommandBar(socket)
    expect(await door.ask({ route: 'status' }, 'http:1')).toEqual({ status: 200, body: {} })
    expect(socket.serviceRouter).toHaveBeenCalledWith('command_bar_http', { route: 'status' }, { local: true, owner: true, connection: 'http:1' }, expect.any(Function))
    door.closed('http:1')
    expect(socket.onConnectionClosed).toHaveBeenCalledWith('http:1')
    // No service declares it (a core with none), or no router yet: unavailable, never a hang.
    socket.serviceRouter.mockReturnValueOnce(false)
    expect(await door.ask({ route: 'status' }, 'http:2')).toEqual({ error: 'SERVICE_UNAVAILABLE' })
    const bare = routedCommandBar({ serviceRouter: null, onConnectionClosed: null })
    expect(await bare.ask({ route: 'status' }, 'http:3')).toEqual({ error: 'SERVICE_UNAVAILABLE' })
    bare.closed('http:3')
  })
})
