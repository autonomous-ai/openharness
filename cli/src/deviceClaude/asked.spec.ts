/**
 * The permission hook's client: it tells the daemon that a prompt waits, in six typed fields, and decides nothing. What it
 * cannot read is nothing sent, and nothing the daemon answers is read. Every daemon here is a listener on a throwaway
 * socket or port.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseObservedHook } from '../core/observedHook.js'
import { hookTokenPath } from '../lib/hookAuth.js'
import { unixSocketPath } from '../lib/localSocket.js'
import { askedSummary, daemonPost, runAsked, type AskedBody } from './asked.js'

/** Names the daemon's socket only: every daemon here listens on a socket in a throwaway folder, or on a port of its own. */
const PORT = 4997

const cleanup: Array<() => unknown> = []
afterEach(async () => {
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

/** A post that records each body. */
function recording() {
  const bodies: AskedBody[] = []
  return { bodies, post: async (body: AskedBody) => { bodies.push(body) } }
}

type Seen = { url?: string; headers: IncomingHttpHeaders; body: string }

/** A daemon at [at] (a socket path, or 0 for a port of its own) that hears each request whole, then [answer]s it. */
async function listener(at: string | 0, answer: (res: ServerResponse) => void) {
  const seen: Seen[] = []
  let heard!: () => void
  const first = new Promise<void>((resolve) => { heard = resolve })
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body }); heard(); answer(res) })
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
  const dataDir = folder('as-')
  const daemon = await listener(unixSocketPath(dataDir, PORT)!, answer)
  return { ...daemon, dataDir, post: daemonPost(dataDir, PORT) }
}

