/**
 * The accounts this machine's owner offered the Swarm: other people's Product Managers on this machine can then run on them and
 * spend their usage. One explicit, reversible choice, kept apart from the folders a machine merely knows (linked in New Harness,
 * made by Add Claude account, found by discovery). The default account of a contributed engine needs no entry.
 *
 * Kept by real folder, on this machine only; the file holds paths, so it never leaves it. A file that cannot be read offers
 * nothing: a lost offer costs the owner one tap, a wrong one spends their account.
 */
import { randomUUID } from 'crypto'
import { closeSync, constants, fchmodSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { env } from '../config/env.js'
import { hardenPrivateStateFileIfPresent, readPrivateStateFile, secureStateDirectory } from './secureState.js'

export type OfferEngine = 'claude' | 'codex'

const FILE = join(env.ADAPTER_DATA_DIR, 'swarm-account-offers.json')
/** Far above what a machine reports (8 per engine); only stops a runaway file. A withdraw is what removes an entry. */
export const MAX_OFFERS = 64

const keyOf = (engine: OfferEngine, folder: string) => `${engine}:${folder}`

function read(): Set<string> {
  try {
    const raw = JSON.parse(readPrivateStateFile(FILE, 1024 * 1024)) as unknown
    if (Array.isArray(raw)) return new Set(raw.filter((k): k is string => typeof k === 'string').slice(0, MAX_OFFERS))
  } catch { /* None offered: see above. */ }
  return new Set()
}

function write(keys: Set<string>): void {
  secureStateDirectory(env.ADAPTER_DATA_DIR)
  hardenPrivateStateFileIfPresent(FILE)
  const temporary = `${FILE}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, JSON.stringify([...keys], null, 2))
      fchmodSync(fd, 0o600)
      fsyncSync(fd)
    } finally { closeSync(fd) }
    renameSync(temporary, FILE)
    renamed = true
  } finally { if (!renamed) rmSync(temporary, { force: true }) }
}

/** The real folders offered for [engine]. */
export function offeredFolders(engine: OfferEngine): Set<string> {
  const prefix = keyOf(engine, '')
  return new Set([...read()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)))
}

/** Records the owner's choice for a real folder; false when the list is full. Synchronous, in the one daemon that writes it. */
export function recordOffer(engine: OfferEngine, folder: string, offered: boolean): boolean {
  const keys = read(), key = keyOf(engine, folder)
  if (offered === keys.has(key)) return true
  if (offered && keys.size >= MAX_OFFERS) return false
  if (offered) keys.add(key); else keys.delete(key)
  write(keys)
  return true
}
