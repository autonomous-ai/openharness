/**
 * A harness package's part of a launch, as every launch in the core asks the Store for it (`StorePort`, core/api.ts;
 * docs/design/2026-10-08-launch-port.md, (L3)): its answer, or, when the Store is down or answers nothing usable,
 * `DSH_UNAVAILABLE` naming the package, never a wait past the call's bound (core/serviceLinks.ts) and never a launch
 * without the harness. The core checks the installed index itself before asking, and says so in its own words.
 */
import type { DshAccount } from '../../dsh/launch.js'
import { dshUnavailable, type DshLaunchAnswer, type DshLaunchRequest, type DshMaterializeAnswer, type DshMaterializeRequest } from '../../dsh/launchWire.js'
import type { AgentEngine } from '../../engines/types.js'
import type { DshRelaunch } from '../../lib/launchOverrides.js'
import type { StorePort } from '../api.js'

export interface DshThroughDeps {
  store: () => Pick<StorePort, 'dshMaterialize' | 'dshLaunch'>
  /** The package's own name ("Drawing") for a refusal, from the installed index; its id when it has none there. */
  nameOf: (dsh: string) => string | undefined
  /** Whether the installed index has the package: a relaunch of one it does not have asks nothing. */
  installed: (dsh: string) => boolean
  /** What the package is told of the account (its private grid) at a relaunch, as the socket knows it now. */
  account: () => DshAccount
}

export function dshThrough({ store, nameOf, installed, account }: DshThroughDeps) {
  const unavailable = (dsh: string) => dshUnavailable(nameOf(dsh) ?? dsh)
  const materialize = async (request: DshMaterializeRequest): Promise<DshMaterializeAnswer> => {
    try { return await store().dshMaterialize(request) } catch { return unavailable(request.dsh) }
  }
  const launch = async (request: DshLaunchRequest): Promise<DshLaunchAnswer> => {
    try { return await store().dshLaunch(request) } catch { return unavailable(request.dsh) }
  }
  /** A relaunch's part (launchOverrides.ts `dshLaunch`): the refusals in the words a relaunch always used. */
  const relaunch = async (dsh: string, workspace: string, engine: AgentEngine, key: string): Promise<DshRelaunch> => {
    const missing = (): DshRelaunch => {
      console.warn(`[dsh] ${dsh} is not installed on this machine · cannot restore its harness context`)
      return { ok: false, error: 'DSH_NOT_INSTALLED', detail: `${dsh} is not installed on this machine` }
    }
    if (!installed(dsh)) return missing()
    const answer = await launch({ dsh, workspace, engine, key, account: account() })
    if (answer.ok) return answer
    // Gone from the Store's index since the core read its own: the same answer, a moment later.
    if (answer.error === 'DSH_NOT_INSTALLED') return missing()
    return { ok: false, error: answer.error, detail: answer.thrown ?? answer.detail }
  }
  return { materialize, launch, relaunch }
}
