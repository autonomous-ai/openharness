/** Fresh synchronous file evidence for eager binding; each instance belongs to one operation. */
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type BigIntStats } from 'node:fs'
import { dirname } from 'node:path'
import { IdentityReadUnavailable } from './identityScan.js'
import { NativeEvidenceBudget, nativeUnavailable } from './nativeEvidence.js'
import { nativeFileKey, NativePaths } from './nativePaths.js'
import { firstLine, nativeSessionMeta, type NativeFirstRecord } from './nativeHeader.js'
import { controlIdentity, type ControlIdentityRule } from './controlIdentity.js'

const stamp = (info: BigIntStats) => `${nativeFileKey(info)}:${info.mode}:${info.uid}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
type Location = { path: string; info: BigIntStats }
type Read = { location: Location; limit: number; line?: string; prefix?: Buffer }

export class NativeFiles {
  readonly paths: NativePaths
  private readonly reads = new Map<string, Read>()
  private readonly directories = new Map<string, string>()
  private entriesLeft = 4096
  constructor(readonly budget = new NativeEvidenceBudget(250)) { this.paths = new NativePaths(budget) }

  locate(path: string, missingOkay = false): Location | null {
    return this.paths.resolveSync(path, missingOkay)
  }

  /** A readable regular file, tied to the path that was inspected, even for an empty file. */
  file(path: string, missingOkay = false): Location | null {
    const location = this.locate(path, missingOkay)
    if (!location) return null
    this.read(location, 1)
    if (!this.reads.has(location.path)) this.reads.set(location.path, { location, limit: 1 })
    return location
  }

  header(path: string, first: NativeFirstRecord) {
    const location = this.locate(path)!
    try {
      const line = firstLine(this.read(location, first.maxBytes + 1), first.maxBytes)
      const meta = nativeSessionMeta(line, first)
      const earlier = this.reads.get(location.path)
      if (earlier?.line !== undefined && earlier.line !== line) return nativeUnavailable('the binding header changed during inspection')
      this.reads.set(location.path, { location, limit: first.maxBytes + 1, line })
      return meta
    } catch (error) {
      if (error instanceof IdentityReadUnavailable) throw error
      return nativeUnavailable('the binding header could not be read completely')
    }
  }

  opening(path: string, rule: ControlIdentityRule) {
    const location = this.locate(path)!
    const bytes = this.read(location, rule.maxBytes + 1)
    const meta = controlIdentity(bytes, rule)
    const prefix = Buffer.from(bytes.subarray(0, meta.bytes))
    this.reads.set(location.path, { location, limit: prefix.length, prefix })
    return { ...meta, fileKey: nativeFileKey(location.info) }
  }

  private read(location: Location, limit: number): Buffer {
    this.budget.step()
    let fd: number | undefined
    try {
      fd = openSync(location.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      const before = fstatSync(fd, { bigint: true })
      if (!before.isFile() || nativeFileKey(before) !== nativeFileKey(location.info)
        || (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid()))) {
        return nativeUnavailable('the binding file has an unconfirmed identity, owner or type')
      }
      const bytes = Buffer.alloc(Math.min(Number(before.size), limit))
      let length = 0
      for (let calls = 0; length < bytes.length; calls++) {
        this.budget.step()
        if (calls >= 64) return nativeUnavailable('the binding file read-operation limit was reached')
        const count = readSync(fd, bytes, length, bytes.length - length, length)
        this.budget.step(count)
        if (!count) return nativeUnavailable('the binding file ended during its read')
        length += count
      }
      if (stamp(fstatSync(fd, { bigint: true })) !== stamp(before)) return nativeUnavailable('the binding file changed during its read')
      return bytes
    } catch (error) {
      if (error instanceof IdentityReadUnavailable) throw error
      return nativeUnavailable('the binding file could not be read')
    } finally {
      if (fd !== undefined) { try { closeSync(fd) } catch { nativeUnavailable('the binding file could not be closed') } }
    }
  }

  /** Guard the iterator's acquisition too: an ancestor can move away and back around opendir.
   * Content stamps on ancestors last only for this enumeration, not the entire pool lookup. */
  private directoryRoute(path: string): Map<string, string> {
    const result = new Map<string, string>()
    for (let part = path;; part = dirname(part)) {
      this.budget.step()
      let info: BigIntStats
      try { info = lstatSync(part, { bigint: true }) }
      catch { return nativeUnavailable('a binding directory ancestor could not be inspected') }
      if (!info.isDirectory()) return nativeUnavailable('a binding directory ancestor changed type')
      result.set(part, stamp(info))
      if (part === dirname(part)) return result
    }
  }

  entries(path: string, missingOkay = false): string[] {
    this.budget.step()
    if (--this.entriesLeft < 0) return nativeUnavailable('the binding directory entry limit was reached')
    const location = this.locate(path, missingOkay)
    if (!location) return []
    if (!location.info.isDirectory()) return nativeUnavailable('a binding session directory is not a directory')
    const route = this.directoryRoute(location.path)
    let before: BigIntStats
    try { before = lstatSync(location.path, { bigint: true }) }
    catch { return nativeUnavailable('a binding session directory became unreadable') }
    if (nativeFileKey(before) !== nativeFileKey(location.info)) return nativeUnavailable('a binding session directory was replaced')
    let directory
    const names: string[] = []
    try {
      directory = opendirSync(location.path, { bufferSize: 32 })
      for (;;) {
        this.budget.step()
        const entry = directory.readSync()
        if (!entry) break
        if (--this.entriesLeft < 0) return nativeUnavailable('the binding directory entry limit was reached')
        names.push(entry.name)
      }
    } catch (error) {
      if (error instanceof IdentityReadUnavailable) throw error
      return nativeUnavailable('a binding session directory could not be read completely')
    } finally {
      if (directory) { try { directory.closeSync() } catch { nativeUnavailable('a binding session directory could not be closed') } }
    }
    const after = this.directoryRoute(location.path)
    if (route.size !== after.size || [...route].some(([part, version]) => after.get(part) !== version)) {
      return nativeUnavailable('a binding directory or ancestor changed during enumeration')
    }
    this.directories.set(location.path, stamp(before))
    return names
  }

  /** Selected identity is checked last. Appended body text does not change a complete header. */
  verify(selected?: string): void {
    this.paths.verify()
    for (const [path, before] of this.directories) {
      this.budget.step()
      try {
        if (stamp(lstatSync(path, { bigint: true })) !== before) return nativeUnavailable('the binding directory pool changed')
      } catch (error) {
        if (error instanceof IdentityReadUnavailable) throw error
        return nativeUnavailable('a binding directory became unreadable')
      }
    }
    const last = selected && this.locate(selected, true)?.path
    const records = [...this.reads.values()]
    for (const record of [...records.filter(read => read.location.path !== last), ...records.filter(read => read.location.path === last)]) {
      const bytes = this.read(record.location, record.limit)
      if (record.prefix && !bytes.equals(record.prefix)) return nativeUnavailable('the conversation opening changed during inspection')
      if (record.line !== undefined && firstLine(bytes, record.limit - 1) !== record.line) {
        return nativeUnavailable('the binding header changed during inspection')
      }
    }
    this.paths.verify()
  }
}
