/**
 * What `harness close <name> --program-token-file <p> --forget` (#4393) deletes in an engine's own store, beside what
 * Harness keeps (its `agent_purge`). Harness never writes OpenClaw's store (engines/openclaw/contract.ts
 * `OPENCLAW_STORE_KEPT`): the session is OpenClaw's Gateway's to delete, by its `sessions.delete` method, called here as
 * OpenClaw's own CLI calls it (`openclaw gateway call`), with the caller's OpenClaw config and Gateway token. Only a
 * program's own harness's session is ever named, and never the agent's `main` one (the Gateway refuses that too).
 */
import { execFile } from 'node:child_process'

/** What became of a conversation: deleted, none to delete, or kept (with why). */
export type Deletion = { state: 'deleted' | 'none' | 'kept'; detail?: string }

/** How `openclaw` is run: its exit code (null when it could not run, or was stopped) and what it printed. */
export type RunOpenclaw = (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>

/** How long the Gateway is given to answer, and the process to end. */
const GATEWAY_MS = 10_000
const PROCESS_MS = 20_000

/** `openclaw` from the caller's PATH, as the person runs it; never a shell. [command] and [timeoutMs] are for tests. */
export const runOpenclaw = (args: string[], command = 'openclaw', timeoutMs = PROCESS_MS): ReturnType<RunOpenclaw> => new Promise((done) => {
  execFile(command, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
    if (!error) return done({ code: 0, stdout: String(stdout), stderr: String(stderr) })
    const { code, killed } = error as { code?: unknown; killed?: boolean }
    const why = code === 'ENOENT' ? 'openclaw is not on the PATH here' : killed ? `openclaw did not answer within ${timeoutMs / 1000} s` : ''
    done({ code: typeof code === 'number' ? code : null, stdout: String(stdout), stderr: why || String(stderr) || error.message })
  })
})

/** The session key of a program's OpenClaw harness: the bound one, else the one Harness launched it with. */
export function openclawKey(agentId: string, sessionId: string | null | undefined): string {
  return sessionId || `agent:main:harness-${agentId}`
}

/** One line of what a process said, for a sentence: control characters gone, at most 200 characters. */
const said = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)

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
export async function deleteOpenclawSession(key: string, run: RunOpenclaw = runOpenclaw): Promise<Deletion> {
  if (!/^agent:[^:\s]+:\S+$/.test(key) || /^agent:[^:]+:main$/.test(key)) {
    return { state: 'kept', detail: `${key} is not a session Harness started, so it was not deleted` }
  }
  const ran = await run(['gateway', 'call', 'sessions.delete', '--params', JSON.stringify({ key, deleteTranscript: true }), '--json', '--timeout', String(GATEWAY_MS)])
  const answer = ran.code === 0 ? answerOf(ran.stdout) : null
  if (!answer || answer.ok !== true) {
    const why = said(ran.stderr) || said(ran.stdout) || (ran.code === null ? 'openclaw could not be run' : `openclaw exited with status ${ran.code}`)
    return { state: 'kept', detail: `OpenClaw's Gateway did not delete it (${why})` }
  }
  if (answer.deleted !== true) return { state: 'none', detail: 'OpenClaw\'s Gateway had no such session' }
  const archived = Array.isArray(answer.archived) ? answer.archived.length : 0
  return { state: 'deleted', ...(archived ? { detail: 'OpenClaw keeps its transcript in its own archive of deleted sessions' } : {}) }
}
