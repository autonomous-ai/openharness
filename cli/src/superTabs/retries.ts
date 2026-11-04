import { SuperTabHostError } from './wire.js'

/** Refusals no resend of the same command can change (Ken's prod scan, 11-04, #2675): an agent gone or to be shared again, a
 *  conversation gone or unreadable, a Buddy session's post outside its thread, a Buddy machine no longer listed. */
export const PERMANENT_REFUSALS: ReadonlySet<string> = new Set(['AGENT_UNAVAILABLE', 'NOT_FOUND', 'BUDDY_SESSION_THREAD', 'BUDDY_MACHINE'])
export const permanentRefusal = (error: unknown): boolean => error instanceof SuperTabHostError && PERMANENT_REFUSALS.has(error.code)

const FIRST_WAIT_MS = 5_000
const LONGEST_WAIT_MS = 5 * 60_000

/** Whether a command a host sends on its own clock may go now, by key (its operation id: a changed command is a new key).
 *  Never again after a permanent refusal; after any other failure, a wait from 5 s doubling to 5 minutes. Until 11-04 the
 *  host's configuration reports went every 5 s and its alerts every 15 s however the backend answered: 615 and 116 refusals
 *  in 32 minutes. */
export class CommandRetries {
  private readonly held = new Map<string, { failures: number; at: number }>()
  constructor(private readonly now: () => number) {}

  due(key: string): boolean {
    const held = this.held.get(key)
    return !held || this.now() >= held.at
  }

  failed(key: string, error: unknown): void {
    if (permanentRefusal(error)) { this.held.set(key, { failures: 0, at: Infinity }); return }
    const failures = (this.held.get(key)?.failures ?? 0) + 1
    this.held.set(key, { failures, at: this.now() + Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** (failures - 1)) })
  }

  sent(key: string): void { this.held.delete(key) }

  /** Forgets every key not in [keys]: a command no longer owed (its agent gone, its reading changed) holds nothing. */
  keep(keys: Iterable<string>): void {
    const kept = new Set(keys)
    for (const key of this.held.keys()) if (!kept.has(key)) this.held.delete(key)
  }
}
