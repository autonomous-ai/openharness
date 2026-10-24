/**
 * Which of the account's machines are team machines (docs/plans/2026-10-24-swarm-team-account.md), as the account's
 * machine list says: `GET /api/machines` gives each machine's `sessionKind`, `team` for a Harness Team account's daemon
 * or a computer that runs team work only (`harness team on`), `computer` for one of the person's own. A row with none
 * is from before team sessions, and is the person's own.
 *
 * A team daemon runs teammates' agents. It is the account's machine, so the person's apps reach it, but it is no more
 * trusted than a machine shared from another account: its roster must never change the keys the person's own machines
 * trust, and theirs is not sent to it (groupSyncer.ts). So a machine whose kind cannot be read — no list from the
 * backend yet, a list too old to go by, a machine the list does not hold — is treated as one that may not take part.
 *
 * Only on a computer where an account has had a team machine ([MachineKinds.teamFree]). Team machines exist only for
 * Swarm work, a hidden feature; everyone else's machines sync as they did before team machines, whatever the list says
 * or fails to say. The team machines a list has shown are remembered on disk, so a restart or a list that cannot be read
 * does not forget them.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { env } from '../../config/env.js'

export type MachineKind = 'team' | 'computer'

/** A list is read again before a round once it is this old. */
export const MACHINE_KINDS_REFRESH_MS = 60_000
/** Past this, a list says nothing: a machine converted to team work since must not still count as the person's own. */
export const MACHINE_KINDS_MAX_AGE_MS = 15 * 60_000

/** Each machine's kind in a `GET /api/machines` body (`{ machines }` or `{ data: { machines } }`); null when it holds no
 *  list. A machine whose `sessionKind` is neither of the known values is left out, so it reads as unknown. */
export function machineKindsOf(body: unknown): Map<string, MachineKind> | null {
  const top = body && typeof body === 'object' ? body as Record<string, unknown> : null
  const data = top?.data && typeof top.data === 'object' ? top.data as Record<string, unknown> : null
  const rows = top?.machines ?? data?.machines
  if (!Array.isArray(rows)) return null
  const kinds = new Map<string, MachineKind>()
  for (const raw of rows) {
    const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
    if (typeof row?.machineId !== 'string' || !row.machineId) continue
    const kind = row.sessionKind === 'team' ? 'team' : row.sessionKind === 'computer' || row.sessionKind === undefined || row.sessionKind === null ? 'computer' : null
    // One machine listed twice is taken at its stricter kind.
    if (kind && kinds.get(row.machineId) !== 'team') kinds.set(row.machineId, kind)
  }
  return kinds
}

export interface MachineKindsDeps {
  /** The account's machine list as the backend answered it; null when it could not be read (offline, signed out). */
  read: () => Promise<unknown>
  now?: () => number
  /** Where the team machines a list has shown are remembered (beside the trust stores, lib/e2ee/store.ts); null keeps
   *  them in memory only. */
  file?: string | null
}

/** The team machines a list has shown on this computer, for any account. */
export const TEAM_MACHINES_FILE = join(env.ADAPTER_DATA_DIR, 'e2e', 'team-machines.json')

function readRemembered(file: string | null): Set<string> {
  if (!file) return new Set()
  try {
    const ids = (JSON.parse(readFileSync(file, 'utf8')) as { teamMachineIds?: unknown }).teamMachineIds
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [])
  } catch {
    return new Set()
  }
}

/** The last machine list read, and reading it again when it is old. */
export class MachineKinds {
  private kinds: Map<string, MachineKind> | null = null
  private readAt = 0
  private reading: Promise<void> | null = null
  private generation = 0
  private readonly now: () => number
  private readonly file: string | null
  private remembered: Set<string> | null = null

  constructor(private readonly deps: MachineKindsDeps) {
    this.now = deps.now ?? Date.now
    this.file = deps.file === undefined ? TEAM_MACHINES_FILE : deps.file
  }

  /** A list the backend just answered (the gateway's own machine list, read for the apps). */
  adopt(body: unknown): void {
    const kinds = machineKindsOf(body)
    if (!kinds) return
    this.kinds = kinds
    this.readAt = this.now()
    this.remember(kinds)
  }

  /** Whether no account on this computer has had a team machine: then every machine syncs as before team machines. */
  teamFree(): boolean {
    return this.known().size === 0
  }

  /** Signed out, or another account: nothing is known any more, and a read on its way is not taken. */
  clear(): void {
    this.kinds = null
    this.readAt = 0
    this.generation++
  }

  /** What the list says [machineId] is; null when it cannot say. */
  kind(machineId: string): MachineKind | null {
    if (this.known().has(machineId)) return 'team'
    if (!this.kinds || this.now() - this.readAt > MACHINE_KINDS_MAX_AGE_MS) return null
    return this.kinds.get(machineId) ?? null
  }

  private known(): Set<string> {
    return this.remembered ??= readRemembered(this.file)
  }

  /** A list's team machines are remembered, and one it now shows as a computer of the person's own (`harness team off`,
   *  or a normal sign-in taking it over) is not. Kept in memory even when it cannot be written, until the daemon stops. */
  private remember(kinds: Map<string, MachineKind>): void {
    const known = this.known()
    let changed = false
    for (const [id, kind] of kinds) {
      if (kind === 'team' && !known.has(id)) { known.add(id); changed = true }
      if (kind === 'computer' && known.delete(id)) changed = true
    }
    if (!changed || !this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(`${this.file}.next`, JSON.stringify({ teamMachineIds: [...known] }), { mode: 0o600 })
      renameSync(`${this.file}.next`, this.file)
    } catch { /* memory keeps them */ }
  }

  /** Read the list again unless it is recent; one read at a time. Never throws. */
  fresh(): Promise<void> {
    if (this.kinds && this.now() - this.readAt < MACHINE_KINDS_REFRESH_MS) return Promise.resolve()
    if (this.reading) return this.reading
    const generation = this.generation
    this.reading = this.deps.read()
      .then((body) => { if (generation === this.generation && body !== null) this.adopt(body) }, () => { /* the last list stands, until it is too old */ })
      .finally(() => { this.reading = null })
    return this.reading
  }
}
