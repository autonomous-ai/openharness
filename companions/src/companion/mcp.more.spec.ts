/**
 * pair/mcp.ts, the edges of the JSON-RPC surface: what is refused, what is ignored, what a malformed line
 * gets back, and that a reply that cannot be serialised is logged rather than taking the server down.
 */
import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { handleMcpMessage, MCP_PROTOCOL_VERSIONS, mcpTools, serveMcp } from './mcp.js'
import { CONTROL_TOOLS } from './control.js'

type Json = Record<string, unknown>
const ok = async (): Promise<Json> => ({ ok: true })

describe('handleMcpMessage', () => {
  it('refuses a request that is not JSON-RPC 2.0 or names no method — and ignores such a notification', async () => {
    expect(await handleMcpMessage({ jsonrpc: '1.0', id: 1, method: 'ping' }, ok, 'v')).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid Request' } })
    expect(await handleMcpMessage({ jsonrpc: '2.0', id: 2 }, ok, 'v')).toEqual({ jsonrpc: '2.0', id: 2, error: { code: -32600, message: 'Invalid Request' } })
    expect(await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 42 }, ok, 'v')).toMatchObject({ error: { code: -32600 } })
    expect(await handleMcpMessage({ jsonrpc: '1.0', method: 'ping' }, ok, 'v')).toBeNull()
    expect(await handleMcpMessage({ jsonrpc: '2.0', id: null, method: 'ping' }, ok, 'v')).toBeNull()   // id null = a notification
  })

  it('answers an unknown method with -32601, carrying the id', async () => {
    expect(await handleMcpMessage({ jsonrpc: '2.0', id: 'x', method: 'resources/list' }, ok, 'v'))
      .toEqual({ jsonrpc: '2.0', id: 'x', error: { code: -32601, message: 'Method not found: resources/list' } })
  })

  it('initializes with its newest protocol when the client asks for none, or one it does not speak', async () => {
    for (const params of [undefined, 'not an object', {}, { protocolVersion: 7 }, { protocolVersion: '1999-01-01' }]) {
      const reply = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params }, ok, '1.2.3')
      expect(reply).toMatchObject({ result: { protocolVersion: MCP_PROTOCOL_VERSIONS[0], serverInfo: { name: 'harnessd', version: '1.2.3' } } })
    }
    const older = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, ok, 'v')
    expect(older).toMatchObject({ result: { protocolVersion: '2024-11-05' } })
  })

  it('refuses a tool it does not have, never calling the daemon', async () => {
    const call = vi.fn(ok)
    for (const params of [{ name: 'rm_rf' }, { name: 7 }, {}]) {
      const reply = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }, call, 'v')
      expect(reply).toMatchObject({ error: { code: -32602, message: expect.stringMatching(/^Unknown tool: /) } })
    }
    expect(call).not.toHaveBeenCalled()
  })

  it('calls with no arguments when they are missing or not an object, and the verb is always the tool', async () => {
    const call = vi.fn(async (_payload: Json): Promise<Json> => ({ ok: true }))
    for (const args of [undefined, 'text', ['agentId', 'x'], null]) {
      await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_machines', arguments: args } }, call, 'v')
    }
    expect(call.mock.calls.map(([payload]) => payload)).toEqual(Array(4).fill({ verb: 'list_machines' }))
  })

  it('turns a daemon that throws a non-Error into a readable UNREACHABLE tool error', async () => {
    const reply = await handleMcpMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'brief' } }, async () => { throw 'socket closed' }, 'v')
    const result = (reply as { result: { content: Array<{ text: string }>; isError: boolean } }).result
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: false, error: 'UNREACHABLE', detail: 'socket closed' })
  })

  it('lists every control tool once, read tools hinted read-only, none destructive', () => {
    const tools = mcpTools()
    expect(tools.map((t) => t.name)).toEqual(CONTROL_TOOLS.map((t) => t.name))
    for (const tool of tools) {
      const kind = CONTROL_TOOLS.find((t) => t.name === tool.name)!.kind
      expect(tool.annotations).toEqual({ readOnlyHint: kind === 'read', destructiveHint: false, openWorldHint: false })
    }
  })
})

describe('serveMcp', () => {
  function serve(call: (p: Json) => Promise<Json>, log?: (line: string) => void) {
    const input = new PassThrough()
    const output = new PassThrough()
    const replies: Json[] = []
    let buffered = ''
    output.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      let at: number
      while ((at = buffered.indexOf('\n')) >= 0) { replies.push(JSON.parse(buffered.slice(0, at)) as Json); buffered = buffered.slice(at + 1) }
    })
    const done = serveMcp({ input, output, call, version: 'v', ...(log ? { log } : {}) })
    return { input, replies, done }
  }

  it('answers a line that is not JSON with a parse error, a batch with a refusal, and skips blank lines', async () => {
    const { input, replies, done } = serve(ok)
    input.write('   \n')
    input.write('{not json\n')
    input.write('[{"jsonrpc":"2.0","id":1,"method":"ping"}]\n')
    input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n')
    input.end()
    await done
    expect(replies).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported' } },
      { jsonrpc: '2.0', id: 2, result: {} },
    ])
  })

  it('logs — and keeps serving — when a reply cannot be written as JSON, or a line is JSON but not a message', async () => {
    const cyclic: Json = { ok: true }
    cyclic.self = cyclic
    // A result whose serialisation throws something that is not an Error at all.
    const throwsText: Json = { toJSON: () => { throw 'unserialisable' } }
    const log = vi.fn()
    const { input, replies, done } = serve(async (p) => (p.verb === 'brief' ? cyclic : p.verb === 'say' ? throwsText : { ok: true }), log)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brief' } })}\n`)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'say' } })}\n`)
    input.write('null\n')
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`)
    input.end()
    await done
    expect(replies).toEqual([{ jsonrpc: '2.0', id: 2, result: {} }])
    expect(log).toHaveBeenCalledTimes(3)
    for (const [line] of log.mock.calls) expect(line).toMatch(/^\[harnessd mcp\] /)
    expect(log).toHaveBeenCalledWith('[harnessd mcp] unserialisable')
  })

  it('without a log, a failed reply is dropped silently', async () => {
    const { input, replies, done } = serve(ok)
    input.write('null\n')
    input.end()
    await done
    expect(replies).toEqual([])
  })

  it('waits for replies still in flight before it resolves on close', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { input, replies, done } = serve(async () => { await gate; return { ok: true } })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'brief' } })}\n`)
    input.end()
    let finished = false
    void done.then(() => { finished = true })
    await new Promise((r) => setTimeout(r, 10))
    expect(finished).toBe(false)
    release()
    await done
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ id: 7, result: { isError: false } })
  })
})
