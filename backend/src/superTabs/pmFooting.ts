/**
 * The coordinator's own footing (Ken, 2026-11-05, follow-up to #3134): every built-in wake ends with where its PM runs and
 * how much of its week is left, so it spends its own quota knowing it. Names only, from the machine's last reading; a reading
 * the Swarm does not have leaves the line out rather than guessing it.
 */
import { weeklyUse } from './leaderboard/brought.js'
import type { Agent, MessageDraft, SuperTabState } from './model.js'
import { until } from './othersWork.js'
import { usernameOf } from './usernames.js'

/** The messages the Swarm's built-in schedule wakes the coordinator with: the schedule, the update request, the morning
 *  digest, the notice digest, and the lost, stalled and idle notices. */
const WAKE_KINDS = new Set(['schedule-request', 'update-request', 'digest-request', 'notice-digest', 'work-lost', 'work-stalled', 'idle'])
const MARK = 'You run on '

/** "You run on <machine>, <account>: weekly X% left, resets in <time>." for [pm]'s machine and account, null when the
 *  machine, the account's name or its weekly reading is unknown. A PM on another account (profileId) is named by that
 *  account's label, with that account's own reading, never the machine's default one. A Harness Team account is named as
 *  that, with its Mac's name and the Mac's reading; the default account is its owner's username's, never an email. */
export function pmFooting(state: SuperTabState, pm: Agent, now: number): string | null {
  const pool = state.machines?.find(m => m.machineId === pm.machineId)
  if (!pool) return null
  const home = (pool.hostMachineId && state.machines?.find(m => m.machineId === pool.hostMachineId)) || pool
  const engine = pm.configuration.engine
  let account: string | undefined, usedPercent: number | null, resetsAt: number | null
  if (pm.profileId) {
    const profile = (pool.observation?.profiles ?? []).find(p => p.engine === engine && p.id === pm.profileId)
    if (!profile || profile.leftPercent == null) return null
    account = profile.label
    usedPercent = 100 - profile.leftPercent
    resetsAt = profile.resetsAt ? Date.parse(profile.resetsAt) : null
    if (resetsAt != null && Number.isNaN(resetsAt)) resetsAt = null
  } else {
    const owner = usernameOf(state, pool.contributorId)
    account = pool.hostMachineId ? 'the Harness Team account' : owner && `${owner}'s own account`
    ;({ usedPercent, resetsAt } = weeklyUse(home, engine))
  }
  if (!account || usedPercent == null || !Number.isFinite(usedPercent)) return null
  const left = Math.min(100, Math.max(0, Math.round(100 - usedPercent)))
  return `${MARK}${home.name}, ${account}: weekly ${left}% left${resetsAt == null ? '' : `, resets in ${until(resetsAt, now)}`}.`
}

/** Ends each built-in wake in [drafts] that goes to [pm] with its footing line, once; the other messages and a wake that
 *  already has it stay as they are. */
export function addFooting(state: SuperTabState, pm: Agent, drafts: readonly MessageDraft[], now: number): void {
  const wakes = drafts.filter(d => WAKE_KINDS.has(String(d.source?.kind)) && d.recipients?.includes(pm.id) && !d.text.includes(MARK))
  const line = wakes.length ? pmFooting(state, pm, now) : null
  if (line) for (const draft of wakes) draft.text = `${draft.text}\n\n${line}`
}
