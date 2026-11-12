/**
 * A process's paths in the daemon's view (Linux only).
 *
 * A process in another mount namespace (a sandbox) names its home and folder as its own mounts show them. Its
 * `mountinfo` and the daemon's say which file of which filesystem such a path is, and where the daemon reaches that
 * file (`mountView.ts`). Nothing is written, and nothing in the process's namespace is opened but those two files.
 */

import { open, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { hostPath, parseMountinfo, type Mount } from './mountView.js'
import { processEnvCacheKey } from './processEnv.js'
import type { ProcessIdentity } from './terminalTypes.js'

export type ProcessView =
  | { state: 'same' }
  | { state: 'unreadable' }
  | { state: 'sandbox'; cwd: string | null; toHost(path: string): string | null }

const SAME: ProcessView = { state: 'same' }
const MOUNTINFO_MAX_BYTES = 1 << 20
const CACHE_LIMIT = 256

// A process keeps its namespace for its life, and a sandbox mounts its folders before it runs the agent: one read per
// process. "Could not look" is never kept, so it cannot harden into an answer.
const views = new Map<string, ProcessView>()

export function clearProcessViews(): void {
  views.clear()
}

// procfs reports no size, so the limit is found by reading: one byte past it is a list too long to take.
async function readMounts(file: string): Promise<Mount[] | null> {
  try {
    const handle = await open(file, 'r')
    try {
      const bytes = Buffer.allocUnsafe(MOUNTINFO_MAX_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
        if (bytesRead === 0) break
        length += bytesRead
      }
      return length > MOUNTINFO_MAX_BYTES ? null : parseMountinfo(bytes.toString('utf8', 0, length))
    } finally {
      await handle.close().catch(() => {})
    }
  } catch {
    return null
  }
}

/** Whether `identity` sees the daemon's mounts; when it does not, its folder as it names it and its paths in ours. */
export async function processView(identity: ProcessIdentity, platform: NodeJS.Platform = process.platform, proc = '/proc'): Promise<ProcessView> {
  // Mount namespaces are Linux's: elsewhere every process names a path as the daemon does.
  if (platform !== 'linux') return SAME
  const key = processEnvCacheKey(identity)
  const kept = views.get(key)
  if (kept) return kept
  const theirs = join(proc, String(identity.pid)), ours = join(proc, 'self')
  let namespaces: string[]
  try {
    namespaces = await Promise.all([readlink(join(theirs, 'ns', 'mnt')), readlink(join(ours, 'ns', 'mnt'))])
  } catch {
    return { state: 'unreadable' }
  }
  let view = SAME
  if (namespaces[0] !== namespaces[1]) {
    const [their, our, cwd] = await Promise.all([readMounts(join(theirs, 'mountinfo')), readMounts(join(ours, 'mountinfo')),
      readlink(join(theirs, 'cwd')).catch(() => null)])
    // Part of a list could take a path through a mount that a line left unread covers: no whole list, no answer.
    view = { state: 'sandbox', cwd, toHost: their && our ? (path) => hostPath(path, their, our) : () => null }
  }
  if (views.size >= CACHE_LIMIT) views.clear()
  views.set(key, view)
  return view
}
