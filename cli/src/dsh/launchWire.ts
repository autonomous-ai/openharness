/** The Store's launch contribution. Core owns the pane and registry; the Store owns package execution. */
import type { AgentEngine } from '../engines/types.js'
import type { DshAccount, DshLaunch } from './launch.js'

export interface DshMaterializeRequest {
  dsh: string
  workspace: string
  engine: AgentEngine
  account: DshAccount
  /** The create's stable label also identifies its workspace preparation across a lost reply. */
  key: string
}

export interface DshLaunchRequest extends DshMaterializeRequest {
  forkOf?: { agentId: string; dshRuntime: string | null }
}

export interface DshRefusal {
  ok: false
  error: string
  detail: string
  /** A restore holds this launch until the service returns. */
  unavailable?: 'store'
  /** The Store answered, but only this workspace is held; other workspaces can still launch. */
  holdScope?: 'workspace'
  /** Relaunches historically used String(error); create and fork used error.message. */
  thrown?: string
}

export type DshMaterializeAnswer = { ok: true; created: string[]; kept: string[]; warnings: string[] } | DshRefusal
export type DshLaunchAnswer = { ok: true; launch: DshLaunch } | DshRefusal

export function dshUnavailable(name: string): DshRefusal {
  return { ok: false, error: 'DSH_UNAVAILABLE', unavailable: 'store',
    detail: `The Store is not running, so ${name} cannot be prepared for this agent. Try again in a moment.` }
}
