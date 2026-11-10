import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { browserTools } from '../lib/browserToolsAsset.js'
import { ownProcessGroup } from '../lib/windows/noWindow.js'
import { browserMcpCommand, type BrowserMcpChild } from './browserMcp.js'
import { AgentClientError, type Where } from './daemon.js'

/** The engine's side of `harness browser-mcp`: one JSON-RPC message per line, as Claude Code and Codex speak it. */
const HERE: Where = { port: 18473, dataDir: '/data', machineId: 'm', harnessPane: true }
const READY = { agentId: 'a1', state: 'ready', podman: '/opt/podman/bin/podman', human: 'normal' }
type Message = { id?: unknown; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number } }

function lines(stream: PassThrough): Message[] {
  const seen: Message[] = []
  createInterface({ input: stream }).on('line', (line) => seen.push(JSON.parse(line) as Message))
  return seen
}

/** The `podman exec` child: what it was sent, and a way to answer as the tool server would. */
function child() {
  const events = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const got = lines(stdin)
  // The tool server exits when its stdin closes (assets/browser/browser-tools.mjs).
  stdin.on('finish', () => events.emit('exit', 0, null))
  const process = Object.assign(events, { stdin, stdout, kill: vi.fn(() => true) }) as unknown as BrowserMcpChild & EventEmitter
  return { process, got, answer: (message: Message) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
}

function relay(states: Array<Record<string, unknown> | Error>, deps: { pane?: string | undefined; where?: Where } = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const out = lines(stdout)
  let errText = ''
  stderr.on('data', (chunk) => { errText += String(chunk) })
  let next = 0
  const ask = vi.fn(async () => {
    const state = states[Math.min(next++, states.length - 1)]
    if (state instanceof Error) throw state
    return state
  })
  const children: ReturnType<typeof child>[] = []
  const spawn = vi.fn(() => { const made = child(); children.push(made); return made.process })
  const done = browserMcpCommand({ stdin, stdout, stderr }, { pane: 'pane' in deps ? deps.pane : '%7', where: () => deps.where ?? HERE, ask, spawn })
  const send = (message: Message) => stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const reply = (id: unknown) => vi.waitFor(() => {
    const found = out.find((message) => message.id === id)
    if (!found) throw new Error(`no reply to ${String(id)}`)
    return found
  })
  return { stdin, out, ask, spawn, children, done, send, reply, stderr: () => errText }
}

const call = (id: number, name = 'browser_snapshot') => ({ id, method: 'tools/call', params: { name, arguments: {} } })

describe('harness browser-mcp', () => {
  it('initialize and tools/list answered without podman', async () => {
    const r = relay([READY])
    r.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code' } } })
    r.send({ method: 'notifications/initialized' })
    r.send({ id: 2, method: 'tools/list' })
    r.send({ id: 3, method: 'resources/list' })
    expect((await r.reply(1)).result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'browser' } })
    expect((await r.reply(2)).result).toEqual(browserTools())
    expect((await r.reply(3)).error?.code).toBe(-32601)
    expect(r.out).toHaveLength(3)
    expect(r.ask).not.toHaveBeenCalled()
    expect(r.spawn).not.toHaveBeenCalled()
  })

  it('tools/call before ready returns the named reason', async () => {
    const r = relay([
      { agentId: 'a1', state: 'setup', podman: null, human: 'normal' },
      { agentId: 'a1', state: 'starting', podman: '/p', human: 'normal' },
      { agentId: 'a1', state: 'failed', error: 'podman_down', podman: '/p', human: 'normal' },
      { agentId: 'a1', state: 'failed', error: 'podman_memory', podman: '/p', human: 'normal' },
      new AgentClientError('TIMEOUT', 'Harness did not answer agent_browser_state in time. Try again.'),
    ])
    const texts = ['Browser is being set up', 'Browser is starting', 'Podman is not running', 'Give Podman 4 GB of memory, then retry',
      'Harness did not answer agent_browser_state in time. Try again.']
    for (const [index, text] of texts.entries()) {
      r.send(call(10 + index))
      expect((await r.reply(10 + index)).result).toEqual({ isError: true, content: [{ type: 'text', text }] })
    }
    expect(r.ask).toHaveBeenCalledWith('agent_browser_state', { pane: '%7' }, 5_000)
    expect(r.spawn).not.toHaveBeenCalled()
  })

  it('the exec runs on the connection the daemon names: Harness\'s own machine, not the person\'s default', async () => {
    const r = relay([{ ...READY, connection: 'harness' }])
    r.send(call(7))
    await vi.waitFor(() => expect(r.spawn).toHaveBeenCalled())
    expect(r.spawn).toHaveBeenCalledWith('/opt/podman/bin/podman',
      ['--connection', 'harness', 'exec', '-i', 'harness-browser-a1', 'node', '/opt/harness-browser/browser-tools.mjs'], expect.anything())
  })

  it('tools/call when ready is forwarded', async () => {
    const r = relay([READY])
    const init = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code' } }
    r.send({ id: 1, method: 'initialize', params: init })
    await r.reply(1)
    r.send(call(7))
    r.send(call(8, 'browser_back'))
    await vi.waitFor(() => expect(r.children[0]?.got).toHaveLength(4))
    expect(r.spawn).toHaveBeenCalledTimes(1)
    expect(r.spawn).toHaveBeenCalledWith('/opt/podman/bin/podman',
      ['exec', '-i', 'harness-browser-a1', 'node', '/opt/harness-browser/browser-tools.mjs'], expect.anything())
    const [replayed, initialized, first, second] = r.children[0].got
    expect(replayed).toMatchObject({ method: 'initialize', params: init })
    expect(initialized).toMatchObject({ method: 'notifications/initialized' })
    expect(initialized.id).toBeUndefined()
    expect(first).toMatchObject({ id: 7, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } })
    expect(second).toMatchObject({ id: 8, params: { name: 'browser_back' } })
    // The child's answer to the replayed initialize is the relay's own, never the engine's.
    r.children[0].answer({ id: replayed.id, result: { protocolVersion: '2025-06-18' } })
    r.children[0].answer({ id: 8, result: { content: [{ type: 'text', text: 'back' }] } })
    r.children[0].answer({ id: 7, result: { content: [{ type: 'text', text: 'snapshot' }] } })
    expect((await r.reply(7)).result).toEqual({ content: [{ type: 'text', text: 'snapshot' }] })
    expect((await r.reply(8)).result).toEqual({ content: [{ type: 'text', text: 'back' }] })
    expect(r.out.map((message) => message.id)).toEqual([1, 8, 7])
  })

  it('each forwarded call carries the human mode of the latest state reply', async () => {
    const r = relay([{ ...READY, human: 'slow' }, { ...READY, human: 'off' }])
    r.send(call(1))
    r.send(call(2))
    await vi.waitFor(() => expect(r.children[0]?.got).toHaveLength(4))
    expect(r.children[0].got.slice(2).map((message) => message.params?._harness)).toEqual([{ human: 'slow' }, { human: 'off' }])
  })

  it('child exit restarts on the next call', async () => {
    const r = relay([READY])
    r.send(call(1))
    await vi.waitFor(() => expect(r.children[0]?.got).toHaveLength(3))
    // The container restarted under a call: the call is answered, not left hanging.
    r.children[0].process.emit('exit', 137, null)
    expect((await r.reply(1)).result).toEqual({ isError: true, content: [{ type: 'text', text: 'Browser stopped' }] })
    r.send(call(2))
    await vi.waitFor(() => expect(r.children[1]?.got).toHaveLength(3))
    expect(r.spawn).toHaveBeenCalledTimes(2)
    expect(r.children[1].got[0]).toMatchObject({ method: 'initialize' })
    expect(r.children[1].got[2]).toMatchObject({ id: 2, method: 'tools/call' })
  })

  it('stdin close ends the child and returns 0', async () => {
    const r = relay([READY])
    r.send(call(1))
    await vi.waitFor(() => expect(r.children[0]?.got).toHaveLength(3))
    r.stdin.end()
    expect(await r.done).toBe(0)
    expect(r.children[0].process.stdin.writableEnded).toBe(true)
  })

  it('outside a Harness pane it exits non-zero with a one-line message', async () => {
    for (const deps of [{ where: { ...HERE, harnessPane: false } }, { pane: undefined }]) {
      const r = relay([READY], deps)
      expect(await r.done).toBe(1)
      expect(r.stderr()).toMatch(/^[^\n]+\n$/)
      expect(r.ask).not.toHaveBeenCalled()
    }
  })

  it('the podman exec child starts with ownProcessGroup()', async () => {
    const r = relay([READY])
    r.send(call(1))
    await vi.waitFor(() => expect(r.spawn).toHaveBeenCalled())
    expect(r.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining(ownProcessGroup()))
  })
})
