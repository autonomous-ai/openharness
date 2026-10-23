/** Canonical path evidence for a bounded native descriptor pool, including excluded candidates. */
import { lstatSync, readlinkSync, type BigIntStats } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, win32 } from 'node:path'
import { NativeEvidenceBudget, nativeUnavailable } from './nativeEvidence.js'
import { hostPlatform } from './windowsFiles.js'

export const nativeFileKey = (info: Pick<BigIntStats, 'dev' | 'ino'>) => `${info.dev}:${info.ino}`
const identity = (info: BigIntStats | null) => info && `${nativeFileKey(info)}:${info.mode}:${info.uid}`
const version = (info: BigIntStats) => `${identity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
/** Saved evidence outlives a reboot, and st_dev does not: macOS numbers /dev/diskN as disks appear at boot, so one
 * restart moved a user's data volume from 1,4 to 1,7 and held every launch for good (2026-10-16). Saved identities
 * and versions lead with st_dev; they are compared without it. */
export const withoutDevice = <T extends string | null | undefined>(saved: T): T => (saved && saved.slice(saved.indexOf(':') + 1)) as T
type Part = { info: BigIntStats | null; target?: string }
type Location = { path: string; info: BigIntStats } | null
/** Immutable route facts can cross a service boundary; timestamps matter for aliases, not sibling churn. */
export type NativePathFact = { path: string; identity: string | null; alias?: { target: string; version: string } }
export function verifyNativePathFacts(facts: readonly NativePathFact[]): void {
  const budget = new NativeEvidenceBudget()
  if (!facts.length || facts.length > 256) return nativeUnavailable('the retained route exceeds its limit')
  for (const fact of facts) {
    budget.step()
    if (!isAbsolute(fact.path) || fact.path.includes('\0') || Buffer.byteLength(fact.path) > 4096) {
      return nativeUnavailable('the retained route is invalid')
    }
    let info: BigIntStats | null, target: string | undefined
    try {
      info = lstatSync(fact.path, { bigint: true })
      if (info.isSymbolicLink()) target = readlinkSync(fact.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return nativeUnavailable('the retained route became unreadable')
      info = null
    }
    if (withoutDevice(identity(info)) !== withoutDevice(fact.identity)
      || (fact.alias && (!info || withoutDevice(version(info)) !== withoutDevice(fact.alias.version) || target !== fact.alias.target))) {
      return nativeUnavailable('the retained route changed during preparation')
    }
  }
}

/** NativePaths walks the paths node:path produces, so by default it walks Windows paths when the path module is
 * Windows' and POSIX ones otherwise, not by `process.platform`: a spec that fakes win32 on a POSIX host still has POSIX paths. */
export class NativePaths {
  private readonly parts = new Map<string, Part>()
  private readonly windows: boolean
  constructor(private readonly budget: NativeEvidenceBudget, platform?: NodeJS.Platform) {
    this.windows = (platform ?? hostPlatform()) === 'win32'
  }

  async resolve(path: string, missingOkay = false): Promise<Location> {
    const steps = this.walk(path, missingOkay)
    let next = steps.next()
    while (!next.done) {
      let proof: Part
      try {
        const info = await lstat(next.value, { bigint: true })
        proof = { info, ...(info.isSymbolicLink() ? { target: await readlink(next.value) } : {}) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') proof = { info: null }
        else return nativeUnavailable('a native location could not be inspected')
      }
      next = steps.next(proof)
    }
    return next.value
  }

  /** Eager binding and hook admission share exactly the same bounded ancestry rules. */
  resolveSync(path: string, missingOkay = false): Location {
    const steps = this.walk(path, missingOkay)
    let next = steps.next()
    while (!next.done) {
      let proof: Part
      try {
        const info = lstatSync(next.value, { bigint: true })
        proof = { info, ...(info.isSymbolicLink() ? { target: readlinkSync(next.value) } : {}) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') proof = { info: null }
        else return nativeUnavailable('a native location could not be inspected')
      }
      next = steps.next(proof)
    }
    return next.value
  }

  snapshot(): NativePathFact[] {
    this.verify()
    return [...this.parts].map(([path, part]) => ({ path, identity: identity(part.info),
      ...(part.target !== undefined ? { alias: { target: part.target, version: version(part.info!) } } : {}) }))
  }

  /** Only an observed absent leaf can be announced before creation. A dangling alias is
   * still an existing leaf and must not borrow the authority of its original parent. */
  absentLeaf(path: string): boolean { return this.parts.get(path)?.info === null }

  /** A reviewed deletion may remove this subtree, never its observed ancestors or aliases.
   * Retain only immutable route facts; every later check receives a fresh bounded budget. */
  retainOutside(removedPath: string): () => void {
    this.budget.step()
    const separator = this.windows ? '\\' : '/'
    const retained = [...this.parts].filter(([path]) => path !== removedPath && !path.startsWith(removedPath + separator))
    return () => {
      const fresh = new NativePaths(new NativeEvidenceBudget(), this.windows ? 'win32' : 'linux')
      for (const [path, part] of retained) fresh.parts.set(path, part)
      fresh.verify()
    }
  }

  private *walk(path: string, missingOkay: boolean): Generator<string, Location, Part> {
    if (this.windows) return yield* this.walkWindows(path, missingOkay)
    if (!isAbsolute(path) || path.includes('\0') || Buffer.byteLength(path) > 4096) return nativeUnavailable('a native location is invalid or exceeds its limit')
    // Follow links in component order. Normalizing bridge/../home first would skip bridge.
    let prefix = '/', pending = path.slice(1).split('/').filter(Boolean), links = 0
    let info: BigIntStats | null = null
    if (!pending.length) pending = ['.']
    for (let index = 0; pending.length; index++) {
      this.budget.step()
      if (index >= 256) return nativeUnavailable('the native path component limit was reached')
      const part = pending.shift()!
      if (part === '..') { prefix = dirname(prefix); if (!pending.length) pending = ['.']; continue }
      if (part === '.' && pending.length) continue
      const next = part === '.' ? prefix : join(prefix, part)
      let proof = this.parts.get(next)
      if (!proof) {
        proof = yield next
        this.parts.set(next, proof)
      }
      info = proof.info
      if (!info) {
        if (missingOkay) return null
        return nativeUnavailable('a native location is missing')
      }
      if (proof.target !== undefined) {
        if (++links > 32) return nativeUnavailable('the native alias depth limit was reached')
        if (isAbsolute(proof.target)) prefix = '/'
        pending = [...proof.target.split('/').filter(Boolean), ...pending]
        if (!pending.length) pending = ['.']
      } else {
        if (pending.length && !info.isDirectory()) return nativeUnavailable('a native path ancestor is not a directory')
        prefix = next
      }
    }
    this.budget.step()
    return { path: prefix, info: info! }
  }

  /**
   * A Windows path: drive-absolute only (`C:\…`), never a UNC share, a device path (`\\?\`, `\\.\`) or a drive-relative
   * one. NTFS gives Node no owner or mode bits to trust a hook file by. What protects it is the profile's ACL and the
   * route itself, so no step may be a link: Harness refuses what Node reports as a symbolic link (symlinks and
   * junctions), and never follows it (spec section 4). `..` is then lexical. A `:` after the drive (an alternate data
   * stream) is refused.
   */
  private *walkWindows(path: string, missingOkay: boolean): Generator<string, Location, Part> {
    if (!/^[A-Za-z]:[\\/]/.test(path) || path.includes('\0') || Buffer.byteLength(path) > 4096) {
      return nativeUnavailable('a native location is invalid or exceeds its limit')
    }
    const steps = [`${path[0].toUpperCase()}:\\`]
    for (const part of path.slice(3).split(/[\\/]/).filter(Boolean)) {
      if (steps.length > 256) return nativeUnavailable('the native path component limit was reached')
      if (part.includes(':')) return nativeUnavailable('a native location is invalid or exceeds its limit')
      if (part === '.') continue
      if (part === '..') { if (steps.length > 1) steps.pop(); continue }
      steps.push(win32.join(steps.at(-1)!, part))
    }
    let info: BigIntStats | null = null
    for (const [index, next] of steps.entries()) {
      this.budget.step()
      let proof = this.parts.get(next)
      if (!proof) {
        proof = yield next
        this.parts.set(next, proof)
      }
      info = proof.info
      if (!info) return missingOkay ? null : nativeUnavailable('a native location is missing')
      if (proof.target !== undefined) return nativeUnavailable('a native location on Windows is a reparse point (a link or junction), which Harness does not follow')
      if (index < steps.length - 1 && !info.isDirectory()) return nativeUnavailable('a native path ancestor is not a directory')
    }
    this.budget.step()
    return { path: steps.at(-1)!, info: info! }
  }

  /** Case/normalization aliases and bind mounts can have different spellings for
   * the same directory. Only the observed physical ancestor chain proves membership. */
  within(path: string, roots: readonly BigIntStats[]): boolean {
    const keys = new Set(roots.map(nativeFileKey))
    const parentOf = this.windows ? win32.dirname : dirname
    for (let parent = parentOf(path);;) {
      this.budget.step()
      const part = this.parts.get(parent)
      if (part?.info && !part.target && part.info.isDirectory() && keys.has(nativeFileKey(part.info))) return true
      // The root (`/`, or a drive's `C:\`) is its own parent.
      if (parentOf(parent) === parent) return false
      if (!part?.info || part.target !== undefined || !part.info.isDirectory()) return nativeUnavailable('the native directory ancestry is incomplete')
      parent = parentOf(parent)
    }
  }

  /** No asynchronous work follows the caller's last header fence. Unrelated directory
   * contents may change; replacing an ordinary ancestor or any alias may not. */
  verify(): void {
    for (const [path, before] of this.parts) {
      this.budget.step()
      let now: BigIntStats | null
      try { now = lstatSync(path, { bigint: true }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') now = null
        else return nativeUnavailable('a native location became unreadable')
      }
      let target: string | undefined
      if (before.target !== undefined && now?.isSymbolicLink()) {
        try { target = readlinkSync(path) } catch { return nativeUnavailable('a native alias became unreadable') }
      }
      if (identity(now) !== identity(before.info)
        || (before.target !== undefined && (!now || version(now) !== version(before.info!)
          || target !== before.target))) {
        return nativeUnavailable('a native path or alias changed during inspection')
      }
    }
  }
}
