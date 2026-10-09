/** The native home catalog is control evidence. A partial read is never an empty list. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { IdentityReadUnavailable } from './identityScan.js'

export type HomeCatalog = { claude: string[]; codex: string[] }
export type HomeCatalogRead = { homes: HomeCatalog; text: string | null; version: string | null }
const MAX_BYTES = 64 * 1024
export const MAX_CATALOG_HOMES = 63 // The default home occupies the remaining slot in the 64-root native pool.
const stamp = (s: Stats) => `${s.dev}:${s.ino}:${s.mode}:${s.uid}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
const unavailable = (reason: string) => new IdentityReadUnavailable(`the saved engine-home catalog ${reason}`)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

function absent(file: string, deadline: () => void): HomeCatalogRead {
  // ENOENT through a dangling data-directory link is unreadable state, not a new installation.
  let parent = dirname(file)
  for (let depth = 0; depth < 32; depth++) {
    deadline()
    try {
      if (!lstatSync(parent).isDirectory()) throw unavailable('has an unavailable parent directory')
      return { homes: { claude: [], codex: [] }, text: null, version: null }
    } catch (error) {
      if (!missing(error)) throw unavailable('has an unavailable parent directory')
      const next = dirname(parent)
      if (next === parent) break
      parent = next
    }
  }
  throw unavailable('exceeded its parent-directory limit')
}

function inspect(info: Stats): void {
  if (!info.isFile() || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || (info.mode & 0o022)) {
    throw unavailable('has an unsafe owner, type or write permission')
  }
  if (info.size > MAX_BYTES) throw unavailable('exceeds its byte limit')
}

function parse(text: string): HomeCatalog {
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw unavailable('is incomplete or invalid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'claude' && key !== 'codex')) {
    throw unavailable('has an unknown schema')
  }
  // JSON.parse silently keeps the last duplicate property. This catalog is a complete pool:
  // an earlier list cannot disappear, including when a key uses an escaped spelling.
  const keys = new Set<string>()
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    let next = match.index! + match[0].length
    while (' \t\r\n'.includes(text[next] ?? '\0')) next++
    if (text[next] !== ':') continue
    const key = JSON.parse(match[0]) as string
    if (keys.has(key)) throw unavailable('contains a repeated home list')
    keys.add(key)
  }
  const result: HomeCatalog = { claude: [], codex: [] }
  for (const engine of ['claude', 'codex'] as const) {
    const homes = (value as Record<string, unknown>)[engine]
    if (homes === undefined) continue
    if (!Array.isArray(homes)) throw unavailable('has an invalid home list')
    if (homes.length > MAX_CATALOG_HOMES) throw new IdentityReadUnavailable('the known session-home limit was reached')
    for (const home of homes) {
      if (typeof home !== 'string' || home.length > 4096 || home.includes('\0') || !isAbsolute(home)) {
        throw unavailable('contains an invalid home')
      }
      if (!result[engine].includes(home)) result[engine].push(home)
    }
  }
  return result
}

/** Fresh, bounded bytes tied to their opened descriptor and current pathname. No stamp cache. */
export function readHomeCatalog(file: string): HomeCatalogRead {
  const started = performance.now()
  const deadline = () => { if (performance.now() - started > 250) throw unavailable('exceeded its read deadline') }
  let info: Stats
  try { info = lstatSync(file) }
  catch (error) {
    if (missing(error)) return absent(file, deadline)
    throw unavailable('could not be inspected')
  }
  inspect(info)
  let fd: number | undefined
  try {
    deadline()
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const before = fstatSync(fd)
    inspect(before)
    if (stamp(before) !== stamp(info)) throw unavailable('changed before it could be opened')
    const buffer = Buffer.alloc(before.size)
    let read = 0, calls = 0
    while (read < buffer.length) {
      deadline()
      if (++calls > 64) throw unavailable('exceeded its read-operation limit')
      const count = readSync(fd, buffer, { offset: read, length: buffer.length - read, position: read })
      if (!count) throw unavailable('ended during its read')
      read += count
    }
    if (stamp(fstatSync(fd)) !== stamp(before) || stamp(lstatSync(file)) !== stamp(before)) {
      throw unavailable('changed during its read')
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    const homes = parse(text)
    deadline()
    return { homes, text, version: stamp(before) }
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    throw unavailable('could not be read completely')
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { throw unavailable('could not close its read descriptor') }
    }
  }
}
