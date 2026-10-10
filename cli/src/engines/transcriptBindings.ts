/** Eager native transcript authority shared by binding, Stop and resume preflight. */
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { env } from '../config/env.js'
import { engineHomeSnapshot, sessionRoots, type EngineHomeSnapshot } from '../lib/engineHomes.js'
import { cursorDataDir } from './cursor/contract.js'
import { NativeFiles } from './kit/nativeFiles.js'
import { nativeFileKey } from './kit/nativePaths.js'
import { nativeUnavailable } from './kit/nativeEvidence.js'
import { sessionStoreOf } from './sessionStoreContracts.js'
import type { AgentEngine } from './types.js'

/** Null means the engine stores conversations in a database, or is only a shell. */
export const transcriptRoot: Readonly<Record<AgentEngine, (() => string) | 'store' | null>> = {
  amp: () => env.AMP_SESSIONS_DIR,
  muse: () => join(env.MUSE_HOME, 'sessions'),
  codex: 'store',
  grok: () => join(env.GROK_HOME, 'sessions'),
  agy: () => join(env.AGY_HOME, 'brain'),
  copilot: () => join(env.COPILOT_HOME, 'session-state'),
  cursor: () => join(cursorDataDir(), 'projects'),
  pi: () => join(env.PI_HOME, 'agent', 'sessions'),
  commandcode: () => join(env.COMMANDCODE_HOME, 'projects'),
  claude: 'store',
  opencode: null, kilo: null, hermes: null, devin: null, terminal: null,
}
export const engineKeepsTranscriptFile = (engine: AgentEngine): boolean => transcriptRoot[engine] !== null
export const needsHomeCatalog = (engine: AgentEngine, profile?: string | null): boolean =>
  transcriptRoot[engine] === 'store' && !(sessionStoreOf(engine)?.sessions.profile && profile)

/** One explicit load batch can reuse root ancestry, including absent roots, then fence it
 * once before publishing its dependent rows. This proof never survives the operation. */
export function transcriptRootEvidence(engine: AgentEngine, profile?: string, snapshot?: EngineHomeSnapshot) {
  const files = new NativeFiles(), root = transcriptRoot[engine]
  const ownSnapshot = !snapshot && needsHomeCatalog(engine, profile) ? engineHomeSnapshot() : undefined
  const roots = root === 'store' ? sessionRoots(engine, profile, snapshot ?? ownSnapshot) : root ? [root()] : []
  const directories = roots.flatMap(path => {
    const location = files.locate(path, true)
    if (!location) return []
    if (!location.info.isDirectory()) return nativeUnavailable('a transcript root is not a directory')
    return [{ original: path, ...location }]
  })
  return { directories, verify(): void { files.verify(); ownSnapshot?.verify() } }
}

/** A deterministic engine locator can precede its directories. Retain the first
 * missing component and its owned ancestor; a dangling alias is not absence. */
function futureDirectory(files: NativeFiles, path: string): { path: string; present: boolean } {
  if (path.split('/').includes('..')) return nativeUnavailable('an unwritten transcript has an unresolved parent step')
  const suffix: string[] = []
  for (let at = path;; at = dirname(at)) {
    files.budget.step()
    const location = files.locate(at, true)
    if (location) {
      if (!location.info.isDirectory()) return nativeUnavailable('the announced transcript ancestor is not a directory')
      if (typeof process.getuid === 'function' && location.info.uid !== BigInt(process.getuid())) {
        return nativeUnavailable('the announced transcript ancestor has an unconfirmed owner')
      }
      if (suffix.length && !files.paths.absentLeaf(join(location.path, suffix[0]))) {
        return nativeUnavailable('the announced transcript ancestor is not a proven absent leaf')
      }
      return { path: join(location.path, ...suffix), present: !suffix.length }
    }
    if (suffix.length >= 64 || at === dirname(at)) return nativeUnavailable('the unwritten transcript ancestor limit was reached')
    suffix.unshift(basename(at))
  }
}

/** A caller can supply its explicit synchronous batch proofs and verify them before publication.
 * Only core-derived locators may name directories that the engine has not written yet. */
