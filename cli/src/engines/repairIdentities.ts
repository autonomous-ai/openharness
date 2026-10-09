/** Native repair facts available while optional history readers are missing or loading. */
import { MUSE_IDENTITY } from './muse/contract.js'
import { PI_FOLDER, PI_HEADER } from './pi/contract.js'
import { identityBytes } from './kit/identityScan.js'
import { readRunIdentity, readSessionHeader, sessionFolder, UNSETTLED } from './kit/sessionIdentity.js'

export const museSessionIdentity = (path: string, matches: (cwd: string) => Promise<boolean>) => readRunIdentity(MUSE_IDENTITY, path, matches)
export const piSessionFolder = (cwd: string): string => sessionFolder(PI_FOLDER, cwd)
export const readPiHead = (path: string) => readSessionHeader(PI_HEADER,
  async bytes => (await identityBytes(path, bytes)).toString('utf8')).catch(() => UNSETTLED)
