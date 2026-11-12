/**
 * What Hachi started never closes with it (docs/design/2026-11-12-hachi.md, "Surface"). Closing a harness closes the
 * harnesses it started (services/agentCleanup.ts), and for Hachi that would end the person's builders and reviewers. So
 * however the Hachi harness closes, what it started is handed to the person instead, its starter cleared: a `Handed`
 * line in this machine's ledger (agentClient/ledger.ts), and in the ledger of each other machine one of them runs on.
 * From then on neither the cascade nor the idle cleanup closes it, and Hachi may read it but no longer tell or close it.
 *
 * One rule for every way Hachi closes:
 * - **Stopped** (the switch turned off, Harness Monitor's Stop, `harness close` from a terminal): the core tells the
 *   cleanup it stopped, and the cleanup hands over before it would close anything (`over`).
 * - **Not stopped, just gone** (its process died, the machine rebooted and did not bring it back): nothing tells the
 *   cleanup, so each of its looks asks whether each Hachi harness that started something here is still running
 *   (`look`), and hands over once one has been gone for `GONE_MS`: long enough that a core starting again, which marks
 *   every harness inactive until it has found their processes, never hands over a Hachi that is about to come back.
 *
 * A harness on another machine that the machine could not be asked about (asleep, offline) stays Hachi's here, and is
 * asked again at the next look until that machine answers: its own idle cleanup would otherwise close it after half an
 * hour, as anything another agent started.
 */
import type { Ledger, LedgerMember, Started } from '../agentClient/ledger.js'
import type { RegisteredSession } from '../lib/registry.js'

/** How long a Hachi harness must be seen gone before what it started is handed over without a stop. */
export const GONE_MS = 2 * 60_000

export interface HachiHandOverDeps {
  ledger: Ledger
  /** This machine's id. */
  self(): string
  /** Asks [machineId]'s messages service to record the hand-over (messages/service.ts `handed`); rejects when that
   *  machine could not be asked or refused. */
  tell(machineId: string, payload: Record<string, unknown>): Promise<unknown>
  now(): number
  log(line: string): void
  count(metric: 'hachi_handed_to_person'): void
}

export function createHachiHandOver(deps: HachiHandOverDeps) {
  /** When each Hachi harness here that still has harnesses was first seen gone, by agent id. */
  const goneSince = new Map<string, number>()
  /** The starters being handed over: a stop told twice, or a look during a stop, hands each harness over once. */
  const handing = new Set<string>()

  /** What [starter] started that is still its own, when it is the Hachi harness: its starts say so (`by.hachi`). */
  const hachiChildren = (starter: LedgerMember): Started[] => deps.ledger.childrenOf(starter).filter((row) => row.by.hachi)

  /** Hands what the Hachi harness [agentId] here started to the person; nothing for any other harness. */
  const over = async (agentId: string): Promise<void> => {
    if (handing.has(agentId)) return
    handing.add(agentId)
    try {
      const from = { machineId: deps.self(), agentId }
      for (const row of hachiChildren(from)) {
        const line = { at: deps.now(), from, handed: { machineId: row.child.machineId, agentId: row.child.agentId } }
        if (row.child.machineId !== from.machineId) {
          try { await deps.tell(row.child.machineId, { action: 'handed', row: line }) } catch (error) {
            deps.log(`[hachi] could not hand ${row.child.name || row.child.agentId.slice(0, 8)} to the person on its machine yet: ${error instanceof Error ? error.message : String(error)}. Asked again at the next look.`)
            continue
          }
        }
        deps.ledger.append(line)
        deps.count('hachi_handed_to_person')
        deps.log(`[hachi] handed ${row.child.name || row.child.agentId.slice(0, 8)} to the person: Hachi closed.`)
      }
    } finally {
      handing.delete(agentId)
    }
  }

  /** One look: each Hachi harness here with harnesses of its own that is not running is handed over once it has been
   *  gone `GONE_MS`. Null when there is nothing to hand over now, so a look that has nothing to do waits on nothing. */
  const look = (live: readonly RegisteredSession[]): Promise<void> | null => {
    const self = deps.self()
    const starters = new Set(deps.ledger.all().filter((row) => row.by.hachi && row.by.machineId === self).map((row) => row.by.agentId))
    for (const id of goneSince.keys()) if (!starters.has(id)) goneSince.delete(id)
    const due: string[] = []
    for (const agentId of starters) {
      if (live.some((s) => s.agentId === agentId && s.active) || !hachiChildren({ machineId: self, agentId }).length) { goneSince.delete(agentId); continue }
      const since = goneSince.get(agentId) ?? deps.now()
      goneSince.set(agentId, since)
      if (deps.now() - since >= GONE_MS) due.push(agentId)
    }
    return due.length ? (async () => { for (const agentId of due) await over(agentId) })() : null
  }

  /** Whether [agentId] here was handed to the person: never closed for its starter, or for sitting idle. */
  const handed = (agentId: string): boolean => deps.ledger.handedAt({ machineId: deps.self(), agentId }) !== null

  return { over, look, handed }
}
