/**
 * P4 — `harness pair mcp` and `harness pair <verb>` (pair/mcp.ts, pair/client.ts): an MCP round trip over
 * real streams, and the loopback request a verb becomes — always as a TOOL client, with the token only
 * when this process holds one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleMcpMessage, MCP_SERVER_NAME, serveMcp } from './mcp.js'
import { pairCommand, pairRequest, pairVerb, parsePairArgs, PairUsageError, type PairSocket } from './client.js'
import { BackendSocket } from '../backendSocket.js'

type Json = Record<string, unknown>

describe('the harnessd MCP server', () => {
  it('answers a whole session over stdio: initialize, tools/list, tools/call, ping', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const calls: Json[] = []
    const call = vi.fn(async (payload: Json) => {
      calls.push(payload)
      return payload.verb === 'send_prompt' ? { ok: false, error: 'TOKEN_REQUIRED' } : { ok: true, machines: [] }
    })
    const lines: Json[] = []
    let buffered = ''
    output.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      let at: number
      while ((at = buffered.indexOf('\n')) >= 0) { lines.push(JSON.parse(buffered.slice(0, at)) as Json); buffered = buffered.slice(at + 1) }
    })
    const served = serveMcp({ input, output, call, version: '9.9.9' })
    const send = (message: Json): void => { input.write(`${JSON.stringify(message)}\n`) }
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_machines', arguments: {} } })
    // A token or a verb in the arguments is dropped: they are the server's to set.
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'send_prompt', arguments: { agentId: 'api', text: 'hi', token: 'forged', verb: 'pause_harness' } } })
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'delete_harness', arguments: {} } })
    send({ jsonrpc: '2.0', id: 6, method: 'ping' })
    send({ jsonrpc: '2.0', id: 7, method: 'resources/list' })
    input.write('not json\n')
    input.end()
    await served
    const byId = new Map(lines.map((line) => [line.id, line]))
    expect(byId.get(1)).toEqual({ jsonrpc: '2.0', id: 1, result: expect.objectContaining({
      protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: MCP_SERVER_NAME, version: '9.9.9' } }) })
    const tools = (byId.get(2)!.result as { tools: Array<{ name: string; inputSchema: Json; annotations: Json }> }).tools
    expect(tools.map((t) => t.name)).toEqual(['list_machines', 'list_harnesses', 'read_harness', 'brief', 'answer_question',
      'send_prompt', 'stop_turn', 'start_harness', 'pause_harness', 'resume_harness', 'say'])
    expect(tools.find((t) => t.name === 'read_harness')!.annotations).toMatchObject({ readOnlyHint: true })
    expect(tools.find((t) => t.name === 'answer_question')!.inputSchema).toMatchObject({ required: ['agentId', 'requestId', 'choice'] })
    expect(byId.get(3)).toEqual({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '{"ok":true,"machines":[]}' }], isError: false } })
    expect(byId.get(4)).toMatchObject({ result: { isError: true, content: [{ type: 'text', text: '{"ok":false,"error":"TOKEN_REQUIRED"}' }] } })
    expect(calls).toEqual([{ verb: 'list_machines' }, { agentId: 'api', text: 'hi', verb: 'send_prompt' }])
    expect(byId.get(5)).toMatchObject({ error: { code: -32602 } })
    expect(byId.get(6)).toEqual({ jsonrpc: '2.0', id: 6, result: {} })
    expect(byId.get(7)).toMatchObject({ error: { code: -32601 } })
    expect(lines.filter((l) => l.id === null)).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }])
    expect(lines).toHaveLength(8)   // the notification got no reply
  })

  it('reports a daemon it cannot reach as a tool error, and speaks a newer client\'s protocol as its own', async () => {
    const failing = async (): Promise<Json> => { throw new Error('Harness is not running on this computer.') }
    const reply = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brief' } }, failing, '1')
    expect(reply).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining('UNREACHABLE') }] } })
    const init = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, failing, '1')
    expect((init!.result as Json).protocolVersion).toBe('2025-06-18')
    expect(await handleMcpMessage({ jsonrpc: '1.0', id: 3, method: 'ping' }, failing, '1')).toMatchObject({ error: { code: -32600 } })
  })
})

describe('harness pair <verb>', () => {
  let dirs: string[] = []
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

  /** A daemon's loopback socket, as far as a pair request goes. */
  function fakeDaemon(reply: (payload: Json) => Json) {
    const sent: Json[] = []
    const connect = (): PairSocket => {
      const handlers: Record<string, (...args: never[]) => void> = {}
      const socket: PairSocket = {
        send: (data) => {
          const frame = JSON.parse(data) as { type: string; payload: Json }
          sent.push(frame)
          if (frame.type === 'machine_select') queueMicrotask(() => (handlers.message as (d: { toString(): string }) => void)({ toString: () => JSON.stringify({ type: 'connected', payload: {} }) }))
          if (frame.type === 'pair') queueMicrotask(() => (handlers.message as (d: { toString(): string }) => void)({ toString: () => JSON.stringify({ type: 'pair_result', payload: { requestId: frame.payload.requestId, ...reply(frame.payload) } }) }))
        },
        close: () => {},
        on: ((event: string, listener: (...args: never[]) => void) => { handlers[event] = listener; if (event === 'open') queueMicrotask(() => listener()) }) as PairSocket['on'],
      }
      return socket
    }
    return { sent, connect }
  }

  it('asks as a tool client, and carries the token only when this process holds one', async () => {
    const daemon = fakeDaemon(() => ({ ok: true }))
    const deps = { port: 1, machineId: async () => 'machine-a', connect: daemon.connect, env: {} as NodeJS.ProcessEnv }
    expect(await pairRequest(deps, { verb: 'list_harnesses' })).toEqual({ ok: true })
    expect(daemon.sent[0]).toEqual({ type: 'machine_select', payload: { machineId: 'machine-a', localProtocolVersion: 1, tool: true } })
    expect(daemon.sent[1]).toMatchObject({ type: 'pair', payload: { verb: 'list_harnesses' } })
    expect(daemon.sent[1].payload).not.toHaveProperty('token')
    await pairRequest({ ...deps, env: { HARNESSD_PAIR_TOKEN: 'abc' } }, { verb: 'stop_turn', agentId: 'api' })
    expect(daemon.sent[3]).toMatchObject({ payload: { verb: 'stop_turn', token: 'abc' } })
    const dir = mkdtempSync(join(tmpdir(), 'pair-client-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'token'), 'from-file\n')
    await pairRequest({ ...deps, tokenFile: join(dir, 'token') }, { verb: 'stop_turn', agentId: 'api' })
    expect(daemon.sent[5]).toMatchObject({ payload: { token: 'from-file' } })
    await expect(pairRequest({ ...deps, machineId: async () => null }, { verb: 'status' })).rejects.toThrow('not running')
  })

  it('parses each verb, and tells a pairing code from a verb', () => {
    expect(pairVerb('list-harnesses')).toBe('list_harnesses')
    expect(pairVerb('123-456')).toBeNull()
    expect(pairVerb(undefined)).toBeNull()
    expect(parsePairArgs('answer_question', ['api', 'q1', 'No,', 'and', 'tell', 'it', '--machine', 'mb']).payload)
      .toEqual({ verb: 'answer_question', agentId: 'api', requestId: 'q1', choice: 'No, and tell it', machineId: 'mb' })
    expect(parsePairArgs('start_harness', ['codex', '/w/api', '--name=tests', '--', 'add', 'a', 'test']).payload)
      .toEqual({ verb: 'start_harness', engine: 'codex', cwd: '/w/api', name: 'tests', prompt: 'add a test' })
    expect(parsePairArgs('brief', ['--since', '30', '--json'])).toEqual({ payload: { verb: 'brief', sinceMinutes: 30 }, json: true })
    // `talk` is not a verb of the CLI: the person talks to their daemon from a window.
    expect(pairVerb('talk')).toBeNull()
    expect(() => parsePairArgs('send_prompt', ['api'])).toThrow(PairUsageError)
    expect(() => parsePairArgs('brief', ['--since'])).toThrow(PairUsageError)
  })

  it('prints the reply, exits 1 on a refusal and 2 on a usage error', async () => {
    const daemon = fakeDaemon((p) => p.verb === 'stop_turn' ? { ok: false, error: 'TOKEN_REQUIRED' } : { ok: true })
    const out: string[] = []
    const deps = { port: 1, machineId: async () => 'machine-a', connect: daemon.connect, env: {} as NodeJS.ProcessEnv, output: (l: string) => out.push(l), error: (l: string) => out.push(l) }
    expect(await pairCommand(['list_machines', '--json'], deps)).toBe(0)
    expect(out.pop()).toBe('{"ok":true}')
    expect(await pairCommand(['stop_turn', 'api', '--json'], deps)).toBe(1)
    expect(await pairCommand(['send_prompt'], deps)).toBe(2)
  })
})

