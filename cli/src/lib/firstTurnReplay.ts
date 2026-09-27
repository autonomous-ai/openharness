/**
 * When an attach may emit a transcript LIVE instead of folding it away as history.
 *
 * A session can be announced before its transcript exists, and the announcement that finally carries
 * the path then reports `isNew=false`. Folding that file as history would swallow the agent's first
 * turn, so a transcript born after its agent registered is replayed live, once (cli.ts
 * `attachSessionNow`).
 *
 * "Born after its agent" alone stays true for the whole life of an ordinary session: every fresh
 * session's transcript appears a few seconds after its agent registers. The only other guard against
 * a second replay was an in-memory set, empty after a daemon restart. So the first `SessionStart` a
 * long session fired after a restart (Claude compacting, Codex resuming) replayed its whole history
 * live. Measured on one machine: 3,553 events from a 346 MB Codex rollout overflowed the outbound
 * queue and exhausted the 4 GB heap. The daemon restarted, the next session did the same, and it
 * crashed again every minute or so.
 *
 * The first turn's announcement arrives while the file is new; a transcript that has existed for
 * longer than {@link FIRST_TURN_WINDOW_MS} is history, whatever the daemon remembers.
 */

/** How new a transcript must be for its content to count as the agent's first turn. */
export const FIRST_TURN_WINDOW_MS = 10 * 60_000

export interface FirstTurnCandidate {
  registeredAt: number
  boundAt: number | null
  transcriptPath?: string | null
}

/** Whether this announcement's transcript is the agent's first turn, to be replayed live. */
export function transcriptIsFirstTurn(
  entry: FirstTurnCandidate,
  /** When the transcript file was created, epoch ms; 0 when it could not be read. */
  birthMs: number,
  options: { rebound: boolean; now: number },
): boolean {
  if (options.rebound || entry.boundAt === null || !entry.transcriptPath) return false
  if (entry.boundAt - entry.registeredAt <= 0) return false
  if (birthMs < entry.registeredAt) return false
  return options.now - birthMs < FIRST_TURN_WINDOW_MS
}
