/**
 * Reading an engine's session files as its contracts declare them: one found by its id, and what its first
 * record says. Moved from engines/codex/rollout.ts (and the lookup from kit/resumeRepair.ts), whose every
 * answer this reproduces (engines/sessionStore.golden.spec.ts). Run as the registry loads and on the hook
 * path, so every read is bounded.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { SessionStoreContract } from '../facets/sessionStore.js'
import { identityHead, IdentityReadUnavailable, type IdentityVersion } from './identityScan.js'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

/**
 * Find one session file by its id without scanning unbounded history: a file ending in `suffix` whose name holds
 * the id, under `root`, looking at no more than `walk` entries. Only names with no `.` are folders worth entering.
 */
export function findSessionFile(id: string, root: string, sessions: { suffix: string; id: RegExp; walk: number }): string | null {
  if (!sessions.id.test(id) || !existsSync(root)) return null
  const stack = [root]
  let visited = 0
  while (stack.length && visited < sessions.walk) {
    const dir = stack.pop()!
    let names: string[]
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (++visited > sessions.walk) break
      const full = join(dir, name)
      if (name.endsWith(sessions.suffix)) {
        if (name.includes(id)) return full
      } else if (!name.includes('.')) {
        stack.push(full)
      }
    }
  }
  return null
}

/** What a session file's first record says about it. */
export interface SessionMeta {
  id: string
  /** A session another session delegated to. */
  isSubagent: boolean
  /** The session that delegated to it, when the record names one. */
  parentThreadId: string | null
  /** The folder the session was started in: the one field that says where it belongs. */
  cwd: string | null
}

/** The value at `path` in `value`, every step an object; undefined where one is not. */
function valueAt(value: unknown, path: readonly string[]): unknown {
  let at: unknown = value
  for (const key of path) {
    const parent = object(at)
    if (!parent) return undefined
    at = parent[key]
  }
  return at
}

export function firstRecordMeta(firstLine: string, first: NonNullable<SessionStoreContract['first']>): SessionMeta | null {
  const record = object(JSON.parse(firstLine))
  if (record?.type !== first.type || !object(valueAt(record, first.id.slice(0, -1)))) return null
  const id = valueAt(record, first.id)
  const cwd = valueAt(record, first.cwd)
  const child = valueAt(record, first.child)
  const parent = valueAt(record, first.parent)
  return {
    id: typeof id === 'string' ? id : '',
    isSubagent: child !== undefined && child !== null,
    parentThreadId: typeof parent === 'string' && parent ? parent : null,
    cwd: typeof cwd === 'string' ? cwd : null,
  }
}

/** Repair pools require conclusive metadata for every candidate. A short, cut or unreadable
 * rollout cannot make a sibling unique. Compatibility readers retain their nullable result. */
export async function readIdentityFirstRecord(file: string, first: NonNullable<SessionStoreContract['first']>, expected?: IdentityVersion): Promise<SessionMeta> {
  try {
    const head = await identityHead(file, Number.MAX_SAFE_INTEGER, first.maxBytes, expected)
    const line = head.lines.find(line => line.trim())
    if (!line) throw new IdentityReadUnavailable('the rollout header is incomplete or exceeds the read limit')
    const meta = firstRecordMeta(line, first)
    if (!meta || (!meta.isSubagent && (!meta.id || !meta.cwd || !isAbsolute(meta.cwd)))) {
      throw new IdentityReadUnavailable('the rollout header is incomplete or invalid')
    }
    return meta
  } catch (error) {
    if (error instanceof IdentityReadUnavailable) throw error
    throw new IdentityReadUnavailable('the rollout header could not be read completely')
  }
}

/** Read only the first record (the first line with anything on it, within the declared bound). Null for a
 *  file that does not open with the declared record, or cannot be read or parsed. */
export function readFirstRecord(file: string, first: NonNullable<SessionStoreContract['first']>): SessionMeta | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(first.maxBytes)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    const firstLine = buffer.subarray(0, bytes).toString('utf8').split('\n').find((line) => line.trim())
    if (!firstLine) return null
    return firstRecordMeta(firstLine, first)
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}
