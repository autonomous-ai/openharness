import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const MAX_FILES = 16, MAX_BYTES = 8 * 1024 * 1024
/** A leading `$NAME` or `${NAME}` of the whole variable name (`$NAME_OTHER` is another variable). */
const leading = (name: string): RegExp => new RegExp(`^\\$(?:\\{${name}\\}|${name}(?![A-Za-z0-9_]))`)
const PROJECT = leading('HARNESS_PROJECT_DIR'), FLOW = leading('HARNESS_FLOW_DIR')
/**
 * The hash of a regular file of at most 8 MiB, read through one handle that never follows a link nor waits on a pipe;
 * undefined for anything else. Only the bytes it had when it was looked at are read.
 */
async function hashRegularFile(path: string): Promise<string | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_BYTES) return undefined
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
    for (let total = 0, read = -1; read !== 0 && total < info.size; total += read) {
      read = (await handle.read(buffer, 0, Math.min(buffer.length, info.size - total), total)).bytesRead
      hash.update(buffer.subarray(0, read))
    }
    return hash.digest('hex')
  } finally { await handle.close() }
}
/**
 * Files a command names literally, with their hashes: what a later rerun can compare. Shell code is not interpreted:
 * only a leading $HARNESS_PROJECT_DIR or $HARNESS_FLOW_DIR is expanded, other variables make a word unknown.
 */
export async function scriptHashes(command: string, dirs: { exec: string; project: string; flow: string }): Promise<{ path: string; sha256: string }[]> {
  const words = command.split(/[\s;|&()<>]+/).map(word => word.replace(/^['"]|['"]$/g, '')).filter(Boolean)
  const found: { path: string; sha256: string }[] = []
  for (const word of words) {
    if (found.length >= MAX_FILES) break
    const expanded = word.replace(PROJECT, dirs.project).replace(FLOW, dirs.flow)
    if (expanded.includes('$')) continue
    const path = isAbsolute(expanded) ? expanded : join(dirs.exec, expanded)
    if (found.some(f => f.path === path)) continue
    try {
      const sha256 = await hashRegularFile(path)
      if (sha256) found.push({ path, sha256 })
    } catch { /* not a file: not a script */ }
  }
  return found
}
