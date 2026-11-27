/**
 * `harness device claude asked`: the client Claude Code's PermissionRequest hook runs (plugins/harness-device). It tells
 * the daemon that a prompt waits, so the dial shows the agent waiting and for what, and decides nothing: it prints nothing
 * and reads no answer, so nothing the daemon or anyone holding its socket sends can become a decision. The prompt is
 * answered in the app it is in (docs/specs/2026-11-13-device-claude-orca.md, after the dial check).
 *
 * Every waiting prompt is told: a permission ask by what the tool acts on, a question form by its first question, and a
 * plan approval by fixed words, its plan never read (docs/plans/2026-11-26-needs-you-right-design.md, Part 6).
 *
 * What leaves this process is six typed fields. The tool input is cut to a one-line summary here, so the rest of it (a
 * file's content, a whole script) never reaches the daemon. No environment variable is sent: Orca puts
 * ORCA_PAIRING_CODE and ORCA_AGENT_SESSION_SPAWN_TOKEN in the same environment. This file runs only in the `harness`
 * command's own process.
 */
import { request } from 'node:http'
import { daemonFetch, localSocketRoute } from '../lib/localTransport.js'
import { WINDOWS_PS_TIMEOUT_MS } from '../lib/windows/processTable.js'

export interface AskedBody {
  engine: 'claude' | 'codex'
  sessionId: string
  event: 'asked'
  tool: string
  summary: string
  cwd?: string
}

export interface AskedDeps {
  stdin: AsyncIterable<Buffer | string>
  /** Hands the body to the daemon, done once it is written or cannot be. */
  post(body: AskedBody): Promise<void>
}

const MAX_STDIN_BYTES = 256 * 1024
/** The core's bounds (core/observedHook.ts): an event with a longer field is refused whole. */
export const MAX_TOOL_CHARS = 64
const MAX_SUMMARY_BYTES = 200
const MAX_CWD_CHARS = 1024
/**
 * Claude Code waits for this hook before the person's prompt can be answered: off Windows the post never holds it
 * longer.
 */
const WRITE_MS = 1_000
/**
 * On Windows the pipe is dialled only after the recorded daemon's process check (`harness-pty ps --json`,
 * lib/windows/daemonPipe.ts), bounded at WINDOWS_PS_TIMEOUT_MS, which a busy or cold machine can spend most of: the
 * post waits that out and WRITE_MS more, still under the hooks' 5 s.
 */
