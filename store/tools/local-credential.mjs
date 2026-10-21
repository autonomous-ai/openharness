// The daemon's local credential, for the daemon checks here (dsh-*.mjs, experience-tests/daemon.mjs).
//
// Since Harness 0.4.21 the loopback port (REST and `/api/local-ws`) answers 401 to a process that does
// not show `X-Harness-Local: <credential>`, the 0600 `hook-credential` file in Harness's data folder
// (`ADAPTER_DATA_DIR`, default `~/.harness/cli/data`). Read with the CLI's own checks
// (cli/src/lib/hookAuth.ts `readHookCredential`); anything else is no credential and no header. The
// Store packages that talk to the daemon each carry the same function, by the same name.
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function localCredentialHeaders(env = process.env) {
  const dir = env.ADAPTER_DATA_DIR || join(homedir(), '.harness', 'cli', 'data')
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  // Windows reports every file as 0o666 and every folder as 0o777, so the mode checks below would always refuse
  // the credential the daemon wrote; there its protection is the profile folder's ACL (cli hookAuth.ts).
  const posixModes = process.platform !== 'win32'
  const opened = []
  try {
    const folder = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    opened.push(folder)
    const where = fstatSync(folder)
    if (!where.isDirectory() || (uid !== null && where.uid !== uid) || (posixModes && (where.mode & 0o022) !== 0)) return {}
    const file = openSync(join(dir, 'hook-credential'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    opened.push(file)
    const stat = fstatSync(file)
    if (!stat.isFile() || stat.size > 128 || (uid !== null && stat.uid !== uid) || (posixModes && (stat.mode & 0o777) !== 0o600)) return {}
    const value = readFileSync(file, 'utf8').trim()
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? { 'X-Harness-Local': value } : {}
  } catch {
    return {}
  } finally {
    for (const fd of opened) closeSync(fd)
  }
}

/** What a check prints when the daemon answers its upgrade 401. */
export const CREDENTIAL_REFUSED = "Harness refused this process's local credential (hook-credential in ADAPTER_DATA_DIR, default ~/.harness/cli/data). Run this as the same OS user as Harness."