const answers = (status: number, body: string) => (res: ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

const BODY: AskedBody = { engine: 'claude', sessionId: 'sess-1', event: 'asked', tool: 'Bash', summary: 'npm test', cwd: '/repo' }

describe('askedSummary', () => {
  it.each([
    ['Bash', { command: 'npm test', description: 'Run the tests' }, 'npm test'],
    ['Bash', { command: 'git add -A\ngit commit -m "wip"\ngit push' }, 'git add -A …'],
    ['Bash', { command: '\n  rm -rf build  \r\nls' }, 'rm -rf build …'],
    ['Bash', { command: '\n  npm test  \r\n\n' }, 'npm test'],
    ['Edit', { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' }, '/repo/src/app.ts'],
    ['Write', { file_path: '/repo/notes.md', content: 'hello' }, '/repo/notes.md'],
    ['Read', { file_path: '/repo/README.md' }, '/repo/README.md'],
    ['NotebookEdit', { notebook_path: '/repo/analysis.ipynb', new_source: 'x = 1' }, '/repo/analysis.ipynb'],
    ['WebFetch', { url: 'https://docs.example.com/guide/start?lang=en&key=abc#top', prompt: 'Summarize' }, 'docs.example.com'],
    ['mcp__github__create_issue', { title: 'A bug' }, 'github: create_issue'],
    ['mcp__claude_ai_Claude_Docs__batch', {}, 'claude_ai_Claude_Docs: batch'],
    ['Glob', { pattern: '**/*.ts' }, 'Glob'],
    ['Task', { description: 'Explore', prompt: 'Find the bug' }, 'Task'],
    ['Bash', {}, 'Bash'],
    ['Bash', { command: ' \n ' }, 'Bash'],
    ['Edit', { file_path: 7 }, 'Edit'],
    ['WebFetch', { url: 'not a url' }, 'WebFetch'],
    ['WebFetch', { url: 'file:///etc/passwd' }, 'WebFetch'],
    ['Read', null, 'Read'],
    ['Read', 'a string', 'Read'],
  ])('the summary per tool: %s %j is %j', (tool, input, summary) => {
    expect(askedSummary(tool, input)).toBe(summary)
  })

  it('cuts 300 bytes of multi-byte text to at most 200 on a character', () => {
    expect(askedSummary('Bash', { command: '日'.repeat(100) })).toBe('日'.repeat(66))
    // 2 + 49 × 4 = 198: the 50th emoji would make 202.
    const emoji = askedSummary('Read', { file_path: `ab${'😀'.repeat(75)}` })
    expect(emoji).toBe(`ab${'😀'.repeat(49)}`)
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(200)
  })

  it('a tab or a newline in the summary becomes a space, as does every other control character', () => {
    expect(askedSummary('Read', { file_path: '/repo/a\tb\nc\u0007d\u007fe\u0085f' })).toBe('/repo/a b c d e f')
  })
})

describe('runAsked', () => {
  it.each(['AskUserQuestion', 'ExitPlanMode'])('sends nothing for %s', async (tool) => {
    const daemon = recording()
    expect(await runAsked({ stdin: chunks(hookInput({ tool_name: tool, tool_input: {} })), post: daemon.post })).toBe(0)
    expect(daemon.bodies).toEqual([])
  })

  it('sends nothing for 256 KB + 1 of stdin, and sends 256 KB', async () => {
    const padded = (bytes: number) => {
      const text = hookInput({ pad: 'x'.repeat(bytes - Buffer.byteLength(hookInput({ pad: '' }))) })
      expect(Buffer.byteLength(text)).toBe(bytes)
      const half = Buffer.from(text)
      return chunks(half.subarray(0, 100_000), half.subarray(100_000))
    }
    const over = recording()
    expect(await runAsked({ stdin: padded(256 * 1024 + 1), post: over.post })).toBe(0)
    expect(over.bodies).toEqual([])
    const whole = recording()
    expect(await runAsked({ stdin: padded(256 * 1024), post: whole.post })).toBe(0)
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
  ])('sends nothing for %s', async (_case, stdin) => {
    const daemon = recording()
    expect(await runAsked({ stdin: chunks(stdin), post: daemon.post })).toBe(0)
    expect(daemon.bodies).toEqual([])
  })

  it('reads stdin in strings as in buffers', async () => {
    const daemon = recording()
    const text = hookInput()
    expect(await runAsked({ stdin: chunks(text.slice(0, 10), Buffer.from(text.slice(10))), post: daemon.post })).toBe(0)
    expect(daemon.bodies).toEqual([BODY])
  })

  it('always exits 0: a post that throws, stdin that fails', async () => {
    expect(await runAsked({ stdin: chunks(hookInput()), post: async () => { throw new Error('boom') } })).toBe(0)
    async function* failing(): AsyncIterable<Buffer> { yield Buffer.from('{'); throw new Error('EIO') }
    expect(await runAsked({ stdin: failing(), post: recording().post })).toBe(0)
  })

  it('cuts a tool name over 64 characters to 64, and summarizes it whole', async () => {
    const tool = `mcp__server__${'t'.repeat(70)}`
    const daemon = recording()
    await runAsked({ stdin: chunks(hookInput({ tool_name: tool, tool_input: {} })), post: daemon.post })
    expect(daemon.bodies).toEqual([{ ...BODY, tool: tool.slice(0, 64), summary: `server: ${'t'.repeat(70)}` }])
  })

  it('the rest of tool_input is not sent, and a cwd that is missing or not a string is left out', async () => {
    const daemon = recording()
    const secret = 'API_KEY=sk-live-0123456789'
    await runAsked({ stdin: chunks(hookInput({ tool_name: 'Write', tool_input: { file_path: '/repo/.env', content: secret } })), post: daemon.post })
    await runAsked({ stdin: chunks(hookInput({ cwd: undefined })), post: daemon.post })
    await runAsked({ stdin: chunks(hookInput({ cwd: 7 })), post: daemon.post })
    const { cwd: _cwd, ...noCwd } = BODY
    expect(daemon.bodies).toStrictEqual([{ ...BODY, tool: 'Write', summary: '/repo/.env' }, noCwd, noCwd])
    expect(JSON.stringify(daemon.bodies)).not.toContain('sk-live')
  })

  // The core refuses a whole event with a cwd it cannot hold (core/observedHook.ts): it goes without one.
  it.each([
    ['of 1025 characters', `/${'d'.repeat(1024)}`],
    ['with a newline', '/repo\n/other'],
    ['with a tab', '/repo\tx'],
  ])('a cwd %s is left out, and the rest is still sent', async (_case, cwd) => {
    const daemon = recording()
    await runAsked({ stdin: chunks(hookInput({ cwd })), post: daemon.post })
    const { cwd: _cwd, ...noCwd } = BODY
    expect(daemon.bodies).toStrictEqual([noCwd])
  })

  // The core's own check (core/observedHook.ts): an event it refused would show nothing on the dial.
  it('the core takes every body it sends, at each bound', async () => {
    const daemon = recording()
    await runAsked({ stdin: chunks(hookInput({ tool_name: `mcp__s__${'t'.repeat(80)}`, tool_input: {}, cwd: `/${'d'.repeat(1023)}` })), post: daemon.post })
    await runAsked({ stdin: chunks(hookInput({ tool_input: { command: `${'日'.repeat(100)}\nls` } })), post: daemon.post })
    await runAsked({ stdin: chunks(hookInput({ tool_name: 'Read', tool_input: { file_path: '/a\tb\u0085c' }, cwd: undefined })), post: daemon.post })
    expect(daemon.bodies).toHaveLength(3)
    for (const body of daemon.bodies) expect(parseObservedHook(body)).toStrictEqual(body)
  })

  it('a cwd of 1024 characters is sent', async () => {
    const daemon = recording()
    const cwd = `/${'d'.repeat(1023)}`
    await runAsked({ stdin: chunks(hookInput({ cwd })), post: daemon.post })
    expect(daemon.bodies).toStrictEqual([{ ...BODY, cwd }])
  })
})

describe('daemonPost', () => {
  it('writes the body to /api/hook/observed over the socket, with no credential', async () => {
    const daemon = await socketDaemon(answers(200, '{"ok":true}'))
    await daemon.post(BODY)
    await daemon.first
    expect(daemon.seen).toHaveLength(1)
    expect(daemon.seen[0].url).toBe('/api/hook/observed')
    expect(JSON.parse(daemon.seen[0].body)).toEqual(BODY)
    expect(daemon.seen[0].headers['x-harness-hook-token']).toBeUndefined()
    expect(existsSync(hookTokenPath(daemon.dataDir))).toBe(false)
  })

  // It waits for the request to be written, never for the answer: whatever the daemon holds or says, the prompt is the app's.
  it('is done once written, from a daemon that never answers', async () => {
    const daemon = await socketDaemon(() => {})
    const started = Date.now()
    await daemon.post(BODY)
    expect(Date.now() - started).toBeLessThan(1_000)
    await daemon.first
    expect(JSON.parse(daemon.seen[0].body)).toEqual(BODY)
  })

  it('a daemon that is not running is done at once', async () => {
    await expect(daemonPost(folder('as-'), PORT)(BODY)).resolves.toBeUndefined()
  })

  it('the posted body never carries ORCA_PAIRING_CODE, ORCA_AGENT_SESSION_SPAWN_TOKEN or any other environment variable', async () => {
    vi.stubEnv('ORCA_PAIRING_CODE', 'pairing-4f1e9c')
    vi.stubEnv('ORCA_AGENT_SESSION_SPAWN_TOKEN', 'spawn-8b2d7a')
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_0b7e4a2c-1d3f-4e5a-8b9c-0d1e2f3a4b5c')
    vi.stubEnv('HARNESS_ASKED_MARKER', 'marker-3c6a5e')
    const daemon = await socketDaemon(answers(200, '{"ok":true}'))
    await runAsked({ stdin: chunks(hookInput()), post: daemon.post })
    await daemon.first
    expect(daemon.seen).toHaveLength(1)
    expect(JSON.parse(daemon.seen[0].body)).toEqual(BODY)
    for (const value of ['pairing-4f1e9c', 'spawn-8b2d7a', 'term_0b7e4a2c', 'marker-3c6a5e']) {
      expect(JSON.stringify(daemon.seen[0])).not.toContain(value)
    }
  })

  // Over the port anyone holding it while the daemon restarts would hear the prompt (audit H1). A data folder and a home too
  // long for a socket leave only the port, so nothing is sent.
  it('sends nothing and creates no hook token where there is no socket', async () => {
    const dir = folder('as-')
    const dataDir = join(dir, 'd'.repeat(100))
    mkdirSync(dataDir, { mode: 0o700 })
    vi.stubEnv('HOME', join(dir, 'h'.repeat(100)))
    const overPort = await listener(0, answers(200, '{"ok":true}'))
    expect(unixSocketPath(dataDir, overPort.port)).toBeNull()
    await runAsked({ stdin: chunks(hookInput()), post: daemonPost(dataDir, overPort.port) })
    expect(overPort.seen).toEqual([])
    expect(existsSync(hookTokenPath(dataDir))).toBe(false)
  })
})
