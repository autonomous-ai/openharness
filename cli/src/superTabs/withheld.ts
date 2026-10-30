/** How long a delivery may wait for an idle terminal before the conversation is told. */
export const WAITING_NOTICE_AFTER_MS = 30_000

/** The reasons the backend can put into words. Anything else the core invents is told as `team_waiting_unavailable`. */
const NOTICE_REASONS = ['team_waiting_unavailable', 'team_waiting_user', 'team_waiting_draft', 'team_waiting_idle', 'team_waiting_control']
export const noticeReason = (reason: string): string => NOTICE_REASONS.includes(reason) ? reason : 'team_waiting_unavailable'

interface Wait { since: number; reason: string; noticed: boolean; retryAt: number }
export interface WithheldReading {
  /** The reason differs from the one last recorded, so it is worth one log line. */
  changed: boolean
  waitedMs: number
  /** The conversation is owed its one notice. */
  noticeDue: boolean
}

/**
 * Remembers, per delivery, why the core keeps holding it back and since when. On 2026-10-21 (10:44:57-10:49:25) an
 * idle Claude pane was refused 266 times and nothing said why, neither in harness.log nor to the people waiting.
 */
export class WithheldDeliveries {
  private readonly waits = new Map<string, Wait>()

  record(deliveryId: string, reason: string, now: number): WithheldReading {
    const known = this.waits.get(deliveryId)
    const wait = known ?? { since: now, reason, noticed: false, retryAt: 0 }
    this.waits.set(deliveryId, wait)
    const changed = !known || known.reason !== reason
    wait.reason = reason
    const waitedMs = now - wait.since
    return { changed, waitedMs, noticeDue: !wait.noticed && waitedMs >= WAITING_NOTICE_AFTER_MS && now >= wait.retryAt }
  }

  noticed(deliveryId: string): void {
    const wait = this.waits.get(deliveryId)
    if (wait) wait.noticed = true
  }

  /** The notice is being posted. If it fails, it is asked for again after another interval, not on every retry. */
  noticeStarted(deliveryId: string, now: number): void {
    const wait = this.waits.get(deliveryId)
    if (wait) wait.retryAt = now + WAITING_NOTICE_AFTER_MS
  }

  clear(deliveryId: string): void { this.waits.delete(deliveryId) }
}
