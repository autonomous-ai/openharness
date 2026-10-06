/** Private, bounded replies to a shell helper. Never type protocol data into stdin. */
import { constants, closeSync, fstatSync, lstatSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function shellContextReply(payload: Record<string, unknown>, home = homedir()): boolean {
  const { context, id, code, text } = payload
  if (typeof context !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(context)
      || typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)
      || (code !== 0 && code !== 1) || typeof text !== 'string' || Buffer.byteLength(text) > 2048) return false
  const uid = process.getuid?.()
  let fd: number | undefined
  try {
    const base = join(home, '.harness', 'shell-requests')
    for (const path of [base, join(base, context)]) {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) return false
    }
    fd = openSync(join(base, context, id), constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFIFO() || stat.uid !== uid || (stat.mode & 0o077) !== 0) return false
    // Large picker catalogs travel through a private file, not through terminal
    // stdin or a single nonblocking FIFO write that could be only partly written.
    if (payload.data !== undefined) {
      const data = JSON.stringify(payload.data)
      if (Buffer.byteLength(data) > 8 * 1024 * 1024) return false
      const target = join(base, context, `${id}.json`)
      try {
        const old = lstatSync(target)
        if (!old.isFile() || old.uid !== uid || (old.mode & 0o077) !== 0 || old.nlink !== 1) return false
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false }
      const staged = `${target}.${randomUUID()}`
      try {
        writeFileSync(staged, data, { flag: 'wx', mode: 0o600 })
        renameSync(staged, target)
      } finally { rmSync(staged, { force: true }) }
    }
    const line = `HN:${id}:${code}:${Buffer.from(text).toString('base64')}\n`
    return writeSync(fd, line) === Buffer.byteLength(line)
  } catch { return false } finally { if (fd !== undefined) closeSync(fd) }
}
