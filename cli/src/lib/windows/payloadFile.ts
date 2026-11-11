/**
 * A signed program in the payload in use (ptyInstall.ts: `runtime\pty\current-pty` names `runtime\pty\<version>\`). Never one a
 * command names or a folder holds: on a computer with Smart App Control nothing else runs at all. Apart from ptyHost/launch.ts,
 * which brings the host's launcher with it, for the commands that only want a file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../../config/env.js'

const VERSION_DIR = /^\d+(\.\d+)*$/

export function payloadFile(name: string, runtimeDir: string = env.ADAPTER_RUNTIME_DIR): string | null {
  let version: string
  try { version = readFileSync(join(runtimeDir, 'pty', 'current-pty'), 'utf8').trim() } catch { return null }
  if (!VERSION_DIR.test(version)) return null
  const file = join(runtimeDir, 'pty', version, name)
  return existsSync(file) ? file : null
}
