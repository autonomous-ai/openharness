/** A complete, bounded native pool for an exact resume id. No optional reader or cross-poll cache. */
import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs'
import { lstat, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { identityBytes, identityEntries, identityScanBudget, IdentityReadUnavailable, type IdentityVersion } from './identityScan.js'

type Layout = { kind: 'projects'; filename: string }
  | { kind: 'walk' | 'directory'; matches: (name: string) => boolean }
type Proof = { path: string; info: Stats | null; content: boolean }
const identity = (info: Stats | null) => info && `${info.dev}:${info.ino}:${info.mode}`
const signature = (info: Stats | null) => info && `${identity(info)}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`

/** Filename authority remains engine-declared. An optional native header can reject another id/cwd;
 * every such exclusion is retained until the complete pool has been checked. */
export async function exactTranscript(roots: readonly string[], layout: Layout,
  options: { accepts?: (path: string, version: IdentityVersion) => Promise<boolean>; verify?: () => void; ambiguous?: string } = {},
): Promise<string | null> {
  if (roots.length > 64) throw new IdentityReadUnavailable('the known session-home limit was reached')
  const budget = identityScanBudget(), started = performance.now()
  const proofs: Proof[] = [], visited = new Set<string>()
  const pathParts = new Map<string, { info: Stats; target?: string }>()
  const aliases = new Map<string, Stats>()
  const selected = new Map<string, Proof>()
  let candidates = 0
  const deadline = () => {
    if (performance.now() - started > 2000) throw new IdentityReadUnavailable('the exact transcript lookup deadline was reached')
  }
  // A directory opened through A -> B -> A can list B while both target stats name A.
  // Retain the links themselves, including links in ancestors and in another link's target.
  // Ordinary ancestor directories retain no content stamp: unrelated activity in /tmp is not ours.
  const inspectAliases = async (path: string) => {
    const location = resolve(path), root = parse(location).root
    let prefix = root, pending = location.slice(root.length).split(sep).filter(Boolean), links = 0
    while (pending.length) {
      deadline()
      const part = pending.shift()!
      if (part === '.') continue
      if (part === '..') { prefix = dirname(prefix); continue }
      const next = join(prefix, part)
      let evidence = pathParts.get(next)
      if (!evidence) {
        if (budget.remaining-- <= 0) throw new IdentityReadUnavailable('the directory entry limit was reached')
        try {
          const info = await lstat(next)
          evidence = { info, ...(info.isSymbolicLink() ? { target: await readlink(next) } : {}) }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw new IdentityReadUnavailable('an exact transcript alias could not be inspected')
        }
        pathParts.set(next, evidence)
      }
      if (evidence.target !== undefined) {
        if (++links > 32) throw new IdentityReadUnavailable('the exact transcript alias depth limit was reached')
        aliases.set(next, evidence.info)
        const targetRoot = isAbsolute(evidence.target) ? parse(evidence.target).root : ''
        if (targetRoot) prefix = targetRoot
        // Follow each link before consuming a later '..'. Lexically normalizing bridge/../home
        // could skip bridge when it actually points at another directory's child.
        const targetParts = evidence.target.slice(targetRoot.length).split(sep === '/' ? /\// : /[\\/]/).filter(Boolean)
        pending = [...targetParts, ...pending]
      } else prefix = next
    }
  }

  const inspect = async (path: string): Promise<Stats | null> => {
    deadline()
    await inspectAliases(path)
    try {
      const info = await lstat(path)
      return info.isSymbolicLink() ? await lstat(await realpath(path)) : info
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new IdentityReadUnavailable('an exact transcript location could not be inspected')
    }
  }
  const candidate = async (path: string) => {
    const info = await inspect(path)
    const proof = { path, info, content: !!options.accepts }
    proofs.push(proof)
    if (!info) return
    if (++candidates > 64) throw new IdentityReadUnavailable('the exact transcript candidate limit was reached')
    if (!info.isFile()) throw new IdentityReadUnavailable('an exact transcript is not a regular file')
    // Even filename-based authority needs a readable regular file. Opening one byte is bounded and
    // nonblocking; stat alone would let an unreadable file authorize a binding.
    if (options.accepts ? await options.accepts(path, info) : await identityBytes(path, 1, info).then(() => true).catch(() => {
      throw new IdentityReadUnavailable('an exact transcript could not be read')
    })) {
      selected.set(identity(info)!, selected.get(identity(info)!) ?? proof)
    }
    deadline()
  }
  const linkedDirectory = async (path: string): Promise<boolean> => {
    const info = await inspect(path)
    proofs.push({ path, info, content: true })
    return info?.isDirectory() ?? false
  }
  const walk = async (path: string, depth = 0): Promise<void> => {
    if (depth > 32) throw new IdentityReadUnavailable('the exact transcript depth limit was reached')
    const info = await inspect(path)
    proofs.push({ path, info, content: true })
    if (!info) return
    if (!info.isDirectory()) throw new IdentityReadUnavailable('an exact transcript directory is not a directory')
    const key = identity(info)!
    if (visited.has(key)) return // Directory aliases retain their path proof without another scan.
    visited.add(key)
    for await (const entry of identityEntries(path, budget, false)) {
      deadline()
      const full = join(path, entry.name)
      if (layout.kind === 'projects') {
        const directory = entry.isDirectory() || (entry.isSymbolicLink() && await linkedDirectory(full))
        if (directory) await candidate(join(full, layout.filename))
      } else if (layout.matches(entry.name)) {
        await candidate(full)
      } else if (layout.kind === 'walk' && !entry.name.includes('.')) {
        const directory = entry.isDirectory() || (entry.isSymbolicLink() && await linkedDirectory(full))
        if (directory) await walk(full, depth + 1)
      }
    }
  }
  for (const root of roots) await walk(root)
  deadline()
  // Keep the final pool check synchronous and the selected file last: no later native await may
  // invalidate the selected header. This is bounded change detection, not an atomic filesystem view.
  const only = selected.size === 1 ? selected.values().next().value! : undefined
  options.verify?.()
  for (const [path, info] of aliases) {
    deadline()
    try {
      if (signature(lstatSync(path)) !== signature(info)) throw new Error('changed alias')
    } catch { throw new IdentityReadUnavailable('an exact transcript alias changed during lookup') }
  }
  for (const proof of [...proofs.filter(proof => proof !== only), ...(only ? [only] : [])]) {
    deadline()
    let now: Stats | null
    try { now = statSync(proof.path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') now = null
      else throw new IdentityReadUnavailable('an exact transcript location became unavailable')
    }
    const fingerprint = proof.content ? signature : identity
    if (fingerprint(now) !== fingerprint(proof.info)) {
      throw new IdentityReadUnavailable('the exact transcript pool changed during lookup')
    }
  }
  if (selected.size > 1) {
    if (options.ambiguous) throw new IdentityReadUnavailable(options.ambiguous, options.ambiguous)
    throw new IdentityReadUnavailable('more than one transcript matches the resumed conversation')
  }
  return only?.path ?? null
}

/** A lossy workspace folder needs canonical evidence for both matches and exclusions. */
export function exactWorkspaces(): { same: (left: string, right: string) => Promise<boolean>; verify: () => void } {
  const proofs = new Map<string, { target: string; identity: string }>()
  const read = async (path: string): Promise<string> => {
    try {
      const target = await realpath(path), info = await lstat(target)
      if (!info.isDirectory()) throw new Error('not a directory')
      const proof = { target, identity: identity(info)! }, previous = proofs.get(path)
      if (previous && (previous.target !== proof.target || previous.identity !== proof.identity)) throw new Error('changed workspace')
      proofs.set(path, proof)
      return target
    } catch { throw new IdentityReadUnavailable('the Pi workspace identity could not be read') }
  }
  return {
    same: async (left, right) => await read(left) === await read(right),
    verify: () => {
      for (const [path, proof] of proofs) {
        try {
          if (realpathSync(path) !== proof.target || identity(statSync(path)) !== proof.identity) throw new Error('changed workspace')
        } catch { throw new IdentityReadUnavailable('the Pi workspace identity changed during lookup') }
      }
    },
  }
}
