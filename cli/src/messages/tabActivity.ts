/**
 * A shared tab's working state across accounts (1c spec, seam 1): another account's harness in a tab shows its spinner
 * in the tab row, which the observer channel never fed (step 0). Each daemon sends its own listed harnesses' state to
 * the tab's machines of other accounts on a change, and renews working before the receiver's lease runs out.
 */
import { cleanSummary } from '../lib/activitySummary.js'
export type ActivityState = 'working' | 'idle' | 'unknown'
/** `summary`: one line, at most SUMMARY_MAX characters, of what the harness does (lib/activitySummary.ts). */
export type SharedActivity = { sharedTabId: string; machineId: string; agentId: string; state: ActivityState; validForMs: number; summary?: string }
export type ActivityNow = { state: ActivityState; summary?: string }
export const ACTIVITY_RENEW_MS = 20_000
/** As long as the core's own working lease (lib/turnActivity.ts WORK_EVIDENCE_MS): a sender that went away is not
 *  shown working for longer than its own windows would show it. */
export const ACTIVITY_LEASE_MS = 30_000
/** A machine that answered `activity` with an unknown action (a 1b daemon) is not asked again for this long. */
export const ACTIVITY_REFUSED_MS = 10 * 60_000
/** How long a harness that went idle stays in what the windows are given, when it has a summary to show: the sender
 *  tells idle once, and a window that opens later still shows what the harness last did. */
export const ACTIVITY_IDLE_KEEP_MS = 10 * 60_000
const FRAME_MS = 1_000, AGENTS_MAX = 64
const STATES = new Set<ActivityState>(['working', 'idle', 'unknown'])

export class ActivityOut {
  private sent = new Map<string, Map<string, { state: ActivityState; summary?: string; at: number }>>()
  private refusedAt = new Map<string, number>()
  /** What to send: a change of state, a changed summary (a new prompt under the same state), and working renewed. */
  due(sharedTabId: string, now: number, current: Record<string, ActivityNow>): Array<{ agentId: string } & ActivityNow> {
    const last = this.sent.get(sharedTabId) ?? new Map<string, { state: ActivityState; summary?: string; at: number }>()
    this.sent.set(sharedTabId, last)
    const out: Array<{ agentId: string } & ActivityNow> = []
    for (const [agentId, { state, summary }] of Object.entries(current)) {
      const was = last.get(agentId)
      if (was && was.state === state && was.summary === summary && (state !== 'working' || now - was.at < ACTIVITY_RENEW_MS)) continue
      last.set(agentId, { state, ...(summary !== undefined ? { summary } : {}), at: now })
      out.push({ agentId, state, ...(summary !== undefined ? { summary } : {}) })
    }
    return out.slice(0, AGENTS_MAX)
  }
  refused(sharedTabId: string, machineId: string, now: number): void { this.refusedAt.set(`${sharedTabId} ${machineId}`, now) }
  refusing(sharedTabId: string, machineId: string, now: number): boolean {
    const at = this.refusedAt.get(`${sharedTabId} ${machineId}`)
    return at !== undefined && now - at < ACTIVITY_REFUSED_MS
  }
  forget(sharedTabId: string): void { this.sent.delete(sharedTabId) }
  /** Forget every tab but these: those left, removed or revoked. */
  prune(held: ReadonlySet<string>): void { for (const id of [...this.sent.keys()]) if (!held.has(id)) this.forget(id) }
}

export class ActivityIn {
  private heard = new Map<string, { activity: SharedActivity; at: number }>()
  private lastFrame = new Map<string, number>()
  take(sharedTabId: string, machineId: string, agents: unknown, listed: (agentId: string) => boolean, now: number): SharedActivity[] {
    const k = `${sharedTabId} ${machineId}`
    const last = this.lastFrame.get(k)
    if (last !== undefined && now - last < FRAME_MS) return []
    this.lastFrame.set(k, now)
    if (!Array.isArray(agents)) return []
    const taken: SharedActivity[] = []
    for (const a of agents.slice(0, AGENTS_MAX)) {
      if (!a || typeof a !== 'object') continue
      const { agentId, state, summary } = a as Record<string, unknown>
      if (typeof agentId !== 'string' || !STATES.has(state as ActivityState) || !listed(agentId)) continue
      // Another account's words: one line however it was sent, cut and cleaned here whatever the sender did.
      const line = cleanSummary(summary)
      const activity: SharedActivity = { sharedTabId, machineId, agentId, state: state as ActivityState, validForMs: state === 'working' ? ACTIVITY_LEASE_MS : 0, ...(line ? { summary: line } : {}) }
      this.heard.set(`${k} ${agentId}`, { activity, at: now })
      taken.push(activity)
    }
    return taken
  }
  /** What the windows should show now: working harnesses whose lease has not run out, with what is left of it, and
   *  those not working that carry a summary, for ACTIVITY_IDLE_KEEP_MS after they were heard. */
  snapshot(now: number): SharedActivity[] {
    return [...this.heard.values()].flatMap(({ activity, at }) => {
      if (activity.state !== 'working') return activity.summary && now - at < ACTIVITY_IDLE_KEEP_MS ? [activity] : []
      const left = ACTIVITY_LEASE_MS - (now - at)
      return left > 0 ? [{ ...activity, validForMs: left }] : []
    })
  }
  /** One harness as last heard (`tab_activity`): working only within its lease, since a sender that went away is not
   *  working for longer than that; idle as it was told, once. Undefined for one never heard from. */
  of(sharedTabId: string, machineId: string, agentId: string, now: number): ActivityNow | undefined {
    const heard = this.heard.get(`${sharedTabId} ${machineId} ${agentId}`)
    if (!heard) return undefined
    const { state, summary } = heard.activity
    if (state === 'working' && now - heard.at >= ACTIVITY_LEASE_MS) return { state: 'unknown' }
    return { state, ...(summary ? { summary } : {}) }
  }
  forget(sharedTabId: string): void {
    for (const k of [...this.heard.keys()]) if (k.startsWith(`${sharedTabId} `)) this.heard.delete(k)
    for (const k of [...this.lastFrame.keys()]) if (k.startsWith(`${sharedTabId} `)) this.lastFrame.delete(k)
  }
  /** Forget every tab but these: those left, removed or revoked. */
  prune(held: ReadonlySet<string>): void {
    for (const id of new Set([...this.heard.keys(), ...this.lastFrame.keys()].map((k) => k.slice(0, k.indexOf(' '))))) if (!held.has(id)) this.forget(id)
  }
}
