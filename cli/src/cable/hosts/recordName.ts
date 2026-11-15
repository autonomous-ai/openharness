import { open } from 'node:fs/promises'
import { join } from 'node:path'
// Types only: the devices process must not load core code.
import type { SessionOwner } from '../../lib/sessionSearch/external.js'
import { observedTitle } from './observedTitle.js'

/** A record is about 1–2 KiB; a larger file is not read. */
export const MAX_RECORD_BYTES = 16 * 1024

export interface RecordNameOptions {
  /** Claude Code's projects folders (claudeProjectsRoots); its process records are in `sessions` beside each. */
  roots: readonly string[]
}

/**
 * The name the person gave a Claude Code session, from the session's own process record, `<sessions>/<pid>.json`,
 * which the session writes itself. This is the one read the dial's naming allows of it (decision 5 of
 * docs/specs/2026-11-15-dial-session-name.md): `name` and `nameSource`, nothing else. Only a `user` name is
 * shown: a `derived` one can come from what was first asked. Never rejects, logs nothing and keeps nothing.
 */
export async function readRecordName(owner: Pick<SessionOwner, 'pid' | 'record'>, opts: RecordNameOptions): Promise<string | undefined> {
  // The very string recordOwners (engines/kit/adoption.ts) builds for this pid: any other path is not this
  // session's own record, so it is never opened.
  if (!opts.roots.some((root) => owner.record === join(root, '..', 'sessions', `${owner.pid}.json`))) return undefined
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
  const { name, nameSource } = row as Record<string, unknown>
  return nameSource === 'user' ? observedTitle(name) : undefined
}
