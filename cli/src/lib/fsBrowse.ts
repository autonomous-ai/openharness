import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import { withinRoots } from './pathContainment.js'

export interface DirEntry { name: string; isDir: true }
export interface ListDirResult { path: string; entries: DirEntry[]; truncated: boolean }
export type ListDirError = { error: 'INVALID_PATH' | 'NOT_FOUND' | 'NOT_A_DIRECTORY' | 'FORBIDDEN' | 'PERMISSION_DENIED' | 'UNAVAILABLE' }

// Bound a directory response before it reaches the relay or local transport.
const MAX_ENTRIES = 2_000
const reads = new Map<string, Promise<ListDirResult | ListDirError>>()

/** Share pending reads across searches: reopening a picker must not repeatedly
 * submit the same stuck provider read to Node's filesystem thread pool. */
export function listDir(path: string): Promise<ListDirResult | ListDirError> {
  const target = path || homedir()
  if (!isAbsolute(target)) return Promise.resolve({ error: 'INVALID_PATH' })
  const key = resolve(target)
  let pending = reads.get(key)
  if (!pending) {
    if (reads.size >= 64) return Promise.resolve({ error: 'UNAVAILABLE' })
    pending = readDir(key).catch((): ListDirError => ({ error: 'UNAVAILABLE' }))
    reads.set(key, pending)
    void pending.then(() => { reads.delete(key) })
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ error: 'UNAVAILABLE' }), 4000)
    void pending.then(result => { clearTimeout(timer); resolve(result) })
  })
}

/** Restrict browsing to under the user's home directory by default — the machine a user runs
 *  `harness` on is "theirs", but a fat-fingered path (or a compromised relay hop) walking arbitrary
 *  system directories is still worth guarding against. Same opt-out convention as CLAUDE_PATH etc.
 *
 *  Measured on the REAL path: a link inside the home folder is named inside it while pointing
 *  anywhere, so the caller resolves before asking (lib/pathContainment.ts). */
function isAllowed(real: string): Promise<boolean> {
  return withinRoots(real, [homedir()])
}

/** One-level directory listing (folders only). Filesystem providers and macOS
 * privacy checks may stall a read, so none may run on the daemon's event loop. */
async function readDir(path: string): Promise<ListDirResult | ListDirError> {
  const target = path || homedir()
  if (!isAbsolute(target)) return { error: 'INVALID_PATH' }
  // Two spellings of one folder: the browser keeps showing the path the person picked, while the
  // fence — and every read below it — uses the folder that path actually opens.
  const requested = resolve(target)
  let resolved: string
  try {
    resolved = await realpath(requested)
  } catch (e) {
    return { error: (e as NodeJS.ErrnoException).code === 'EACCES' ? 'PERMISSION_DENIED' : 'NOT_FOUND' }
  }
  if (!await isAllowed(resolved)) return { error: 'FORBIDDEN' }

  let st
  try {
    st = await stat(resolved)
  } catch (e) {
    return { error: (e as NodeJS.ErrnoException).code === 'EACCES' ? 'PERMISSION_DENIED' : 'NOT_FOUND' }
  }
  if (!st.isDirectory()) return { error: 'NOT_A_DIRECTORY' }

  let raw
  try {
    raw = await readdir(resolved, { withFileTypes: true })
  } catch (e) {
    return { error: (e as NodeJS.ErrnoException).code === 'EACCES' ? 'PERMISSION_DENIED' : 'NOT_FOUND' }
  }

  const dirs: DirEntry[] = []
  for (const d of raw) {
    if (d.name.startsWith('.')) continue // hidden — same convention as files.ts's isHidden
    if (d.isDirectory()) dirs.push({ name: d.name, isDir: true })
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  const truncated = dirs.length > MAX_ENTRIES
  return { path: requested, entries: truncated ? dirs.slice(0, MAX_ENTRIES) : dirs, truncated }
}