describe('a tool client on the loopback socket', () => {
  it('is answered, but is not presence: no window, no pair brain, no daemon_* lines', async () => {
    const socket = new BackendSocket('token')
    const attached = vi.fn()
    socket.onLocalClient = attached
    const tool: Json[] = []
    const window: Json[] = []
    socket.registerLocalClient('local:tool', { sendFrame: (f) => { tool.push(f as Json); return true }, sendBinary: () => true }, { tool: true })
    expect(socket.hasLocalClient()).toBe(false)
    expect(socket.localClientIds()).toEqual([])
    expect(attached).not.toHaveBeenCalled()
    socket.registerLocalClient('local:window', { sendFrame: (f) => { window.push(f as Json); return true }, sendBinary: () => true })
    expect(socket.hasLocalClient()).toBe(true)
    socket.sendLocal({ type: 'daemon_say', payload: { id: 'x' } })
    expect(window.map((f) => f.type)).toContain('daemon_say')
    expect(tool.map((f) => f.type)).not.toContain('daemon_say')
    socket.pairControl = { verbs: new Set(['list_harnesses']), local: async (payload) => ({ ok: true, verb: payload.verb }) }
    socket.handleLocalFrame('local:tool', { type: 'pair', payload: { requestId: 'r1', verb: 'list_harnesses' } })
    await vi.waitFor(() => expect(tool).toContainEqual({ type: 'pair_result', payload: { requestId: 'r1', ok: true, verb: 'list_harnesses' } }))
    await socket.unregisterLocalClient('local:tool')
    expect(attached).toHaveBeenCalledTimes(1)   // the window only
    await socket.unregisterLocalClient('local:window')
    await socket.stop()
  })
})
