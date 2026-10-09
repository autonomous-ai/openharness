import { externalEvidenceActive, externalReadFailed } from '../evidence.js'
/**
 * Grok: one folder per conversation, `<GROK_HOME>/sessions/<group>/<id>/`, where the group is the
 * folder it ran in (URL-encoded, or a slug and hash with the path in `.cwd` when that is too long).
 * `summary.json` names its folder and title, `prompt_context.json` says who it was written for (a
 * headless run says `is_non_interactive`, a sub-agent's `audience` is `subagent`), and `updates.jsonl`
 * is the conversation itself.
 *
 * A running Grok lists what it has open in `<GROK_HOME>/active_sessions.json` (`session_id`, `pid`,
 * `cwd`, `opened_at`), which can outlive a crash. A shared backend (`grok agent leader`, `serve`,
 * `headless`, `stdio`) holds the sessions of every client connected to it: never stopped from here.
 *
 * When a conversation last moved is its own last line's time, not the file's: Grok appends its exit
 * hooks (`session_end`) when the process quits, hours after the last word.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { agentCommandOwnershipSnapshot } from '../../engineBin.js'
import { argvTokens, engineProcessMatch } from '../../tmux.js'
import { forEachLine } from '../../transcriptLines.js'
import { absoluteFolder, entries, epochMs, fileStamp, parseLine, readJson, readTail, record, text, UUID } from './support.js'
import type { ExternalProvider, ExternalSession, OwnerClaim, ProcessView, RunningProcess, ScanContext } from './types.js'

export interface GrokOptions { home: string }

export type GrokSkip = 'unreadable' | 'headless' | 'subagent' | 'hidden' | 'mismatch' | 'no-folder' | 'empty'

/** What one session folder holds: a conversation to offer, or why it is not one. */
export type GrokRead =
  | { kind: 'session'; cwd: string; title: string; movedAt: number | null }
  | { kind: 'skip'; reason: GrokSkip }

const PROMPT = /"sessionUpdate"\s*:\s*"user_message_chunk"/

/** The kinds that are the conversation itself; hooks, mode changes and retries are not. */
const MOVES = new Set([
  'user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update',
  'turn_completed', 'plan', 'subagent_spawned', 'subagent_finished',
])

/** How much of the end of `updates.jsonl` is read, and then how much more when that was one long line. */
const TAIL_BYTES = [256 * 1024, 4 * 1024 * 1024]

/** `ps` gives a process's start to the second, truncated: an entry this much older can still be its own. */
const START_SLACK_MS = 1000

/** A Grok process that serves other clients rather than one person's terminal. */
const SHARED_MODES = new Set(['leader', 'serve', 'headless', 'stdio'])

const skip = (reason: GrokSkip): GrokRead => ({ kind: 'skip', reason })

/**
 * A JSON file's value; undefined when there is none. One Grok is still writing is not JSON yet and
 * throws, so a scan's memo keeps nothing of it and the next scan reads it again.
 */
async function jsonFile(path: string): Promise<unknown> {
  const source = await readFile(path, 'utf8').catch(error => { externalReadFailed(error, 'record'); return null })
  return source === null ? undefined : JSON.parse(source)
}

/** One `updates.jsonl` line: its kind, and when it was written (`_meta.agentTimestampMs`, else the
 *  line's `timestamp` in seconds). */
function update(line: string): { kind: string; at: number | null; event: string } | null {
  const row = record(parseLine(line))
  const params = record(row?.params)
  const change = record(params?.update)
  const kind = text(change?.sessionUpdate)
  if (!kind) return null
  return { kind, at: epochMs(record(params?._meta)?.agentTimestampMs) ?? epochMs(row?.timestamp), event: text(change?.event_name) }
}

/**
 * The first answer [pick] gives, reading lines back from the end of [path]. A window that starts
 * mid-file starts mid-line, so its first line is never read.
 */
async function fromEnd<T>(path: string, pick: (line: string) => T | null): Promise<T | null> {
  const size = (await stat(path).catch(error => { externalReadFailed(error, 'record'); return null }))?.size ?? 0
  for (const bytes of TAIL_BYTES) {
    const lines = (await readTail(path, bytes)).split('\n')
    for (let i = lines.length - 1; i >= (size > bytes ? 1 : 0); i--) {
      const found = pick(lines[i])
      if (found !== null) return found
    }
    if (size <= bytes) break
  }
  return null
}

