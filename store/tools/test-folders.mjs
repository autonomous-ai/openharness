// The temporary folders of these specs: under the OS temp folder, and gone when a spec file ends, passed or failed.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A socket's path has 96 bytes (local-daemon.mjs), and these specs put up to 32 under the root: an agent's long TMPDIR would not fit. */
const MAX_ROOT_BYTES = 60

const made = new Set()

/** A new folder for this spec file, removed by [removeTempFolders]. */
export function tempFolder(prefix) {
  const root = Buffer.byteLength(tmpdir()) <= MAX_ROOT_BYTES ? tmpdir() : '/tmp'
  const dir = mkdtempSync(join(root, prefix))
  made.add(dir)
  return dir
}

/** Removes every folder [tempFolder] made: call it from the spec file's `after`, once what listens in them has closed. */
export function removeTempFolders() {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
  made.clear()
}
