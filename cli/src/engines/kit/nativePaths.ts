/** Canonical path evidence for a bounded native descriptor pool, including excluded candidates. */
import { lstatSync, readlinkSync, type BigIntStats } from 'node:fs'
import { lstat, readlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { NativeEvidenceBudget, nativeUnavailable } from './nativeEvidence.js'

export const nativeFileKey = (info: Pick<BigIntStats, 'dev' | 'ino'>) => `${info.dev}:${info.ino}`
const identity = (info: BigIntStats | null) => info && `${nativeFileKey(info)}:${info.mode}`
const version = (info: BigIntStats) => `${identity(info)}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
type Part = { info: BigIntStats | null; target?: string }

export class NativePaths {
  private readonly parts = new Map<string, Part>()
  constructor(private readonly budget: NativeEvidenceBudget) {}

  async resolve(path: string, missingOkay = false): Promise<{ path: string; info: BigIntStats } | null> {
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
        try {
          info = await lstat(next, { bigint: true })
          proof = { info, ...(info.isSymbolicLink() ? { target: await readlink(next) } : {}) }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') proof = { info: null }
          else return nativeUnavailable('a native location could not be inspected')
        }
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

  /** Case/normalization aliases and bind mounts can have different spellings for
   * the same directory. Only the observed physical ancestor chain proves membership. */
  within(path: string, roots: readonly BigIntStats[]): boolean {
    const keys = new Set(roots.map(nativeFileKey))
    for (let parent = dirname(path);;) {
      this.budget.step()
      const part = this.parts.get(parent)
      if (part?.info && !part.target && part.info.isDirectory() && keys.has(nativeFileKey(part.info))) return true
      if (parent === '/') return false
      if (!part?.info || part.target !== undefined || !part.info.isDirectory()) return nativeUnavailable('the native directory ancestry is incomplete')
      parent = dirname(parent)
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