/** Whether a person said anything: a `user_message_chunk` anywhere in the stream. */
async function prompted(path: string): Promise<boolean> {
  let found = false
  try {
    await forEachLine(path, 0, () => { found = true }, { skip: (head) => !PROMPT.test(head), shouldStop: () => found })
  } catch (error) {
    externalReadFailed(error, 'conversation stream')
    return false
  }
  return found
}

/** When the conversation last moved: the time of its last conversation line. */
export function grokMovedAt(path: string): Promise<number | null> {
  return fromEnd(path, (line) => {
    const row = update(line)
    return row && MOVES.has(row.kind) ? row.at : null
  })
}

/**
 * Whether a session's last turn is still running: a prompt after the last `turn_completed`. A
 * `session_end` hook means the process that wrote it quit. Null when the end of the stream says
 * neither.
 */
export function grokTurnOpen(path: string): Promise<boolean | null> {
  return fromEnd(path, (line) => {
    const row = update(line)
    if (row?.kind === 'user_message_chunk') return true
    if (row?.kind === 'turn_completed') return false
    if (row?.kind === 'hook_execution' && row.event === 'session_end') return false
    return null
  })
}

/**
 * One session folder, read: the conversation a person had there, or why it is not one. Throws while
 * its `summary.json` or `prompt_context.json` is half-written.
 */
export async function readGrokSession(dir: string, sessionId: string): Promise<GrokRead> {
  const summary = record(await jsonFile(join(dir, 'summary.json')))
  const context = record(await jsonFile(join(dir, 'prompt_context.json')))
  // Without both, a session cannot be told apart from a headless run or a sub-agent: not offered.
  if (!summary || !context) return skip('unreadable')
  if (context.is_non_interactive === true) return skip('headless')
  // A `/fork` peer is `primary` with a parent: a conversation of its own, and kept.
  if (context.audience === 'subagent' || text(summary.session_kind).startsWith('subagent')) return skip('subagent')
  if (summary.hidden === true) return skip('hidden')
  const info = record(summary.info)
  if (text(info?.id) && info?.id !== sessionId) return skip('mismatch')
  const cwd = absoluteFolder(info?.cwd) ?? absoluteFolder(context.working_directory)
  if (!cwd) return skip('no-folder')
  const updates = join(dir, 'updates.jsonl')
  if (!await prompted(updates)) return skip('empty')
  return {
    kind: 'session',
    cwd,
    title: text(summary.generated_title).trim(),
    movedAt: await grokMovedAt(updates) ?? epochMs(summary.last_active_at),
  }
}

/** The stream of session [sessionId], wherever its group is: first where [cwd] puts it, then by id. */
async function streamOf(home: string, sessionId: string, cwd: string): Promise<string | null> {
  const root = join(home, 'sessions')
  const direct = cwd ? join(root, encodeURIComponent(cwd), sessionId, 'updates.jsonl') : null
  if (direct && await fileStamp(direct)) return direct
  for (const group of await entries(root)) {
    if (!group.isDirectory()) continue
    const path = join(root, group.name, sessionId, 'updates.jsonl')
    if (await fileStamp(path)) return path
  }
  return null
}

/**
 * Whether [row] is a Grok. `agent` is also Cursor's name, and Cursor's `agent` is a node process
 * carrying its package's path, so an `agent` that is not Cursor's is Grok's.
 */
function isGrok(row: RunningProcess, ownership: ReturnType<typeof agentCommandOwnershipSnapshot>): boolean {
  if (engineProcessMatch(row, 'grok', ownership).score > 0) return true
  const named = [basename(row.executable), basename(argvTokens(row.args)[0] ?? '')].some((name) => name.toLowerCase() === 'agent')
  return named && engineProcessMatch(row, 'cursor', ownership).score === 0
}

/**
 * Whether [row] is a Grok backend shared by other clients (`grok agent [options] leader`), or a client
 * of one (`--leader`), whose session lives on in the leader when the client is stopped.
 */
function shared(row: RunningProcess): boolean {
  const tokens = argvTokens(row.args).slice(1)
  const agent = tokens.indexOf('agent')
  return tokens.includes('--leader') || (agent >= 0 && tokens.slice(agent + 1).some((token) => SHARED_MODES.has(token)))
}

