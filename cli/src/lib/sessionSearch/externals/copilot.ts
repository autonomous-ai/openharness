/**
 * GitHub Copilot CLI: one folder per conversation, `<COPILOT_HOME>/session-state/<id>/`, holding its
 * event stream (`events.jsonl`, whose first line is `session.start`) and `workspace.yaml` (its folder
 * as it is now, its name, and `client_name`: which program held it). The VS Code agent host and
 * other editors keep their sessions in the same store; cloud tasks (`mc_task_id`), a rem-agent run
 * detached from its parent, and programs driving the SDK are not a person's conversations.
 * Sub-agents live inside their parent's stream (`agentId`), never in a folder of their own.
 *
 * A process with a session open holds `inuse.<pid>.lock` in its folder, and an in-process `/resume`
 * takes a second lock without dropping the first: a pid's newest lock is the session it is in. The
 * pid is the runtime itself: the native `copilot` (the npm loader's child), or the SDK's
 * `copilot-runtime` that an editor starts, which is never stopped from here.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { copilotHistoryTurnOpen } from '../../../engines/copilot/normalizer.js'
import { agentCommandOwnershipSnapshot } from '../../engineBin.js'
import { argvTokens, engineProcessMatch } from '../../tmux.js'
import { forEachLine } from '../transcript.js'
import { absoluteFolder, entries, epochMs, fileStamp, parseLine, readTail, record, text, UUID } from './support.js'
import type { ExternalOrigin, ExternalProvider, ExternalSession, OwnerClaim, ProcessView, RunningProcess, ScanContext } from './types.js'

export interface CopilotOptions { home: string }

export type CopilotSkip = 'unreadable' | 'mismatch' | 'detached' | 'cloud-task' | 'automation' | 'no-folder' | 'empty'

/** What one session folder holds: a conversation to offer, or why it is not one. */
export type CopilotRead =
  | { kind: 'session'; cwd: string; origin: ExternalOrigin; title: string; movedAt: number | null }
  | { kind: 'skip'; reason: CopilotSkip }

const TAIL_BYTES = [256 * 1024, 4 * 1024 * 1024]
const LOCK = /^inuse\.(\d+)\.lock$/
/** `ps` gives a process's start to the second, truncated: a lock this much older can still be its own. */
const START_SLACK_MS = 1000

/** Clients that are an editor's agent (`client_name`, as the runtime's own telemetry groups them). */
const EDITOR_CLIENT = /^(?:vscode-agent-host|GitHub Copilot Language Server|github\/acp|microsoft\/.+|JetBrains\..+|Google\..+)$/
/** Clients that are GitHub's automation, or a program on the SDK that named nothing (`sdk`). */
const AUTOMATION_CLIENT = /^(?:sdk|github\/(?:copilot-cloud-agent|coverage-agent|copilot-code-review(?:\/.*)?|code-scanning(?:\/.*)?))$/
/** Event types that are the conversation moving. */
const MOVES = new Set(['user.message', 'assistant.message', 'assistant.turn_end', 'abort'])
/** Event types that open or close a turn: a tail with none of them cannot say whether one runs. */
const TURN_MARKS = new Set(['user.message', 'assistant.turn_start', 'assistant.turn_end', 'abort', 'session.shutdown'])
/** Flags that make a Copilot a server for other programs rather than a person's terminal. */
const SERVER_FLAGS = new Set(['--headless', '--server', '--stdio', '--acp'])

const skip = (reason: CopilotSkip): CopilotRead => ({ kind: 'skip', reason })

// ---- workspace.yaml -------------------------------------------------------------------------------

/** A double-quoted scalar's one-character escapes. */
const ESCAPES: Record<string, string> = {
  '0': String.fromCharCode(0), a: String.fromCharCode(7), b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f',
  r: '\r', e: String.fromCharCode(0x1b), ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: String.fromCharCode(0x85),
  _: String.fromCharCode(0xa0), L: String.fromCharCode(0x2028), P: String.fromCharCode(0x2029),
}

/**
 * A flow scalar's text: plain (to the end of [source]), or quoted from its opening quote to its
 * closing one. Lines fold as YAML folds them: a line break between two lines is a space, each blank
 * line between them a newline, and the white space around a break is not content. In single quotes
 * `''` is a quote; in double quotes a backslash escapes, and an escaped line break joins two lines.
 */
