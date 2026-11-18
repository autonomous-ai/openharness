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

/** What a session's record gives the dial: a key is present only with a value. */
export interface SessionRecord {
  name?: string
  hostSession?: string
}

export interface RecordOptions {
  /** Claude Code's records folders (observedPlaces.ts `claude.records()`): `sessions` beside each projects folder, and
   *  each Orca account home's. */
  records: readonly string[]
}

/**
 * What a Claude Code session's own process record, `<sessions>/<pid>.json`, which the session writes itself, gives the
 * dial. This is the one read the dial allows of it (decisions 5 and 6 of docs/specs/2026-11-15-dial-session-name.md):
 * `name`, `nameSource`, `entrypoint`, `sessionId` and `hostSessionId`, nothing else.
 * - `name`: a `user` name is shown: a `derived` one can come from what was first asked. So is the Claude app's
 *   (`entrypoint` `claude-desktop`, no `nameSource`): the app sets that title itself (`rename_session`) and its hook
 *   sends the same string as `session_title` on the next prompt (decision 2 of
 *   docs/plans/2026-11-17-dial-recap-after-restart-design.md).
 * - `hostSession`: the Claude app's own id of the session, which Claude Code writes from the
 *   `CLAUDE_CODE_HOST_SESSION_ID` the app gives it; the link to the app names it, so a session the scan found opens
 *   before its first hook (docs/plans/2026-11-18-dial-claude-app-swipe-before-hook-design.md). Taken as written: the
 *   adapter checks its form.
 * Never rejects, logs nothing and keeps nothing.
 */
export async function readRecord(
  owner: Pick<SessionOwner, 'pid' | 'record'> & { sessionId: string }, opts: RecordOptions,
): Promise<SessionRecord> {
  // The very string recordOwners (engines/kit/adoption.ts) builds for this pid in one of the folders it reads: any other
  // path is not this session's own record, so it is never opened.
  if (!declared) return {}
  if (!opts.records.some((folder) => owner.record === join(folder, `${owner.pid}${declared.suffix}`))) return {}
  let text: string
  try {
    const file = await open(owner.record, 'r')
    try {
      // One byte past the bound tells a larger file from one exactly at it.
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_RECORD_BYTES) return {}
      text = buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
  } catch {
    return {}
  }
  let row: unknown
  try {
    row = JSON.parse(text)
  } catch {
    // Caught while Claude Code rewrites it.
    return {}
  }
  if (!row || typeof row !== 'object') return {}
  const { name, nameSource, entrypoint, sessionId, hostSessionId } = row as Record<string, unknown>
  // The owner can be seconds old: a /clear or /resume since rewrote the record for another session (decision 6), as
  // confirmOwner (engines/kit/adoption.ts) checks.
  if (sessionId !== owner.sessionId) return {}
  const app = entrypoint === 'claude-desktop'
  const given = nameSource === 'user' || (nameSource === undefined && app)
  const shown = given ? observedTitle(name) : undefined
  return {
    ...(shown !== undefined && { name: shown }),
    ...(app && typeof hostSessionId === 'string' && { hostSession: hostSessionId }),
  }
}
