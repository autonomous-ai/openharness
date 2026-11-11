import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { MAX_WAITING, runLimitMs, ToolServers, WINDOW_MS, type ToolChild } from './toolServers.js'

type Line = { jsonrpc: string; id: number; method: string; params: Record<string, unknown> }
type FakeChild = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough | null
  kill: Mock<(signal?: NodeJS.Signals) => boolean>
  /** What was written to the child's input, one parsed line each. */
  lines: Line[]
}

/** `podman exec -i … browser-tools.mjs` as the spec drives it: two pipes and an emitter. */
function fakeChild(withStderr: boolean): FakeChild {
  const stdin = new PassThrough()
  const made: FakeChild = Object.assign(new EventEmitter(), {
    stdin, stdout: new PassThrough(), stderr: withStderr ? new PassThrough() : null, kill: vi.fn((_signal?: NodeJS.Signals) => true), lines: [] as Line[],
  })
  let partial = ''
  stdin.on('data', (chunk: Buffer) => {
    const parts = (partial + chunk.toString()).split('\n')
    partial = parts.pop()!
    for (const part of parts) made.lines.push(JSON.parse(part) as Line)
  })
  return made
}

function harness(options: { startFails?: boolean; withStderr?: boolean } = {}) {
  const children: FakeChild[] = []
  const log = vi.fn()
  const start = { fails: options.startFails ?? false }
  const spawn = vi.fn((_agentId: string): ToolChild => {
    if (start.fails) throw new Error('podman is not set up at /opt/podman/bin/podman')
    const child = fakeChild(options.withStderr ?? true)
    children.push(child)
    return child
  })
  return { servers: new ToolServers({ spawn, log }), children, spawn, log, start }
}

const settle = () => vi.advanceTimersByTimeAsync(0)
const text = (value: string) => ({ content: [{ type: 'text', text: value }] })

