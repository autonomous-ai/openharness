/**
 * Codex profiles — CODEX_HOME folders this machine can point a Codex agent at.
 *
 * Runs entirely on whatever machine the CLI is on (see `backendSocket.ts`'s `codex_profiles_list`
 * and `codex_profile_link` cases), which is what makes this work for a remote machine: the desktop
 * app never touches a filesystem itself, it only renders what this reports. Ported from the Flutter
 * desktop app's `lib/core/codex_profiles.dart`, whose discovery half moved to `codexProfileDiscovery.ts`
 * and whose "linked" persistence moved from the app's own local storage (which could not mean
 * anything for a remote machine) to this machine's own state directory.
 */

import { lstatSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'
import { env } from '../config/env.js'
import { homeIsAbsolute } from '../engines/kit/homeAdoption.js'
import { discoverCodexProfiles } from './codexProfileDiscovery.js'
import { atomicWriteJson, hardenPrivateStateFileIfPresent, jsonArray, probeState, readState, requireState, secureStateDirectory } from './secureState.js'

export interface CodexProfile {
  path: string
  label: string
}

export type CodexProfileError = { error: 'INVALID_PATH' | 'NOT_FOUND' }

const FILE = join(env.ADAPTER_DATA_DIR, 'codex-profiles.json')
const MAX_LINKED = 256
const LIST_MAX_BYTES = 1024 * 1024
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/

/** A path a link takes as given: absolute, at most 4096 characters, no control character. */
const wellFormed = (path: string): boolean => homeIsAbsolute(path) && path.length <= 4096 && !CONTROL_CHARS_RE.test(path)

function labelFor(path: string): string {
  const parts = path.split('/').filter((p) => p.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

function readLinkedPaths(): Set<string> {
  try {
    // A list another account could write is not this reader's to set aside: no list, and the writer refuses it too.
    hardenPrivateStateFileIfPresent(FILE, LIST_MAX_BYTES)
  } catch {
    return new Set()
  }
  const read = readState(FILE, 'cache', jsonArray)
  return linkedIn(read.state === 'ok' ? read.value : [])
}

/** The paths a link starts from. Throws when another account could write the list, or it cannot be read now
 *  (StateFileUnreadable): read as none, the link would drop every other profile. */
function linkedPathsToChange(): Set<string> {
  hardenPrivateStateFileIfPresent(FILE, LIST_MAX_BYTES)
  return linkedIn(requireState(FILE, jsonArray, 'cache') ?? [])
}

const linkedIn = (list: unknown[]): Set<string> => new Set(list.filter((p): p is string => typeof p === 'string').slice(0, MAX_LINKED))

function writeLinkedPaths(paths: Set<string>): void {
  secureStateDirectory(env.ADAPTER_DATA_DIR)
  // 'trust': the old file's owner and mode are checked, as this file always was.
  atomicWriteJson(FILE, [...paths].slice(0, MAX_LINKED), 'trust')
}

/**
 * The homes the person linked, for a `codex queue` to run under. The queue loads the home's `config.toml`, so only
 * Harness's own records name a home: a list another account could write names none, and an entry no link could have
 * written (wellFormed) is none. Read-only, unlike `readLinkedPaths`: it never tightens the list's mode, and `probeState`
 * never sets an unparsable list aside.
 */
export function readLinkedCodexHomes(): string[] {
  let st
  try {
    st = lstatSync(FILE)
  } catch {
    return []
  }
  const uid = process.getuid?.()
  // lstat: a link at the list is not a list. Windows has no mode bits; the data folder's place protects it there.
  if (!st.isFile() || (uid !== undefined && st.uid !== uid) || st.size > LIST_MAX_BYTES) return []
  if (process.platform !== 'win32' && (st.mode & 0o022) !== 0) return []
  const read = probeState(FILE, jsonArray)
  return read.state === 'ok' ? [...linkedIn(read.value)].filter(wellFormed) : []
}

/** How long the linked list and each own home's real path hold: the dial's list asks `can()` on every 1 s tick. */
export const TRUSTED_HOMES_MS = 30_000
/** How long the own homes hold: one look reads the adopted homes' catalog from disk, and asks them once per row. */
export const OWN_HOMES_MS = 1_000

/** A home Harness trusts, with its `sessions` folder resolved: a rollout in that folder is the home's session's. */
export interface TrustedCodexHome {
  home: string
  sessions: string
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * The Codex homes Harness trusts, for `codex queue`: [own]'s (the daemon's CODEX_HOME and the adopted homes), each
 * also by its real path when that differs, then the linked ones as stored, since a link stores a home's real path (a
 * linked home on a dead network volume is never asked). The deepest come first, as a home may lie inside another's
 * sessions folder: the first whose folder holds a rollout is its session's. [now] is a monotonic clock.
 */
export function trustedCodexHomes(
  own: () => readonly string[],
  now: () => number,
  read: () => string[] = readLinkedCodexHomes,
  real: (path: string) => string | null = realOrNull,
): () => readonly TrustedCodexHome[] {
  let linkedAt: number | undefined
  let ownAt: number | undefined
  let linked: string[] = []
  // Made anew with each read of the list, so it holds only the homes asked about in one hold.
  let reals = new Map<string, string | null>()
  let trusted: TrustedCodexHome[] = []
  return () => {
    const at = now()
    if (linkedAt === undefined || at - linkedAt >= TRUSTED_HOMES_MS) {
      linkedAt = at
      linked = read()
      reals = new Map()
      ownAt = undefined
    }
    if (ownAt !== undefined && at - ownAt < OWN_HOMES_MS) return trusted
    ownAt = at
    const homes = new Set<string>()
    for (const home of own()) {
      let resolved = reals.get(home)
      if (resolved === undefined) reals.set(home, resolved = real(home))
      homes.add(home)
      if (resolved !== null) homes.add(resolved)
    }
    for (const home of linked) homes.add(home)
    // A stable sort: of two homes as deep, the one listed first stays first.
    trusted = [...homes].map((home) => {
      const sessions = resolve(home, 'sessions')
      return { home, sessions, depth: sessions.split(sep).filter(Boolean).length }
    }).sort((a, b) => b.depth - a.depth).map(({ home, sessions }) => ({ home, sessions }))
    return trusted
  }
}

/** Validate + resolve a folder path the same way for both linking and re-checking a saved one. */
export function resolveCodexProfilePath(path: string): CodexProfile | CodexProfileError {
  if (!wellFormed(path)) return { error: 'INVALID_PATH' }
  let st
  try {
    st = statSync(path)
  } catch {
    return { error: 'NOT_FOUND' }
  }
  if (!st.isDirectory()) return { error: 'NOT_FOUND' }
  let resolved: string
  try {
    resolved = realpathSync(path)
  } catch {
    return { error: 'NOT_FOUND' }
  }
  if (resolved.length > 4096 || CONTROL_CHARS_RE.test(resolved)) return { error: 'INVALID_PATH' }
  return { path: resolved, label: labelFor(resolved) }
}

/** Link a folder as a Codex profile, persisted on this machine so it survives future requests. */
export function linkCodexProfile(path: string): CodexProfile | CodexProfileError {
  const profile = resolveCodexProfilePath(path)
  if ('error' in profile) return profile
  const linked = linkedPathsToChange()
  linked.add(profile.path)
  writeLinkedPaths(linked)
  return profile
}

/** The Codex account that needs no CODEX_HOME: an inherited CODEX_HOME, or ~/.codex. */
export function defaultCodexHome(home: string = homedir(), environment: Record<string, string | undefined> = process.env): string {
  const folder = environment.CODEX_HOME || join(home, '.codex')
  try { return realpathSync(folder) } catch { return folder }
}

function processEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value
  }
  return environment
}