export function transcriptEvidence(engine: AgentEngine, path: string, profile?: string,
  allowMissing: boolean | 'derived' = false, snapshot?: EngineHomeSnapshot, roots?: ReturnType<typeof transcriptRootEvidence>,
) {
  const files = new NativeFiles(), root = transcriptRoot[engine]
  const scope = roots ?? transcriptRootEvidence(engine, profile, snapshot)
  const location = root ? files.file(path, true) : null
  if (!location && allowMissing === 'derived') {
    if (typeof root !== 'function') return nativeUnavailable('the unwritten transcript has no deterministic root')
    const parent = futureDirectory(files, dirname(path)), declared = futureDirectory(files, root())
    const actual = join(parent.path, basename(path))
    if (parent.present && !files.paths.absentLeaf(actual)) {
      return nativeUnavailable('the announced transcript is not a proven absent leaf')
    }
    const member = relative(declared.path, actual)
    return { valid: !!member && member !== '..' && !member.startsWith('../') && !isAbsolute(member), files,
      matchingRoots: scope.directories,
      verify(selected = path): void { files.verify(selected); if (!roots) scope.verify() } }
  }
  const parent = !location && allowMissing ? files.locate(dirname(path), true) : null
  if (parent && !parent.info.isDirectory()) return nativeUnavailable('the announced transcript parent is not a directory')
  if (parent && typeof process.getuid === 'function' && parent.info.uid !== BigInt(process.getuid())) {
    return nativeUnavailable('the announced transcript parent has an unconfirmed owner')
  }
  if (parent && !files.paths.absentLeaf(join(parent.path, basename(path)))) {
    return nativeUnavailable('the announced transcript is not a proven absent leaf')
  }
  const actual = location?.path ?? (parent ? join(parent.path, basename(path)) : null)
  const matchingRoots = actual ? scope.directories.filter(directory => files.paths.within(actual, [directory.info])) : []
  const valid = !!actual && matchingRoots.length > 0 && (engine !== 'cursor'
    || (!!basename(actual).replace(/\.jsonl$/, '') && basename(dirname(actual)) === basename(actual).replace(/\.jsonl$/, '')
      && basename(dirname(dirname(actual))) === 'agent-transcripts'))
  return {
    valid, files, matchingRoots,
    verify(selected = path): void { files.verify(selected); if (!roots) scope.verify() },
  }
}

/** Parent repair requires the complete declared pool, including unreadable or excluded candidates. */
function parentTranscript(files: NativeFiles, engine: AgentEngine, id: string,
  roots: ReturnType<typeof transcriptRootEvidence>['directories'],
): string | null {
  const store = sessionStoreOf(engine), rule = store?.byId
  if (rule?.layout !== 'walk' || !store?.first || !rule.id.test(id)) return null
  const visited = new Set<string>(), selected = new Map<string, string>()
  let candidates = 0
  const walk = (path: string, depth: number): void => {
    if (depth > 32) return nativeUnavailable('the binding transcript depth limit was reached')
    const location = files.locate(path, true)
    if (!location) return
    if (!location.info.isDirectory()) return nativeUnavailable('a binding transcript directory is not a directory')
    if (!roots.some(root => nativeFileKey(root.info) === nativeFileKey(location.info))
      && !files.paths.within(location.path, roots.map(root => root.info))) {
      return nativeUnavailable('a binding parent directory escaped its transcript roots')
    }
    const key = nativeFileKey(location.info)
    if (visited.has(key)) return
    visited.add(key)
    for (const name of files.entries(path)) {
      const candidate = join(path, name)
      if (name.endsWith(rule.suffix) && name.includes(id)) {
        if (++candidates > 64) return nativeUnavailable('the binding transcript candidate limit was reached')
        const file = files.file(candidate)!
        if (!files.paths.within(file.path, roots.map(root => root.info))) {
          return nativeUnavailable('a binding parent candidate escaped its transcript roots')
        }
        const meta = files.header(candidate, store.first!)
        if (meta.id === id && !meta.isSubagent) selected.set(nativeFileKey(file.info), selected.get(nativeFileKey(file.info)) ?? candidate)
      } else if (!name.includes('.')) {
        const child = files.locate(candidate)!
        if (child.info.isDirectory()) walk(candidate, depth + 1)
      }
    }
  }
  for (const root of roots) walk(root.original, 0)
  if (selected.size > 1) return nativeUnavailable('more than one transcript matches the bound parent conversation')
  return selected.values().next().value ?? null
}

/** Validate a saved binding and repair a conclusively identified child overwrite before committing. */
export function savedTranscriptEvidence(engine: AgentEngine, sessionId: string, path: string,
  profile?: string, snapshot?: EngineHomeSnapshot, roots?: ReturnType<typeof transcriptRootEvidence>,
) {
  const proof = transcriptEvidence(engine, path, profile, false, snapshot, roots)
  let selected: string | null = proof.valid ? path : null
  const store = sessionStoreOf(engine)
  if (selected && store?.first) {
    const meta = proof.files.header(selected, store.first)
    if (meta.isSubagent) {
      selected = store.repairsOverwrittenParent && meta.parentThreadId === sessionId
        ? parentTranscript(proof.files, engine, sessionId, proof.matchingRoots) : null
    } else if (meta.id !== sessionId) {
      return nativeUnavailable('the saved transcript names a different conversation')
    }
  }
  const fileKey = selected ? nativeFileKey(proof.files.file(selected)!.info) : null
  return { path: selected, fileKey, verify: () => proof.verify(selected ?? path) }
}

/** Keep immutable identity across awaits, not a lookup's expiring work budget.
 * Each control boundary earns fresh header, root and catalog evidence before acting. */
export function controlTranscriptEvidence(engine: AgentEngine, sessionId: string, path: string, profile?: string) {
  const read = () => {
    const proof = savedTranscriptEvidence(engine, sessionId, path, profile)
    proof.verify()
    if (!proof.path) return nativeUnavailable('the saved conversation file is unavailable')
    return { path: proof.path, fileKey: proof.fileKey }
  }
  const before = read()
  return { path: before.path, verify(): void {
    const after = read()
    if (after.path !== before.path || after.fileKey !== before.fileKey) {
      nativeUnavailable('the saved conversation file was replaced during the operation')
    }
  } }
}