function flow(source: string, quote: '' | "'" | '"'): string | null {
  let out = ''
  let space = ''
  let breaks = 0
  for (let i = quote ? 1 : 0; i < source.length; i++) {
    const char = source[i]
    if (char === ' ' || char === '\t') { space += char; continue }
    if (char === '\n') { breaks++; space = ''; continue }
    // Text follows: whatever separated it from the text before is folded now.
    out += breaks ? (breaks === 1 ? ' ' : '\n'.repeat(breaks - 1)) : space
    breaks = 0
    space = ''
    if (char === quote) {
      if (quote === "'" && source[i + 1] === "'") { out += "'"; i++; continue }
      return out
    }
    if (quote !== '"' || char !== '\\') { out += char; continue }
    const next = source[++i]
    if (next === '\n') {
      while (source[i + 1] === ' ' || source[i + 1] === '\t') i++
      continue
    }
    const width = next === 'x' ? 2 : next === 'u' ? 4 : next === 'U' ? 8 : 0
    const hex = source.slice(i + 1, i + 1 + width)
    if (width && hex.length === width && /^[0-9a-fA-F]+$/.test(hex) && parseInt(hex, 16) <= 0x10ffff) {
      out += String.fromCodePoint(parseInt(hex, 16))
      i += width
    } else if (!width && Object.hasOwn(ESCAPES, next)) {
      out += ESCAPES[next]
    } else {
      return null
    }
  }
  return quote ? null : out
}