export function grokProvider(options: GrokOptions): ExternalProvider {
  return {
    engine: 'grok',
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      const root = join(options.home, 'sessions')
      const found: ExternalSession[] = []
      for (const group of await entries(root)) {
        if (!group.isDirectory()) continue
        const folder = join(root, group.name)
        for (const entry of await entries(folder)) {
          if (!entry.isDirectory() || !UUID.test(entry.name)) continue
          const dir = join(folder, entry.name)
          const updates = join(dir, 'updates.jsonl')
          const stamp = await fileStamp(updates)
          if (!stamp) continue
          const [summary, context] = await Promise.all([
            fileStamp(join(dir, 'summary.json')), fileStamp(join(dir, 'prompt_context.json')),
          ])
          const fingerprint = `${stamp.stamp}|${summary?.stamp ?? '-'}|${context?.stamp ?? '-'}`
          const read = await ctx.memo(`grok:${dir}`, fingerprint, () => readGrokSession(dir, entry.name)).catch(error => { externalReadFailed(error, 'record'); return null })
          await ctx.pace()
          // Half-written: nothing was remembered, and the next scan reads it again.
          if (read?.kind !== 'session' || ctx.excluded(read.cwd)) continue
          found.push({
            sessionId: entry.name, engine: 'grok', cwd: read.cwd, origin: 'terminal', title: read.title,
            mtime: read.movedAt ?? stamp.mtime, transcriptPath: updates,
          })
        }
      }
      return found
    },
    async owners(view: ProcessView): Promise<OwnerClaim[]> {
      const listed = await readJson(join(options.home, 'active_sessions.json'))
      // Grok itself starts over from an empty list when this file is corrupt.
      if (!Array.isArray(listed) && listed !== null) externalReadFailed(new Error('invalid active sessions'), 'owner record')
      if ((!Array.isArray(listed) || !listed.length) && !externalEvidenceActive()) return []
      const byPid = new Map<number, Array<{ sessionId: string; cwd: string; at: number }>>()
      for (const item of Array.isArray(listed) ? listed : []) {
        const entry = record(item)
        const sessionId = text(entry?.session_id)
        const pid = entry?.pid
        if (!UUID.test(sessionId) || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
          externalReadFailed(new Error('invalid active session'), 'owner record'); continue
        }
        const at = epochMs(entry?.opened_at)
        if (externalEvidenceActive() && (!Number.isFinite(at) || at! <= 0)) {
          externalReadFailed(new Error('missing owner start'), 'owner record'); continue
        }
        byPid.set(pid, [...byPid.get(pid) ?? [], { sessionId, cwd: text(entry?.cwd), at: at ?? 0 }])
      }
      const rows = new Map((await view.list()).map((row) => [row.pid, row]))
      const ownership = agentCommandOwnershipSnapshot()
      const claims: OwnerClaim[] = []
      for (const [pid, held] of byPid) {
        const row = rows.get(pid)
        if (externalEvidenceActive() && !row && view.alive(pid)) externalReadFailed(new Error('missing owner process'), 'owner process')
        // An entry outlives a crash, and its pid can be reused: only a live Grok counts.
        if (!row || !view.alive(pid) || !isGrok(row, ownership)) continue
        if (externalEvidenceActive() && (!Number.isFinite(row.started) || row.started! <= 0)) {
          externalReadFailed(new Error('missing process start'), 'owner process'); continue
        }
        // An entry opened before the process that has its pid started was an earlier process's. An
        // entry that does not say when it was opened is kept.
        const current = held.filter((entry) => !entry.at || row.started === undefined || entry.at + START_SLACK_MS >= row.started)
        if (!current.length) continue
        const app = shared(row)
        // A terminal's Grok has one session open: an older entry under its pid is a crashed Grok's.
        const newest = current.reduce((latest, entry) => entry.at >= latest.at ? entry : latest)
        if (!app && externalEvidenceActive() && new Set(current.filter(entry => entry.at === newest.at)
          .map(entry => JSON.stringify([entry.sessionId, entry.cwd]))).size > 1) {
          externalReadFailed(new Error('ambiguous current process record'), 'current owner'); continue
        }
        const open = app ? current : [newest]
        for (const entry of open) {
          const stream = await streamOf(options.home, entry.sessionId, entry.cwd)
          claims.push({ sessionId: entry.sessionId, pid, record: stream ?? '', ...(app ? { app: true } : {}) })
        }
      }
      if (externalEvidenceActive()) for (const row of rows.values()) {
        if (view.alive(row.pid) && isGrok(row, ownership) && !claims.some(claim => claim.pid === row.pid))
          externalReadFailed(new Error('no current process record'), 'current owner')
      }
      return claims
    },
    async busy(owner): Promise<boolean | null> {
      return owner.record ? grokTurnOpen(owner.record) : null
    },
  }
}
