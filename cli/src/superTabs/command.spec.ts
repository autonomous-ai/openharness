import { expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { parseSuperTabArgs, superTabCommand } from './command.js'
import type { Where } from '../agentClient/daemon.js'
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
  const deps = { where: () => where, pane: undefined, open, print }
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
it('parses plan, with or without the Lead\'s assessments, and refuses anything more', () => {
  expect(parseSuperTabArgs([...prefix, 'plan'], where).payload).toMatchObject({ action: 'plan' })
  expect(parseSuperTabArgs([...prefix, 'plan', '{"groups":{}}'], where).payload).toMatchObject({ action: 'plan', request: { groups: {} } })
  expect(() => parseSuperTabArgs([...prefix, 'plan', '{}', 'extra'], where)).toThrow('harness super-tab')
})
it('plans through the caller with its data folder, and prints the plan or why there is none', async () => {
  const print = vi.fn(), close = vi.fn()
  const request = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
    if (type === 'agents_list') return { agents: [{ id: 'native', engine: 'claude', tmuxPane: '%42', status: 'active' }] }
    if (payload.action === 'routeContext') return { error: 'LEAD_REQUIRED', detail: 'x' }
    return { ok: true }
  })
  const deps = { where: () => where, pane: '%42', open: async () => ({ request, close, machineId: 'machine' }), print }
  expect(await superTabCommand(['--tab', 'tab', 'plan'], deps)).toBe(1)
  expect(request).toHaveBeenCalledWith('super_tabs', expect.objectContaining({ action: 'routeContext', tabId: 'tab', harnessId: 'native' }), 30_000)
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toMatchObject({ error: 'LEAD_REQUIRED' })
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
    const deps = { where: () => where, pane: undefined, open: async () => ({ request, close: vi.fn(), machineId: 'machine' }), print: vi.fn(),
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
it('parses propose with up to 5 --attach files, always as a proposal', () => {
  const json = JSON.stringify({ type: 'message.send', conversationId: 'chat', ownerMessageId: 'ask', goal: 'G', scope: 'S', priority: 'normal' })
  expect(parseSuperTabArgs([...prefix, 'propose', 'op-1', json, '--attach', 'plan.md', '--attach', 'shot.png'], where).payload)
    .toMatchObject({ action: 'command', attach: [resolve('plan.md'), resolve('shot.png')], command: { type: 'buddy.propose', conversationId: 'chat' } })
  expect(parseSuperTabArgs([...prefix, 'propose', 'op-1', json], where).payload).not.toHaveProperty('attach')
  expect(() => parseSuperTabArgs([...prefix, 'propose', 'op-1', json, ...['a', 'b', 'c', 'd', 'e', 'f'].flatMap(f => ['--attach', f])], where))
    .toThrow('Attach at most 5 files to a proposal.')
  for (const tail of [['--attach'], ['--attach', ''], ['--reply-to', 'm1'], ['extra']]) {
    expect(() => parseSuperTabArgs([...prefix, 'propose', 'op-1', json, ...tail], where)).toThrow('harness super-tab')
  }
})
it('attaches to a proposal only files inside the Buddy\'s own folder, uploaded to its chat, beside the files its owner sent', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const folder = mkdtempSync(join(tmpdir(), 'buddy-folder-')), outside = mkdtempSync(join(tmpdir(), 'buddy-outside-'))
  try {
    writeFileSync(join(folder, 'plan.md'), '# Plan\n')
    mkdirSync(join(folder, 'docs'))
    writeFileSync(join(folder, 'docs', 'shot.png'), Buffer.from([1, 2, 3]))
    writeFileSync(join(outside, 'secret.txt'), 'not the Buddy\'s')
    symlinkSync(join(outside, 'secret.txt'), join(folder, 'link.txt'))
    for (const dir of ['.git', '.harness']) { mkdirSync(join(folder, dir)); writeFileSync(join(folder, dir, 'config'), 'token') }
    // The same records in other letters: one folder on a case-insensitive Mac, their own on Linux.
    for (const dir of ['.GIT', '.Harness']) {
      try { mkdirSync(join(folder, dir)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      writeFileSync(join(folder, dir, 'config'), 'token')
    }
    // A second name inside the folder for a file outside it.
    linkSync(join(outside, 'secret.txt'), join(folder, 'hard.txt'))
    const calls: Array<Record<string, unknown>> = []
    let frames: unknown[] = [{ id: 'buddy-harness', engine: 'claude', status: 'active', tmuxPane: '%7', project: { cwd: folder } }]
    const request = vi.fn(async (type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      if (type === 'agents_list') return { agents: frames }
      calls.push(payload)
      if (payload.action === 'status') return { ok: true, value: { state: { projects: [{ id: 'p', leadConversationId: 'lead' }],
        conversations: [{ id: 'lead', projectId: 'p' }, { id: 'chat', projectId: 'p', kind: 'buddy' }] } } }
      if (payload.step === 'sent') return { ok: true, value: { agentId: 'buddy', attachmentIds: null } }
      return { ok: true, value: { revision: 9, result: { messageId: 'm' } } }
    })
    let uploads = 0
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { attachment: { id: `f${++uploads}` } } }), { status: 200 }))
    const deps = { where: () => where, open: async () => ({ request, close: vi.fn(), machineId: 'machine' }), print: vi.fn(), pane: '%7',
      fetch: fetch as unknown as typeof globalThis.fetch }
    const json = JSON.stringify({ conversationId: 'chat', ownerMessageId: 'ask', goal: 'G', scope: 'S', priority: 'normal', attachmentIds: ['owner-log'] })
    const propose = (...files: string[]) => superTabCommand([...prefix, 'propose', 'op', json, ...files.flatMap(f => ['--attach', f])], deps)
    const error = () => JSON.parse(deps.print.mock.calls.at(-1)![0]).error as string

    expect(await propose(join(folder, 'plan.md'), join(folder, 'docs', '..', 'docs', 'shot.png'))).toBe(0)
    // Uploaded into its chat; a retry would look for the proposal in the project chat.
    expect(calls.filter(c => c.step === 'sent')).toEqual([expect.objectContaining({ conversationId: 'lead', operationId: 'op' })])
    expect(fetch.mock.calls.map(c => ((c as unknown as [string, RequestInit])[1].body as FormData).get('conversationId'))).toEqual(['chat', 'chat'])
    expect(calls.at(-1)).toMatchObject({ operationId: 'op', command: { type: 'buddy.propose', attachmentIds: ['owner-log', 'f1', 'f2'] } })
    expect(calls.at(-1)).not.toHaveProperty('attach')

    // Outside its folder, through a link, or in its repository's and Harness's own records: refused before any upload.
    calls.length = 0
    for (const path of [join(outside, 'secret.txt'), join(folder, 'link.txt'), join(folder, 'hard.txt'), join(folder, '.git', 'config'),
      join(folder, '.harness', 'config'), join(folder, '.GIT', 'config'), join(folder, '.Harness', 'config'), folder]) {
      expect(await propose(path), path).toBe(1)
      expect(error()).toContain('Attach only files inside your folder')
    }
    // Its owner's files count too, before anything is uploaded.
    expect(await propose(...Array(5).fill(join(folder, 'plan.md')))).toBe(1)
    expect(error()).toBe('Attach at most 5 files to a proposal.')
    expect(await propose(join(folder, 'missing.md'))).toBe(1)
    expect(error()).toContain('missing.md')
    // Only from its own terminal, where its folder is known: never through another machine's daemon. From a harness's pane
    // that is refused before anything else (#2093: a harness reaches the Swarm through this computer's Harness alone).
    for (const relay of [['--machine', 'other-mac'], ['--port', '14002']]) {
      expect(await superTabCommand(['--tab', 'tab', '--agent', 'agent', ...relay, 'propose', 'op', json, '--attach', join(folder, 'plan.md')], deps)).toBe(1)
      expect(error()).toBe('From a harness, Swarm commands go to this computer\'s own Harness only: leave out --machine and --port, or give this computer\'s own.')
    }
    frames = []
    expect(await propose(join(folder, 'plan.md'))).toBe(1)
    expect(error()).toContain('from your Buddy\'s own terminal')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(calls.filter(c => c.action === 'command')).toEqual([])

    // Already sent: nothing is uploaded and the proposal names the files it went with.
    frames = [{ id: 'buddy-harness', engine: 'claude', status: 'active', tmuxPane: '%7', project: { cwd: folder } }]
    request.mockImplementation(async (type: string, payload: Record<string, unknown> = {}) => {
      if (type === 'agents_list') return { agents: frames }
      calls.push(payload)
      if (payload.action === 'status') return { ok: true, value: { state: { projects: [{ id: 'p', leadConversationId: 'lead' }], conversations: [{ id: 'chat', projectId: 'p' }] } } }
      if (payload.step === 'sent') return { ok: true, value: { agentId: 'buddy', attachmentIds: ['owner-log', 'f1', 'f2'] } }
      return { ok: true, value: { revision: 9, result: { messageId: 'm' } } }
    })
    expect(await propose(join(folder, 'plan.md'), join(folder, 'docs', 'shot.png'))).toBe(0)
    expect(calls.at(-1)).toMatchObject({ command: { attachmentIds: ['owner-log', 'f1', 'f2'] } })
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally {
    rmSync(folder, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
it('sends a proposal file\'s bytes as they were when checked, even if the path then turns into a link out of the folder', async () => {
  const { mkdtempSync, writeFileSync, symlinkSync, unlinkSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const folder = mkdtempSync(join(tmpdir(), 'buddy-folder-')), outside = mkdtempSync(join(tmpdir(), 'buddy-outside-'))
  try {
    writeFileSync(join(folder, 'plan.md'), '# Plan\n')
    writeFileSync(join(outside, 'secret.txt'), 'outside bytes')
    const frames = [{ id: 'buddy-harness', engine: 'claude', status: 'active', tmuxPane: '%7', project: { cwd: folder } }]
    const request = vi.fn(async (type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      if (type === 'agents_list') return { agents: frames }
      if (payload.action === 'status') return { ok: true, value: { state: { projects: [{ id: 'p', leadConversationId: 'lead' }], conversations: [{ id: 'chat', projectId: 'p' }] } } }
      if (payload.step === 'sent') {
        // After the check, before the upload: the checked name now points outside.
        unlinkSync(join(folder, 'plan.md'))
        symlinkSync(join(outside, 'secret.txt'), join(folder, 'plan.md'))
        return { ok: true, value: { agentId: 'buddy', attachmentIds: null } }
      }
      return { ok: true, value: { revision: 9, result: { messageId: 'm' } } }
    })
    const sent: string[] = []
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(await ((init!.body as FormData).get('file') as File).text())
      return new Response(JSON.stringify({ success: true, data: { attachment: { id: 'f1' } } }), { status: 200 })
    })
    const deps = { where: () => where, open: async () => ({ request, close: vi.fn(), machineId: 'machine' }), print: vi.fn(), pane: '%7',
      fetch: fetch as unknown as typeof globalThis.fetch }
    const json = JSON.stringify({ conversationId: 'chat', ownerMessageId: 'ask', goal: 'G', scope: 'S', priority: 'normal' })
    expect(await superTabCommand([...prefix, 'propose', 'op', json, '--attach', join(folder, 'plan.md')], deps)).toBe(0)
    expect(sent).toEqual(['# Plan\n'])
  } finally {
    rmSync(folder, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
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
  const deps = { where: () => where, pane: undefined, open: async () => ({ request, close, machineId: 'machine' }), print }
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
  const deps = { where: () => where, pane: undefined, open: async () => ({ request, close, machineId: 'machine' }), print }
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
  const deps = { where: () => where, pane: undefined, open: async () => ({ request, close, machineId: 'machine' }), print }
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
it('lets a machine owner set how many agents it offers, as the person, from their own terminal', async () => {
  const print = vi.fn(), close = vi.fn()
  const request = vi.fn(async (type: string, _payload?: Record<string, unknown>) => (type === 'agents_list' ? { agents: [] }
    : { ok: true, machineId: 'studio', maxAgents: 96, maximum: 96 }) as Record<string, unknown>)
  const deps = { where: () => where, open: async () => ({ request, close, machineId: 'machine' }), print, pane: '%99', env: {} }
  expect(await superTabCommand(['--tab', 'tab', 'set-agents', 'studio', '96'], deps)).toBe(0)
  expect(request).toHaveBeenLastCalledWith('super_tabs', expect.objectContaining({ action: 'setMachineAgents', tabId: 'tab', machineId: 'studio', maxAgents: 96 }), 30_000)
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toMatchObject({ ok: true, maxAgents: 96 })
  request.mockResolvedValue({ error: 'ABOVE_MACHINE_MAXIMUM', detail: 'Mac Studio can offer at most 96 agents: one for every 2 GB of its memory, and at least 4.' })
  expect(await superTabCommand(['--tab', 'tab', 'set-agents', 'studio', '97'], deps)).toBe(1)
  expect(print.mock.calls.at(-1)![0]).toContain('at most 96 agents')
  for (const argv of [['--tab', 'tab', 'set-agents', 'studio'], ['--tab', 'tab', 'set-agents', 'studio', '0'], ['--tab', 'tab', 'set-agents', 'studio', '2.5'],
    ['--tab', 'tab', 'set-agents', 'studio', 'many'], ['--tab', 'tab', 'set-agents', '../x', '8'], ['--tab', 'tab', 'set-agents', 'studio', '8', '--yes']]) {
    expect(() => parseSuperTabArgs(argv, where)).toThrow('set-agents MACHINE_ID COUNT')
  }
})
it('refuses to set a machine\'s agents for an agent: a Swarm agent\'s pane, an outside agent\'s shell, or --agent', async () => {
  const print = vi.fn(), close = vi.fn()
  const request = vi.fn(async (type: string) => type === 'agents_list' ? { agents: [{ id: 'worker', engine: 'claude', tmuxPane: '%7', status: 'active' }] } : { ok: true })
  const deps = { where: () => where, pane: undefined, open: async () => ({ request, close, machineId: 'machine' }), print }
  for (const [argv, extra] of [
    [['--tab', 'tab', 'set-agents', 'studio', '96'], { pane: '%7', env: {} }],
    [['--tab', 'tab', 'set-agents', 'studio', '96'], { pane: '%99', env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'session' } }],
    [['--tab', 'tab', '--agent', 'agent', 'set-agents', 'studio', '96'], { pane: '%99', env: {} }],
  ] as const) {
    expect(await superTabCommand(argv, { ...deps, ...extra })).toBe(1)
    expect(print.mock.calls.at(-1)![0]).toContain('Set a machine\'s agents from your own terminal or from Desktop, not from an agent.')
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
it('keeps the mentioned people on a post that sends files', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'super-tab-mention-'))
  try {
    writeFileSync(join(dir, 'shot.png'), Buffer.from([1, 2, 3]))
    const request = vi.fn(async (_type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
      payload.step === 'sent' ? { ok: true, value: { agentId: 'agent-1', attachmentIds: null } } : { ok: true, value: { revision: 9, result: { messageId: 'm' } } })
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { attachment: { id: 'f1' } } }), { status: 200 }))
    const deps = { where: () => where, pane: undefined, open: async () => ({ request, close: vi.fn(), machineId: 'machine' }), print: vi.fn(),
      fetch: fetch as unknown as typeof globalThis.fetch }
    expect(await superTabCommand([...prefix, 'post', 'lead', 'Please check', 'op', '--attach', join(dir, 'shot.png'), '--mention', 'person-ken'], deps)).toBe(0)
    expect(request.mock.calls.at(-1)![1]).toMatchObject({ action: 'command', command: { type: 'message.send', attachmentIds: ['f1'], mentions: ['person-ken'] } })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Decisions (v2): the Lead, or a worker, reads the decisions it asked and their answers.
it('reads the caller\'s open decisions, or with --answered the answered ones', () => {
  expect(parseSuperTabArgs([...prefix, 'decisions'], where).payload).toMatchObject({ action: 'decisions', state: 'open' })
  expect(parseSuperTabArgs([...prefix, 'decisions', '--answered'], where).payload).toMatchObject({ action: 'decisions', state: 'answered' })
  for (const argv of [[...prefix, 'decisions', 'extra'], [...prefix, 'decisions', '--answered', 'extra']]) expect(() => parseSuperTabArgs(argv, where)).toThrow('harness super-tab')
})

it('parses a Buddy\'s propose OPERATION_ID JSON as its proposal command, whatever type the JSON names', () => {
  const prefix = ['--tab', 'tab', '--agent', 'buddy']
  const proposal = { conversationId: 'chat', ownerMessageId: 'asked', goal: 'Offline sync', scope: 'Desktop only', priority: 'normal' }
  expect(parseSuperTabArgs([...prefix, 'propose', 'op-1', JSON.stringify({ ...proposal, type: 'work.assign' })], where).payload)
    .toMatchObject({ action: 'command', operationId: 'op-1', command: { ...proposal, type: 'buddy.propose' } })
  expect(() => parseSuperTabArgs([...prefix, 'propose', 'op-1'], where)).toThrow('harness super-tab')
})
// Security review of #2087: --agent naming a Builder let a Buddy on the same machine speak as it. The harness the command
// runs in goes with every request, and the daemon holds the agent named to that harness's own (service.spec.ts).
it('sends the pane\'s own harness with every --agent request, so the agent it names is checked against it', async () => {
  const request = vi.fn(async (type: string) => type === 'agents_list'
    ? { agents: [{ id: 'buddy-harness', engine: 'claude', tmuxPane: '%42', status: 'active' }] } : { ok: true })
  const deps = { where: () => where, pane: '%42', open: async () => ({ request, close: vi.fn(), machineId: 'machine' }), print: vi.fn() }
  for (const argv of [['post', 'g1', 'Ready', 'op'], ['command', 'op', '{"type":"work.status"}'], ['message', 'g1', 'm1'], ['messages', 'g1'], ['status']]) {
    expect(await superTabCommand(['--tab', 'tab', '--agent', 'builder', ...argv], deps)).toBe(0)
    expect(request).toHaveBeenLastCalledWith('super_tabs', expect.objectContaining({ agentId: 'builder', harnessId: 'buddy-harness' }), 30_000)
  }
})
// The Lead's must on #904's plan: the harness asking is the pane the command runs in, never one it names.
it('refuses a command that sets TMUX_PANE to another harness\'s pane, before it asks the Swarm anything', async () => {
  const request = vi.fn(async (type: string) => type === 'agents_list'
    ? { agents: [{ id: 'builder-harness', engine: 'claude', tmuxPane: '%7', status: 'active' }] } : { ok: true })
  const print = vi.fn()
  // This command runs in pane %42 (its process 700 is an ancestor); %7 is the Builder's.
  const probe = { panes: () => [{ pane: '%7', pid: 500 }, { pane: '%42', pid: 700 }], ancestors: () => [900, 800, 700, 600, 1].map(pid => ({ pid, command: pid === 600 ? 'tmux' : 'node' })) }
  const deps = { where: () => where, probe, env: { TMUX_PANE: '%7' }, open: async () => ({ request, close: vi.fn(), machineId: 'machine' }), print }
  for (const argv of [['--tab', 'tab', 'post', 'g1', 'Ready', 'op'], ['--tab', 'tab', '--agent', 'builder', 'post', 'g1', 'Ready', 'op']]) {
    expect(await superTabCommand(argv, deps)).toBe(1)
    expect(JSON.parse(print.mock.calls.at(-1)![0]).error).toBe('This command names a pane it does not run in. Run it as your harness gave it, without setting TMUX_PANE.')
  }
  expect(request.mock.calls.some(c => c[0] === 'super_tabs')).toBe(false)
  // Unset, the pane is still found from the processes: %42, which is no harness, so --agent is the person's as before.
  expect(await superTabCommand(['--tab', 'tab', '--agent', 'builder', 'status'], { ...deps, env: {} })).toBe(0)
  const sent = request.mock.calls.at(-1) as unknown as [string, Record<string, unknown>]
  expect(sent[1]).toMatchObject({ action: 'status', agentId: 'builder' })
  expect(sent[1]).not.toHaveProperty('harnessId')
})
// The second review of #2087: from a Buddy's pane, --machine sent its request to the owner's other Mac, which knew no pane
// there and served the agent it named. From a harness, the Swarm is reached through this computer's own Harness alone.
it('refuses, from a harness, a --machine or --port other than this computer\'s own, and lets a person\'s terminal choose', async () => {
  const opened: Where[] = []
  const request = vi.fn(async (type: string) => type === 'agents_list'
    ? { agents: [{ id: 'buddy-harness', engine: 'claude', tmuxPane: '%42', status: 'active' }] } : { ok: true })
  const print = vi.fn()
  const deps = { where: () => where, print, open: async (to: Where) => { opened.push(to); return { request, close: vi.fn(), machineId: to.machineId } as never } }
  const elsewhere = [['--machine', 'macbook'], ['--port', '15000'], ['--port', '15000', '--machine', 'macbook']]
  for (const flags of elsewhere) {
    opened.length = 0
    expect(await superTabCommand([...flags, '--tab', 'tab', '--agent', 'builder', 'status'], { ...deps, pane: '%42' })).toBe(1)
    expect(JSON.parse(print.mock.calls.at(-1)![0]).error)
      .toBe('From a harness, Swarm commands go to this computer\'s own Harness only: leave out --machine and --port, or give this computer\'s own.')
    // Only this computer's daemon was asked which harness the pane is.
    expect(opened).toEqual([where])
  }
  // This computer's own values, as the delivered instructions write them.
  expect(await superTabCommand(['--port', '14001', '--machine', 'machine', '--tab', 'tab', '--agent', 'builder', 'status'], { ...deps, pane: '%42' })).toBe(0)
  // A pane that is no harness's, and a terminal outside tmux: the person's choice.
  for (const pane of ['%9', undefined]) {
    opened.length = 0
    expect(await superTabCommand(['--machine', 'macbook', '--tab', 'tab', '--agent', 'builder', 'status'], { ...deps, pane })).toBe(0)
    expect(opened.at(-1)).toMatchObject({ machineId: 'macbook' })
  }
})
// Windows has no cheap check of a pty host pane (second review, item 4): while this computer runs a Buddy, an agent's shell
// may not name an agent.
it('refuses --agent from an agent\'s shell on Windows while this computer runs a Buddy, and leaves a person\'s terminal alone', async () => {
  let buddiesHere = true
  const request = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => type === 'agents_list' ? { agents: [] }
    : payload.action === 'buddyCheck' ? { ok: true, buddiesHere } : { ok: true })
  const print = vi.fn()
  const deps = { where: () => where, print, platform: 'win32' as const, open: async () => ({ request, close: vi.fn(), machineId: 'machine' }) }
  for (const env of [{ HARNESS_PANE: 'p1:%3' }, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' }]) {
    buddiesHere = true
    expect(await superTabCommand([...prefix, 'status'], { ...deps, env })).toBe(1)
    expect(JSON.parse(print.mock.calls.at(-1)![0]).error).toContain('This Windows computer runs a Buddy')
    buddiesHere = false
    expect(await superTabCommand([...prefix, 'status'], { ...deps, env })).toBe(0)
  }
  buddiesHere = true
  expect(await superTabCommand([...prefix, 'status'], { ...deps, env: {} })).toBe(0)
})
// The re-check of #2093 (minor 6): on Windows, --machine asked the other machine's daemon whether a Buddy runs, which it
// does not answer for another computer, and a pty host pane was no pane for the other-machine refusal.
it('on Windows, refuses another machine from a harness\'s pane, and asks this computer\'s daemon about its Buddies', async () => {
  const opened: Where[] = []
  let buddiesHere = false
  const request = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => type === 'agents_list'
    ? { agents: [{ id: 'win-harness', engine: 'claude', tmuxPane: '%3', status: 'active', terminal: { runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: '%3' }] } }] }
    : payload.action === 'buddyCheck' ? { ok: true, buddiesHere } : { ok: true })
  const print = vi.fn()
  const deps = { where: () => where, print, platform: 'win32' as const,
    open: async (to: Where) => { opened.push(to); return { request, close: vi.fn(), machineId: to.machineId } as never } }
  expect(await superTabCommand(['--machine', 'macbook', ...prefix, 'status'], { ...deps, env: { HARNESS_PANE: 'p1:%3' } })).toBe(1)
  expect(JSON.parse(print.mock.calls.at(-1)![0]).error).toContain('this computer\'s own Harness only')
  expect(opened).toEqual([where])
  // A Claude Code shell with no Harness pane: this computer's daemon is asked about its Buddies, not the other machine's.
  buddiesHere = true
  opened.length = 0
  expect(await superTabCommand(['--machine', 'macbook', ...prefix, 'status'], { ...deps, env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' } })).toBe(1)
  expect(JSON.parse(print.mock.calls.at(-1)![0]).error).toContain('This Windows computer runs a Buddy')
  expect(opened).toEqual([where])
  // A person's terminal chooses its machine.
  opened.length = 0
  expect(await superTabCommand(['--machine', 'macbook', ...prefix, 'status'], { ...deps, env: {} })).toBe(0)
  expect(opened.at(-1)).toMatchObject({ machineId: 'macbook' })
})
// Re-check 2 of #2093 (important 6): pane ids restart in every tmux server, so a private server counted up to a Builder's
// pane id (%221) and its command was taken for that Builder. The pane's harness is taken only when the Harness daemon's own
// pane of it is among the command's parents.
it('takes a pane\'s harness only when the daemon\'s own pane process is among the command\'s parents', async () => {
  let panePid = 555
  const request = vi.fn(async (type: string) => type === 'agents_list'
    ? { agents: [{ id: 'builder-harness', engine: 'claude', tmuxPane: '%221', status: 'active' }] }
    : type === 'terminal_info' ? { command: 'claude', path: '/work', pid: panePid, tty: '/dev/ttys001' } : { ok: true })
  const print = vi.fn()
  // A private tmux server (600) whose pane %221 runs this command (700): the daemon's own %221 is process 555.
  const probe = { panes: () => [{ pane: '%221', pid: 700 }], ancestors: () => [900, 700, 600, 1].map(pid => ({ pid, command: pid === 600 ? 'tmux' : 'node' })) }
  const deps = { where: () => where, probe, env: { TMUX: '/private/x/default,600,0', TMUX_PANE: '%221' }, print,
    open: async () => ({ request, close: vi.fn(), machineId: 'machine' }) }
  for (const argv of [['--tab', 'tab', 'status'], ['--tab', 'tab', '--agent', 'builder', 'post', 'g1', 'Ready', 'op']]) {
    expect(await superTabCommand(argv, deps)).toBe(1)
    expect(JSON.parse(print.mock.calls.at(-1)![0]).error)
      .toBe('This command does not run in the Harness pane it names, so it did not run. Run it as your harness gave it, in its own pane.')
  }
  expect(request.mock.calls.some(([type]) => type === 'super_tabs')).toBe(false)
  // The daemon's own pane: the harness goes with the request.
  panePid = 700
  expect(await superTabCommand(['--tab', 'tab', 'status'], deps)).toBe(0)
  expect(request).toHaveBeenCalledWith('terminal_info', { agentId: 'builder-harness' }, 10_000)
  expect(request).toHaveBeenLastCalledWith('super_tabs', expect.objectContaining({ harnessId: 'builder-harness' }), 30_000)
})
// Re-check 2 of #2093 at 0648a8690 (minor 8): a failed Swarm answer is no "Swarm off" on Windows' backstop either.
it('refuses --agent from an agent\'s shell on Windows when this computer\'s Swarm cannot answer', async () => {
  const request = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => type === 'agents_list' ? { agents: [] }
    : payload.action === 'buddyCheck' ? { error: 'SERVICE_FAILED', service: 'superTabs' } : { ok: true })
  const print = vi.fn()
  expect(await superTabCommand([...prefix, 'status'], { where: () => where, print, platform: 'win32', env: { HARNESS_PANE: 'p1:%3' },
    open: async () => ({ request, close: vi.fn(), machineId: 'machine' }) })).toBe(1)
  expect(JSON.parse(print.mock.calls.at(-1)![0]).error).toBe('Harness could not reach this computer\'s Swarm just now, so it did not run this. Try again in a moment.')
  expect(request.mock.calls.filter(([type, payload]) => type === 'super_tabs' && (payload as Record<string, unknown>)?.action !== 'buddyCheck')).toEqual([])
})

// Cost records (Dee, 2026-10-29): what routed attempts cost and how they went, over the last days.
it('reads the cost summary of the last 7 days, or of --days N up to 90', () => {
  expect(parseSuperTabArgs([...prefix, 'costs'], where).payload).toMatchObject({ action: 'costs', days: 7 })
  expect(parseSuperTabArgs([...prefix, 'costs', '--days', '30'], where).payload).toMatchObject({ action: 'costs', days: 30 })
  for (const argv of [[...prefix, 'costs', '--days'], [...prefix, 'costs', '--days', '0'], [...prefix, 'costs', '--days', '91'],
    [...prefix, 'costs', '--days', '7x'], [...prefix, 'costs', 'extra']]) expect(() => parseSuperTabArgs(argv, where), argv.join(' ')).toThrow('harness super-tab')
})