/** A block scalar: `|` keeps its line breaks, `>` folds them; `-` strips the final ones, `+` keeps them all. */
function block(header: string, lines: readonly string[]): string | null {
  const shape = /^([|>])(?:([1-9])?([+-])?|([+-])([1-9]))[ \t]*(?:#.*)?$/.exec(header)
  if (!shape) return null
  const chomp = shape[3] ?? shape[4] ?? ''
  const indent = Number(shape[2] ?? shape[5] ?? 0) || (lines.find((line) => line.trim())?.search(/[^ ]/) ?? 0)
  const body = lines.map((line) => line.slice(indent))
  let end = body.length
  while (end > 0 && !body[end - 1].trim()) end--
  if (!end) return ''
  let text = ''
  if (shape[1] === '|') {
    text = body.slice(0, end).join('\n')
  } else {
    // Folded: a break between two lines is a space, but not around a blank or a more-indented line.
    let blank = 0
    let started = false
    let wasIndented = false
    for (const line of body.slice(0, end)) {
      if (!line) { blank++; continue }
      const indented = /^[ \t]/.test(line)
      if (!started) text += '\n'.repeat(blank)
      else text += indented || wasIndented ? '\n'.repeat(blank + 1) : blank ? '\n'.repeat(blank) : ' '
      text += line
      blank = 0
      started = true
      wasIndented = indented
    }
  }
  if (chomp === '-') return text
  return text + '\n'.repeat(chomp === '+' ? body.length - end + 1 : 1)
}

/** One value: the text after `key:`, and the lines that continue it. Null for none, and for a map
 *  or a list, which Harness never needs from this file. */
function scalar(first: string, more: readonly string[]): string | null {
  if (!first) return null
  if (first.startsWith('"') || first.startsWith("'")) return flow([first, ...more].join('\n'), first[0] as "'" | '"')
  if (first.startsWith('|') || first.startsWith('>')) return block(first, more)
  // A plain value ends at a comment.
  const value = flow([first, ...more].map((line) => line.replace(/(?:^|[ \t])#.*$/, '')).join('\n'), '')
  return /^(?:~|null|Null|NULL)?$/.test(value!) ? null : value
}

/**
 * The top-level scalars of `workspace.yaml`. Copilot's runtime writes it with libyaml (serde_yaml),
 * which quotes a value only when it must (single quotes, else double) and writes one with line breaks as a
 * literal block (`|-`).
 */
export function workspaceYaml(source: string): Map<string, string | null> {
  const lines = (source.charCodeAt(0) === 0xfeff ? source.slice(1) : source).split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  const values = new Map<string, string | null>()
  for (let i = 0; i < lines.length;) {
    const key = /^([A-Za-z_][\w.-]*):(?:[ \t]+(.*))?$/.exec(lines[i++])
    if (!key) continue
    const more: string[] = []
    while (i < lines.length && (!lines[i] || /^[ \t]/.test(lines[i]))) more.push(lines[i++])
    values.set(key[1], scalar((key[2] ?? '').trim(), more))
  }
  return values
}

// ---- the stream ----------------------------------------------------------------------------------

/** Where a session was held, from its `client_name`; null for automation, which is never offered. */
export function copilotOrigin(client: string): ExternalOrigin | null {
  if (AUTOMATION_CLIENT.test(client)) return null
  return EDITOR_CLIENT.test(client) ? 'editor' : 'terminal'
}

/** A prompt a person wrote: the main agent's, not a skill's injection, another agent's or autopilot's. */
function personPrompt(line: string): boolean {
  const row = record(parseLine(line))
  const data = record(row?.data)
  if (row?.type !== 'user.message' || !data || 'agentId' in row || row.ephemeral === true) return false
  return !/^(?:skill-|agent-)/.test(text(data.source)) && data.isAutopilotContinuation !== true
}

/**
 * The stream's first record (`session.start`), and whether a person asked anything: one pass from the
 * start, which stops at the first prompt. Null when the stream cannot be read. Throws while its first
 * line is still being written, so a scan's memo keeps nothing and the next scan reads it again.
 */
async function streamHead(path: string): Promise<{ start: Record<string, unknown> | null; prompted: boolean } | null> {
  let start: Record<string, unknown> | null = null
  let prompted = false
  let first = true
  let end: number
  try {
    ({ end } = await forEachLine(path, 0, ({ text: line, offset }) => {
      if (!offset) start = record(parseLine(line))
      // Several lines can follow in the chunk that held the prompt: one prompt is enough.
      else if (personPrompt(line)) prompted = true
    }, {
      // Past `session.start`, only a line that can be a prompt is read whole.
      skip: (head) => {
        const skipped = !first && !head.includes('"user.message"')
        first = false
        return skipped
      },
      shouldStop: () => prompted,
    }))
  } catch {
    return null
  }
  // Not one whole line yet.
  if (!end) throw new Error('session.start is not written yet')
  return { start, prompted }
}

/** The first answer [pick] gives, reading lines back from the end of [path]. */
async function fromEnd<T>(path: string, pick: (line: string) => T | null): Promise<T | null> {
  const size = (await stat(path).catch(() => null))?.size ?? 0
  for (const bytes of TAIL_BYTES) {
    const lines = (await readTail(path, bytes)).split('\n')
    // A window that starts mid-file starts mid-line.
    for (let i = lines.length - 1; i >= (size > bytes ? 1 : 0); i--) {
      const found = pick(lines[i])
      if (found !== null) return found
    }
    if (size <= bytes) break
  }
  return null
}

/** When the conversation last moved: its last prompt, answer or turn end. */
export function copilotMovedAt(path: string): Promise<number | null> {
  return fromEnd(path, (line) => {
    const row = record(parseLine(line))
    return MOVES.has(text(row?.type)) ? epochMs(row?.timestamp) : null
  })
}

/**
 * Whether the main agent is mid-turn, by `copilotHistoryTurnOpen` over the end of the stream. A
 * sub-agent's rounds (`agentId`) run inside the parent's turn and are left out. Null when the end of
 * the stream holds no turn event at all.
 */
export async function copilotTurnOpen(path: string): Promise<boolean | null> {
  const size = (await stat(path).catch(() => null))?.size ?? 0
  for (const bytes of TAIL_BYTES) {
    const lines = (await readTail(path, bytes)).split('\n').filter((line) => {
      // A window that starts mid-file starts mid-line, and half a line is not JSON.
      const row = record(parseLine(line))
      return !!row && !('agentId' in row) && TURN_MARKS.has(text(row.type))
    })
    if (lines.length) return copilotHistoryTurnOpen(lines)
    if (size <= bytes) break
  }
  return null
}

/**
 * One session folder, read: the conversation a person had there, or why it is not one. Throws while
 * its first line is half-written.
 */
export async function readCopilotSession(dir: string, sessionId: string): Promise<CopilotRead> {
  const events = join(dir, 'events.jsonl')
  const head = await streamHead(events)
  const data = record(head?.start?.data)
  if (!head || head.start?.type !== 'session.start' || !data) return skip('unreadable')
  if (text(data.sessionId) && data.sessionId !== sessionId) return skip('mismatch')
  if (text(data.detachedFromSpawningParentSessionId)) return skip('detached')
  const workspace = workspaceYaml(await readFile(join(dir, 'workspace.yaml'), 'utf8').catch(() => ''))
  if (workspace.get('mc_task_id')) return skip('cloud-task')
  const origin = copilotOrigin(workspace.get('client_name') ?? '')
  if (!origin) return skip('automation')
  // `workspace.yaml` follows a `/cwd` change, and a resume restores that folder; `session.start` has
  // the folder it began in.
  const cwd = absoluteFolder(workspace.get('cwd')) ?? absoluteFolder(record(data.context)?.cwd)
  if (!cwd) return skip('no-folder')
  if (!head.prompted) return skip('empty')
  return { kind: 'session', cwd, origin, title: (workspace.get('name') ?? '').trim(), movedAt: await copilotMovedAt(events) }
}

// ---- processes -----------------------------------------------------------------------------------

/** What [row] is: the CLI, an editor's SDK runtime (or a CLI serving one), or not Copilot at all. */
function copilotProcess(row: RunningProcess, ownership: ReturnType<typeof agentCommandOwnershipSnapshot>): 'cli' | 'server' | null {
  const tokens = argvTokens(row.args)
  const runtime = [row.executable, tokens[0] ?? ''].some((path) => /^copilot-runtime(?:\.exe)?$/i.test(basename(path)))
  if (!runtime && engineProcessMatch(row, 'copilot', ownership).score <= 0) return null
  return runtime || tokens.some((token) => SERVER_FLAGS.has(token)) ? 'server' : 'cli'
}

export function copilotProvider(options: CopilotOptions): ExternalProvider {
  const root = join(options.home, 'session-state')
  return {
    engine: 'copilot',
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      const found: ExternalSession[] = []
      for (const entry of await entries(root)) {
        if (!entry.isDirectory() || !UUID.test(entry.name)) continue
        const dir = join(root, entry.name)
        const events = join(dir, 'events.jsonl')
        const stamp = await fileStamp(events)
        if (!stamp) continue
        const workspace = await fileStamp(join(dir, 'workspace.yaml'))
        const read = await ctx.memo(`copilot:${dir}`, `${stamp.stamp}|${workspace?.stamp ?? '-'}`, () => readCopilotSession(dir, entry.name))
          .catch(() => null)
        await ctx.pace()
        // Half-written: nothing was remembered, and the next scan reads it again.
        if (read?.kind !== 'session' || ctx.excluded(read.cwd)) continue
        found.push({
          sessionId: entry.name, engine: 'copilot', cwd: read.cwd, origin: read.origin, title: read.title,
          mtime: read.movedAt ?? stamp.mtime, transcriptPath: events,
        })
      }
      return found
    },
    async owners(view: ProcessView): Promise<OwnerClaim[]> {
      // Each pid's newest lock: the session it is in now.
      const newest = new Map<number, { sessionId: string; at: number }>()
      for (const entry of await entries(root)) {
        if (!entry.isDirectory() || !UUID.test(entry.name)) continue
        for (const file of await entries(join(root, entry.name))) {
          const pid = Number(LOCK.exec(file.name)?.[1] ?? 0)
          const stamp = pid > 0 ? await fileStamp(join(root, entry.name, file.name)) : null
          if (!stamp) continue
          const held = newest.get(pid)
          if (!held || stamp.mtime > held.at || (stamp.mtime === held.at && entry.name > held.sessionId)) {
            newest.set(pid, { sessionId: entry.name, at: stamp.mtime })
          }
        }
      }
      if (!newest.size) return []
      const rows = new Map((await view.list()).map((row) => [row.pid, row]))
      const ownership = agentCommandOwnershipSnapshot()
      const claims: OwnerClaim[] = []
      for (const [pid, held] of newest) {
        const row = rows.get(pid)
        // A crash leaves its lock behind, and the pid can be reused: only a live Copilot counts.
        const kind = row && view.alive(pid) ? copilotProcess(row, ownership) : null
        // A lock older than the process that has its pid was left by an earlier one.
        if (!kind || (row!.started !== undefined && held.at + START_SLACK_MS < row!.started)) continue
        claims.push({
          sessionId: held.sessionId, pid, record: join(root, held.sessionId, 'events.jsonl'),
          ...(kind === 'server' ? { app: true } : {}),
        })
      }
      return claims
    },
    busy: (owner) => copilotTurnOpen(owner.record),
  }
}
