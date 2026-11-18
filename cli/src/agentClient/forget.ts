/**
 * What `harness close <name> --program-token-file <p> --forget` (#4393) deletes in an engine's own store, beside what
 * Harness keeps (its `agent_purge`). Each engine's session is deleted by the engine itself, as its own CLI deletes it,
 * with the caller's config: Harness never writes OpenClaw's store (engines/openclaw/contract.ts `OPENCLAW_STORE_KEPT`),
 * and Hermes's store has triggers (its search index, its display order) that only Hermes's own delete keeps whole.
 *
 * - OpenClaw: the Gateway's `sessions.delete` (`openclaw gateway call`), for every key the harness has used: the one
 *   Harness launched it with (`agent:main:harness-<id>`), which keeps its conversation after a `/new`, and the one it is
 *   bound to now. Never an agent's `main` key (the Gateway refuses that too).
 * - Hermes: `hermes sessions delete --yes <id>`, once its store is read to hold exactly that id: Hermes would otherwise
 *   take the id as a prefix of another session's.
 */
import { execFile } from 'node:child_process'
import { env } from '../config/env.js'
import { hermesDbPath } from '../engines/hermes/contract.js'
import { sqliteReadAll } from '../lib/sqliteRead.js'

/** What became of a conversation: deleted, none to delete, or kept (with why). */
export type Deletion = { state: 'deleted' | 'none' | 'kept'; detail?: string }
/** One engine session and what became of it. */
export type SessionDeletion = Deletion & { key: string }

/** How an engine's CLI is run: its exit code (null when it could not run, or was stopped) and what it printed. */
export type RunCommand = (command: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>

/** How long the Gateway is given to answer, and a process to end. */
const GATEWAY_MS = 10_000
const RETRY_MS = 30_000
const PROCESS_MS = 20_000

/** [command] from the caller's PATH, as the person runs it; never a shell. [timeoutMs] is for tests. */
export const runCommand = (command: string, args: string[], timeoutMs = PROCESS_MS): ReturnType<RunCommand> => new Promise((done) => {
  execFile(command, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
    if (!error) return done({ code: 0, stdout: String(stdout), stderr: String(stderr) })
    const { code, killed } = error as { code?: unknown; killed?: boolean }
    const name = command.split(/[\\/]/).pop()
    const why = code === 'ENOENT' ? `${name} is not on the PATH here` : killed ? `${name} did not answer within ${timeoutMs / 1000} s` : ''
    done({ code: typeof code === 'number' ? code : null, stdout: String(stdout), stderr: why || String(stderr) || error.message })
  })
})

/** Every OpenClaw key a program's harness has used: the one Harness launched it with, and the one it is bound to now
 *  when that is another (`/new` moves the pane to `agent:main:tui-<uuid>`, and the first key keeps its conversation). */
export function openclawKeys(agentId: string, sessionId: string | null | undefined): string[] {
  const launched = `agent:main:harness-${agentId}`
  return sessionId && sessionId !== launched ? [launched, sessionId] : [launched]
}

/** One line of what a process said, for a sentence: control characters gone, no closing stop, at most 200 characters. */
const said = (text: string): string =>
  text.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200).replace(/[.\s]+$/, '')

/** The Gateway's answer in what `openclaw gateway call --json` printed (an object, pretty-printed), or null. */
function answerOf(stdout: string): Record<string, unknown> | null {
  const from = stdout.indexOf('{'), to = stdout.lastIndexOf('}')
  if (from < 0 || to < from) return null
  // From a `{` to a `}`: an object, when it parses at all.
  try { return JSON.parse(stdout.slice(from, to + 1)) as Record<string, unknown> } catch { return null }
}

/**
 * Deletes OpenClaw session [key] and its transcript through the Gateway. `deleted` once the Gateway says it deleted it;
 * `none` when it had no such session; `kept`, with why, for a key that is not a harness's own, a Gateway that did not
 * answer, or one that refused. OpenClaw keeps a deleted session's transcript in its own archive of deleted sessions, and
 * the answer says so when it did.
 */
export async function deleteOpenclawSession(key: string, run: RunCommand = runCommand): Promise<SessionDeletion> {
  if (!/^agent:[^:\s]+:\S+$/.test(key) || /^agent:[^:]+:main$/.test(key)) {
    return { key, state: 'kept', detail: `${key} is not a session Harness started, so it was not deleted` }
  }
  const call = (ms: number) => run('openclaw', ['gateway', 'call', 'sessions.delete', '--params', JSON.stringify({ key, deleteTranscript: true }), '--json', '--timeout', String(ms)])
  const ran = await call(GATEWAY_MS)
  let answer = ran.code === 0 ? answerOf(ran.stdout) : null
  // A busy Gateway can finish the delete after the call gave up (18.5 s on a loaded Mac, #4393): asked once more, with
  // longer to answer, before saying it was kept. Holding no such session then, the first call deleted it.
  let late = false
  if (!answer || answer.ok !== true) {
    const again = await call(RETRY_MS)
    const second = again.code === 0 ? answerOf(again.stdout) : null
    if (!second || second.ok !== true) {
      const why = said(ran.stderr) || said(ran.stdout) || (ran.code === null ? 'openclaw could not be run' : `openclaw exited with status ${ran.code}`)
      return { key, state: 'kept', detail: `OpenClaw's Gateway did not delete it (${why})` }
    }
    answer = second
    late = true
  }
  if (answer.deleted !== true) {
    return late ? { key, state: 'deleted', detail: 'OpenClaw\'s Gateway answered late; asked again, it no longer holds the session' }
      : { key, state: 'none', detail: 'OpenClaw\'s Gateway had no such session' }
  }
  const archived = Array.isArray(answer.archived) ? answer.archived.length : 0
  return { key, state: 'deleted', ...(archived ? { detail: 'OpenClaw keeps its transcript in its own archive of deleted sessions' } : {}) }
}

export interface HermesDeps {
  run?: RunCommand
  /** Whether Hermes's store holds exactly session [id]: true, false, or null when it cannot be read. */
  holds?: (id: string) => Promise<boolean | null>
}

/** Whether the Hermes store of this caller (`HERMES_HOME`, as Hermes resolves it) holds exactly session [id]. */
export async function hermesHolds(id: string, database = hermesDbPath(env.HERMES_HOME)): Promise<boolean | null> {
  const read = await sqliteReadAll(database, 'SELECT id FROM sessions WHERE id = ?;', [id])
  return read.ok ? read.rows.length > 0 : null
}

/**
 * Deletes Hermes session [id], its messages and files, as Hermes deletes them (`hermes sessions delete --yes`): one
 * transaction its own triggers keep whole. `none` when the store holds no such session; `kept`, with why, when it
 * cannot be read or Hermes did not say it deleted it.
 */
export async function deleteHermesSession(id: string, deps: HermesDeps = {}): Promise<SessionDeletion> {
  const holds = await (deps.holds ?? hermesHolds)(id)
  if (holds === null) return { key: id, state: 'kept', detail: 'Hermes\'s store could not be read here, so nothing was deleted' }
  if (!holds) return { key: id, state: 'none', detail: 'Hermes\'s store has no such session' }
  const ran = await (deps.run ?? runCommand)('hermes', ['sessions', 'delete', '--yes', id])
  if (ran.code === 0 && ran.stdout.includes(`Deleted session '${id}'`)) return { key: id, state: 'deleted' }
  const why = said(ran.stderr) || said(ran.stdout) || (ran.code === null ? 'hermes could not be run' : `hermes exited with status ${ran.code}`)
  return { key: id, state: 'kept', detail: `Hermes did not delete it (${why})` }
}
