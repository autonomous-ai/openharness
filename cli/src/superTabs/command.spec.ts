import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { resolve } from 'node:path'
import { parseSuperTabArgs, readStdin, StdinIdle, superTabCommand } from './command.js'
import type { Where } from '../agentClient/daemon.js'
const where = { port: 14001, dataDir: '/fixture', machineId: 'machine' }
const prefix = ['--tab', 'tab', '--agent', 'agent']
it('keeps an explicit stable receipt for agent messages', () => {
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', 'Ready', 'op-1'], where).payload).toMatchObject({ action: 'command', operationId: 'op-1', command: { type: 'message.send', conversationId: 'lead', text: 'Ready' } })
  expect(parseSuperTabArgs(['--port', '14002', '--machine', 'target', ...prefix, 'messages', 'lead'], where)).toMatchObject({ where: { port: 14002, machineId: 'target' }, payload: { conversationId: 'lead' } })
  expect(parseSuperTabArgs([...prefix, 'message', 'lead', 'old-question'], where).payload)
    .toMatchObject({ action: 'message', conversationId: 'lead', messageId: 'old-question' })
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', '--tab', 'literal'], where).payload.command).toMatchObject({ text: '--tab' })
  expect(parseSuperTabArgs(['--tab', 'tab', 'status'], where).payload.agentId).toBe('')
  // An agent in its own pane may leave its Swarm out: its daemon takes the one it is in (service.ts).
  expect(parseSuperTabArgs(['status'], where).payload).toMatchObject({ action: 'status', tabId: '' })
  expect(() => parseSuperTabArgs(['--tab', '../other', 'status'], where)).toThrow('harness super-tab')
  for (const argv of [[], [...prefix, 'post', 'lead', 'Ready'], [...prefix, 'messages', '../other'],
    [...prefix, 'message', 'lead'], [...prefix, 'message', 'lead', '../other'], [...prefix, 'message', 'lead', 'id', 'extra'],
    ['--port', 'no', 'messages', 'lead'], ['--machine', '', 'messages', 'lead'], [...prefix, 'messages', 'lead', 'extra']]) {
    expect(() => parseSuperTabArgs(argv, where)).toThrow('harness super-tab')
  }
})
// 2026-10-30: three Reviewer verdicts posted with TEXT - arrived as a single dash, #2345's findings among them.
it('reads a post\'s message from stdin for -, once, without its last line break', () => {
  const stdin = vi.fn(() => "Ready: no\n- P1: it's '%h %s'\n"), terminal = vi.fn(() => false)
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', '-', 'op-1', '--reply-to', 'm1'], where, stdin, terminal).payload).toMatchObject({ action: 'command',
    operationId: 'op-1', command: { type: 'message.send', conversationId: 'lead', text: "Ready: no\n- P1: it's '%h %s'", replyTo: 'm1' } })
  expect(stdin).toHaveBeenCalledOnce()
  // A message that is only a dash goes on stdin; a CRLF ending is a line break too.
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', '-', 'op-2'], where, () => '-\r\n', () => false).payload.command).toMatchObject({ text: '-' })
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', '-', 'op-3', '--attach', 'a.png'], where, () => 'with a file', () => false).payload)
    .toMatchObject({ attach: [resolve('a.png')], command: { text: 'with a file' } })
})
it('refuses a post\'s - with an empty or a terminal stdin, naming the fix, and posts nothing', async () => {
  for (const empty of ['', '\n', '  \n\n']) {
    for (const tail of [[], ['--attach', 'a.png']]) {
      expect(() => parseSuperTabArgs([...prefix, 'post', 'lead', '-', 'op-1', ...tail], where, () => empty, () => false))
        .toThrow("post - read no message from stdin, so nothing was posted. Send the message on stdin: post GROUP - OPERATION_ID <<'MSG'")
    }
  }
  // A terminal is never read: reading it would wait for input that never comes.
  const stdin = vi.fn(() => 'never read')
  expect(() => parseSuperTabArgs([...prefix, 'post', 'lead', '-', 'op-1'], where, stdin, () => true))
    .toThrow('post - reads the message from stdin, but stdin is a terminal, so nothing was posted.')
  expect(stdin).not.toHaveBeenCalled()
  const print = vi.fn(), close = vi.fn(), request = vi.fn(async () => ({ ok: true }))
  const deps = { where: () => where, pane: undefined, open: async () => ({ request, close, machineId: 'machine' }), print }
  expect(await superTabCommand([...prefix, 'post', 'lead', '-', 'op'], { ...deps, stdin: () => '', terminal: () => false })).toBe(1)
  expect(await superTabCommand([...prefix, 'post', 'lead', '-', 'op'], { ...deps, stdin, terminal: () => true })).toBe(1)
  expect(print.mock.calls.map(([line]) => JSON.parse(line).error)).toEqual([expect.stringContaining('read no message from stdin'), expect.stringContaining('stdin is a terminal')])
  expect(request).not.toHaveBeenCalled()
})
it('never reads stdin for a post whose TEXT is the message', () => {
  const stdin = vi.fn(() => 'from stdin'), terminal = vi.fn(() => false)
  for (const text of ['Ready', '--', '- ', ' -', '-x', '']) {
    const tail = text ? [] : ['--attach', 'a.png']
    expect(parseSuperTabArgs([...prefix, 'post', 'lead', text, 'op-1', ...tail], where, stdin, terminal).payload.command).toMatchObject({ text })
  }
  expect(stdin).not.toHaveBeenCalled()
  expect(terminal).not.toHaveBeenCalled()
})
// The server takes 32,000 characters of a post (backend `message.send`); a longer one it refused with a field message, and from 512 KiB the
// daemon's socket closed on it, so the agent was only told "The connection to Harness closed." (Q3, 2026-11-09). Said before anything is sent.
it('refuses a post or an answer of more than 32,000 characters with the length, before anything is sent, and takes 32,000', async () => {
  const exactly = 'x'.repeat(32_000)
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', exactly, 'op-1'], where).payload.command).toMatchObject({ text: exactly })
  // Counted as the server counts, once trimmed: a heredoc's line breaks and spaces around the words are no part of it.
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', `  ${exactly}\n\n`, 'op-1'], where).payload.command).toMatchObject({ text: `  ${exactly}\n\n` })
  const long = 'x'.repeat(32_001)
  const refusal = 'This post is 32,001 characters, and a post takes at most 32,000: nothing was posted. Say it shorter, or put the rest in a file or a pull request and post its link.'
  expect(() => parseSuperTabArgs([...prefix, 'post', 'lead', long, 'op-1'], where)).toThrow(refusal)
  expect(() => parseSuperTabArgs([...prefix, 'post', 'lead', long, 'op-1', '--attach', 'a.png'], where)).toThrow(refusal)
  expect(() => parseSuperTabArgs([...prefix, 'answer', 'lead', 'msg-1', long, 'op-2'], where)).toThrow(refusal)
  expect(() => parseSuperTabArgs([...prefix, 'post', 'lead', '-', 'op-3'], where, () => long, () => false)).toThrow(refusal)
  // From the command: the agent is told in the line it reads, and the daemon is never asked.
  const print = vi.fn(), request = vi.fn(), open = vi.fn(async () => ({ request, close: vi.fn(), machineId: 'machine' }))
  expect(await superTabCommand([...prefix, 'post', 'lead', '-', 'op-4'], { where: () => where, pane: undefined, open: open as never, print, stdin: () => 'y'.repeat(3_000_000), terminal: () => false })).toBe(1)
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toEqual({ error: 'This post is 3,000,000 characters, and a post takes at most 32,000: nothing was posted. Say it shorter, or put the rest in a file or a pull request and post its link.', operationId: 'op-4' })
  expect(open).not.toHaveBeenCalled()
})
// An interrupted post is repeated with the same id and the same stdin; stdin is read before anything is sent, so the repeat
// sends the same message under the same id, and the Swarm keeps one.
it('repeats an interrupted stdin post with the same id and text, and it posts once', async () => {
  const posted = new Map<string, unknown>(), print = vi.fn(), close = vi.fn()
  let lose = true
  const request = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
    if (type !== 'super_tabs') return { agents: [] }
    posted.set(String(payload.operationId), (payload.command as { text?: string }).text)
    if (lose) { lose = false; throw new Error('Connection lost') }
    return { ok: true }
  })
  const deps = { where: () => where, pane: undefined, open: async () => ({ request, close, machineId: 'machine' }), print, terminal: () => false }
  const stdin = vi.fn(() => "Verdict: it's fine\n")
  expect(await superTabCommand([...prefix, 'post', 'lead', '-', 'op-verdict'], { ...deps, stdin })).toBe(1)
  expect(JSON.parse(print.mock.calls.at(-1)![0])).toEqual({ error: 'Connection lost', operationId: 'op-verdict' })
  expect(await superTabCommand([...prefix, 'post', 'lead', '-', 'op-verdict'], { ...deps, stdin })).toBe(0)
  expect(stdin).toHaveBeenCalledTimes(2)
  const sent = request.mock.calls.filter(([type]) => type === 'super_tabs').map(([, payload]) => payload)
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual(sent[0])
  expect([...posted]).toEqual([['op-verdict', "Verdict: it's fine"]])
})
it('finds the native caller without requiring an ID in the initial launch prompt', async () => {
  const request = vi.fn(async (type: string) => type === 'agents_list'
    ? { agents: [{ id: 'native', engine: 'codex', tmuxPane: '%42', status: 'active' }] }
    : { ok: true })
  const close = vi.fn(), print = vi.fn()
  const deps = { where: () => where, pane: '%42', open: async () => ({ request, close, machineId: 'machine' }), print }
  expect(await superTabCommand(['--tab', 'tab', 'messages', 'lead'], deps)).toBe(0)
  expect(request).toHaveBeenLastCalledWith('super_tabs', expect.objectContaining({ harnessId: 'native' }), 30_000)
  expect(await superTabCommand(['--tab', 'tab', 'messages', 'lead'], { ...deps, pane: '%43' })).toBe(1)
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
it('has only status, messages, message, post, answer, screen and type: every other command is refused with the usage line, which offers no other, and nothing is asked of the daemon', async () => {
  const gone = [['mine'], ['task', 'g1'], ['decisions'], ['decisions', '--answered'], ['instructions'],
    ['instructions', 'p1'], ['costs'], ['costs', '--days', '30'], ['react', 'lead', 'msg-1', 'eyes', 'op-1'], ['command', 'op-1', '{"type":"work.assign"}'],
    ['propose', 'op-1', '{"goal":"x"}'], ['start', 'op-1', '{"engine":"codex"}'], ['resume', 'start-1'], ['capacity', 'machine-2', '{}'], ['remove-machine', 'box'],
    ['remove-machine', 'box', '--yes'], ['set-agents', 'studio', '96'], ['help'], ['help', 'tools'], ['plan'], ['route', 'g1', '{}']]
  for (const tail of gone) {
    expect(() => parseSuperTabArgs([...prefix, ...tail], where), tail.join(' ')).toThrow(/^harness super-tab \[--tab ID\]/)
    const print = vi.fn(), open = vi.fn()
    expect(await superTabCommand(['--tab', 'tab', ...tail], { where: () => where, pane: undefined, open: open as never, print }), tail.join(' ')).toBe(1)
    expect(open).not.toHaveBeenCalled()
    const refusal = String(JSON.parse(print.mock.calls.at(-1)![0]).error)
    expect(refusal).toMatch(/^harness super-tab \[--tab ID\] \[--agent ID\] \[--port N --machine ID\] status \[--project NAME\] \[--archived \[PAGE\]\] \| messages GROUP /)
    expect(refusal).not.toMatch(/\b(mine|task|decisions|instructions|costs|react|command|propose|start|resume|capacity|remove-machine|set-agents|help|plan|route)\b/)
  }
})
it('posts a reply to one message with --reply-to, and rejects a bad id', () => {
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', 'Ready', 'op-1', '--reply-to', 'msg-1'], where).payload.command)
    .toMatchObject({ type: 'message.send', conversationId: 'lead', text: 'Ready', replyTo: 'msg-1' })
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', 'Ready', 'op-1'], where).payload.command).toMatchObject({ replyTo: null })
  for (const tail of [['--reply-to'], ['--reply-to', '../x'], ['--reply-to', ''], ['--reply-to', 'a', 'b'], ['--reply', 'a']]) {
    expect(() => parseSuperTabArgs([...prefix, 'post', 'lead', 'Ready', 'op-1', ...tail], where)).toThrow('harness super-tab')
  }
})
// Answers go right below, not in a thread (anh Dee, 2026-11-04; task #2929).
it('posts an answer right below one message with --answers, never with --reply-to too', () => {
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', 'Ready', 'op-1', '--answers', 'msg-1', '--to', 'a1'], where).payload.command)
    .toEqual({ type: 'message.send', conversationId: 'lead', text: 'Ready', replyTo: null, answers: 'msg-1', recipientIds: ['a1'] })
  expect(parseSuperTabArgs([...prefix, 'post', 'lead', 'Ready', 'op-1'], where).payload.command).not.toHaveProperty('answers')
  for (const tail of [['--answers'], ['--answers', '../x'], ['--answers', 'a', '--answers', 'b'], ['--answers', 'a', '--reply-to', 'b'], ['--reply-to', 'b', '--answers', 'a']]) {
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
  const { mkdtempSync, writeFileSync, rmSync, truncateSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'super-tab-attach-'))
  try {
    writeFileSync(join(dir, 'shot.png'), Buffer.from([1, 2, 3]))
    // Sparse: past the 256 MB limit without taking the room.
    writeFileSync(join(dir, 'big.bin'), '')
    truncateSync(join(dir, 'big.bin'), 256 * 1024 * 1024 + 1)
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
    expect(JSON.parse(deps.print.mock.calls.at(-1)![0]).error).toBe(`big.bin is over the 256 MB limit (${256 * 1024 * 1024 + 1} bytes).`)
    // Refused before any request: not even the check for an earlier send.
    expect(calls.map(c => c.step ?? c.action)).toEqual(['sent'])
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
// Project instructions, phase 1: an agent names the agents a post reaches (task #2963: with none, the server reaches no PM).
it('passes each --to as a recipient, at most 16, and keeps a post without one unnamed', () => {
  expect(parseSuperTabArgs([...prefix, 'post', 'g1', 'Ready', 'op-1', '--to', 'a1', '--to', 'a2', '--to', 'a1'], where).payload.command)
    .toMatchObject({ type: 'message.send', conversationId: 'g1', recipientIds: ['a1', 'a2'] })
  expect(parseSuperTabArgs([...prefix, 'post', 'g1', 'Ready', 'op-1'], where).payload.command).toMatchObject({ recipientIds: [] })
  expect(() => parseSuperTabArgs([...prefix, 'post', 'g1', 'Ready', 'op-1', '--to'], where)).toThrow('harness super-tab')
  const many = Array.from({ length: 17 }, (_, i) => ['--to', `a${i}`]).flat()
  expect(() => parseSuperTabArgs([...prefix, 'post', 'g1', 'Ready', 'op-1', ...many], where)).toThrow('harness super-tab')
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

// Security review of #2087: --agent naming a Builder let a Buddy on the same machine speak as it. The harness the command
// runs in goes with every request, and the daemon holds the agent named to that harness's own (service.spec.ts).
it('sends the pane\'s own harness with every --agent request, so the agent it names is checked against it', async () => {
  const request = vi.fn(async (type: string) => type === 'agents_list'
    ? { agents: [{ id: 'buddy-harness', engine: 'claude', tmuxPane: '%42', status: 'active' }] } : { ok: true })
  const deps = { where: () => where, pane: '%42', open: async () => ({ request, close: vi.fn(), machineId: 'machine' }), print: vi.fn() }
  for (const argv of [['post', 'g1', 'Ready', 'op'], ['message', 'g1', 'm1'], ['messages', 'g1']]) {
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
  expect(await superTabCommand(['--tab', 'tab', '--agent', 'builder', 'messages', 'g1'], { ...deps, env: {} })).toBe(0)
  const sent = request.mock.calls.at(-1) as unknown as [string, Record<string, unknown>]
  expect(sent[1]).toMatchObject({ action: 'messages', agentId: 'builder' })
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
    expect(await superTabCommand([...flags, '--tab', 'tab', '--agent', 'builder', 'messages', 'g1'], { ...deps, pane: '%42' })).toBe(1)
    expect(JSON.parse(print.mock.calls.at(-1)![0]).error)
      .toBe('From a harness, Swarm commands go to this computer\'s own Harness only: leave out --machine and --port, or give this computer\'s own.')
    // Only this computer's daemon was asked which harness the pane is.
    expect(opened).toEqual([where])
  }
  // This computer's own values, as the delivered instructions write them.
  expect(await superTabCommand(['--port', '14001', '--machine', 'machine', '--tab', 'tab', '--agent', 'builder', 'messages', 'g1'], { ...deps, pane: '%42' })).toBe(0)
  // A pane that is no harness's, and a terminal outside tmux: the person's choice.
  for (const pane of ['%9', undefined]) {
    opened.length = 0
    expect(await superTabCommand(['--machine', 'macbook', '--tab', 'tab', '--agent', 'builder', 'messages', 'g1'], { ...deps, pane })).toBe(0)
    expect(opened.at(-1)).toMatchObject({ machineId: 'macbook' })
  }
})
// Windows' parents, as `harness-pty ps` lists them: this command under pane process 700, under the PTY host.
const windowsPane = async () => [
  { pid: process.pid, parentPid: 700, executable: 'node.exe', startMarker: 'w:30', args: '' },
  { pid: 700, parentPid: 600, executable: 'claude.exe', startMarker: 'w:20', args: '' },
  { pid: 600, parentPid: 1, executable: 'harness-pty.exe', startMarker: 'w:10', args: '' },
]
const windowsAlone = async () => [{ pid: process.pid, parentPid: 1, executable: 'node.exe', startMarker: 'w:30', args: '' }]
// A Buddy on the computer used to refuse every agent's shell there (second review, item 4). Now each is told apart by its pane.
it('on Windows, a Buddy on the computer refuses no other agent, and a pane speaks as its own harness', async () => {
  const request = vi.fn(async (type: string, payload: Record<string, unknown> = {}) => type === 'agents_list'
    ? { agents: [{ id: 'win-harness', engine: 'claude', tmuxPane: '%3', status: 'active', terminal: { runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: '%3' }] } }] }
    : type === 'terminal_info' ? { command: 'claude', path: 'C:\\work', pid: 700 }
    : payload.action === 'buddyCheck' ? { ok: true, buddiesHere: true } : { ok: true })
  const print = vi.fn()
  const deps = { where: () => where, print, platform: 'win32' as const, open: async () => ({ request, close: vi.fn(), machineId: 'machine' }) }
  expect(await superTabCommand([...prefix, 'messages', 'g1'], { ...deps, env: { HARNESS_PANE: 'p1:%3' }, readProcesses: windowsPane })).toBe(0)
  expect(request).toHaveBeenLastCalledWith('super_tabs', expect.objectContaining({ harnessId: 'win-harness' }), 30_000)
  // Outside Harness: an agent's shell and a person's terminal alike, with its --agent.
  for (const env of [{ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' }, {}]) {
    expect(await superTabCommand([...prefix, 'messages', 'g1'], { ...deps, env, readProcesses: windowsAlone })).toBe(0)
  }
})
// As a private tmux server's pane on a Mac: a command may not name a pane on Windows that its parents are not in.
it('on Windows, refuses a command naming another harness\'s pane, and one under the PTY host naming none', async () => {
  const request = vi.fn(async (type: string) => type === 'agents_list'
    ? { agents: [{ id: 'builder', engine: 'claude', tmuxPane: '%9', status: 'active', terminal: { runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: '%9' }] } }] }
    : type === 'terminal_info' ? { command: 'claude', path: 'C:\\work', pid: 555 } : { ok: true })
  const print = vi.fn()
  const deps = { where: () => where, print, platform: 'win32' as const, open: async () => ({ request, close: vi.fn(), machineId: 'machine' }) }
  expect(await superTabCommand(['--tab', 'tab', 'messages', 'g1'], { ...deps, env: { HARNESS_PANE: 'p1:%9' }, readProcesses: windowsPane })).toBe(1)
  expect(JSON.parse(print.mock.calls.at(-1)![0]).error)
    .toBe('This command does not run in the Harness pane it names, so it did not run. Run it as your harness gave it, in its own pane.')
  expect(await superTabCommand(['--tab', 'tab', 'messages', 'g1'], { ...deps, env: {}, readProcesses: windowsPane })).toBe(1)
  expect(JSON.parse(print.mock.calls.at(-1)![0]).error)
    .toBe('Harness could not tell which pane this command runs in, so it did not run it. Run it as your harness gave it, in its own pane.')
  expect(request.mock.calls.some(([type]) => type === 'super_tabs')).toBe(false)
})
// The re-check of #2093 (minor 6): a pty host pane was no pane for the other-machine refusal, and --machine asked the other
// machine's daemon about this computer.
it('on Windows, refuses another machine from a harness\'s pane, asking this computer\'s daemon', async () => {
  const opened: Where[] = []
  const request = vi.fn(async (type: string) => type === 'agents_list'
    ? { agents: [{ id: 'win-harness', engine: 'claude', tmuxPane: '%3', status: 'active', terminal: { runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: '%3' }] } }] }
    : { ok: true })
  const print = vi.fn()
  const deps = { where: () => where, print, platform: 'win32' as const,
    open: async (to: Where) => { opened.push(to); return { request, close: vi.fn(), machineId: to.machineId } as never } }
  expect(await superTabCommand(['--machine', 'macbook', ...prefix, 'messages', 'g1'], { ...deps, env: { HARNESS_PANE: 'p1:%3' }, readProcesses: windowsPane })).toBe(1)
  expect(JSON.parse(print.mock.calls.at(-1)![0]).error).toContain('this computer\'s own Harness only')
  expect(opened).toEqual([where])
  // A person's terminal chooses its machine.
  opened.length = 0
  expect(await superTabCommand(['--machine', 'macbook', ...prefix, 'messages', 'g1'], { ...deps, env: {}, readProcesses: windowsAlone })).toBe(0)
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
  for (const argv of [['--tab', 'tab', 'messages', 'g1'], ['--tab', 'tab', '--agent', 'builder', 'post', 'g1', 'Ready', 'op']]) {
    expect(await superTabCommand(argv, deps)).toBe(1)
    expect(JSON.parse(print.mock.calls.at(-1)![0]).error)
      .toBe('This command does not run in the Harness pane it names, so it did not run. Run it as your harness gave it, in its own pane.')
  }
  expect(request.mock.calls.some(([type]) => type === 'super_tabs')).toBe(false)
  // The daemon's own pane: the harness goes with the request.
  panePid = 700
  expect(await superTabCommand(['--tab', 'tab', 'messages', 'g1'], deps)).toBe(0)
  expect(request).toHaveBeenCalledWith('terminal_info', { agentId: 'builder-harness' }, 10_000)
  expect(request).toHaveBeenLastCalledWith('super_tabs', expect.objectContaining({ harnessId: 'builder-harness' }), 30_000)
})

// A Buddy's read verbs (Ken, 10-29): archived tasks a page at a time, and a task's older messages, with no new verb.
it('parses archived status pages and older message pages', () => {
  const at = ['--tab', 'tab']
  expect(parseSuperTabArgs([...at, 'status', '--archived'], where).payload).toMatchObject({ action: 'status', archived: true })
  expect(parseSuperTabArgs([...at, 'status', '--archived', 'eyJsYSI6MX0'], where).payload).toMatchObject({ action: 'status', archived: true, before: 'eyJsYSI6MX0' })
  // By sequence and message id together: messages may share a sequence, and a sequence alone skipped them (security review 2).
  expect(parseSuperTabArgs([...at, 'messages', 'lead', '--before', '40', 'm-1'], where).payload).toMatchObject({ action: 'messages', conversationId: 'lead', before: 40, beforeId: 'm-1' })
  for (const argv of [['status', '--archived', 'a b'], ['status', '--old'], ['messages', 'lead', '--before', '-1', 'm-1'], ['messages', 'lead', '--before', 'x', 'm-1'],
    ['messages', 'lead', '--before', '40'], ['messages', 'lead', '--before', '9007199254740992', 'm-1'], ['messages', 'lead', '--before', '40', 'a b'], ['messages', 'lead', '--after', '4', 'm-1']]) {
    expect(() => parseSuperTabArgs([...at, ...argv], where)).toThrow('harness super-tab')
  }
})

// Spec 2026-10-31-one-buddy-per-swarm: a person's one Buddy reads one of its projects by name, alone or with its archive.
it('parses status --project NAME, alone or with --archived, and refuses it without a name', () => {
  expect(parseSuperTabArgs([...prefix, 'status', '--project', 'Web App'], where).payload).toMatchObject({ action: 'status', project: 'Web App' })
  expect(parseSuperTabArgs([...prefix, 'status', '--project', 'web', '--archived'], where).payload).toMatchObject({ action: 'status', project: 'web', archived: true })
  expect(parseSuperTabArgs([...prefix, 'status', '--archived', 'eyJsYSI6MX0', '--project', 'web'], where).payload)
    .toMatchObject({ action: 'status', project: 'web', archived: true, before: 'eyJsYSI6MX0' })
  expect(parseSuperTabArgs([...prefix, 'status'], where).payload).not.toHaveProperty('project')
  for (const argv of [['status', '--project'], ['status', '--project', 'a\nb'], ['messages', 'lead', '--project', 'web']]) {
    expect(() => parseSuperTabArgs([...prefix, ...argv], where)).toThrow('harness super-tab')
  }
})

// A Buddy's thread session reads its own thread (spec 2026-10-30-buddy-thread-sessions), paged as the conversation is.
it('parses one thread\'s messages, and its older pages', () => {
  const at = ['--tab', 'tab']
  expect(parseSuperTabArgs([...at, 'messages', 'chat', '--thread', 'root-1'], where).payload).toMatchObject({ action: 'messages', conversationId: 'chat', thread: 'root-1' })
  expect(parseSuperTabArgs([...at, 'messages', 'chat', '--thread', 'root-1', '--before', '40', 'm-1'], where).payload)
    .toMatchObject({ action: 'messages', conversationId: 'chat', thread: 'root-1', before: 40, beforeId: 'm-1' })
  for (const argv of [['messages', 'chat', '--thread'], ['messages', 'chat', '--thread', 'a b'], ['messages', 'chat', '--thread', '../x'],
    ['messages', 'chat', '--thread', 'root-1', '--before', '40'], ['messages', 'chat', '--thread', 'root-1', 'extra'],
    ['messages', 'chat', '--thread', 'root-1', '--before', 'x', 'm-1']]) {
    expect(() => parseSuperTabArgs([...at, ...argv], where)).toThrow('harness super-tab')
  }
})

// #2360 took the stdin form out of a Buddy's help, as its guard refuses a post read from stdin (#2358). The usage line still
// offered it, so a Buddy that followed it was refused and tried again.
describe("a Buddy's usage line", () => {
  const buddyDeps = (buddy: boolean | 'fails') => {
    const asked: Array<[string, Record<string, unknown> | undefined, number]> = [], opened: Where[] = []
    const request = vi.fn(async (type: string, payload?: Record<string, unknown>) => {
      asked.push([type, payload, opened.length])
      if (type === 'agents_list') return { agents: [{ id: 'buddy-h', engine: 'claude', tmuxPane: '%9', status: 'active' }] }
      if (payload?.action === 'buddyCheck') {
        if (buddy === 'fails') throw new Error('daemon gone')
        return { ok: true, buddy }
      }
      return { ok: true }
    })
    const print = vi.fn()
    const open = vi.fn(async (at: Where) => { opened.push(at); return { request, close: vi.fn(), machineId: 'machine' } })
    const run = async (argv: string[], terminal = false) => {
      expect(await superTabCommand(['--tab', 'tab', ...argv], { where: () => where, pane: '%9', open, print, terminal: () => terminal })).toBe(1)
      return JSON.parse(print.mock.calls.at(-1)![0]).error as string
    }
    return { run, asked, opened, request }
  }
  it('has no stdin form for a Buddy: its post line takes TEXT', async () => {
    const { run } = buddyDeps(true)
    const error = await run(['post', 'lead', 'Ready'])
    expect(error).toContain('post GROUP TEXT OPERATION_ID [--to AGENT]... [--answers MESSAGE_ID | --reply-to')
    expect(error).not.toMatch(/stdin|TEXT\|-|<<| - /)
  })

  it('keeps the stdin form for any other agent, and for a harness Harness cannot confirm is a Buddy', async () => {
    for (const buddy of [false, 'fails'] as const) {
      const { run } = buddyDeps(buddy)
      expect(await run(['post', 'lead', 'Ready'])).toContain('post GROUP TEXT|- OPERATION_ID')
    }
  })

  it("asks this computer's daemon about the pane's own harness, only when the command is refused", async () => {
    const { run, asked, opened } = buddyDeps(true)
    await run(['post', 'lead', 'Ready'])
    expect(asked.find(([, payload]) => payload?.action === 'buddyCheck')?.[1]).toEqual({ action: 'buddyCheck', harnessId: 'buddy-h' })
    // Through the guard's own steps (paneBuddy), without its pane check: a wording is no refusal.
    expect(asked.map(([type]) => type)).toEqual(['agents_list', 'super_tabs'])
    // Another machine named with --machine is never the one asked: the pane is this computer's.
    expect(await run(['--port', '14002', '--machine', 'other', 'post', 'lead', 'Ready'])).toContain('post GROUP TEXT OPERATION_ID')
    expect(opened).toEqual([where, where])
    // A command that parses never asks.
    const ok = buddyDeps(true)
    await superTabCommand(['--tab', 'tab', 'post', 'lead', 'Ready', 'op-1'], { where: () => where, pane: '%9', open: async () => ({ request: ok.request, close: vi.fn(), machineId: 'machine' }), print: vi.fn() })
    expect(ok.request).toHaveBeenCalled()
    expect(ok.asked.some(([, payload]) => payload?.action === 'buddyCheck')).toBe(false)
  })
  it('words it for a Buddy on Windows from a Buddy\'s own pane alone', async () => {
    const wording = async (buddy: boolean) => {
      const print = vi.fn(), request = vi.fn(async (type: string, payload?: Record<string, unknown>) =>
        payload?.action === 'buddyCheck' ? { ok: true, buddy }
        : type === 'agents_list' ? { agents: [{ id: 'win-harness', engine: 'claude', tmuxPane: '%3', status: 'active', terminal: { runtimes: [{ backend: 'ptyhost', instance: 'p1', paneId: '%3' }] } }] } : { ok: true })
      await superTabCommand(['--tab', 'tab', 'post', 'lead', 'Ready'], { where: () => where, print, platform: 'win32', env: {}, pane: 'p1:%3',
        open: async () => ({ request, close: vi.fn(), machineId: 'machine' }) })
      return JSON.parse(print.mock.calls.at(-1)![0]).error as string
    }
    expect(await wording(true)).toContain('post GROUP TEXT OPERATION_ID')
    expect(await wording(false)).toContain('post GROUP TEXT|- OPERATION_ID')
  })
})

// #2355: post - read stdin with no limit, so a pipe left open and idle waited for good.
describe('stdin for -', () => {
  afterEach(() => { vi.useRealTimers() })
  it('refuses an open stdin that sends nothing for 30 s, and lets go of it', async () => {
    vi.useFakeTimers()
    const stream = new PassThrough()
    const read = readStdin(stream).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(stream.destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await read).toBeInstanceOf(StdinIdle)
    expect(stream.destroyed).toBe(true)
  })

  it('reads a slow, steady stream whole, however long it takes, and refuses one that stalls part way', async () => {
    vi.useFakeTimers()
    const stream = new PassThrough()
    const read = readStdin(stream)
    for (let line = 0; line < 20; line++) { stream.write(`line ${line}\n`); await vi.advanceTimersByTimeAsync(29_000) }
    stream.end('last')
    expect(await read).toBe(Array.from({ length: 20 }, (_, line) => `line ${line}\n`).join('') + 'last')
    const stalled = new PassThrough()
    const partial = readStdin(stalled).catch((error: Error) => error)
    stalled.write('{"type":')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await partial).toBeInstanceOf(StdinIdle)
  })

  it('says how to end stdin for a post, and sends nothing', async () => {
    const print = vi.fn(), request = vi.fn(async () => ({ ok: true }))
    const deps = { where: () => where, pane: undefined, open: async () => ({ request, close: vi.fn(), machineId: 'machine' }), print, terminal: () => false,
      stdin: () => Promise.reject(new StdinIdle()) }
    expect(await superTabCommand([...prefix, 'post', 'lead', '-', 'op-1'], deps)).toBe(1)
    expect(JSON.parse(print.mock.calls.at(-1)![0]).error).toBe("post - read stdin until nothing more came for 30 s, but stdin was never closed, so nothing was posted. "
      + "Close stdin after the message, as a heredoc does: post GROUP - OPERATION_ID <<'MSG' (the message on the next lines, then MSG alone on a line), or pass it as TEXT.")
    expect(request).not.toHaveBeenCalled()
    // What arrives in time is used as before, read once.
    const stdin = vi.fn(async () => 'Ready\n')
    expect(await superTabCommand([...prefix, 'post', 'lead', '-', 'op-3'], { ...deps, stdin })).toBe(0)
    expect(stdin).toHaveBeenCalledOnce()
    expect(request).toHaveBeenLastCalledWith('super_tabs', expect.objectContaining({ operationId: 'op-3', command: expect.objectContaining({ type: 'message.send', text: 'Ready' }) }), 30_000)
  })
})

// Task #3403: the PM answers each ask once, in its place. `answer` names the message; the server places it in that message's
// thread or right below it, and refuses a second answer with where the first is.
it('sends answer as the answer to a message, placed by the server', () => {
  expect(parseSuperTabArgs([...prefix, 'answer', 'lead', 'ask-1', 'Out at 09:00.', 'op-1'], where).payload).toMatchObject({ action: 'command', operationId: 'op-1',
    command: { type: 'message.send', conversationId: 'lead', text: 'Out at 09:00.', replyTo: null, answers: 'ask-1', answer: true, recipientIds: [] } })
  expect(parseSuperTabArgs([...prefix, 'answer', 'lead', 'ask-1', '-', 'op-2', '--to', 'dev'], where, () => 'From stdin\n', () => false).payload.command)
    .toMatchObject({ text: 'From stdin', recipientIds: ['dev'] })
  for (const argv of [['answer', 'lead', 'ask-1', 'Text'], ['answer', 'lead', '../x', 'Text', 'op'], ['answer', 'lead', 'ask-1', '  ', 'op'],
    ['answer', 'lead', 'ask-1', 'Text', 'op', '--reply-to', 'm1']]) {
    expect(() => parseSuperTabArgs([...prefix, ...argv], where)).toThrow('harness super-tab')
  }
})