/**
 * Every Codex profile this machine lists: previously linked folders, `observedPaths` (Codex
 * homes the caller already knows about from this same machine's other Codex agents), and freshly
 * discovered folders. Never throws — a discovery scan that fails still returns the linked/observed
 * folders that resolved fine.
 */
export function listCodexProfiles(
  observedPaths: readonly string[] = [],
  /** Injectable for tests only; production always discovers this machine's own home/environment. */
  discoveryOptions: { home: string; environment: Record<string, string> } = {
    home: homedir(),
    environment: processEnvironment(),
  },
): CodexProfile[] {
  const candidates = new Set<string>([...readLinkedPaths(), ...observedPaths])
  try {
    for (const path of discoverCodexProfiles(discoveryOptions)) {
      candidates.add(path)
    }
  } catch {
    // A discovery failure must not hide linked/observed profiles that are still good.
  }
  const profiles = new Map<string, CodexProfile>()
  for (const path of candidates) {
    const resolved = resolveCodexProfilePath(path)
    // A vanished folder or a malformed persisted entry must not be offered as a working profile.
    if (!('error' in resolved)) profiles.set(resolved.path, resolved)
  }
  return [...profiles.values()].sort((a, b) => {
    const byLabel = a.label.toLowerCase().localeCompare(b.label.toLowerCase())
    return byLabel !== 0 ? byLabel : a.path.localeCompare(b.path)
  })
}
