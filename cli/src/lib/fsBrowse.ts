import { readdirSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, resolve } from 'path'
import { withinRootsSync } from './pathContainment.js'

export interface DirEntry { name: string; isDir: true }
export interface ListDirResult { path: string; entries: DirEntry[]; truncated: boolean }
export type ListDirError = { error: 'INVALID_PATH' | 'NOT_FOUND' | 'NOT_A_DIRECTORY' | 'FORBIDDEN' | 'PERMISSION_DENIED' }

// A giant directory (e.g. someone browsing to `/`) must not produce an unbounded reply — nothing
// upstream (backend relay, hub) caps non-terminal frame size, so this is the only bound in the path.
const MAX_ENTRIES = 2_000

/** Restrict browsing to under the user's home directory by default — the machine a user runs
 *  `harness` on is "theirs", but a fat-fingered path (or a compromised relay hop) walking arbitrary
 *  system directories is still worth guarding against. Same opt-out convention as CLAUDE_PATH etc.
 *
 *  Measured on the REAL path: a link inside the home folder is named inside it while pointing
 *  anywhere, so the caller resolves before asking (lib/pathContainment.ts). */
function isAllowed(real: string): boolean {
  return withinRootsSync(real, [homedir()])
}

/** One-level directory listing (folders only) rooted at `path`, or `homedir()` when omitted. */
export function listDir(path: string): ListDirResult | ListDirError {
  const target = path || homedir()
  if (!isAbsolute(target)) return { error: 'INVALID_PATH' }
  // Two spellings of one folder: the browser keeps showing the path the person picked, while the
  // fence — and every read below it — uses the folder that path actually opens.
  const requested = resolve(target)
  let resolved: string
  try {
    resolved = realpathSync(requested)
  } catch (e) {
    return { error: (e as NodeJS.ErrnoException).code === 'EACCES' ? 'PERMISSION_DENIED' : 'NOT_FOUND' }
  }
  if (!isAllowed(resolved)) return { error: 'FORBIDDEN' }

  let st
  try {
    st = statSync(resolved)
  } catch (e) {
    return { error: (e as NodeJS.ErrnoException).code === 'EACCES' ? 'PERMISSION_DENIED' : 'NOT_FOUND' }
  }
  if (!st.isDirectory()) return { error: 'NOT_A_DIRECTORY' }

  let raw
  try {
    raw = readdirSync(resolved, { withFileTypes: true })
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
