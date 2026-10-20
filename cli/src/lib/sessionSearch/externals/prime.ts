import { externalReadFailed } from '../evidence.js'
/**
 * Prime Agent: `<agentDir>/sessions/<uuidv7>.jsonl`, one flat folder (Pi's fork, without Pi's per-cwd
 * folders). The first entry is the header, `{type:'session', id, cwd, rlmDepth}`, and it is the only
 * authority for either. RLM children are kept under `<agentDir>/session-artifacts/…` and are never listed:
 * each belongs to its parent's conversation.
 *
 * A session's name is the latest `session_info` entry, as in Pi (`readPiTitle`). Its time is the newest user
 * or assistant message. The pane holds a client, not the session (engines/prime/contract.ts): only an argv
 * that names it (`--resume <id>`) says which process shows it.
 */

import { join } from 'node:path'
import { PRIME_HEADER } from '../../../engines/prime/contract.js'
import { readSessionHeader, type NativeSessionHead } from '../../../engines/kit/sessionIdentity.js'
import type { AgentCommandOwnershipSnapshot } from '../../engineBin.js'
import { engineProcessMatch, resumeSessionId } from '../../tmux.js'
import { piActivity, readPiTitle, type PiTitleRead } from './pi.js'
import { entries, fileStamp, parseLine, readHead, readTail, record, text } from './support.js'
import { type ExternalProvider, type ExternalSession, type OwnerClaim, type ProcessView, type ScanContext } from './types.js'
import { UNSETTLED } from './types.js'

const NO_FILE_OWNERS: AgentCommandOwnershipSnapshot = {
  cursorFileKeys: new Set(), grokFileKeys: new Set(), conflictingFileKeys: new Set(),
  agentCandidates: [], cursorAgentCandidates: [], grokCandidates: [],
}

/** Custom messages that hand the model a prompt (engines/prime/normalizer.ts). */
const PROMPTS = ['agent_message', 'async_bash_completion', 'rlm_child_terminal_notice', 'rlm_child_failure', 'heartbeat_prompt']

export type PrimeHead = NativeSessionHead

export async function readPrimeHead(path: string): Promise<PrimeHead | null | typeof UNSETTLED> {
  return readSessionHeader(PRIME_HEADER, bytes => readHead(path, bytes))
}

/** Whether the header says this is an RLM child (`rlmDepth >= 1`). Unreadable reads as a root. */
async function isChild(path: string): Promise<boolean> {
  const row = record(parseLine((await readHead(path, 16 * 1024)).split('\n')[0] ?? ''))
  return typeof row?.rlmDepth === 'number' && row.rlmDepth > 0
}

/**
 * Whether the last exchange is still running. A person's message, a tool's result or a prompting custom
 * message means the agent is on it; an assistant message is mid-turn only while it calls tools.
 */
export async function primeTurnOpen(path: string): Promise<boolean | null> {
  if (!path) return null
  for (const bytes of [256 * 1024, 4 * 1024 * 1024]) {
    const tail = await readTail(path, bytes)
    const lines = tail.split('\n')
    for (const line of (Buffer.byteLength(tail) < bytes ? lines : lines.slice(1)).reverse()) {
      if (!line.includes('"message"') && !line.includes('"custom_message"')) continue
      const row = record(parseLine(line))
      if (row?.type === 'custom_message' && row.display === true && PROMPTS.includes(text(row.customType))) return true
      const message = record(row?.message)
      if (row?.type !== 'message' || !message) continue
      if (message.role === 'user' || message.role === 'toolResult') return true
      if (message.role === 'assistant') return text(message.stopReason) ? message.stopReason === 'toolUse' : null
    }
    if (Buffer.byteLength(tail) < bytes) break
  }
  return null
}

export interface PrimeOptions { agentDir: string }

/** The session each running client names on its command line (`--resume <id>`). */
async function argvClaims(view: ProcessView, recordOf: (sessionId: string) => string): Promise<OwnerClaim[]> {
  const claims: OwnerClaim[] = []
  for (const row of await view.list()) {
    if (!engineProcessMatch(row, 'prime', NO_FILE_OWNERS).score) continue
    if (view.alive(row.pid)) externalReadFailed(new Error('only launch arguments identify this live process'), 'current owner')
    const sessionId = resumeSessionId('prime', row.args)
    // A client can switch session inside (`/resume`, `/new`): never stopped on this.
    if (sessionId) claims.push({ sessionId, pid: row.pid, record: recordOf(sessionId), fromArgs: true })
  }
  return claims
}

export function primeProvider(options: PrimeOptions): ExternalProvider {
  let transcripts = new Map<string, string>()
  const titles = new Map<string, PiTitleRead>()
  return {
    engine: 'prime',
    async scan(ctx: ScanContext): Promise<ExternalSession[]> {
      const dir = join(options.agentDir, 'sessions')
      const found: ExternalSession[] = []
      for (const file of await entries(dir)) {
        if (!file.name.endsWith('.jsonl')) continue
        const path = join(dir, file.name)
        const stamp = await fileStamp(path)
        if (!stamp) continue
        const head = await ctx.head(`prime:${path}`, stamp.stamp, () => readPrimeHead(path))
        await ctx.pace()
        if (!head || ctx.excluded(head.cwd)) continue
        const info = await ctx.memo(`prime:info:${path}`, stamp.stamp, async () => {
          if (await isChild(path)) return null
          const read = await readPiTitle(path, titles.get(path))
          titles.set(path, read)
          return { title: read.title, mtime: await piActivity(path) }
        })
        if (!info) continue
        found.push({
          sessionId: head.sessionId, engine: 'prime', cwd: head.cwd, origin: 'terminal',
          title: info.title, mtime: info.mtime ?? stamp.mtime, transcriptPath: path,
        })
      }
      const listed = new Set(found.map((session) => session.transcriptPath))
      for (const path of titles.keys()) if (!listed.has(path)) titles.delete(path)
      transcripts = new Map([...found].sort((a, b) => a.mtime - b.mtime).map((session) => [session.sessionId, session.transcriptPath!]))
      return found
    },
    owners: (view: ProcessView) => argvClaims(view, (sessionId) => transcripts.get(sessionId) ?? ''),
    busy: (owner) => primeTurnOpen(owner.record),
  }
}