/** The child answers its line `id` with `body` (a `result` or an `error`). */
async function reply(child: FakeChild, id: number, body: Record<string, unknown>) {
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`)
  await settle()
}

/** A promise whose answer the spec can look at before it settles. */
function track<T>(promise: Promise<T>): { value?: T } {
  const out: { value?: T } = {}
  void promise.then((value) => { out.value = value })
  return out
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('runLimitMs', () => {
  it('is the tool\'s own limit plus 10 s', () => {
    expect(runLimitMs('browser_navigate')).toBe(70_000)
    expect(runLimitMs('browser_wait')).toBe(40_000)
    expect(runLimitMs('browser_snapshot')).toBe(30_000)
    expect(runLimitMs('browser_click')).toBe(30_000)
  })
})

describe('ToolServers', () => {
  it('the first call starts the child once and a second reuses it', async () => {
    const { servers, children, spawn } = harness()
    const first = servers.call('a1', 'browser_snapshot', {}, 'normal')
    await settle()
    expect(spawn.mock.calls).toEqual([['a1']])
    const child = children[0]!
    // No MCP handshake: the first line is the call itself.
    expect(child.lines).toEqual([{
      jsonrpc: '2.0', id: expect.any(Number), method: 'tools/call',
      params: { name: 'browser_snapshot', arguments: {}, _harness: { human: 'normal' } },
    }])
    await reply(child, child.lines[0]!.id, { result: text('- button "Go" [ref=e1]') })
    await expect(first).resolves.toEqual({ reply: text('- button "Go" [ref=e1]') })

    const second = servers.call('a1', 'browser_click', { ref: 'e1' }, 'normal')
    await settle()
    expect(child.lines[1]).toMatchObject({ method: 'tools/call', params: { name: 'browser_click', arguments: { ref: 'e1' } } })
    expect(child.lines[1]!.id).not.toBe(child.lines[0]!.id)
    await reply(child, child.lines[1]!.id, { result: { ...text('Clicked'), isError: false } })
    await expect(second).resolves.toEqual({ reply: { ...text('Clicked'), isError: false } })
    expect(spawn).toHaveBeenCalledTimes(1)

    // Another agent's browser is another tool server.
    const other = servers.call('a2', 'browser_tabs', {}, 'normal')
    await settle()
    expect(spawn.mock.calls).toEqual([['a1'], ['a2']])
    await reply(children[1]!, children[1]!.lines[0]!.id, { result: text('1 tab') })
    await expect(other).resolves.toEqual({ reply: text('1 tab') })
    expect(children[0]!.lines).toHaveLength(2)
  })

  it('calls run in the order they arrive, one at a time', async () => {
    const { servers, children } = harness()
    const a = track(servers.call('a1', 'browser_navigate', { url: 'example.com' }, 'normal'))
    const b = track(servers.call('a1', 'browser_snapshot', {}, 'normal'))
    const c = track(servers.call('a1', 'browser_screenshot', {}, 'normal'))
    await settle()
    const child = children[0]!
    expect(child.lines.map(line => line.params.name)).toEqual(['browser_navigate'])

    await reply(child, child.lines[0]!.id, { result: text('example.com · Example') })
    expect(a.value).toEqual({ reply: text('example.com · Example') })
    expect(child.lines.map(line => line.params.name)).toEqual(['browser_navigate', 'browser_snapshot'])
    expect(b.value).toBeUndefined()

    await reply(child, child.lines[1]!.id, { result: text('snapshot') })
    expect(b.value).toEqual({ reply: text('snapshot') })
    expect(child.lines.map(line => line.params.name)).toEqual(['browser_navigate', 'browser_snapshot', 'browser_screenshot'])

    const image = { content: [{ type: 'image', data: '/9j/4AAQ', mimeType: 'image/jpeg' }] }
    await reply(child, child.lines[2]!.id, { result: image })
    expect(c.value).toEqual({ reply: image })
    expect(children).toHaveLength(1)
  })

  it('eight wait and the ninth is BUSY', async () => {
    expect(MAX_WAITING).toBe(8)
    const { servers, children } = harness()
    const running = track(servers.call('a1', 'browser_snapshot', {}, 'normal'))
    const waiting = Array.from({ length: 8 }, () => track(servers.call('a1', 'browser_tabs', {}, 'normal')))
    await expect(servers.call('a1', 'browser_tabs', {}, 'normal')).resolves.toEqual({ error: 'BUSY' })
    await settle()
    const child = children[0]!
    expect(child.lines).toHaveLength(1)

    // One finishes, one starts: there is room for one more to wait.
    await reply(child, child.lines[0]!.id, { result: text('done') })
    expect(running.value).toEqual({ reply: text('done') })
    const more = track(servers.call('a1', 'browser_tabs', {}, 'normal'))
    await settle()
    expect(more.value).toBeUndefined()
    await expect(servers.call('a1', 'browser_tabs', {}, 'normal')).resolves.toEqual({ error: 'BUSY' })
    expect(waiting.every(call => call.value === undefined)).toBe(true)
  })

  it('each call carries its human mode', async () => {
    const { servers, children } = harness()
    void servers.call('a1', 'browser_click', { ref: 'e1' }, 'off')
    await settle()
    const child = children[0]!
    await reply(child, child.lines[0]!.id, { result: text('Clicked') })
    void servers.call('a1', 'browser_type', { ref: 'e2', text: 'hi' }, 'slow')
    await settle()
    expect(child.lines.map(line => line.params._harness)).toEqual([{ human: 'off' }, { human: 'slow' }])
  })

  it('a call past its limit is TOOL_TIMEOUT, its child is killed, and the next call starts another', async () => {
    const { servers, children, spawn, log } = harness()
    for (const [tool, limit] of [['browser_snapshot', 30_000], ['browser_navigate', 70_000], ['browser_wait', 40_000]] as const) {
      const call = track(servers.call('a1', tool, { url: 'https://example.com/private?token=1' }, 'normal'))
      await settle()
      const child = children.at(-1)!
      await vi.advanceTimersByTimeAsync(limit - 1)
      expect(call.value).toBeUndefined()
      expect(child.kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(call.value).toEqual({ error: 'TOOL_TIMEOUT' })
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.stdin.writableEnded).toBe(true)
      // Its reply after the limit, and its exit, change nothing.
      await reply(child, child.lines[0]!.id, { result: text('late') })
      child.emit('exit')
    }
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(log.mock.calls).toEqual([
      ['agent browser a1: browser_snapshot ran past 30 s; its tool server is started again'],
      ['agent browser a1: browser_navigate ran past 70 s; its tool server is started again'],
      ['agent browser a1: browser_wait ran past 40 s; its tool server is started again'],
    ])

    // The call that waited behind the one that ran too long runs on a new child.
    const slow = track(servers.call('a1', 'browser_snapshot', {}, 'normal'))
    const next = servers.call('a1', 'browser_tabs', {}, 'normal')
    await settle()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(slow.value).toEqual({ error: 'TOOL_TIMEOUT' })
    expect(children).toHaveLength(5)
    const fresh = children[4]!
    expect(fresh.lines.map(line => line.params.name)).toEqual(['browser_tabs'])
    await reply(fresh, fresh.lines[0]!.id, { result: text('1 tab') })
    await expect(next).resolves.toEqual({ reply: text('1 tab') })
  })

  it('a child that exits after answering fails the running call ENDED and the next call starts another', async () => {
    const { servers, children, spawn, log } = harness()
    const first = servers.call('a1', 'browser_snapshot', {}, 'normal')
    await settle()
    const child = children[0]!
    await reply(child, child.lines[0]!.id, { result: text('snapshot') })
    await expect(first).resolves.toEqual({ reply: text('snapshot') })

    const running = servers.call('a1', 'browser_click', { ref: 'e1' }, 'normal')
    const waiting = servers.call('a1', 'browser_snapshot', {}, 'normal')
    await settle()
    // The container restarted: its exec ends. A write to its closed input fails without throwing, and an error after
    // the exit is the same end, heard once.
    child.stdin.emit('error', new Error('write EPIPE'))
    child.emit('exit')
    child.emit('error')
    await expect(running).resolves.toEqual({ error: 'ENDED' })
    expect(log.mock.calls).toEqual([['agent browser a1: its tool server exited']])

    await settle()
    expect(spawn).toHaveBeenCalledTimes(2)
    const fresh = children[1]!
    expect(fresh.lines.map(line => line.params.name)).toEqual(['browser_snapshot'])
    await reply(fresh, fresh.lines[0]!.id, { result: text('again') })
    await expect(waiting).resolves.toEqual({ reply: text('again') })
  })

  it('a child that cannot start is TOOL_FAILED', async () => {
    const { servers, children, spawn, log, start } = harness({ startFails: true })
    await expect(servers.call('a1', 'browser_snapshot', {}, 'normal')).resolves.toEqual({ error: 'TOOL_FAILED' })
    expect(log.mock.calls).toEqual([['agent browser a1: its tool server did not start']])

    // Podman ran but the exec failed (no such container): it exits, or errors, before it ever answered.
    start.fails = false
    for (const event of ['exit', 'error'] as const) {
      const call = servers.call('a1', 'browser_snapshot', {}, 'normal')
      await settle()
      children.at(-1)!.emit(event)
      await expect(call).resolves.toEqual({ error: 'TOOL_FAILED' })
    }
    expect(spawn).toHaveBeenCalledTimes(3)
    // Nothing in a log line names the cause's words, which can hold a path.
    expect(log.mock.calls.flat().some(line => String(line).includes('/opt/podman'))).toBe(false)
    // Nothing runs there now: ending it answers nothing.
    expect(servers.end('a1', 'STOPPED')).toBe(0)
  })

  it('a reply that carries no result fails the call TOOL_FAILED', async () => {
    const { servers, children } = harness()
    const call = servers.call('a1', 'browser_snapshot', {}, 'normal')
    await settle()
    const child = children[0]!
    await reply(child, child.lines[0]!.id, { error: { code: -32601, message: 'Unknown method tools/call' } })
    await expect(call).resolves.toEqual({ error: 'TOOL_FAILED' })

    const empty = servers.call('a1', 'browser_snapshot', {}, 'normal')
    await settle()
    await reply(child, child.lines[1]!.id, { result: null })
    await expect(empty).resolves.toEqual({ error: 'TOOL_FAILED' })
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('end answers the running call and every waiting one with its reason, says how many, and ends the child\'s input', async () => {
    const { servers, children, spawn, log } = harness()
    expect(servers.end('a1', 'STOPPED')).toBe(0)

    const calls = [
      servers.call('a1', 'browser_navigate', { url: 'example.com' }, 'normal'),
      servers.call('a1', 'browser_snapshot', {}, 'normal'),
      servers.call('a1', 'browser_click', { ref: 'e1' }, 'normal'),
    ]
    const window = servers.window('a1', 1280, 800)
    await settle()
    const child = children[0]!
    expect(servers.end('a1', 'STOPPED')).toBe(3)
    for (const call of calls) await expect(call).resolves.toEqual({ error: 'STOPPED' })
    await expect(window).resolves.toEqual({ error: 'WINDOW_FAILED' })
    expect(child.stdin.writableEnded).toBe(true)
    expect(child.kill).not.toHaveBeenCalled()

    // What the ended child still says, and its exit, change nothing and are not logged.
    await reply(child, child.lines[0]!.id, { result: text('late') })
    child.emit('exit')
    expect(log).not.toHaveBeenCalled()
    expect(child.lines.map(line => line.params.name ?? line.method)).toEqual(['browser_navigate', 'window'])
    // Its time limit went with it.
    await vi.advanceTimersByTimeAsync(70_000)
    expect(log).not.toHaveBeenCalled()

    // The next start's first call starts a new child.
    const next = servers.call('a1', 'browser_snapshot', {}, 'normal')
    await settle()
    expect(spawn).toHaveBeenCalledTimes(2)
    await reply(children[1]!, children[1]!.lines[0]!.id, { result: text('fresh') })
    await expect(next).resolves.toEqual({ reply: text('fresh') })
    expect(servers.end('a1', 'ENDED')).toBe(0)
    expect(children[1]!.stdin.writableEnded).toBe(true)
  })

  it('a call whose asker went while it waited never runs', async () => {
    const { servers, children } = harness()
    const running = new AbortController()
    const first = servers.call('a1', 'browser_snapshot', {}, 'normal', running.signal)
    const asker = new AbortController()
    const left = servers.call('a1', 'browser_click', { ref: 'e1' }, 'normal', asker.signal)
    const gone = new AbortController()
    gone.abort()
    const already = servers.call('a1', 'browser_click', { ref: 'e2' }, 'normal', gone.signal)
    const last = servers.call('a1', 'browser_tabs', {}, 'normal')
    await settle()
    const child = children[0]!

    asker.abort()
    await expect(left).resolves.toEqual({ error: 'ENDED' })
    await expect(already).resolves.toEqual({ error: 'ENDED' })
    // A call that already runs is not taken back: its asker's going changes nothing.
    running.abort()
    await reply(child, child.lines[0]!.id, { result: text('snapshot') })
    await expect(first).resolves.toEqual({ reply: text('snapshot') })
    await settle()
    expect(child.lines.map(line => line.params.name)).toEqual(['browser_snapshot', 'browser_tabs'])
    await reply(child, child.lines[1]!.id, { result: text('1 tab') })
    await expect(last).resolves.toEqual({ reply: text('1 tab') })

    // Gone, it no longer holds a place: eight more may wait.
    void servers.call('a1', 'browser_snapshot', {}, 'normal')
    const eight = Array.from({ length: 8 }, () => track(servers.call('a1', 'browser_tabs', {}, 'normal')))
    await settle()
    expect(eight.every(call => call.value === undefined)).toBe(true)
  })

  it('the window is written while a call runs, answers its size, and is WINDOW_FAILED after 5 s or on an error, killing nothing', async () => {
    expect(WINDOW_MS).toBe(5_000)
    const { servers, children, spawn } = harness()
    const call = track(servers.call('a1', 'browser_navigate', { url: 'example.com' }, 'normal'))
    const sized = servers.window('a1', 1280, 800)
    await settle()
    const child = children[0]!
    expect(child.lines[1]).toEqual({ jsonrpc: '2.0', id: expect.any(Number), method: 'window', params: { width: 1280, height: 800 } })
    await reply(child, child.lines[1]!.id, { result: { width: 1280, height: 800 } })
    await expect(sized).resolves.toEqual({ width: 1280, height: 800 })
    expect(call.value).toBeUndefined()

    const silent = track(servers.window('a1', 1100, 700))
    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1)
    expect(silent.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(silent.value).toEqual({ error: 'WINDOW_FAILED' })
    // Its answer after the limit is heard by nobody.
    await reply(child, child.lines[2]!.id, { result: { width: 1100, height: 700 } })

    // An image from before has no window method.
    const old = servers.window('a1', 1100, 700)
    await settle()
    await reply(child, child.lines[3]!.id, { error: { code: -32601, message: 'Unknown method window' } })
    await expect(old).resolves.toEqual({ error: 'WINDOW_FAILED' })

    const odd = servers.window('a1', 1100, 700)
    await settle()
    await reply(child, child.lines[4]!.id, { result: { width: 1100 } })
    await expect(odd).resolves.toEqual({ error: 'WINDOW_FAILED' })

    expect(child.kill).not.toHaveBeenCalled()
    await reply(child, child.lines[0]!.id, { result: text('example.com · Example') })
    expect(call.value).toEqual({ reply: text('example.com · Example') })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('a window with no tool server running starts one, and fails when it cannot start or ends first', async () => {
    const { servers, children, spawn, start } = harness()
    const sized = servers.window('a1', 1024, 640)
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
    const child = children[0]!
    await reply(child, child.lines[0]!.id, { result: { width: 1024, height: 640 } })
    await expect(sized).resolves.toEqual({ width: 1024, height: 640 })

    // The window answered, so the child had answered: a call it then drops ended, rather than failed.
    const call = servers.call('a1', 'browser_snapshot', {}, 'normal')
    const pending = servers.window('a1', 1100, 700)
    await settle()
    child.emit('exit')
    await expect(pending).resolves.toEqual({ error: 'WINDOW_FAILED' })
    await expect(call).resolves.toEqual({ error: 'ENDED' })

    start.fails = true
    await expect(servers.window('a1', 1100, 700)).resolves.toEqual({ error: 'WINDOW_FAILED' })
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('garbage and unknown ids on the child\'s output are ignored, and its stderr is read and dropped', async () => {
    const { servers, children } = harness()
    const call = track(servers.call('a1', 'browser_snapshot', {}, 'normal'))
    await settle()
    const child = children[0]!
    child.stdout.write('not json\nnull\n5\n{"jsonrpc":"2.0","id":9999,"result":{}}\n{"jsonrpc":"2.0","id":"1","result":{}}\n')
    child.stderr!.write('browser-tools: page.goto: net::ERR_NAME_NOT_RESOLVED at https://private.example\n')
    await settle()
    expect(call.value).toBeUndefined()
    expect(child.stderr!.readableFlowing).toBe(true)
    await reply(child, child.lines[0]!.id, { result: text('snapshot') })
    expect(call.value).toEqual({ reply: text('snapshot') })
  })

  it('a child with no stderr is served the same', async () => {
    const { servers, children } = harness({ withStderr: false })
    const call = servers.call('a1', 'browser_tabs', {}, 'normal')
    await settle()
    await reply(children[0]!, children[0]!.lines[0]!.id, { result: text('1 tab') })
    await expect(call).resolves.toEqual({ reply: text('1 tab') })
  })

  it('endAll ends every child', async () => {
    const { servers, children, log } = harness()
    const a1 = servers.call('a1', 'browser_snapshot', {}, 'normal')
    const a2 = servers.call('a2', 'browser_snapshot', {}, 'normal')
    await settle()
    servers.endAll()
    await expect(a1).resolves.toEqual({ error: 'ENDED' })
    await expect(a2).resolves.toEqual({ error: 'ENDED' })
    expect(children.map(child => child.stdin.writableEnded)).toEqual([true, true])
    expect(servers.end('a1', 'STOPPED')).toBe(0)
    expect(servers.end('a2', 'STOPPED')).toBe(0)
    for (const child of children) child.emit('exit')
    expect(log).not.toHaveBeenCalled()
  })
})
