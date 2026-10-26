/**
 * Before Harness resumes a Claude Code session in a pane (`claude --resume <sessionId>`), stop any
 * `claude --bg` background job still holding that SAME session: Claude Code refuses the resume while
 * one is live ("that session is running in the background (<short>). Run `claude attach …` or
 * `claude stop …` first"), and the pane fell back to a shell. Claude engine only — see `launch.ts`'s
 * `resumeArgs`.
 *
 * `claude agents --help` (2.1.283): "--all  With --json: also include completed background sessions."
 * Left out, the listing is already live-only — measured locally, a failed job present with `--all`
 * disappears without it — so this never has to guess which state strings still mean "running" (an
 * allow-list of today's state strings would silently stop matching once Claude Code shipped a new one).
 *
 * Every failure — a `claude` with no `agents`/`stop` subcommand, a listing that errors, output that is
 * not the JSON array documented — is swallowed into a no-op. A background job this cannot read or stop
 * must never block the resume it exists to unblock; the resume still runs and reports Claude Code's own
 * refusal if the job really is in the way.
 */
import { execFile } from 'node:child_process'
import { patientExec } from './patientExec.js'

export interface ClaudeAgentListEntry {
  id?: string
  sessionId?: string
  kind?: string
  [key: string]: unknown
}

/** `null` means the call did not answer (missing subcommand, non-zero exit, timeout) — never thrown. */
export type ClaudeAgentsExec = (bin: string, args: readonly string[], timeoutMs: number, env?: NodeJS.ProcessEnv) => Promise<string | null>

// A spawn that throws synchronously (EMFILE, a bad binary path) is a failed call too, not a rejected resume.
const defaultExec: ClaudeAgentsExec = (bin, args, timeoutMs, env) => new Promise(resolve => {
  try {
    patientExec(execFile)(bin, args, { timeout: timeoutMs, ...(env ? { env } : {}) },
      (error, stdout) => resolve(error ? null : stdout))
  } catch {
    resolve(null)
  }
})

/** The one live background job (if any) holding the exact session Harness is about to resume. Never a
 *  session id prefix or a different job's: a wrong match would stop someone else's conversation. */
export function conflictingBackgroundJob(entries: readonly ClaudeAgentListEntry[], sessionId: string): ClaudeAgentListEntry | null {
  return entries.find(entry => entry.kind === 'background' && entry.sessionId === sessionId && !!entry.id) ?? null
}

async function liveBackgroundJobs(bin: string, exec: ClaudeAgentsExec, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<ClaudeAgentListEntry[]> {
  const out = await exec(bin, ['agents', '--json'], timeoutMs, env)
  if (out === null) return []
  try {
    const parsed = JSON.parse(out)
    return Array.isArray(parsed) ? parsed as ClaudeAgentListEntry[] : []
  } catch {
    return []
  }
}

export interface StopConflictingBackgroundJobOptions {
  /** The exact Claude binary the resume itself is about to run — never a bare `claude` on PATH, which
   *  could resolve to a different install than the one that owns `~/.claude/jobs`. */
  bin: string
  /** The session id Harness is about to pass to `--resume`. */
  sessionId: string
  /** The environment the resume launch itself will run with (its `CLAUDE_CONFIG_DIR`, grid/gateway
   *  variables): the job list and stop must be read from the SAME jobs store the resume will see. */
  env?: NodeJS.ProcessEnv
  log?: (message: string) => void
  exec?: ClaudeAgentsExec
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  listTimeoutMs?: number
  stopTimeoutMs?: number
  /** The longest this waits for the stopped job to leave the live listing. */
  pollBudgetMs?: number
  pollIntervalMs?: number
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => { const t = setTimeout(resolve, ms); t.unref?.() })

export async function stopConflictingBackgroundJob(options: StopConflictingBackgroundJobOptions): Promise<void> {
  const {
    bin, sessionId, env, log = () => {}, exec = defaultExec, sleep = defaultSleep, now = Date.now,
    listTimeoutMs = 3_000, stopTimeoutMs = 3_000, pollBudgetMs = 5_000, pollIntervalMs = 250,
  } = options
  const shortSession = sessionId.slice(0, 8)
  const job = conflictingBackgroundJob(await liveBackgroundJobs(bin, exec, listTimeoutMs, env), sessionId)
  if (!job?.id) return
  const stopped = await exec(bin, ['stop', job.id], stopTimeoutMs, env)
  if (stopped === null) {
    log(`[resume] could not stop background job ${job.id} holding session ${shortSession} — resuming anyway`)
    return
  }
  log(`[resume] stopped background job ${job.id} holding session ${shortSession}`)
  const deadline = now() + pollBudgetMs
  while (now() < deadline) {
    if (!conflictingBackgroundJob(await liveBackgroundJobs(bin, exec, listTimeoutMs, env), sessionId)) return
    await sleep(pollIntervalMs)
  }
}
