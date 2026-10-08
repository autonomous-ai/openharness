/**
 * A harness package's part of a launch, as the core asks the Store for it (`StorePort`, core/api.ts) and the
 * Store answers (services/storeLaunch.ts): the core keeps the installed index and the checks it makes before
 * asking; the Store lays the workspace out and prepares each session's runtime (docs/design/2026-10-08-launch-port.md,
 * (L3)). Types only, and the one refusal the core gives when the Store cannot be asked.
 */
import type { AgentEngine } from '../engines/types.js'
import type { DshAccount, DshLaunch } from './launch.js'

/** A create's workspace: the package's template and its init, before the session is prepared. */
export interface DshMaterializeRequest {
  dsh: string
  workspace: string
  engine: AgentEngine
  account: DshAccount
}

/** What was laid out (`template → <folder>` when the template went in), what was kept, and what could not be done:
 *  never fatal. Or why the workspace could not be prepared at all. */
export type DshMaterializeAnswer =
  | { ok: true; created: string[]; kept: string[]; warnings: string[] }
  | { ok: false; error: string; detail: string }

/** A session's runtime: created under `key`, or read back from it on a relaunch; a fork's copied from its source. */
export interface DshLaunchRequest {
  dsh: string
  workspace: string
  engine: AgentEngine
  key: string
  account: DshAccount
  /** The agent a fork is made from: its runtime, as the row names it or as one made before rows named it. */
  forkOf?: { agentId: string; dshRuntime: string | null }
}

/**
 * The package's env and args for this session, or why not: `DSH_NOT_INSTALLED`, or `DSH_RUNTIME_FAILED` with the
 * reason (`detail`) and the error as a relaunch always said it (`thrown`).
 */
export type DshLaunchAnswer =
  | { ok: true; launch: DshLaunch }
  | { ok: false; error: string; detail: string; thrown?: string }

/** The refusal a launch that needs the Store gets while it cannot be asked: never a launch without the harness. */
export function dshUnavailable(name: string): { ok: false; error: 'DSH_UNAVAILABLE'; detail: string } {
  return {
    ok: false,
    error: 'DSH_UNAVAILABLE',
    detail: `The Store is not running, so ${name} cannot be prepared for this agent. Try again in a moment.`,
  }
}
