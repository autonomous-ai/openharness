// The Codex home a rollout path is in, for the dial skill. The path is another process's open file, read by `lsof`, so a
// home is taken only from the exact shape Codex writes, by fixed levels, never by looking for the first `sessions`: a
// home whose own path holds a `sessions` folder still resolves right, and any other shape gives nothing.
import { resolve } from 'node:path'
import type { SessionOwner } from '../lib/sessionSearch/external.js'
import { within } from '../lib/sessionSearch/externals/support.js'

export type RolloutOwner = Pick<SessionOwner, 'engine' | 'record' | 'tty' | 'harness' | 'fromArgs'>

/** Whether the scan's owner is one a home is taken from. */
export function takesOwner(owner: RolloutOwner): boolean {
  // The terminal is not looked at: Codex 0.167.1's app-server, and codex-acp, hold a session's rollout with none. A
  // Harness-run owner is Harness's own agent, and one placed from its arguments has no path of its own.
  return owner.engine === 'codex' && !owner.harness && !owner.fromArgs
}

const MAX_BYTES = 1024

/** `sessions/YYYY/MM/DD/rollout-*.jsonl`, the path's last segments under the home. */
const LEVELS = [/^sessions$/, /^\d{4}$/, /^\d{2}$/, /^\d{2}$/, /^rollout-.*\.jsonl$/]

/** The home a rollout path is in, or null when the path fails a rule (`shape`). Reads no file. */
export function rolloutHome(record: string, dataDir: string): string | null {
  // Equal to its own resolve(): absolute, with no `..`, `.`, `//` or trailing `/` that would move the home.
  if (Buffer.byteLength(record) > MAX_BYTES || /[\x00-\x1f\x7f]/.test(record) || resolve(record) !== record) return null
  const segments = record.split('/')
  // One more than the levels is the filesystem root as the home, which is never one.
  if (segments.length <= LEVELS.length + 1) return null
  const tail = segments.slice(-LEVELS.length)
  if (!LEVELS.every((level, i) => level.test(tail[i]))) return null
  // A rollout in the data dir is a byproduct of Harness's own agents, as the open scan treats it.
  if (within(dataDir, record)) return null
  return segments.slice(0, -LEVELS.length).join('/')
}
