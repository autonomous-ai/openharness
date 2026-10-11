import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { agentOfClient, answer, callerEnv, INSTRUCTIONS, mcpCommand, PROTOCOL_VERSIONS, result, type McpDeps, type Ran } from './mcp.js'

/** A runner that records what it was asked and answers [ran]. */
function runner(ran: Partial<Ran> = {}) {
  const calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = []
  const run = async (argv: string[], env: NodeJS.ProcessEnv): Promise<Ran> => { calls.push({ argv, env }); return { code: 0, out: 'ok\n', err: '', ...ran } }
  return { calls, run }
}
const deps = (over: Partial<McpDeps> = {}): McpDeps => ({ run: runner().run, env: {}, cwd: '/work/here', session: 'mcp-1', ...over })
const call = (name: string, args: Record<string, unknown> = {}, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

describe('harness mcp', () => {
  it('answers initialize in the client\'s protocol version when it knows it, with what to use Harness for', async () => {
    const state: { client?: string } = {}
    const known = await answer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'cursor-vscode' } } }, deps(), state)
    expect(known).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'harness' }, instructions: INSTRUCTIONS } })
    expect(state.client).toBe('cursor-vscode')
    const newer = await answer({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, deps())
    expect((newer!.result as Record<string, unknown>).protocolVersion).toBe(PROTOCOL_VERSIONS[0])
    expect(await answer({ jsonrpc: '2.0', id: 3, method: 'ping' }, deps())).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
  })

  it('lists send only to a harness in its own pane: an agent outside Harness has nothing to be answered at', async () => {
    const names = async (inPane: boolean) => ((await answer({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, deps({ inPane })))!.result as { tools: Array<{ name: string; argv?: unknown }> }).tools
    const outside = await names(false)
    expect(outside.map((t) => t.name)).toEqual(['harness_list', 'harness_start', 'harness_wait', 'harness_read', 'harness_close'])
    expect(outside.every((t) => t.argv === undefined)).toBe(true)
    expect((await names(true)).map((t) => t.name)).toContain('harness_send')
    expect(await answer(call('harness_send', { to: 'x', text: 'y' }), deps())).toMatchObject({ error: { code: -32602 } })
  })

  it('runs each tool as its verb', async () => {
    const r = runner()
    const d = deps({ run: r.run, inPane: true })
    await answer(call('harness_list'), d)
    await answer(call('harness_list', { all: true }), d)
    await answer(call('harness_start', { task: 'review it\nall of it', folder: 'app', name: 'reviewer' }), d)
    await answer(call('harness_start', { task: 'train', folder: '/abs', name: 'gpu', agent: 'codex', machine: 'mini' }), d)
    await answer(call('harness_start', { task: 'x', folder: '~/p', name: 'n' }), d)
    await answer(call('harness_wait', { names: ['a', ' b ', ''] }), d)
    await answer(call('harness_wait', { names: ['a'], any: true, timeout_seconds: 9999 }), d)
    await answer(call('harness_wait', { names: ['a'], timeout_seconds: 1.5 }), d)
    await answer(call('harness_read', { name: 'a' }), d)
    await answer(call('harness_read', { name: 'a', chars: 99.9 }), d)
    await answer(call('harness_send', { to: 'a', text: 'also the footer' }), d)
    await answer(call('harness_close', { name: 'a' }), d)
    await answer(call('harness_close', { name: 'a', now: true }), d)
    expect(r.calls.map((c) => c.argv)).toEqual([
      ['ps'], ['ps', '--all'],
      ['new', 'claude', '/work/here/app', '--name', 'reviewer', '--task', 'review it\nall of it'],
      ['new', 'codex', '@mini', '/abs', '--name', 'gpu', '--task', 'train'],
      ['new', 'claude', '~/p', '--name', 'n', '--task', 'x'],
      ['wait', 'a,b', '--timeout', '120s'], ['wait', 'a', '--any', '--timeout', '600s'], ['wait', 'a', '--timeout', '2s'],
      ['show', 'a'], ['show', 'a', '--chars', '99'],
      ['send', 'a', 'also the footer'],
      ['close', 'a'], ['close', 'a', '--now'],
    ])
  })

  it('says whose session it is when the agent did not, and leaves a harness pane and a named session alone', () => {
    expect(callerEnv(deps({ env: { PATH: '/bin' } }), 'cursor-vscode')).toEqual({ PATH: '/bin', AI_AGENT: 'cursor', HARNESS_AGENT_SESSION: 'mcp-1' })
    expect(callerEnv(deps({ env: { AI_AGENT: 'amp_1_agent' } }))).toEqual({ AI_AGENT: 'amp_1_agent', HARNESS_AGENT_SESSION: 'mcp-1' })
    expect(callerEnv(deps({ env: {} }))).toMatchObject({ AI_AGENT: 'mcp-client' })
    expect(callerEnv(deps({ env: {}, session: undefined }))).toMatchObject({ HARNESS_AGENT_SESSION: `mcp-${process.ppid}` })
    expect(callerEnv(deps({ env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' } }), 'claude-code')).toEqual({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' })
    expect(callerEnv(deps({ env: { CODEX_THREAD_ID: 't' } }))).toEqual({ CODEX_THREAD_ID: 't' })
    expect(callerEnv(deps({ env: { TMUX_PANE: '%1' }, inPane: true }))).toEqual({ TMUX_PANE: '%1' })
  })

  it('knows the agents MCP clients are by the names they give', () => {
    expect(['claude-code', 'codex-mcp-client', 'Cursor-VSCode', 'claude-ai', 'claude-desktop', 'my agent_2', '', '  '].map(agentOfClient))
      .toEqual(['claude-code', 'codex', 'cursor', 'claude-desktop', 'claude-desktop', 'my-agent-2', 'mcp-client', 'mcp-client'])
  })

  it('answers with what the verb printed; a failure is an error, and a wait that ends without an answer is not', () => {
    expect(result('harness_list', { code: 0, out: 'rows\n', err: '' })).toEqual({ content: [{ type: 'text', text: 'rows' }] })
    expect(result('harness_close', { code: 0, out: '', err: '' })).toEqual({ content: [{ type: 'text', text: 'Done.' }] })
    expect(result('harness_close', { code: 1, out: '', err: 'You did not start x, so you may not close it.\n' }))
      .toEqual({ content: [{ type: 'text', text: 'You did not start x, so you may not close it.' }], isError: true })
    expect(result('harness_read', { code: 2, out: '', err: '' })).toEqual({ content: [{ type: 'text', text: 'harness exited 2' }], isError: true })
    expect(result('harness_wait', { code: 3, out: 'a: needs-input\n', err: '' })).toEqual({ content: [{ type: 'text', text: 'a: needs-input' }] })
    expect(result('harness_wait', { code: 4, out: 'a: stopped\n', err: '' }).isError).toBeUndefined()
    expect(result('harness_wait', { code: 124, out: 'a: working\n', err: '' })).toEqual({ content: [{ type: 'text', text: 'a: working\nStill working. Call harness_wait again to keep waiting.' }] })
    expect(result('harness_wait', { code: 124, out: '', err: '' }).content[0].text).toBe('Still working. Call harness_wait again to keep waiting.')
    // Elsewhere those exits are failures.
    expect(result('harness_read', { code: 3, out: '', err: 'x' }).isError).toBe(true)
  })

  it('refuses what is not a request it knows, and answers no notification', async () => {
    expect(await answer({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps())).toBeNull()
    expect(await answer({ jsonrpc: '2.0', method: 'notifications/unknown' }, deps())).toBeNull()
    expect(await answer({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, deps())).toEqual({ jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'Method not found: resources/list' } })
    expect(await answer({ jsonrpc: '2.0', id: 5 }, deps())).toEqual({ jsonrpc: '2.0', id: 5, error: { code: -32600, message: 'Invalid request' } })
    expect(await answer({ jsonrpc: '2.0' }, deps())).toBeNull()
    expect(await answer({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'harness_nope' } }, deps())).toMatchObject({ error: { code: -32602, message: 'Unknown tool: harness_nope' } })
    // Arguments that are not an object are none.
    const r = runner()
    await answer({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'harness_list', arguments: 'x' } }, deps({ run: r.run }))
    expect(r.calls[0].argv).toEqual(['ps'])
  })

  it('serves newline-delimited JSON-RPC, calls side by side, until its input ends', async () => {
    const input = new PassThrough(), output = new PassThrough()
    const written: string[] = []
    output.on('data', (chunk) => written.push(...String(chunk).split('\n').filter(Boolean)))
    let release: () => void = () => {}
    const slow = new Promise<void>((done) => { release = done })
    const run = async (argv: string[]): Promise<Ran> => {
      if (argv[0] === 'wait') await slow
      if (argv[0] === 'show') throw new Error('boom')
      return { code: 0, out: argv[0], err: '' }
    }
    const served = mcpCommand({ run, env: {}, session: 's' }, input, output)
    input.write(`${JSON.stringify(call('harness_wait', { names: ['a'] }, 1))}\n\nnot json\n`)
    input.write(`${JSON.stringify(call('harness_list', {}, 2))}\n`)
    input.write(`${JSON.stringify(call('harness_read', { name: 'a' }, 3))}\n`)
    await new Promise((done) => setTimeout(done, 20))
    // The list and the failure answered while the wait still waits.
    expect(written.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'ps' }] } },
      { jsonrpc: '2.0', id: 3, error: { code: -32603, message: 'boom' } },
    ])
    release()
    input.end()
    expect(await served).toBe(0)
    expect(JSON.parse(written.at(-1)!)).toEqual({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'wait' }] } })
  })
})
