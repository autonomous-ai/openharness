/** The launch port's Store contribution, including the reason a restore must remain held. */
import type { DshAccount } from '../../dsh/launch.js'
import { dshUnavailable, type DshLaunchRequest, type DshMaterializeRequest } from '../../dsh/launchWire.js'
import type { AgentEngine } from '../../engines/types.js'
import type { StorePort } from '../api.js'
import { dshLaunchAnswerIn, dshMaterializeAnswerIn } from '../storeLink.js'

export function dshThrough({ store, nameOf, account }: {
  store: () => StorePort
  nameOf: (id: string) => string | undefined
  account: () => DshAccount
}) {
  const unavailable = (id: string) => dshUnavailable(nameOf(id) ?? id)
  const materialize = async (request: DshMaterializeRequest) => {
    try { return dshMaterializeAnswerIn(await store().dshMaterialize(request)) ?? unavailable(request.dsh) }
    catch { return unavailable(request.dsh) }
  }
  const launch = async (request: DshLaunchRequest) => {
    try { return dshLaunchAnswerIn(await store().dshLaunch(request)) ?? unavailable(request.dsh) }
    catch { return unavailable(request.dsh) }
  }
  const relaunch = async (dsh: string, workspace: string, engine: AgentEngine, key: string) => {
    // Ask the Store before declaring a saved package missing: it may still be preparing its index.
    const answer = await launch({ dsh, workspace, engine, key, account: account() })
    if (answer.ok) return answer
    if (answer.error === 'DSH_NOT_INSTALLED') console.warn(`[dsh] ${dsh} is not installed on this machine · cannot restore its harness context`)
    return { ...answer, detail: answer.thrown ?? answer.detail }
  }
  return { materialize, launch, relaunch }
}

export type DshThrough = ReturnType<typeof dshThrough>
