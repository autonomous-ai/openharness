/** Exact executable identity shared by trusted core selection and setup observations. */
import { realpathSync, statSync } from 'node:fs'
import type { NativeExecutableSnapshot } from './versionData.js'

export function executableIdentity(file: string): string | null {
  try {
    const target = realpathSync(file), info = statSync(file, { bigint: true })
    return info.isFile() ? `${file}:${target}:${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` : null
  } catch { return null }
}

export function retainedExecutable(command: string, identity: string): NativeExecutableSnapshot {
  return { command, identity, current: () => executableIdentity(command) === identity }
}
