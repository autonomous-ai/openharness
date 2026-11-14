/**
 * `harness device claude asked`: the client Claude Code's PermissionRequest hook runs (plugins/harness-device). It tells
 * the daemon that a prompt waits, so the dial shows the agent waiting and for what, and decides nothing: it prints nothing
 * and reads no answer, so nothing the daemon or anyone holding its socket sends can become a decision. The prompt is
 * answered in the app it is in (docs/specs/2026-11-13-device-claude-orca.md, after the dial check).
 *
 * What leaves this process is six typed fields. The tool input is cut to a one-line summary here, so the rest of it (a
 * file's content, a whole script) never reaches the daemon. No environment variable is sent: Orca puts
 * ORCA_PAIRING_CODE and ORCA_AGENT_SESSION_SPAWN_TOKEN in the same environment. This file runs only in the `harness`
 * command's own process.
 */
import { request } from 'node:http'
import { localSocketRoute } from '../lib/localTransport.js'

export interface AskedBody {
  engine: 'claude'
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
const MAX_TOOL_CHARS = 64
const MAX_SUMMARY_BYTES = 200
const MAX_CWD_CHARS = 1024
/** Claude Code waits for this hook before the person's prompt can be answered: the post never holds it longer. */
const WRITE_MS = 1_000
/** These need the person at the terminal anyway: the dial shows them already as the agent waiting. */
const PERSON_ONLY = new Set(['AskUserQuestion', 'ExitPlanMode'])
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

/** The prompt's one line: what the tool acts on, or its name when its input does not say. */
export function askedSummary(tool: string, input: unknown): string {
  const field = (name: string): string => {
    const value = isRecord(input) ? input[name] : undefined
    return typeof value === 'string' ? value : ''
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  let shown = ''
  if (tool === 'Bash') {
    // The first line with text: a command that opens with a blank line would otherwise show the tool's name.
    const lines = field('command').split(/[\r\n]/).map((line) => line.trim()).filter(Boolean)
    shown = lines.length > 1 ? `${lines[0]} …` : lines[0] ?? ''
  } else if (FILE_TOOLS.has(tool)) shown = field('file_path')
  else if (tool === 'NotebookEdit') shown = field('notebook_path')
  else if (tool === 'WebFetch') shown = hostOf(field('url'))
  else if (mcp) shown = `${mcp[1]}: ${mcp[2]}`
  // The core refuses a control character in any field (core/observedHook.ts), which would lose the whole event.
  return cutBytes((shown.trim() || tool).replace(/\p{Cc}/gu, ' '), MAX_SUMMARY_BYTES)
}

/** The hook's input as the body to post, or null for nothing to send: too long, not JSON, or a tool that is the person's. */
async function askedBody(stdin: AsyncIterable<Buffer | string>): Promise<AskedBody | null> {
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
  if (!isRecord(input)) return null
  const { session_id: sessionId, tool_name: tool, tool_input: toolInput, cwd } = input
  if (typeof sessionId !== 'string' || !sessionId || typeof tool !== 'string' || !tool || PERSON_ONLY.has(tool)) return null
  return {
    engine: 'claude', sessionId, event: 'asked', tool: tool.slice(0, MAX_TOOL_CHARS), summary: askedSummary(tool, toolInput),
    // The core refuses an event with a cwd it cannot hold: one it would refuse is not sent.
    ...(typeof cwd === 'string' && cwd.length <= MAX_CWD_CHARS && !/\p{Cc}/u.test(cwd) ? { cwd } : {}),
  }
}

/** Tells the daemon once and exits 0 whatever happens: a failure here must never block or decide the tool call. */
export async function runAsked(deps: AskedDeps): Promise<0> {
  try {
    const body = await askedBody(deps.stdin)
    if (body) await deps.post(body)
  } catch {
    // Nothing shown on the dial: the prompt is still there.
  }
  return 0
}

/**
 * The post to the daemon's `/api/hook/observed` (core/observedHook.ts), as the hook outside a pane posts its events
 * (hook/notify.mjs `postObserved`): written, never waited on, and its answer never read.
 */
export function daemonPost(dataDir: string, port: number): (body: AskedBody) => Promise<void> {
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