const PIPE_MS = WINDOWS_PS_TIMEOUT_MS + WRITE_MS
/** A form with no words of its own still waits on the person, so it is told with these. */
const NO_QUESTION = 'A question'
/** A plan approval's line: the plan's text is the person's work in progress and never leaves this process. */
const PLAN_READY = 'Plan ready to approve'
const FILE_TOOLS = new Set(['Edit', 'Write', 'Read'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** At most [max] bytes of UTF-8, cut between characters, never inside one. */
function cutBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text
  let cut = '', bytes = 0
  for (const char of text) {
    bytes += Buffer.byteLength(char)
    if (bytes > max) break
    cut += char
  }
  return cut
}

/**
 * [text] as one line: each control character a space, since the core refuses one in any field (core/observedHook.ts),
 * which would lose the whole event. Trimmed after, so text of control characters alone says nothing.
 */
const oneLine = (text: string): string => text.replace(/\p{Cc}/gu, ' ').trim()

/**
 * The prompt's one line: what the tool acts on, a form's first question or a plan approval's fixed words, or the tool's
 * name when its input does not say.
 */
export function askedSummary(tool: string, input: unknown): string {
  if (tool === 'ExitPlanMode') return PLAN_READY
  const text = (record: unknown, name: string): string => {
    const value = isRecord(record) ? record[name] : undefined
    return typeof value === 'string' ? value : ''
  }
  const field = (name: string): string => text(input, name)
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  let shown = ''
  if (tool === 'AskUserQuestion') {
    // The dial has one line, so the first question stands for the whole form.
    const questions = isRecord(input) ? input.questions : undefined
    const first = Array.isArray(questions) ? questions[0] : undefined
    shown = oneLine(text(first, 'question')) || oneLine(text(first, 'header')) || NO_QUESTION
  } else if (tool === 'Bash') {
    // The first line with text: a command that opens with a blank line would otherwise show the tool's name.
    const lines = field('command').split(/[\r\n]/).map(oneLine).filter(Boolean)
    shown = lines.length > 1 ? `${lines[0]} …` : lines[0] ?? ''
  } else if (FILE_TOOLS.has(tool)) shown = field('file_path')
  else if (tool === 'NotebookEdit') shown = field('notebook_path')
  else if (tool === 'WebFetch') shown = hostOf(field('url'))
  else if (mcp) shown = `${mcp[1]}: ${mcp[2]}`
  return askedLine(shown, tool)
}

/** [shown] as the prompt's one line, or the tool's name when it says nothing, within the core's bounds. */
export function askedLine(shown: string, tool: string): string {
  return cutBytes(oneLine(shown) || oneLine(tool), MAX_SUMMARY_BYTES)
}

/** The cwd field, left out when the core would refuse the event for it (core/observedHook.ts). */
export function cwdField(cwd: unknown): { cwd?: string } {
  return typeof cwd === 'string' && cwd.length <= MAX_CWD_CHARS && !/\p{Cc}/u.test(cwd) ? { cwd } : {}
}

/** Claude Code's hook input as the body to post, or null when it names no session or tool. */
function claudeBody(input: Record<string, unknown>): AskedBody | null {
  const { session_id: sessionId, tool_name: tool, tool_input: toolInput, cwd } = input
  if (typeof sessionId !== 'string' || !sessionId || typeof tool !== 'string' || !tool) return null
  return {
    engine: 'claude', sessionId, event: 'asked', tool: tool.slice(0, MAX_TOOL_CHARS), summary: askedSummary(tool, toolInput),
    ...cwdField(cwd),
  }
}

/** The hook's input as an object, or null when it is too long or not a JSON object. */
async function hookInput(stdin: AsyncIterable<Buffer | string>): Promise<Record<string, unknown> | null> {
  const parts: Buffer[] = []
  let bytes = 0
  for await (const chunk of stdin) {
    const part = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    bytes += part.length
    if (bytes > MAX_STDIN_BYTES) return null
    parts.push(part)
  }
  let input: unknown
  try {
    input = JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch {
    return null
  }
  return isRecord(input) ? input : null
}

/**
 * Reads the hook's input, makes it the [body] to post, tells the daemon once and exits 0 whatever happens: a failure
 * here must never block or decide the tool call.
 */
export async function tellAsked(
  stdin: AsyncIterable<Buffer | string>, post: (body: AskedBody) => Promise<void>,
  body: (input: Record<string, unknown>) => AskedBody | null,
): Promise<0> {
  try {
    const input = await hookInput(stdin)
    const made = input && body(input)
    if (made) await post(made)
  } catch {
    // Nothing shown on the dial: the prompt is still there.
  }
  return 0
}

/** Claude Code's PermissionRequest hook. */
export function runAsked(deps: AskedDeps): Promise<0> {
  return tellAsked(deps.stdin, deps.post, claudeBody)
}

/**
 * The post to the daemon's `/api/hook/observed` (core/observedHook.ts), as the hook outside a pane posts its events
 * (hook/notify.mjs `postObserved`): written, never waited on, and its answer never read. On Windows it goes through
 * [send], the daemon's pipe by default.
 */
export function daemonPost(
  dataDir: string, port: number, platform: NodeJS.Platform = process.platform, send: typeof fetch = daemonFetch(dataDir, port),
): (body: AskedBody) => Promise<void> {
  if (platform === 'win32') return (body) => pipePost(send, port, body)
  return (body) => new Promise((resolve) => {
    // Only over the socket does the filesystem say the listener is this account's daemon. Over the port, an account holding
    // it while the daemon restarts would hear the prompt (audit H1), so a folder too long for a socket sends nothing.
    const socketPath = localSocketRoute(dataDir, port)
    if (!socketPath) { resolve(); return }
    const payload = JSON.stringify(body)
    const req = request({
      socketPath, path: '/api/hook/observed', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    })
    // Written is done: the request is the kernel's, and the daemon reads it whole after this process has gone.
    const done = (): void => {
      clearTimeout(timer)
      req.destroy()
      resolve()
    }
    const timer = setTimeout(done, WRITE_MS)
    req.on('finish', done)
    req.on('error', done)
    req.end(payload)
  })
}

/**
 * On Windows the pipe's answer proves the daemon's token (lib/localTransport.ts `daemonFetch`), so only this account's
 * daemon hears the prompt. A pipe request is done when answered, not when written: the wait is bounded by PIPE_MS and
 * the answer cancelled unread.
 */
async function pipePost(send: typeof fetch, port: number, body: AskedBody): Promise<void> {
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<void>((resolve) => { timer = setTimeout(() => { abort.abort(); resolve() }, PIPE_MS) })
  const sent = send(`http://127.0.0.1:${port}/api/hook/observed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abort.signal,
  }).then((answer) => answer.body?.cancel(), () => {}).catch(() => {})
  await Promise.race([sent, late])
  clearTimeout(timer)
}
