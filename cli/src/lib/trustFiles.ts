/**
 * Every trust file on this computer, for `harness status` to name the ones that cannot be read. Each store lists its
 * own files with the parse it reads them with, so status finds a file unreadable exactly when its store does.
 */
import { basename, join } from 'node:path'
import { env } from '../config/env.js'
import { authSessionFiles } from './authSession.js'
import { keptAccountDirs } from './e2ee/accountTrust.js'
import { deviceLogFiles } from './e2ee/deviceLogStore.js'
import { machinePeerFiles } from './e2ee/machinePeers.js'
import { e2eeStoreFiles } from './e2ee/store.js'
import { trustGroupFiles } from './e2ee/trustGroup.js'
import { hookSecretFiles } from './hookAuth.js'
import { probeState, type TrustFile } from './secureState.js'

/** What an account switch keeps of each account (accountTrust.ts `stashTrust`). */
const KEPT = ['group.json', 'group-blocked.json', 'machinePeers.json', 'paired.json']

/** The live files, then each kept account's copies, read with the parse of the live file of the same name. */
export function trustFiles(): TrustFile[] {
  const live = [
    ...e2eeStoreFiles(), ...trustGroupFiles(), ...machinePeerFiles(), ...deviceLogFiles(), ...authSessionFiles(),
    ...hookSecretFiles(env.ADAPTER_DATA_DIR),
  ]
  const parseOf = new Map(live.map((entry) => [basename(entry.file), entry.parse]))
  const kept = keptAccountDirs().flatMap((dir) => KEPT.map((name) => ({ file: join(dir, name), parse: parseOf.get(name)! })))
  return [...live, ...kept]
}

/** One line for each of [files] that cannot be read, with its full path and the fix. Logs nothing, moves nothing. */
export function unreadableTrustLines(files: readonly TrustFile[] = trustFiles()): string[] {
  return files.flatMap(({ file, parse }) => {
    const read = probeState(file, parse)
    return read.state === 'unreadable' ? [`  ! ${file} cannot be read (${read.failure}) · move it aside to start over`] : []
  })
}
