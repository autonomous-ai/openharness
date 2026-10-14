/** A native control proof retains the original private file and directory.
 * Opening a substitute and later restoring the pathname cannot confirm it. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, type BigIntStats } from 'node:fs'
import { hookPreparationRoutes, inspectHookFile } from '../engines/kit/nativeHookFiles.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'

export function inspectNativeControlFile(file: string, directory: string) {
  const identity = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.uid}:${info.mode}`
  const stamp = (info: BigIntStats) => `${identity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  const privateState = (path: string, isDirectory: boolean) => {
    const info = lstatSync(path, { bigint: true })
    if ((isDirectory ? !info.isDirectory() : !info.isFile()) || (info.mode & 0o777n) !== BigInt(isDirectory ? 0o700 : 0o600)
      || typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) {
      throw new IdentityReadUnavailable('native control needs its original private saved state')
    }
    return identity(info)
  }
  const originalDirectory = privateState(directory, true)
  privateState(file, false)
  const routes = hookPreparationRoutes([file]), retained = inspectHookFile(file, 0o600)
  // A commit replaces the leaf intentionally, never the authority for its parent.
  const verifyDirectory = () => {
    if (privateState(directory, true) !== originalDirectory) throw new IdentityReadUnavailable('the original native control directory changed')
    routes.verify()
  }
  const verify = () => {
    verifyDirectory(); privateState(file, false)
    retained.verify()
  }
  return {
    content: retained.content, verify, verifyDirectory,
    confirm(current: () => void) {
      const check = () => { verify(); current() }
      for (const [path, isDirectory] of [[file, false], [directory, true]] as const) {
        const version = isDirectory ? identity : stamp, before = isDirectory ? originalDirectory : retained.stamp
        check()
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (isDirectory ? constants.O_DIRECTORY : constants.O_NONBLOCK))
        try {
          if (version(fstatSync(fd, { bigint: true })) !== before) throw new IdentityReadUnavailable('native control changed before durability confirmation')
          check()
          fsyncSync(fd)
          if (version(fstatSync(fd, { bigint: true })) !== before) {
            throw new IdentityReadUnavailable('native control changed during durability confirmation')
          }
          check()
        } finally { closeSync(fd) }
      }
      check()
    },
  }
}
