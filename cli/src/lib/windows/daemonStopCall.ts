/**
 * `harness stop` on Windows, the CLI's half: POST /api/daemon/stop to the core over the daemon's pipe, which asks its
 * master to stop everything (core/daemonStopRoute.ts). The pipe, its token and the dead-process check come from
 * ./daemonPipe.ts `daemonPipe`; the auth (a nonce bound to the pipe's id) and the proof check from
 * ./pipeClient.ts `pipeRequest`. Reaching the pipe proves nothing on Windows, so only an answer with the token's
 * proof counts: a process that took the pipe's name after the daemon died is never believed.
 */
import { daemonPipe } from './daemonPipe.js'
import { pipeRequest, type PipeReply, type PipeRequest, type PipeTarget } from './pipeClient.js'

export const DAEMON_STOP_PATH = '/api/daemon/stop'
/** The core answers at once and stops after: a pipe that holds the call longer is not the daemon. */
export const STOP_CALL_TIMEOUT_MS = 3_000

export interface StopCallDeps {
  /** The daemon's pipe and token (./daemonPipe.ts `daemonPipe`); null when there is none to dial. */
  pipe(): Promise<PipeTarget | null>
  /** One proven request (./pipeClient.ts `pipeRequest`): it rejects an answer without the token's proof. */
  request(target: PipeTarget, request: PipeRequest): Promise<PipeReply>
}

export function processStopCallDeps(dataDir: string, configuredPort: number): StopCallDeps {
  return { pipe: () => daemonPipe(dataDir, configuredPort), request: pipeRequest }
}

/** Whether the daemon took the stop: it answered 202, with the token's proof. */
export async function askDaemonToStop(deps: StopCallDeps): Promise<boolean> {
  const target = await deps.pipe().catch(() => null)
  if (!target) return false
  try {
    const reply = await deps.request(target, {
      method: 'POST', path: DAEMON_STOP_PATH, headers: { 'x-adapter-local': '1' }, timeoutMs: STOP_CALL_TIMEOUT_MS, maxBytes: 4_096,
    })
    return reply.status === 202
  } catch {
    // PipeUnproven (not this user's daemon), nothing listening, or no answer in time: not taken.
    return false
  }
}
