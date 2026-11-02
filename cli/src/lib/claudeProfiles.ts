/**
 * Claude profiles — CLAUDE_CONFIG_DIR folders this machine can point a Claude agent at, the Claude
 * counterpart of `codexProfiles.ts` (same persistence, same "answered on the machine in question").
 * The default account (no CLAUDE_CONFIG_DIR) is always first, with the id 'default'.
 *
 * Two labels: `label` is for the machine's owner (may be an email); `reportLabel` is what leaves the
 * machine and so never holds an '@'.
 */

import { createHash, randomUUID } from 'crypto'
import { closeSync, constants, fchmodSync, fsyncSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { env } from '../config/env.js'
import { listCodexProfiles } from './codexProfiles.js'
import { hardenPrivateStateFileIfPresent, readPrivateStateFile, secureStateDirectory } from './secureState.js'

export interface ClaudeProfile {
  id: string
  path: string
  label: string
  reportLabel: string
}

export type ClaudeProfileError = { error: 'INVALID_PATH' | 'NOT_FOUND' }

const FILE = join(env.ADAPTER_DATA_DIR, 'claude-profiles.json')
const MAX_LINKED = 256
const MAX_ENTRIES = 512
// A real ~/.claude.json grows with the project history; this only stops a runaway file.
const MAX_ACCOUNT_FILE_BYTES = 16 * 1024 * 1024
const REPORT_LABEL_MAX = 40
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/
const ORCA_HOME_RE = /\/claude-profiles\/([0-9a-f][0-9a-f-]*)\/home$/i

/** Opaque, stable per machine: no path or account name leaves the machine through it. */
export function profileId(machineId: string, engine: 'claude' | 'codex', realpath: string): string {
  return createHash('sha256').update(`${machineId}:${engine}:${realpath}`).digest('hex').slice(0, 16)
}

function accountOf(folder: string): { displayName?: string; emailAddress?: string } {
  try {
    const file = join(folder, '.claude.json')
    if (statSync(file).size > MAX_ACCOUNT_FILE_BYTES) return {}
    const account = (JSON.parse(readFileSync(file, 'utf8')) as { oauthAccount?: Record<string, unknown> }).oauthAccount
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    return { displayName: text(account?.displayName), emailAddress: text(account?.emailAddress) }
  } catch {
    return {}
  }
}

function reportLabelFor(path: string, displayName: string | undefined): string {
  const orca = ORCA_HOME_RE.exec(path)
  const candidates = [displayName, orca ? `Orca ${orca[1].slice(0, 4)}` : basename(path)]
  const found = candidates.find((c) => c && !c.includes('@')) ?? 'Claude'
  return found.slice(0, REPORT_LABEL_MAX)
}

function profileFor(machineId: string, path: string, isDefault = false): ClaudeProfile {
  const { displayName, emailAddress } = accountOf(path)
  return {
    id: isDefault ? 'default' : profileId(machineId, 'claude', path),
    path,
    label: displayName ?? emailAddress ?? basename(path),
    reportLabel: reportLabelFor(path, displayName),
  }
}

function readLinkedPaths(): Set<string> {
  try {
    const raw = JSON.parse(readPrivateStateFile(FILE, 1024 * 1024)) as unknown
    if (Array.isArray(raw)) return new Set(raw.filter((p): p is string => typeof p === 'string').slice(0, MAX_LINKED))
  } catch {
    // Discovery still works when the optional saved list is unavailable/unreadable/malformed.
  }
  return new Set()
}

function writeLinkedPaths(paths: Set<string>): void {
  secureStateDirectory(env.ADAPTER_DATA_DIR)
  hardenPrivateStateFileIfPresent(FILE)
  const temporary = `${FILE}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, JSON.stringify([...paths].slice(0, MAX_LINKED), null, 2))
      fchmodSync(fd, 0o600)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, FILE)
    renamed = true
  } finally {
    if (!renamed) rmSync(temporary, { force: true })
  }
}

/** Validate + resolve a folder path the same way for linking and for re-checking a saved one. */
function resolveFolder(path: string): string | ClaudeProfileError {
  if (!path.startsWith('/') || path.length > 4096 || CONTROL_CHARS_RE.test(path)) return { error: 'INVALID_PATH' }
  try {
    if (!statSync(path).isDirectory()) return { error: 'NOT_FOUND' }
    const resolved = realpathSync(path)
    return resolved.length > 4096 || CONTROL_CHARS_RE.test(resolved) ? { error: 'INVALID_PATH' } : resolved
  } catch {
    return { error: 'NOT_FOUND' }
  }
}

/** Link a folder as a Claude profile, persisted on this machine so it survives future requests. */
export function linkClaudeProfile(path: string, machineId: string): { profile: ClaudeProfile } | ClaudeProfileError {
  const resolved = resolveFolder(path)
  if (typeof resolved !== 'string') return resolved
  const linked = readLinkedPaths()
  linked.add(resolved)
  writeLinkedPaths(linked)
  return { profile: profileFor(machineId, resolved) }
}

function holdsProfile(folder: string): boolean {
  return ['.claude.json', 'settings.json'].some((name) => {
    try {
      return statSync(join(folder, name)).isFile()
    } catch {
      return false
    }
  })
}

function entries(folder: string): string[] {
  try {
    return readdirSync(folder).slice(0, MAX_ENTRIES).map((name) => join(folder, name))
  } catch {
    return []
  }
}

/** The inherited CLAUDE_CONFIG_DIR, conventional `~/.claude-*` folders and Orca's per-profile homes and Desktop's own. */
function discover(home: string, environment: NodeJS.ProcessEnv): string[] {
  const found: string[] = []
  const inherited = environment.CLAUDE_CONFIG_DIR
  if (inherited) found.push(inherited)
  found.push(...entries(home).filter((e) => basename(e).startsWith('.claude-')))
  const orca = join(home, 'Library', 'Application Support', 'orca', 'claude-profiles')
  found.push(...entries(orca).map((e) => join(e, 'home')))
  // Where Desktop's "Add Claude account…" puts the folders it creates.
  found.push(...entries(join(home, '.harness', 'claude-profiles')))
  return found.filter(holdsProfile)
}

/**
 * Every Claude profile this machine can offer: the default account, linked folders, `observedPaths`
 * (folders the caller already knows from this machine's other agents) and discovered ones. Never
 * throws; a folder that vanished or is malformed is just not offered.
 */
export function listClaudeProfiles(
  observedPaths: readonly string[] = [],
  options: { home?: string; environment?: NodeJS.ProcessEnv; machineId: string },
): ClaudeProfile[] {
  const home = options.home ?? homedir()
  const candidates = new Set<string>([...readLinkedPaths(), ...observedPaths, ...discover(home, options.environment ?? process.env)])
  const defaultPath = resolveFolder(home)
  const defaultProfile = profileFor(options.machineId, typeof defaultPath === 'string' ? defaultPath : home, true)
  const profiles = new Map<string, ClaudeProfile>()
  for (const candidate of candidates) {
    const resolved = resolveFolder(candidate)
    if (typeof resolved === 'string' && resolved !== defaultProfile.path) profiles.set(resolved, profileFor(options.machineId, resolved))
  }
  const others = [...profiles.values()].sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.path.localeCompare(b.path))
  return [defaultProfile, ...others]
}

/** What leaves the machine for a Codex folder: its name, and never one holding an '@' (an email). */
export function codexReportLabel(path: string): string {
  const name = basename(path)
  return (name.includes('@') ? 'Codex' : name).slice(0, REPORT_LABEL_MAX)
}

/**
 * The folder a reported profile id stands for: 'default' for the engine's default account (the literal 'default', which an
 * older backend sends, or its reported id), a path for a profile this machine still has, null for an unknown or gone one.
 */
export function profileHome(
  engine: string, id: string, machineId: string, options: { home?: string; environment?: NodeJS.ProcessEnv } = {},
): string | 'default' | null {
  if (engine !== 'claude' && engine !== 'codex') return null
  if (id === 'default' || id === profileId(machineId, engine, 'default')) return 'default'
  if (engine === 'claude') return listClaudeProfiles([], { ...options, machineId }).find((p) => p.id === id)?.path ?? null
  const discovery = options.home ? { home: options.home, environment: (options.environment ?? {}) as Record<string, string> } : undefined
  return listCodexProfiles([], discovery).find((p) => profileId(machineId, 'codex', p.path) === id)?.path ?? null
}
