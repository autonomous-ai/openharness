/**
 * Which of the account's OTHER computers seem offline — read from the machine list this daemon already
 * keeps (`GET /api/machines`, refreshed every 60 s), and used for ONE thing: labelling a model that only
 * such a computer serves on a sleeping grid, so it is not offered as if it would answer.
 *
 * ⚠️ A label, never a removal. Presence describes the harness daemon on that computer, not the model
 * server it runs: a computer whose daemon is down may still be serving (and a computer whose daemon is
 * up may not be). So every rule below errs toward NOT labelling, and nothing here ever hides a row, and
 * nothing here ever refuses a move (grid-reads-without-waking issue 03).
 *
 * Pure but for the clock the caller passes in.
 */
import { sameComputer } from '../device/machineList.js'

/** A computer reads "seems offline" only once two lists at least this far apart both said `offline`,
 *  with nothing else read between them — one list is a blip, not a finding. */
export const COMPUTER_OFFLINE_MIN_MS = 60_000

/** The list is re-read every 60 s; one that has not been re-read in three of those is not evidence. */
export const MACHINE_LIST_FRESH_MS = 3 * 60_000

/** One of the account's computers, as the machine list says it. */
export interface ListedComputer {
  machineId: string
  /** Every name a grid node on it could be registered under: its hostname, and its name as the Machines
   *  list shows it (the Model Manager joins a grid under that). */
  names: string[]
  /** Its name as the Machines list shows it — what a label says. */
  display: string
  /** The backend's word. Only `offline` is offline: `unknown` is a presence the backend could not read. */
  status: string
  /** This computer — the one running this daemon, which is by definition not offline. */
  local: boolean
}

export interface ComputerList {
  computers: ListedComputer[]
  /** The signed-out list — this computer alone, made up locally, which says nothing about any other. */
  guest: boolean
}

export interface OfflineReading {
  /** The computer's name as the Machines list shows it. */
  machine: string
  /** When the first of the offline reads was made, epoch ms. */
  since: number
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)
const name = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

/** The computers in a `GET /api/machines` body — `{data:{machines}}` as the backend answers, or the older
 *  top-level `{machines}` — or null when the body carries no machine list at all. */
export function computersIn(body: unknown, localComputerId: string): ComputerList | null {
  if (!isObject(body)) return null
  const data = isObject(body.data) ? body.data : body
  if (!Array.isArray(data.machines)) return null
  const computers = data.machines.filter(isObject).flatMap((row): ListedComputer[] => {
    const machineId = name(row.machineId)
    if (!machineId) return []
    const hostname = name(row.hostname)
    const shown = name(row.name)
    return [{
      machineId,
      names: [...new Set([hostname, shown].filter(Boolean))],
      display: shown || hostname || machineId,
      status: typeof row.status === 'string' ? row.status : '',
      local: sameComputer(name(row.computerId), localComputerId),
    }]
  })
  return { computers, guest: data.guest === true }
}

/** When one computer has been reading offline: the first read of the run, and the latest. */
interface Streak { since: number; last: number }

export class ComputerPresence {
  private computers: ListedComputer[] = []
  private guest = true
  private listAt: number | null = null
  private readonly streaks = new Map<string, Streak>()

  /**
   * Take a list read at `at`. Returns whether any computer's verdict may have changed, so a caller can
   * re-tell its clients only when there is something to tell.
   */
  observe(list: ComputerList, at: number): boolean {
    const before = this.verdicts(at)
    this.computers = list.computers
    this.guest = list.guest
    this.listAt = at
    const listed = new Set(list.computers.map((computer) => computer.machineId))
    for (const id of [...this.streaks.keys()]) if (!listed.has(id)) this.streaks.delete(id)
    for (const computer of list.computers) {
      if (computer.status !== 'offline') { this.streaks.delete(computer.machineId); continue }
      const streak = this.streaks.get(computer.machineId)
      this.streaks.set(computer.machineId, { since: streak?.since ?? at, last: at })
    }
    return this.verdicts(at) !== before
  }

  /**
   * The computer a grid node named `nodeName` runs on, when that computer seems offline — else null. All
   * must hold: the list is fresh and not the guest one; exactly ONE of the account's computers goes by
   * that name (counting this one, so a name this computer shares is never labelled); it is not this
   * computer; and it read offline in two lists at least [COMPUTER_OFFLINE_MIN_MS] apart, with nothing else
   * read between them.
   */
  seemsOffline(nodeName: string, now: number): OfflineReading | null {
    if (!this.fresh(now)) return null
    const named = this.computers.filter((computer) => computer.names.includes(nodeName))
    if (named.length !== 1 || named[0]!.local) return null
    const streak = this.streaks.get(named[0]!.machineId)
    if (!streak || streak.last - streak.since < COMPUTER_OFFLINE_MIN_MS) return null
    return { machine: named[0]!.display, since: streak.since }
  }

  private fresh(now: number): boolean {
    return !this.guest && this.listAt !== null && now - this.listAt <= MACHINE_LIST_FRESH_MS
  }

  /** The computers labelled right now, as one comparable value — empty when none is (a stale list
   *  labels nothing, the same as a fresh one in which every computer is up). */
  private verdicts(now: number): string {
    if (!this.fresh(now)) return ''
    return this.computers
      .filter((computer) => computer.names.some((nodeName) => this.seemsOffline(nodeName, now)))
      .map((computer) => computer.machineId)
      .sort()
      .join('\n')
  }
}
