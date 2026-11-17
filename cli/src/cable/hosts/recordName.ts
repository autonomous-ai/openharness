import { open } from 'node:fs/promises'
import { join } from 'node:path'
// Data the devices process already loads (lib/engineHomes.ts), and types only: it must not load core code.
import { sessionStoreContracts } from '../../engines/sessionStoreContracts.js'
import type { SessionOwner } from '../../lib/sessionSearch/external.js'
import { observedTitle } from './observedTitle.js'

/** A record is about 1–2 KiB; a larger file is not read. */
export const MAX_RECORD_BYTES = 16 * 1024

const { live } = sessionStoreContracts.claude
/** Claude Code's process record, `<folder>/<pid><suffix>`, as its store declares it. */
const declared = 'record' in live ? live.record : undefined

export interface RecordNameOptions {
  /** Claude Code's records folders (observedPlaces.ts `claude.records()`): `sessions` beside each projects folder, and
   *  each Orca account home's. */
  records: readonly string[]
}

/**
 * The name the person gave a Claude Code session, from the session's own process record, `<sessions>/<pid>.json`,
 * which the session writes itself. This is the one read the dial's naming allows of it (decisions 5 and 6 of
 * docs/specs/2026-11-15-dial-session-name.md): `name`, `nameSource` and `sessionId`, nothing else. Only a `user`
 * name is shown: a `derived` one can come from what was first asked. Never rejects, logs nothing and keeps nothing.
 */
export async function readRecordName(
  owner: Pick<SessionOwner, 'pid' | 'record'> & { sessionId: string }, opts: RecordNameOptions,
): Promise<string | undefined> {
  // The very string recordOwners (engines/kit/adoption.ts) builds for this pid in one of the folders it reads: any other
  // path is not this session's own record, so it is never opened.
  if (!declared) return undefined
  if (!opts.records.some((folder) => owner.record === join(folder, `${owner.pid}${declared.suffix}`))) return undefined
  let text: string
  try {
    const file = await open(owner.record, 'r')
    try {
      // One byte past the bound tells a larger file from one exactly at it.
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_RECORD_BYTES) return undefined
      text = buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
  } catch {
    return undefined
  }
  let row: unknown
  try {
    row = JSON.parse(text)
  } catch {
    // Caught while Claude Code rewrites it.
    return undefined
  }
  if (!row || typeof row !== 'object') return undefined
  const { name, nameSource, sessionId } = row as Record<string, unknown>
  // The owner can be seconds old: a /clear or /resume since rewrote the record for another session (decision 6), as
  // confirmOwner (engines/kit/adoption.ts) checks.
  return nameSource === 'user' && sessionId === owner.sessionId ? observedTitle(name) : undefined
}
