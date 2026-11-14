/**
 * The Claude Code homes this machine lists: CLAUDE_CONFIG_DIR folders a Claude agent can be pointed at. The core reads them
 * in line for one check as a launch is asked (claudeHomeListed, core/agents/launches.ts), so this module holds the listing
 * alone and loads no Codex profile code (#4147, part of #1016); linking a folder, the default account's ids and a reported
 * id's folder are lib/claudeProfiles.ts, which the services that answer for profiles load.
 *
 * The default account (no CLAUDE_CONFIG_DIR) is always first, marked `default`; its id is the one every component uses for
 * it, `profileId(machine, 'claude', 'default')`. A profile's `path` is the folder as it was given or linked, which is what
 * Claude Code hashes for its Keychain item and what CLAUDE_CONFIG_DIR must hold; its id is of the real path.
 *
 * Its `label` is the folder's name, for the machine's owner alone: no profile leaves the machine.
 */

import { createHash } from 'crypto'
import { readdirSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, join, resolve, sep } from 'path'
import { env } from '../config/env.js'
import { homeIsAbsolute } from '../engines/kit/homeAdoption.js'
import { readPrivateStateFile } from './secureState.js'

export interface ClaudeProfile {
  id: string
  path: string
  label: string
  /** Set on the default account alone. */
  default?: true
}

export type ClaudeProfileError = { error: 'INVALID_PATH' | 'NOT_FOUND' }

/** The folders linked by hand (lib/claudeProfiles.ts linkClaudeProfile). */
export const LINKED_FILE = join(env.ADAPTER_DATA_DIR, 'claude-profiles.json')
export const MAX_LINKED = 256
const MAX_ENTRIES = 512
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/
const ORCA_HOME_RE = /\/claude-profiles\/([0-9a-f][0-9a-f-]*)\/home$/i

/** Opaque, stable per machine: no path or account name leaves the machine through it. */
export function profileId(machineId: string, engine: 'claude' | 'codex', realpath: string): string {
  return createHash('sha256').update(`${machineId}:${engine}:${realpath}`).digest('hex').slice(0, 16)
}

function harnessFolder(home: string): string {
  return join(home, '.harness', 'claude-profiles') + sep
}

/** The folder's name, never the account's: Harness reads no sign-in (loginReads.spec.ts), so not the account's name either. */
function folderLabel(path: string, home: string): string {
  const orca = ORCA_HOME_RE.exec(path)
  return orca ? `Orca ${orca[1].slice(0, 4)}` : path.startsWith(harnessFolder(home)) ? `Claude ${basename(path)}` : basename(path)
}

export function profileFor(machineId: string, path: string, real: string, home: string, isDefault = false): ClaudeProfile {
  return {
    id: profileId(machineId, 'claude', isDefault ? 'default' : real),
    ...(isDefault ? { default: true as const } : {}),
    path,
    label: folderLabel(path, home),
  }
}

export function readLinkedPaths(): Set<string> {
  try {
    const raw = JSON.parse(readPrivateStateFile(LINKED_FILE, 1024 * 1024)) as unknown
    if (Array.isArray(raw)) return new Set(raw.filter((p): p is string => typeof p === 'string').slice(0, MAX_LINKED))
  } catch {
    // Discovery still works when the optional saved list is unavailable/unreadable/malformed.
  }
  return new Set()
}

/** Validate + resolve a folder path the same way for linking and for re-checking a saved one. */
export function resolveFolder(path: string): string | ClaudeProfileError {
  if (!homeIsAbsolute(path) || path.length > 4096 || CONTROL_CHARS_RE.test(path)) return { error: 'INVALID_PATH' }
  try {
    if (!statSync(path).isDirectory()) return { error: 'NOT_FOUND' }
    const resolved = realpathSync(path)
    return resolved.length > 4096 || CONTROL_CHARS_RE.test(resolved) ? { error: 'INVALID_PATH' } : resolved
  } catch {
    return { error: 'NOT_FOUND' }
  }
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
 * Every Claude profile this machine lists: the default account, linked folders, `observedPaths`
 * (folders the caller already knows from this machine's other agents) and discovered ones. Never
 * throws; a folder that vanished or is malformed is just not listed.
 */
export function listClaudeProfiles(
  observedPaths: readonly string[] = [],
  options: { home?: string; environment?: NodeJS.ProcessEnv; machineId: string },
): ClaudeProfile[] {
  const home = options.home ?? homedir()
  const linkedPaths = readLinkedPaths()
  const candidates = new Set<string>([...linkedPaths, ...observedPaths, ...discover(home, options.environment ?? process.env)])
  const defaultPath = resolveFolder(home)
  const defaultProfile = profileFor(options.machineId, home, typeof defaultPath === 'string' ? defaultPath : home, home, true)
  const profiles = new Map<string, ClaudeProfile>()
  for (const candidate of candidates) {
    const resolved = resolveFolder(candidate)
    // De-duplicated by the real folder; the path kept is the first one given.
    if (typeof resolved === 'string' && resolved !== (typeof defaultPath === 'string' ? defaultPath : home) && !profiles.has(resolved)) {
      profiles.set(resolved, profileFor(options.machineId, candidate, resolved, home))
    }
  }
  const others = [...profiles.values()].sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.path.localeCompare(b.path))
  return [defaultProfile, ...others]
}

/**
 * Whether [claudeHome] may be handed to an agent as its CLAUDE_CONFIG_DIR: a profile this machine lists (the default account
 * has none), or a folder under `~/.harness/claude-profiles/`, where Desktop's "Add Claude account" makes a new one before it
 * holds any file. Any other path would be written into (hooks, folder trust) and adopted for good (core/agents/launches.ts).
 */
export function claudeHomeListed(
  claudeHome: string, machineId: string, options: { home?: string; environment?: NodeJS.ProcessEnv } = {},
): boolean {
  const own = join(options.home ?? homedir(), '.harness', 'claude-profiles') + sep
  if (resolve(claudeHome) === claudeHome && claudeHome.startsWith(own)) return true
  return listClaudeProfiles([], { ...options, machineId }).some((p) => !p.default && p.path === claudeHome)
}
