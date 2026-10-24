import { expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { parseSuperTabArgs, superTabCommand } from './command.js'
const where = { port: 14001, dataDir: '/fixture', machineId: 'machine' }
const prefix = ['--tab', 'tab', '--agent', 'agent']
it('keeps an explicit stable receipt for agent messages and arbitrary work commands', () => {
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', 'Ready', 'op-1'], where).payload).toMatchObject({ action: 'command', operationId: 'op-1', command: { type: 'message.send', conversationId: 'lead', text: 'Ready' } })
  expect(parseSuperTabArgs([...prefix, 'command', 'op-2', '{"type":"work.assign"}'], where).payload).toMatchObject({ command: { type: 'work.assign' } })
  expect(parseSuperTabArgs(['--port', '14002', '--machine', 'target', ...prefix, 'messages', 'lead'], where)).toMatchObject({ where: { port: 14002, machineId: 'target' }, payload: { conversationId: 'lead' } })
  expect(parseSuperTabArgs(['help'], where).payload.action).toBe('help')
  expect(parseSuperTabArgs([...prefix, 'message', 'lead', 'old-question'], where).payload)
    .toMatchObject({ action: 'message', conversationId: 'lead', messageId: 'old-question' })
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', '--tab', 'literal'], where).payload.command).toMatchObject({ text: '--tab' })
  expect(parseSuperTabArgs(['--tab', 'tab', 'status'], where).payload.agentId).toBe('')
  for (const argv of [[], ['status'], [...prefix, 'post', 'lead', 'Ready'], [...prefix, 'messages', '../other'],
    [...prefix, 'message', 'lead'], [...prefix, 'message', 'lead', '../other'], [...prefix, 'message', 'lead', 'id', 'extra'],
    ['--port', 'no', 'help'], ['--machine', '', 'help'], [...prefix, 'status', 'extra'], [...prefix, 'route', 'g1'], [...prefix, 'route', '../x', '{}']]) {
    expect(() => parseSuperTabArgs(argv, where)).toThrow('harness super-tab')
  }
})
it('finds the native caller without requiring an ID in the initial launch prompt', async () => {
  const request = vi.fn(async (type: string) => type === 'agents_list'
    ? { agents: [{ id: 'native', engine: 'codex', tmuxPane: '%42', status: 'active' }] }
    : { ok: true })
  const close = vi.fn(), print = vi.fn()
  const deps = { where: () => where, pane: '%42', open: async () => ({ request, close, machineId: 'machine' }), print }
  expect(await superTabCommand(['--tab', 'tab', 'status'], deps)).toBe(0)
  expect(request).toHaveBeenLastCalledWith('super_tabs', expect.objectContaining({ harnessId: 'native' }), 30_000)
  expect(await superTabCommand(['--tab', 'tab', 'status'], { ...deps, pane: '%43' })).toBe(1)
  expect(print.mock.calls.at(-1)![0]).toContain('inside the participating harness')
  expect(close).toHaveBeenCalledTimes(2)
})
it('uses the existing daemon transport and retains a receipt in an uncertain answer', async () => {
  const print = vi.fn(), close = vi.fn(), request = vi.fn(async () => ({ ok: true }))
  const open = vi.fn(async () => ({ request, close, machineId: 'machine' }))
  const deps = { where: () => where, open, print }
  expect(await superTabCommand([...prefix, 'post', 'lead', 'Ready', 'op'], deps)).toBe(0)
  expect(close).toHaveBeenCalledOnce()
  request.mockRejectedValueOnce(new Error('Connection lost'))
  expect(await superTabCommand([...prefix, 'post', 'lead', 'Ready', 'op'], deps)).toBe(1)
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toEqual({ error: 'Connection lost', operationId: 'op' })
  expect(close).toHaveBeenCalledTimes(2)
})
it('parses route GROUP JSON', () => {
  expect(parseSuperTabArgs([...prefix, 'route', 'g1', '{"difficulty":"low","risk":"low","why":"x"}'], where).payload)
    .toMatchObject({ action: 'route', conversationId: 'g1', assessment: { difficulty: 'low' } })
})
it('routes through the caller and prints the decision, or the parse failure as an error', async () => {
  const print = vi.fn(), close = vi.fn()
  const request = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
    if (type === 'agents_list') return { agents: [{ id: 'native', engine: 'claude', tmuxPane: '%42', status: 'active' }] }
    if (payload.action === 'routeContext') return { error: 'AGENT_UNAVAILABLE', detail: 'x' }
    return { ok: true }
  })
  const deps = { where: () => where, pane: '%42', open: async () => ({ request, close, machineId: 'machine' }), print }
  expect(await superTabCommand(['--tab', 'tab', 'route', 'g1', '{"difficulty":"low","risk":"low","why":"x"}'], deps)).toBe(1)
  expect(request).toHaveBeenCalledWith('super_tabs', expect.objectContaining({ action: 'routeContext', tabId: 'tab', harnessId: 'native' }), 30_000)
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toMatchObject({ error: 'AGENT_UNAVAILABLE' })
  expect(await superTabCommand(['--tab', 'tab', 'route', 'g1', '{nope'], deps)).toBe(1)
  expect(JSON.parse(print.mock.calls.at(-1)![0]).error).toMatch(/JSON/)
})
it('posts a reply to one message with --reply-to, and rejects a bad id', () => {
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', 'Ready', 'op-1', '--reply-to', 'msg-1'], where).payload.command)
    .toMatchObject({ type: 'message.send', conversationId: 'lead', text: 'Ready', replyTo: 'msg-1' })
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', 'Ready', 'op-1'], where).payload.command).toMatchObject({ replyTo: null })
  for (const tail of [['--reply-to'], ['--reply-to', '../x'], ['--reply-to', ''], ['--reply-to', 'a', 'b'], ['--reply', 'a']]) {
    expect(() => parseSuperTabArgs([...prefix, 'post', 'lead', 'Ready', 'op-1', ...tail], where)).toThrow('harness super-tab')
  }
})
it('parses repeated --attach, allows empty text with a file, and refuses empty text alone', () => {
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', '', 'op-1', '--attach', 'a.png', '--reply-to', 'm1', '--attach', 'b.log'], where).payload)
    .toMatchObject({ attach: [resolve('a.png'), resolve('b.log')], command: { text: '', replyTo: 'm1' } })
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', 'Ready', 'op-1'], where).payload).not.toHaveProperty('attach')
  for (const tail of [[], ['--attach'], ['--attach', '']]) {
    expect(() => parseSuperTabArgs([...prefix, 'post', 'lead', ' ', 'op-1', ...tail], where)).toThrow('harness super-tab')
  }
})
it('uploads each --attach file to the daemon\'s local upload route as the agent, then sends the message with their ids', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'super-tab-attach-'))
  try {
    writeFileSync(join(dir, 'shot.png'), Buffer.from([1, 2, 3]))
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(10 * 1024 * 1024 + 1))
    const calls: Array<Record<string, unknown>> = []
    const request = vi.fn(async (_type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      calls.push(payload)
      if (payload.step === 'sent') return { ok: true, value: { agentId: 'agent-1', attachmentIds: null } }
      return { ok: true, value: { revision: 9, result: { messageId: 'm' } } }
    })
    let uploads = 0
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const file = (init!.body as FormData).get('file') as File
      return file.name === 'denied.png'
        ? new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Not in this conversation.' } }), { status: 403 })
        : new Response(JSON.stringify({ success: true, data: { attachment: { id: `f${++uploads}` } } }), { status: 200 })
    })
    const deps = { where: () => where, open: async () => ({ request, close: vi.fn(), machineId: 'machine' }), print: vi.fn(),
      fetch: fetch as unknown as typeof globalThis.fetch }
    expect(await superTabCommand([...prefix, 'post', 'lead', '', 'op', '--attach', join(dir, 'shot.png'), '--attach', join(dir, 'shot.png')], deps)).toBe(0)
    expect(calls.map(c => c.step ?? c.action)).toEqual(['sent', 'command'])
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:14001/api/super-tabs/tab/attachments?asAgentId=agent-1')
    expect(init!.headers).toMatchObject({ 'x-adapter-local': '1' })
    const form = init!.body as FormData
    expect([...form.keys()]).toEqual(['conversationId', 'file'])
    expect(form.get('file')).toMatchObject({ name: 'shot.png', type: 'image/png', size: 3 })
    // Its own deadline, well past a service answer's half minute.
    expect(init!.signal).toBeInstanceOf(AbortSignal)
    expect(calls.at(-1)).toMatchObject({ operationId: 'op', command: { type: 'message.send', text: '', attachmentIds: ['f1', 'f2'] } })
    expect(calls.at(-1)).not.toHaveProperty('attach')
    expect(request.mock.calls.every(c => (c as unknown[])[2] === 30_000)).toBe(true)

    // Already sent: nothing is uploaded and the send returns its receipt.
    calls.length = 0
    request.mockImplementationOnce(async () => ({ ok: true, value: { agentId: 'agent-1', attachmentIds: ['f0'] } }))
    expect(await superTabCommand([...prefix, 'post', 'lead', '', 'op', '--attach', join(dir, 'shot.png')], deps)).toBe(0)
    expect(calls.map(c => c.step ?? c.action)).toEqual(['command'])
    expect(calls[0]).toMatchObject({ command: { attachmentIds: ['f0'] } })
    expect(fetch).toHaveBeenCalledTimes(2)

    // A refused or oversized file stops the post: nothing is sent.
    calls.length = 0
    writeFileSync(join(dir, 'denied.png'), Buffer.from([1]))
    expect(await superTabCommand([...prefix, 'post', 'lead', 'x', 'op2', '--attach', join(dir, 'denied.png')], deps)).toBe(1)
    expect(JSON.parse(deps.print.mock.calls.at(-1)![0]).error).toBe('Not in this conversation.')
    expect(await superTabCommand([...prefix, 'post', 'lead', 'x', 'op3', '--attach', join(dir, 'big.bin')], deps)).toBe(1)
    expect(JSON.parse(deps.print.mock.calls.at(-1)![0]).error).toContain('over the 10.0 MB limit')
    expect(calls.map(c => c.step ?? c.action)).toEqual(['sent', 'sent'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
it('parses screen AGENT [--scrollback N] and type AGENT [TEXT] [--key K]...', () => {
  expect(parseSuperTabArgs([...prefix, 'screen', 'worker'], where).payload).toMatchObject({ action: 'screen', command: { type: 'agent.screen', agentId: 'worker' } })
  expect(parseSuperTabArgs([...prefix, 'screen', 'worker', '--scrollback', '120'], where).payload).toMatchObject({ command: { type: 'agent.screen', agentId: 'worker', scrollback: 120 } })
  expect(parseSuperTabArgs([...prefix, 'type', 'worker', '2', '--key', 'enter'], where).payload).toMatchObject({ action: 'type', command: { type: 'agent.input', agentId: 'worker', text: '2', keys: ['Enter'] } })
  expect(parseSuperTabArgs([...prefix, 'type', 'worker', '--key', 'Esc', '--key', 'ctrl-c', '--key', '1'], where).payload.command).toEqual({ type: 'agent.input', agentId: 'worker', keys: ['Esc', 'Ctrl-C', '1'] })
  for (const argv of [[...prefix, 'screen'], [...prefix, 'screen', '../x'], [...prefix, 'screen', 'worker', '--scrollback', '201'], [...prefix, 'screen', 'worker', '--scrollback', '-1'], [...prefix, 'screen', 'worker', '--scrollback', '0'],
    [...prefix, 'type', 'worker'], [...prefix, 'type', 'worker', '--key', 'F1'], [...prefix, 'type', 'worker', 'a', 'b'], [...prefix, 'type', 'worker', '--key']]) {
    expect(() => parseSuperTabArgs(argv, where)).toThrow('harness super-tab')
  }
})
it('sends a terminal request, reads its result again while it is pending, and prints the screen as plain text', async () => {
  const print = vi.fn(), close = vi.fn()
  const results: Record<string, unknown>[] = [{ error: 'BACKEND_TIMEOUT', detail: 'slow' }, { ok: true, value: { requestId: 'r1', pending: true } }, { ok: true, value: { ok: true, text: 'Allow?\n1. Yes' } }]
  const request = vi.fn(async (_type: string, payload: Record<string, any> = {}): Promise<Record<string, unknown>> => payload.action === 'command'
    ? { ok: true, value: { result: { requestId: 'r1' } } } : results.shift()!)
  const deps = { where: () => where, open: async () => ({ request, close, machineId: 'machine' }), print }
  expect(await superTabCommand([...prefix, 'screen', 'worker'], deps)).toBe(0)
  expect(request.mock.calls.map(([, payload]) => payload!.action)).toEqual(['command', 'terminalResult', 'terminalResult', 'terminalResult'])
  expect(request.mock.calls[0]![1]).toMatchObject({ tabId: 'tab', agentId: 'agent', operationId: expect.stringMatching(/^terminal-/), command: { type: 'agent.screen', agentId: 'worker' } })
  // Not `requestId`: the daemon's transport numbers each request under that name and would overwrite it.
  expect(request.mock.calls[1]![1]).toEqual({ action: 'terminalResult', tabId: 'tab', agentId: 'agent', terminalRequestId: 'r1' })
  expect(print).toHaveBeenLastCalledWith('Allow?\n1. Yes')
  // Typing prints what became of it; a refusal from the host is a failure.
  results.push({ ok: true, value: { ok: false, error: 'Unknown key: Home.' } })
  expect(await superTabCommand([...prefix, 'type', 'worker', '--key', 'Enter'], deps)).toBe(1)
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toEqual({ ok: false, error: 'Unknown key: Home.' })
  results.push({ ok: true, value: { ok: true } })
  expect(await superTabCommand([...prefix, 'type', 'worker', 'y'], deps)).toBe(0)
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toEqual({ ok: true })
})
it('gives up after three pending reads, and passes on a refused request without reading', async () => {
  const print = vi.fn(), close = vi.fn()
  let refused = false
  const request = vi.fn(async (_type: string, payload: Record<string, any> = {}): Promise<Record<string, unknown>> => payload.action === 'command'
    ? refused ? { error: 'LEAD_REQUIRED', detail: 'Only the Lead of this agent\'s project may read its terminal.' } : { ok: true, value: { result: { requestId: 'r1' } } }
    : { ok: true, value: { requestId: 'r1', pending: true } })
  const deps = { where: () => where, open: async () => ({ request, close, machineId: 'machine' }), print }
  expect(await superTabCommand([...prefix, 'screen', 'worker'], deps)).toBe(1)
  expect(request).toHaveBeenCalledTimes(4)
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toEqual({ error: 'TERMINAL_PENDING', detail: 'The worker\'s machine has not answered yet. Try again in a moment.' })
  refused = true
  request.mockClear()
  expect(await superTabCommand([...prefix, 'screen', 'worker'], deps)).toBe(1)
  expect(request).toHaveBeenCalledOnce()
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toMatchObject({ error: 'LEAD_REQUIRED' })
})
it('lets a machine owner preview and then remove their machine, as the person, without a participating harness', async () => {
  const print = vi.fn(), close = vi.fn()
  const request = vi.fn(async (_type: string, payload?: Record<string, unknown>) => payload?.method === 'GET'
    ? { ok: true, value: { blockedBy: null, agents: [{ id: 'a1', name: 'Builder', projectName: 'App' }], soleSourceProjects: [] } }
    : { ok: true, value: { revision: 2 } })
  const deps = { where: () => where, open: async () => ({ request, close, machineId: 'machine' }), print, pane: '%99', env: {} }
  expect(await superTabCommand(['--tab', 'tab', 'remove-machine', 'box'], deps)).toBe(0)
  expect(request.mock.calls.filter(c => c[0] === 'super_tabs')).toHaveLength(1)
  expect(request).toHaveBeenLastCalledWith('super_tabs', expect.objectContaining({ action: 'backend', method: 'GET', path: '/api/super-tabs/tab/machines/box/removal' }), 30_000)
  expect(print.mock.calls.at(-1)![0]).toContain('Builder')
  expect(await superTabCommand(['--tab', 'tab', 'remove-machine', 'box', '--yes'], deps)).toBe(0)
  const sent = request.mock.calls.at(-1)![1]!
  expect(sent).toMatchObject({ action: 'backend', method: 'POST', path: '/api/super-tabs/tab/commands', body: { command: { type: 'machine.remove', machineId: 'box' } } })
  expect(String((sent.body as Record<string, unknown>).operationId)).toMatch(/^machine-remove-/)
  request.mockImplementation(async (type: string) => (type === 'super_tabs'
    ? { error: 'LEAD_PROTECTED', detail: 'This machine runs the Product Manager of App.' } : { agents: [] }) as never)
  expect(await superTabCommand(['--tab', 'tab', 'remove-machine', 'box', '--yes'], deps)).toBe(1)
  expect(print.mock.calls.at(-1)![0]).toContain('Product Manager of App')
  for (const argv of [['--tab', 'tab', 'remove-machine'], ['--tab', 'tab', 'remove-machine', '../x'], ['--tab', 'tab', 'remove-machine', 'box', '--force']]) {
    expect(() => parseSuperTabArgs(argv, where)).toThrow('harness super-tab')
  }
})
it('refuses to remove a machine for an agent: a Swarm agent\'s pane, an outside agent\'s shell, or --agent', async () => {
  const print = vi.fn(), close = vi.fn()
  const request = vi.fn(async (type: string) => type === 'agents_list' ? { agents: [{ id: 'worker', engine: 'claude', tmuxPane: '%7', status: 'active' }] } : { ok: true })
  const deps = { where: () => where, open: async () => ({ request, close, machineId: 'machine' }), print }
  for (const [argv, extra] of [
    [['--tab', 'tab', 'remove-machine', 'box', '--yes'], { pane: '%7', env: {} }],
    [['--tab', 'tab', 'remove-machine', 'box', '--yes'], { pane: '%99', env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'session' } }],
    [['--tab', 'tab', '--agent', 'agent', 'remove-machine', 'box', '--yes'], { pane: '%99', env: {} }],
  ] as const) {
    expect(await superTabCommand(argv, { ...deps, ...extra })).toBe(1)
    expect(print.mock.calls.at(-1)![0]).toContain('your own terminal')
  }
  expect(request.mock.calls.some(c => c[0] === 'super_tabs')).toBe(false)
})
// Lead mentions (spec 2026-10-24-lead-mentions): each --mention names a person by id or email; the service maps them.
it('passes each --mention as written, and leaves a post without one unchanged', () => {
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', 'Please confirm', 'op-1', '--mention', 'ken@example.com', '--reply-to', 'm1', '--mention', 'person-2'], where).payload.command)
    .toEqual({ type: 'message.send', conversationId: 'lead', text: 'Please confirm', replyTo: 'm1', recipientIds: [], mentions: ['ken@example.com', 'person-2'] })
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', 'Ready', 'op-1'], where).payload.command).not.toHaveProperty('mentions')
  for (const tail of [['--mention'], ['--mention', ''], ['--mention', ' ']]) {
    expect(() => parseSuperTabArgs([...prefix, 'post', 'lead', 'Ready', 'op-1', ...tail], where)).toThrow('harness super-tab')
  }
})
it('asks for help as the calling harness, so a Lead sees its own options, and still answers outside one', async () => {
  const request = vi.fn(async (type: string) => type === 'agents_list'
    ? { agents: [{ id: 'native', engine: 'claude', tmuxPane: '%42', status: 'active' }] } : { ok: true, help: {} })
  const deps = { where: () => where, pane: '%42', open: async () => ({ request, close: vi.fn(), machineId: 'machine' }), print: vi.fn() }
  expect(await superTabCommand(['--tab', 'tab', 'help'], deps)).toBe(0)
  expect(request).toHaveBeenLastCalledWith('super_tabs', expect.objectContaining({ action: 'help', tabId: 'tab', harnessId: 'native' }), 30_000)
  expect(await superTabCommand(['--tab', 'tab', 'help'], { ...deps, pane: '%43' })).toBe(0)
  expect(request).toHaveBeenLastCalledWith('super_tabs', expect.not.objectContaining({ harnessId: expect.anything() }), 30_000)
  request.mockClear()
  expect(await superTabCommand(['help'], deps)).toBe(0)
  expect(request).not.toHaveBeenCalledWith('agents_list')
})
