/**
 * A ceiling on a machine starting turns in a loop (Stability 3.2).
 *
 * A person starts a turn, reads the answer and starts another: seconds to minutes apart. An older CLI was measured
 * sending 106k turn-start signals a day, each one counted and relayed to every app watching. After
 * SHORT_TURN_RUN_MAX turn starts in a row each under SHORT_TURN_GAP_MS after the one before, the next ones are neither
 * counted nor relayed for SHORT_TURN_PAUSE_MS; the run starts again after that. The turns themselves run on the
 * machine, untouched; only the server's work for each signal stops.
 */
export const SHORT_TURN_GAP_MS = 10_000
export const SHORT_TURN_RUN_MAX = 20
export const SHORT_TURN_PAUSE_MS = 60_000

export type ShortTurnVerdict = 'relay' | 'pause_started' | 'paused'

export class ShortTurnGuard {
  private lastAt: number | undefined
  private run = 0
  private pausedUntil = 0

  constructor(private readonly now: () => number = () => Date.now()) {}

  admit(): ShortTurnVerdict {
    const at = this.now()
    if (at < this.pausedUntil) return 'paused'
    if (this.pausedUntil) {
      this.pausedUntil = 0
      this.lastAt = undefined
      this.run = 0
    }
    this.run = this.lastAt !== undefined && at - this.lastAt < SHORT_TURN_GAP_MS ? this.run + 1 : 0
    this.lastAt = at
    if (this.run <= SHORT_TURN_RUN_MAX) return 'relay'
    this.pausedUntil = at + SHORT_TURN_PAUSE_MS
    return 'pause_started'
  }
}
