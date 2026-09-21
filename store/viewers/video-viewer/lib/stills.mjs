// Publish native PNG frames without replacing a previous render's evidence.
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_STILL_BYTES = 64 * 1024 * 1024
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const problem = (message, status = 400) => Object.assign(new Error(message), { status })

export function keepStill(workspace, requestedName, png) {
  if (!Buffer.isBuffer(png) || png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) throw problem('not a png')
  if (png.length > MAX_STILL_BYTES) throw problem('the frame exceeds 64 MiB', 413)
  const name = String(requestedName || 'frame').replace(/[^\w.@+-]+/g, '-').replace(/^[-.]+/, '').slice(0, 120) || 'frame'
  const sha256 = createHash('sha256').update(png).digest('hex')
  let directory = realpathSync(workspace)
  for (const part of ['.harness', 'stills']) {
    directory = join(directory, part)
    try { mkdirSync(directory) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const stat = lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw problem('the still directory must be a real workspace directory', 409)
  }
  const temporary = join(directory, `.frame-${randomUUID()}.tmp`)
  let ownsTemporary = false
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    ownsTemporary = true
    try { writeFileSync(fd, png) } finally { closeSync(fd) }
    for (const hash of [sha256.slice(0, 16), sha256]) {
      const filename = `${name}-${hash}.png`, target = join(directory, filename)
      try { linkSync(temporary, target) } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const stat = lstatSync(target)
        // A short hash collision or a user-edited old file is never overwritten.
        // Use the complete hash instead, and do not follow a link at either name.
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== png.length || !readFileSync(target).equals(png)) continue
      }
      const path = `.harness/stills/${filename}`
      return { path, abs: join(workspace, path), sha256 }
    }
    throw problem('a kept frame at this hash has different contents', 409)
  } finally {
    if (ownsTemporary) {
      try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
}
