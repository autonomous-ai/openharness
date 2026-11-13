/**
 * Claude profiles — linking a CLAUDE_CONFIG_DIR folder on this machine, the Claude counterpart of `codexProfiles.ts` (same
 * persistence, same "answered on the machine in question"), and what a reported profile id stands for, for either engine.
 * The listing itself is lib/claudeHomes.ts, which the core loads without this module's Codex profile code (#4147).
 */

import { randomUUID } from 'crypto'
import { closeSync, constants, fchmodSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { env } from '../config/env.js'
import { LINKED_FILE, listClaudeProfiles, MAX_LINKED, profileFor, profileId, readLinkedPaths, resolveFolder, type ClaudeProfile,
  type ClaudeProfileError } from './claudeHomes.js'
import { defaultCodexHome, listCodexProfiles } from './codexProfiles.js'
import { hardenPrivateStateFileIfPresent, secureStateDirectory } from './secureState.js'

function writeLinkedPaths(paths: Set<string>): void {
  secureStateDirectory(env.ADAPTER_DATA_DIR)
  hardenPrivateStateFileIfPresent(LINKED_FILE)
  const temporary = `${LINKED_FILE}.${process.pid}.${randomUUID()}.tmp`
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
    renameSync(temporary, LINKED_FILE)
    renamed = true
  } finally {
    if (!renamed) rmSync(temporary, { force: true })
  }
}

/** Link a folder as a Claude profile, persisted on this machine so it survives future requests. */
export function linkClaudeProfile(path: string, machineId: string): { profile: ClaudeProfile } | ClaudeProfileError {
  const resolved = resolveFolder(path)
  if (typeof resolved !== 'string') return resolved
  const linked = readLinkedPaths()
  linked.add(path)
  writeLinkedPaths(linked)
  return { profile: profileFor(machineId, path, resolved, homedir()) }
}

/**
 * Whether [id] names [engine]'s default account on this machine: the literal 'default', which an older backend sends, its
 * reported id, or for Codex the id of the default home's path, which a native Codex launch once reported.
 */
function namesDefaultAccount(
  engine: 'claude' | 'codex', id: string, machineId: string, options: { home?: string; environment?: NodeJS.ProcessEnv } = {},
): boolean {
  return id === 'default' || id === profileId(machineId, engine, 'default')
    || (engine === 'codex' && id === profileId(machineId, engine, defaultCodexHome(options.home, options.environment)))
}

/**
 * The folder a reported profile id stands for: 'default' for the engine's default account (the literal 'default', which an
 * older backend sends, or its reported id), a path for a profile this machine still has, null for an unknown or gone one.
 */
export function profileHome(
  engine: string, id: string, machineId: string, options: { home?: string; environment?: NodeJS.ProcessEnv } = {},
): string | 'default' | null {
  if (engine !== 'claude' && engine !== 'codex') return null
  if (namesDefaultAccount(engine, id, machineId, options)) return 'default'
  if (engine === 'claude') return listClaudeProfiles([], { ...options, machineId }).find((p) => p.id === id)?.path ?? null
  const discovery = options.home ? { home: options.home, environment: (options.environment ?? {}) as Record<string, string> } : undefined
  return listCodexProfiles([], discovery).find((p) => profileId(machineId, 'codex', p.path) === id)?.path ?? null
}

