import { PassThrough } from 'node:stream'
import { parseNewArgs } from '../lib/newCommand.js'
import { step } from './commands.js'
import { describe, expect, it } from 'vitest'
import { agentOfClient, answer, callerEnv, INSTRUCTIONS, mcpCommand, PROTOCOL_VERSIONS, result, STARTABLE_AGENTS, TOOLS, type McpDeps, type Ran } from './mcp.js'
import { HARNESS_AGENT_TOOLS } from '../engines/facets/hooks.js'

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
    const known = await answer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'cursor-vscode' } } }, deps({ run: runner({ code: 1, out: '' }).run }), state)
    expect(known).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'harness' }, instructions: INSTRUCTIONS } })
    expect(state.client).toBe('cursor-vscode')
    const newer = await answer({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, deps())
    expect((newer!.result as Record<string, unknown>).protocolVersion).toBe(PROTOCOL_VERSIONS[0])
    expect(await answer({ jsonrpc: '2.0', id: 3, method: 'ping' }, deps())).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
  })

  it('begins its instructions with who the agent is right now, from harness whoami', async () => {
    const r = runner({ out: 'You: Codex, outside Harness, on studio. Nothing can message you here.\nCan start harnesses: yes.\n' })
    const got = await answer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client' } } }, deps({ run: r.run }))
    expect(r.calls.map((c) => c.argv)).toEqual([['whoami']])
    expect(r.calls[0].env.AI_AGENT).toBe('codex')
    expect((got!.result as { instructions: string }).instructions)
      .toBe(`Right now:\nYou: Codex, outside Harness, on studio. Nothing can message you here.\nCan start harnesses: yes.\n\n${INSTRUCTIONS}`)
  })

  it('connects with the plain instructions when whoami fails or is slow', async () => {
    const failed = await answer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, deps({ run: runner({ code: 1, out: '' }).run }))
    expect((failed!.result as { instructions: string }).instructions).toBe(INSTRUCTIONS)
    const slow = await answer({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }, deps({ run: () => new Promise(() => {}), whoamiMs: 5 }))
    expect((slow!.result as { instructions: string }).instructions).toBe(INSTRUCTIONS)
  })

  it('offers harness_whoami as a read-only tool that runs harness whoami', async () => {
    const r = runner()
    await answer(call('harness_whoami'), deps({ run: r.run }))
    expect(r.calls[0].argv).toEqual(['whoami'])
    expect(TOOLS.find((t) => t.name === 'harness_whoami')?.annotations).toEqual({ readOnlyHint: true })
    expect(INSTRUCTIONS).toContain('harness_whoami')
  })

  it('lists send only to a harness in its own pane: an agent outside Harness has nothing to be answered at', async () => {
    const names = async (inPane: boolean) => ((await answer({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, deps({ inPane })))!.result as { tools: Array<{ name: string; argv?: unknown }> }).tools
    const outside = await names(false)
    expect(outside.map((t) => t.name)).toEqual(['harness_whoami', 'harness_list', 'harness_search', 'harness_machines', 'harness_start', 'harness_wait', 'harness_read', 'harness_settings', 'harness_close'])
    expect(outside.every((t) => t.argv === undefined)).toBe(true)
    expect((await names(true)).map((t) => t.name)).toContain('harness_send')
    expect(await answer(call('harness_send', { to: 'x', text: 'y' }), deps())).toMatchObject({ error: { code: -32602 } })
    // Tell names its sender by its pane too: more work from the harness that started one, never from outside Harness.
    expect((await names(true)).map((t) => t.name)).toContain('harness_tell')
    expect(await answer(call('harness_tell', { name: 'x', text: 'y' }), deps())).toMatchObject({ error: { code: -32602 } })
    const tell = (await names(true)).find((t) => t.name === 'harness_tell') as unknown as { description: string }
    expect(tell.description).toMatch(/^Give more work to a harness you started, on any machine, in the conversation it already has/)
    expect(tell.description).toContain('only while the person allows it (Harness Settings, agents-tell-agents)')
    // It reaches teammates in the agent's tab while Agent Messages are on (Settings ▸ Experimental, owner 2026-10-12), and
    // nothing else: not a harness the agent started (owner, 2026-10-11: Agent Messages off means off).
    const send = (await names(true)).find((t) => t.name === 'harness_send') as unknown as { description: string }
    expect(send.description).toMatch(/teammate: a harness in the same tab as you, while Agent Messages are on \(Settings ▸ Experimental, off by default\)\. Refused anywhere else, even to a harness you started/)
    expect(INSTRUCTIONS).toContain('More work for a harness you started goes by harness_tell, once you have read its answer, while the person allows it; a message to a teammate in your tab by harness_send, while Agent Messages are on')
    expect(INSTRUCTIONS).not.toContain('Send follow-ups for the same work to the harness you started')
    // When to start one at all, and to close it, as every harness is told as it starts (lib/agentAttribution.ts).
    expect(INSTRUCTIONS).toContain('Every harness spends the person\'s tokens. Start one (harness_start) only for work that can run in parallel')
    expect(INSTRUCTIONS).toContain('close it once you have its answer (harness_close). At most 4 of yours at once, and a harness another agent started may not start harnesses itself.')
  })

  it('says which tools only read, add or close what can be resumed, so Codex runs them all without asking', async () => {
    // Codex's rule for a tool with no approval setting of its own (codex-rs core/src/mcp_tool_call.rs
    // `requires_mcp_tool_approval`, 0.162.1): destructive asks, read-only does not, and anything else asks unless it
    // says it is neither destructive nor open-world. A close keeps the conversation, so it is not destructive either.
    const codexAsks = (a: Record<string, unknown> = {}) => a.destructiveHint === true || (a.readOnlyHint !== true && (a.destructiveHint !== false || a.openWorldHint !== false))
    const listed = ((await answer({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, deps({ inPane: true })))!.result as { tools: Array<{ name: string; annotations?: Record<string, unknown> }> }).tools
    expect(Object.fromEntries(listed.map((tool) => [tool.name, codexAsks(tool.annotations)]))).toEqual({
      harness_whoami: false, harness_list: false, harness_search: false, harness_machines: false, harness_start: false, harness_wait: false, harness_read: false, harness_tell: false, harness_send: false, harness_close: false,
      // Turning a setting on widens what agents may do: an engine that asks before an unmarked tool asks the person too.
      harness_settings: true,
    })
  })

  it('runs only the verbs Harness allows agents to run without asking, each as the tool the rules name', () => {
    // The engines' permission rules (facets/hooks.ts HARNESS_AGENT_TOOLS) allow each verb, and its tool by name.
    // But `settings`, which the engine asks the person about (a setting widens what agents may do).
    const runs = Object.fromEntries(TOOLS.filter((tool) => tool.name !== 'harness_settings')
      .map((tool) => [tool.argv({ name: 'x', names: ['x'], task: 't', to: 'x', text: 't' }, '/work')[0], tool.name]))
    expect(runs).toEqual(HARNESS_AGENT_TOOLS)
    expect(Object.keys(HARNESS_AGENT_TOOLS)).not.toContain('settings')
  })

  it('runs each tool as its verb', async () => {
    const r = runner()
    const d = deps({ run: r.run, inPane: true })
    await answer(call('harness_list'), d)
    await answer(call('harness_list', { all: true }), d)
    await answer(call('harness_list', { machine: ' grid-dev ', all: true }), d)
    await answer(call('harness_search', { words: 'who am i', limit: 5, when: 'last week' }), d)
    await answer(call('harness_search', { words: 'review the diff' }), d)
    await answer(call('harness_machines'), d)
    await answer(call('harness_start', { task: 'review it\nall of it', folder: 'app', name: 'reviewer' }), d)
    await answer(call('harness_start', { task: 'train', folder: '/abs', name: 'gpu', agent: 'codex', machine: 'mini' }), d)
    await answer(call('harness_start', { task: 'x', folder: '~/p', name: 'n' }), d)
    await answer(call('harness_start', { task: 'a game', project: 'snake', name: 'game', model: ' haiku ' }), d)
    await answer(call('harness_wait', { names: ['a', ' b ', ''] }), d)
    await answer(call('harness_wait', { names: ['a'], any: true, timeout_seconds: 9999 }), d)
    await answer(call('harness_wait', { names: ['a'], timeout_seconds: 1.5 }), d)
    await answer(call('harness_read', { name: 'a' }), d)
    await answer(call('harness_read', { name: 'a', chars: 99.9 }), d)
    await answer(call('harness_send', { to: 'a', text: 'also the footer' }), d)
    await answer(call('harness_tell', { name: 'a', text: '--now: add tests\ntoo' }), d)
    await answer(call('harness_settings'), d)
    await answer(call('harness_settings', { name: 'agents-tell-agents', on: true }), d)
    await answer(call('harness_settings', { name: 'agents-tell-agents', on: true, person_said_yes: true }), d)
    await answer(call('harness_settings', { name: 'agent-messages', on: false }), d)
    await answer(call('harness_close', { name: 'a' }), d)
    await answer(call('harness_close', { name: 'a', now: true }), d)
    expect(r.calls.map((c) => c.argv)).toEqual([
      ['ps'], ['ps', '--all'], ['ps', '--machine', 'grid-dev', '--all'],
      ['search', 'who am i', 'last week', '--limit', '5'], ['search', 'review the diff'],
      ['machines'],
      ['new', 'claude', '/work/here/app', '--name', 'reviewer', '--task', 'review it\nall of it'],
      ['new', 'codex', '--machine', 'mini', '/abs', '--name', 'gpu', '--task', 'train'],
      ['new', 'claude', '~/p', '--name', 'n', '--task', 'x'],
      ['new', 'claude', '--model', 'haiku', '--new', 'snake', '--name', 'game', '--task', 'a game'],
      ['wait', 'a,b', '--timeout', '45s'], ['wait', 'a', '--any', '--timeout', '600s'], ['wait', 'a', '--timeout', '2s'],
      ['show', 'a'], ['show', 'a', '--chars', '99'],
      ['send', 'a', 'also the footer'],
      // After `--`, words that look like options are the work, not flags.
      ['tell', 'a', '--', '--now: add tests\ntoo'],
      ['settings'], ['settings', 'agents-tell-agents', 'on'], ['settings', 'agents-tell-agents', 'on', '--person-said-yes'],
      ['settings', 'agent-messages', 'off'],
      ['close', 'a'], ['close', 'a', '--now'],
    ])
  })

  it('offers harness_search and harness_machines as read-only tools that run their verbs', async () => {
    const listed = ((await answer({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, deps()))!.result as { tools: Array<{ name: string; inputSchema: { required: string[] }; annotations?: Record<string, unknown> }> }).tools
    const search = listed.find((tool) => tool.name === 'harness_search')!
    const machines = listed.find((tool) => tool.name === 'harness_machines')!
    expect(search.inputSchema.required).toEqual(['words'])
    expect(search.annotations).toEqual({ readOnlyHint: true })
    expect(machines.inputSchema.required).toEqual([])
    expect(machines.annotations).toEqual({ readOnlyHint: true })
    expect(INSTRUCTIONS).toContain('search what was already said or decided (harness_search)')
    const r = runner()
    const d = deps({ run: r.run })
    await answer(call('harness_search', { words: 'the missing diff' }), d)
    await answer(call('harness_machines'), d)
    expect(r.calls.map((c) => c.argv)).toEqual([['search', 'the missing diff'], ['machines']])
  })

  it('lets harness_start run any startable engine, not only claude and codex', async () => {
    const listed = ((await answer({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, deps()))!.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }).tools
    const start = listed.find((tool) => tool.name === 'harness_start')!
    const agentSchema = start.inputSchema.properties.agent as { enum?: string[] }
    expect(agentSchema.enum).toContain('claude')
    expect(agentSchema.enum).toContain('codex')
    expect(agentSchema.enum).toContain('opencode')
    expect(agentSchema.enum).toContain('pi')
    expect(agentSchema.enum).toContain('cursor')
    // Every engine but the terminal is startable, and the terminal is not an agent.
    expect(agentSchema.enum).toEqual(STARTABLE_AGENTS)
    expect(agentSchema.enum).not.toContain('terminal')
  })

  it('starts a harness in a new project Harness makes when asked for one, or when given no folder', async () => {
    // A folder was required, so Codex as an MCP client could only name one of its own: Claude Code, started in an empty
    // ~/work, waited on its trust question (a clean VM, CLI 0.3.75, 2026-10-11).
    const listed = ((await answer({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, deps()))!.result as { tools: Array<{ name: string; inputSchema: { required: string[]; properties: Record<string, unknown> } }> })
      .tools.find((tool) => tool.name === 'harness_start')!
    expect(listed.inputSchema.required).toEqual(['task', 'name'])
    expect(listed.inputSchema.properties).toHaveProperty('project')
    expect(INSTRUCTIONS).toContain('Give it a project name (project), never a folder of your own')
    const r = runner()
    const d = deps({ run: r.run })
    await answer(call('harness_start', { task: 'a second opinion', project: 'opinion', name: 'opinion' }), d)
    await answer(call('harness_start', { task: 'go', name: 'quick', agent: 'codex', machine: 'mini' }), d)
    await answer(call('harness_start', { task: 'go', name: 'both', folder: 'app', project: 'p' }), d)
    expect(r.calls.map((c) => c.argv)).toEqual([
      ['new', 'claude', '--new', 'opinion', '--name', 'opinion', '--task', 'a second opinion'],
      ['new', 'codex', '--machine', 'mini', '--new', '--name', 'quick', '--task', 'go'],
      ['new', 'claude', '/work/here/app', '--new', 'p', '--name', 'both', '--task', 'go'],
    ])
    // As `harness new` reads them: a new project, one named by the clock, and a refusal to guess between the two.
    const words = { cwd: '/work/here', home: '/home/me' }
    expect(parseNewArgs(r.calls[0].argv.slice(1), words)).toMatchObject({ agent: 'claude', cwd: null, projectName: 'opinion', name: 'opinion' })
    expect(parseNewArgs(r.calls[1].argv.slice(1), words)).toMatchObject({ agent: 'codex', machine: 'mini', cwd: null, projectName: '' })
    expect(() => parseNewArgs(r.calls[2].argv.slice(1), words)).toThrow('Name a folder or a new project, not both.')
  })

  it('says whose session it is when the agent did not, and leaves a harness pane and a named session alone', () => {
    const via = { HARNESS_VIA_MCP: '1' }
    expect(callerEnv(deps({ env: { PATH: '/bin' } }), 'cursor-vscode')).toEqual({ PATH: '/bin', AI_AGENT: 'cursor', HARNESS_AGENT_SESSION: 'mcp-1', ...via })
    expect(callerEnv(deps({ env: { AI_AGENT: 'amp_1_agent' } }))).toEqual({ AI_AGENT: 'amp_1_agent', HARNESS_AGENT_SESSION: 'mcp-1', ...via })
    expect(callerEnv(deps({ env: {} }))).toMatchObject({ AI_AGENT: 'mcp-client' })
    expect(callerEnv(deps({ env: {}, session: undefined }))).toMatchObject({ HARNESS_AGENT_SESSION: `mcp-${process.ppid}` })
    expect(callerEnv(deps({ env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' } }), 'claude-code')).toEqual({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', ...via })
    expect(callerEnv(deps({ env: { CODEX_THREAD_ID: 't' } }))).toEqual({ CODEX_THREAD_ID: 't', ...via })
    expect(callerEnv(deps({ env: { TMUX_PANE: '%1' }, inPane: true }))).toEqual({ TMUX_PANE: '%1', ...via })
  })

  it('has the verbs it runs name their next steps as its tools, and the shell keeps its own', () => {
    const mcp = { HARNESS_VIA_MCP: '1' }
    expect(step(mcp, 'show', 'reviewer')).toBe('harness_read (name: "reviewer")')
    expect(step(mcp, 'wait', 'reviewer')).toBe('harness_wait (names: "reviewer")')
    expect(step(mcp, 'ps')).toBe('harness_list')
    expect(step(mcp, 'show', 'reviewer', { flag: '--chars 9000', arg: 'chars: 9000' })).toBe('harness_read (name: "reviewer", chars: 9000)')
    expect(step({}, 'show', 'reviewer', { flag: '--chars 9000', arg: 'chars: 9000' })).toBe('harness show reviewer --chars 9000')
    expect(step({}, 'ps')).toBe('harness ps')
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
    expect(result('harness_wait', { code: 3, out: 'a: needs the person\n', err: '' })).toEqual({ content: [{ type: 'text', text: 'a: needs the person' }] })
    // A refusal is an answer: the agent should not retry it as it would a failure.
    expect(result('harness_close', { code: 5, out: '', err: 'You did not start x, so you may not close it. Only the person can.\n' }))
      .toEqual({ content: [{ type: 'text', text: 'You did not start x, so you may not close it. Only the person can.' }] })
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
