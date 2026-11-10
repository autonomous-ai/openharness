/**
 * A Product Manager runs on its machine's default account alone. In Swarm v4 an agent runs on its own person's computers under
 * their own login, and Desktop dropped the page where a person offered another account of theirs to the Swarm and could take it
 * back (F9): nothing would show them a PM spending it. So lead.switch takes the default account only, whatever an older CLI
 * still reports, and a PM a switch left on another account is moved back by the liveness sweep.
 */

import { agentDisplayName } from './agentNames.js'
import { defaultProfileId, machineOffline, storedProfileId } from './machines.js'
import { fail, stableId, type Agent, type MessageDraft, type SuperTabState } from './model.js'
import { ledProject } from './projects.js'

/** What a host reports it can do for a Product Manager's switch; a host from before it is never asked (HOST_OUTDATED). */
export const SWITCH_CAPABILITY = 'leadSwitch'
/** How many times the sweep asks a PM's machine to move it back before it says it could not. */
export const ACCOUNT_RETURN_TRIES = 3
/** The wait after the first failed try; each later one waits twice as long. */
export const ACCOUNT_RETURN_WAIT_MS = 2 * 60_000

/** The refusal of a switch onto any account but the destination's default one. */
export function defaultAccountOnly(name: string, machine: string): never {
  fail('DEFAULT_ACCOUNT_ONLY', `A ${name} runs on ${machine}'s default account only.`, 403)
}

/**
 * Each PM still on another account of its machine (`profileId`, from a switch before the server took the default alone) is asked
 * to move to its engine's default account there, as Switch PM would, with the model and effort it runs now. The sweep runs on a
 * machine's report at most every 30 seconds, and the PM's machine carries the switch out with a handoff, so the PM keeps its
 * work: one is asked within about 30 seconds of its machine being online with this server. A failed try is asked
 * again after 2, then 4 minutes; after the third its project chat hears once that it is still there. The project chat hears
 * when it starts; the switch's result line says when it is done.
 */
export function pmsToDefaultAccount(state: SuperTabState, now: number): MessageDraft[] {
  const rows: MessageDraft[] = []
  for (const pm of state.agents) {
    if (!pm.profileId && !pm.accountReturn) continue
    const engine = pm.configuration?.engine ?? ''
    if (storedProfileId(pm.machineId, engine, pm.profileId) === undefined) {
      delete pm.accountReturn
      continue
    }
    const project = pm.switchRequest || pm.switchLanded ? undefined : ledProject(state, pm.id)
    if (!project) continue
    const returning = pm.accountReturn, tries = returning?.tries ?? 0
    const pool = state.machines?.find(m => m.machineId === pm.machineId)
    const machine = pool?.name ?? 'its machine'
    if (returning && tries >= ACCOUNT_RETURN_TRIES) {
      if (returning.gaveUp) continue
      returning.gaveUp = true
      rows.push(line(state, pm, project.leadConversationId, stableId('account-return-failed', pm.id, String(returning.at)),
        `The PM still runs on another account on ${machine}: it could not move to the default account. Use Switch PM to move it.`))
      continue
    }
    if (returning && now < returning.at + ACCOUNT_RETURN_WAIT_MS * 2 ** (tries - 1)) continue
    if (!pool || machineOffline(pool, now) || !pool.observation?.capabilities?.includes(SWITCH_CAPABILITY)) continue
    // Its own id each time: a host keeps what it did for a switch id (cli superTabs/leadSwitchRequest.ts).
    const id = stableId('account-return', pm.id, String(now))
    pm.switchRequest = { id, engine, profileId: defaultProfileId(pm.machineId, engine),
      ...(pm.configuration.model ? { model: pm.configuration.model } : {}), ...(pm.configuration.effort ? { effort: pm.configuration.effort } : {}),
      requestedBy: pm.machineOwnerId, at: new Date(now).toISOString() }
    pm.accountReturn = { tries: tries + 1, at: now }
    if (!tries) rows.push(line(state, pm, project.leadConversationId, stableId(id, 'line'), `Moving the PM to ${machine}'s default account.`))
  }
  return rows
}

const line = (state: SuperTabState, pm: Agent, conversationId: string, id: string, text: string): MessageDraft => ({
  id, conversationId, replyTo: null, recipients: [], text, source: { kind: 'switch', agentId: pm.id },
  author: { kind: 'agent', id: pm.id, name: pm.name, displayName: agentDisplayName(state.agents, pm.id), membershipGeneration: pm.membershipGeneration } })
