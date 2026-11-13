/**
 * Why this shell cannot reach the daemon, in words for the person or the agent that asked.
 *
 * A sandbox keeps a command from the daemon's socket and port, and even from the signal that asks whether its
 * process is alive (EPERM). Codex runs an agent's commands in one on macOS. Harness told such an agent "Harness is
 * not running here. Start it with `harness start`": it ran `harness start`, which crashed on the spawn lock, then
 * asked the person "May I start the Harness adapter?" while Harness was running all along (a fresh Mac, 2026-10-12).
 *
 * "Harness is running" needs the daemon's process as well as a sandbox. Measured with `codex sandbox` 0.162.1
 * (2026-10-11): seatbelt refuses a connect to a loopback port nobody listens on with EPERM too, and Codex marks every
 * command it sandboxes whether or not Harness runs; but kill(pid, 0) still answers ESRCH for a pid that is gone. With a
 * sandbox and no daemon, the agent is told to start Harness outside the sandbox, where `harness start` can write.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config/env.js'

export const NOT_RUNNING = 'Harness is not running here. Start it with `harness start`.'
/**
 * Where Harness set Codex up, its rules run a `harness` agent command outside the sandbox only when every command in
 * the line is one (codex-rs core/src/exec_policy.rs, 0.162.1): `harness wait x; echo $?` is sandboxed and lands here.
 * Run alone, it needs no escalation; where Harness has no rules, it does.
 */
export const SANDBOXED = 'Harness is running, but a sandbox keeps this shell from reaching it (Codex runs commands in one). '
  + 'Run this harness command by itself, not piped or joined with other commands: Harness lets Codex run it outside the '
  + 'sandbox then, without asking. If it is still blocked, run it outside the sandbox. Harness needs no starting.'
/** Nothing running, and the sandbox refuses `harness start` its data folder as well (mkdir EPERM). */
export const START_OUTSIDE = 'Harness is not running here, and this sandbox keeps it from starting. '
  + 'Run `harness start` outside the sandbox (with escalated permissions).'

export interface SandboxEvidence {
  /** What failed: a connection's or a file's error. */
  error?: unknown
  /** The daemon's pid, as its pid file names it. */
  pid?: number | null
  env?: NodeJS.ProcessEnv
  signal?: (pid: number, signal: 0) => void
}

/** The daemon's pid, as the pid file in [dataDir] names it (lib/daemonState.ts `PID_FILE`). */
export function pidIn(dataDir: string): number | null {
  try {
    const pid = parseInt(readFileSync(join(dataDir, 'adapter.pid'), 'utf8').trim(), 10)
    return pid > 0 ? pid : null
  } catch { return null }
}

/** A connection or a file refused by a policy on the way, not by a daemon that is not there (ECONNREFUSED, ENOENT). */
export function refused(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES'
}

/** Codex marks every command it runs in its sandbox: CODEX_SANDBOX=seatbelt on macOS, and CODEX_SANDBOX_NETWORK_DISABLED
 *  wherever the network is off. */
const codexSandbox = (env: NodeJS.ProcessEnv): boolean => !!env.CODEX_SANDBOX || !!env.CODEX_SANDBOX_NETWORK_DISABLED

/** Whether a sandbox, not a stopped daemon, is what this shell runs into: the daemon's process is there, and a sandbox
 *  is in the way. */
export function sandboxed({ error, pid = null, env = process.env, signal = (p, s) => { process.kill(p, s) } }: SandboxEvidence = {}): boolean {
  if (pid === null) return false
  try { signal(pid, 0) } catch (failure) {
    // Gone. Refused, it is there, and asking was not permitted: a sandbox.
    return (failure as NodeJS.ErrnoException).code === 'EPERM'
  }
  return refused(error) || codexSandbox(env)
}

/** What to say when the daemon cannot be reached. */
export function unreachableText(evidence: SandboxEvidence = {}): string {
  if (sandboxed(evidence)) return SANDBOXED
  return codexSandbox(evidence.env ?? process.env) ? START_OUTSIDE : NOT_RUNNING
}

/** What to say when this shell cannot reach the daemon of [dataDir]: stopped, or out of reach in a sandbox. The agent
 *  verbs reach the daemon that made their pane, whose folder may not be this CLI's. */
export function daemonUnreachableText(error?: unknown, dataDir: string = env.ADAPTER_DATA_DIR): string {
  return unreachableText({ error, pid: pidIn(dataDir) })
}

/** What `harness start` says for [evidence.error] in place of the error itself, or null when it is no sandbox's doing:
 *  outside a sandbox, EPERM on the data folder is a permissions problem, shown as it is. */
export function startRefusalText(evidence: SandboxEvidence): string | null {
  if (!refused(evidence.error)) return null
  const text = unreachableText(evidence)
  return text === NOT_RUNNING ? null : text
}
