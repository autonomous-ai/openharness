/**
 * `harness device claude stop` and `harness device codex stop`: the plugin's Stop hook. A turn that ends on a question
 * to the person, while a dial is attached, the person is away and the agent rang nothing, is stopped once and asked to
 * decide: ring the dial with `harness device notify`, or end (docs/plans/2026-11-26-needs-you-right-design.md, Part 5).
 *
 * It reads four fields of the hook's input: `session_id`, `cwd`, `stop_hook_active` and `last_assistant_message`, and
 * for Codex `transcript_path`, whose first line alone it reads. The answer's last characters and that line never leave
 * this process: they are not sent, logged, printed or kept. The devices get the engine, the session id and one bit,
 * whether the answer's tail asks.
 *
 * A session in the data folder (Harness's own one-shots), a headless run (`claude -p`, `codex exec`, Codex run as
 * another agent's MCP tool: nobody is there to ring) and an engine whose skill is not on tell the devices nothing. Every
 * other stop is reported, an ask or not: the devices hold an outside session's turn end for its report, once it has
 * reported, so the end is never told before a yes could stop it. The input's own checks come before any file is read
 * (Codex's rollout head, the skill's files), so malformed input or a Harness one-shot costs no read, and the devices
 * are asked last. Codex's headless sign is its rollout's first line: nothing in the hook's input or the environment
 * says `exec` (`permission_mode` is `bypass` under `exec`, and likely under a `--yolo` TUI too).
 *
 * Both engines read what this prints as the stop's decision, so it prints the block or nothing: any failure prints
 * nothing, and it always exits 0.
 */
import { closeSync, readSync } from 'node:fs'
import { NOTICE_SESSION } from '../lib/dialNotice.js'
import { within } from '../lib/sessionSearch/externals/support.js'
import { hookInput } from './asked.js'
import { openRollout } from './codexTurn.js'

export const DIAL_STOP_REASON = 'Your answer asks the person something, and they are not at this session. If the task cannot go on without them, run harness device notify now, as the dial skill says, and end your turn. If nothing is needed from them, end your turn.'

/** The block both engines read from a Stop hook, on one line. */
export function stopOutput(): string {
  return JSON.stringify({ decision: 'block', reason: DIAL_STOP_REASON })
}

/** Code points of the answer's end looked at: a question asked earlier in a long answer is not the turn's ask. */
export const ASK_TAIL_CHARS = 400

/** Whether the last ASK_TAIL_CHARS code points of [message] hold a question mark, ASCII or full-width. */
export function endsOnAsk(message: string): boolean {
  const tail = [...message].slice(-ASK_TAIL_CHARS).join('')
  return tail.includes('?') || tail.includes('？')
}

/** Whether this stop asks the person something: not the second look already, and an answer whose tail asks. */
export function asksOf(input: Record<string, unknown>): boolean {
  const message = input.last_assistant_message
  return input.stop_hook_active !== true && typeof message === 'string' && endsOnAsk(message)
}

/**
 * The devices' answer is waited for this long, its request included: past it the stop goes on. On Windows it starts
 * after the pipe's proof, which reads the process table first (bounded at WINDOWS_PS_TIMEOUT_MS).
 */
export const NUDGE_ANSWER_MS = 300

/**
 * Codex's first rollout line is about 22 KB (Codex 0.172.0), most of it its instructions: it is read within the bound
 * the session store reads that record in (engines/codex/sessionStore.ts).
 */
const ROLLOUT_HEAD_MAX_BYTES = 128 * 1024
const HEAD_CHUNK_BYTES = 16_384

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The `source` of a Codex session nobody is at: `codex exec`, and Codex run as another agent's MCP tool. */
const HEADLESS_SOURCES = new Set(['exec', 'mcp'])

/**
 * Whether the Codex rollout at [transcriptPath], a file of [codexHome]'s, is a headless run's: its first line is the
 * session's `session_meta`, whose `source` is one of HEADLESS_SOURCES. The path is the hook's input, so it is opened as
 * `codex asked` opens one (codexTurn.ts): a regular file inside the Codex home, never a link or a FIFO. False for
 * anything that cannot be read or does not say so, so a session is never taken for headless by mistake.
 */
export function codexHeadless(transcriptPath: unknown, codexHome: string): boolean {
  if (typeof transcriptPath !== 'string') return false
  const rollout = openRollout(transcriptPath, codexHome)
  if (!rollout) return false
  try {
    const head = Buffer.alloc(ROLLOUT_HEAD_MAX_BYTES)
    let length = 0
    let newline = -1
    while (newline < 0 && length < ROLLOUT_HEAD_MAX_BYTES) {
      const read = readSync(rollout.fd, head, length, Math.min(HEAD_CHUNK_BYTES, ROLLOUT_HEAD_MAX_BYTES - length), length)
      if (read === 0) break
      const found = head.subarray(length, length + read).indexOf(0x0a)
      if (found >= 0) newline = length + found
      length += read
    }
    if (newline < 0) return false
    const line: unknown = JSON.parse(head.subarray(0, newline).toString('utf8'))
    const source = isRecord(line) && line.type === 'session_meta' && isRecord(line.payload) ? line.payload.source : undefined
    return typeof source === 'string' && HEADLESS_SOURCES.has(source)
  } catch {
    return false
  } finally {
    closeSync(rollout.fd)
  }
}

export interface StopDeps {
  stdin: AsyncIterable<Buffer | string>
  dataDir: string
  engine: 'claude' | 'codex'
  /** Whether the session is a headless run, from the engine's own sign. */
  headless(input: Record<string, unknown>): boolean
  /** Whether the dial is set up for this engine: its plugin on, not removed, and Harness's skill in its home. */
  acts(): boolean
  /** The devices' answer to the report, or a status or null for none: bounded by NUDGE_ANSWER_MS. */
  ask(message: { type: 'nudge'; engine: 'claude' | 'codex'; sessionId: string; ask: boolean }): Promise<Record<string, unknown> | number | null>
  out(line: string): void
}

/** Only `{ nudge: true }` is a yes: any other answer, a status or none lets the stop go on. */
const isYes = (answer: Record<string, unknown> | number | null): boolean =>
  isRecord(answer) && answer.nudge === true && Object.keys(answer).length === 1

export async function runStop(deps: StopDeps): Promise<0> {
  try {
    const input = await hookInput(deps.stdin)
    const sessionId = input?.session_id
    const cwd = input?.cwd
    if (!input || typeof sessionId !== 'string' || !NOTICE_SESSION.test(sessionId)) return 0
    if (typeof cwd !== 'string' || within(deps.dataDir, cwd)) return 0
    if (deps.headless(input) || !deps.acts()) return 0
    const ask = asksOf(input)
    const answer = await deps.ask({ type: 'nudge', engine: deps.engine, sessionId, ask })
    if (ask && isYes(answer)) deps.out(stopOutput())
  } catch {
    // Nothing printed: the turn ends as it would without Harness.
  }
  return 0
}
