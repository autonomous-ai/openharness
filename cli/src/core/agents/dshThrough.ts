/** The launch port's Store contribution, including the reason a restore must remain held. */
import type { DshAccount } from '../../dsh/launch.js'
import { realpath } from 'node:fs/promises'
import { setUpWithin } from '../../lib/setUpWithin.js'
import { dshUnavailable, type DshDescribeRequest, type DshLaunchRequest, type DshMaterializeRequest } from '../../dsh/launchWire.js'
import type { AgentEngine } from '../../engines/types.js'
import type { StorePort } from '../api.js'
import { dshContextAnswerIn, dshDescriptionIn, dshLaunchAnswerIn, dshMaterializeAnswerIn, type DshLaunchIdentity } from '../storeLink.js'

/** A slow/unavailable workspace holds this launch; it cannot pin the core's event loop. */
export async function captureDshWorkspace(workspace: string, read: (path: string) => Promise<string> = realpath): Promise<string | null> {
  let captured: string | null = null
  await setUpWithin(async () => { captured = await read(workspace) }, 5_000)
  return captured
}

export function dshThrough({ store, nameOf, account }: {
  store: () => StorePort
  nameOf: (id: string) => string | undefined
  account: () => DshAccount
}) {
  const unavailable = (id: string) => dshUnavailable(nameOf(id) ?? id)
  const describe = async (dsh: string, engine: AgentEngine) => {
    try {
      const answer = dshDescriptionIn(await store().dshDescribe({ dsh, engine }))
      if (!answer) console.warn('[store] PACKAGE_FACTS_REFUSED')
      return answer ?? unavailable(dsh)
    }
    catch { return unavailable(dsh) }
  }
  const context = async (request: DshDescribeRequest) => {
    try { return dshContextAnswerIn(await store().dshContext(request)) ?? unavailable(request.dsh) }
    catch { return unavailable(request.dsh) }
  }
  const materialize = async (request: DshMaterializeRequest) => {
    try { return dshMaterializeAnswerIn(await store().dshMaterialize(request)) ?? unavailable(request.dsh) }
    catch { return unavailable(request.dsh) }
  }
  const launch = async (request: DshLaunchRequest, identity?: DshLaunchIdentity) => {
    const captured = { ...request, account: { ...request.account } }
    const trusted = identity ? { workspace: identity.workspace, ...(identity.ids ? { ids: [...identity.ids] } : {}) } : undefined
    try {
      const answer = dshLaunchAnswerIn(await store().dshLaunch(request), captured, trusted)
      if (!answer) console.warn('[store] LAUNCH_CONTRIBUTION_REFUSED')
      return answer ?? unavailable(request.dsh)
    }
    catch { return unavailable(request.dsh) }
  }
  const relaunch = async (dsh: string, workspace: string, engine: AgentEngine, key: string) => {
    // Ask the Store before declaring a saved package missing: it may still be preparing its index.
    const capturedAccount = { ...account() }
    const captured = await captureDshWorkspace(workspace)
    if (!captured) return { ok: false as const, error: 'DSH_WORKSPACE_MISSING', detail: `${dsh} has no saved workspace` }
    // A historical snapshot may retain an earlier package id/directory. Those remain Store's
    // package authority; the independently captured workspace and key do not come from its reply.
    const answer = await launch({ dsh, workspace, engine, key, account: capturedAccount }, { workspace: captured })
    if (answer.ok) return answer
    if (answer.error === 'DSH_NOT_INSTALLED') console.warn(`[dsh] ${dsh} is not installed on this machine · cannot restore its harness context`)
    return { ...answer, detail: answer.thrown ?? answer.detail }
  }
  return { describe, context, materialize, launch, relaunch }
}

export type DshThrough = ReturnType<typeof dshThrough>
