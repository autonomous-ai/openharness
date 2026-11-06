/**
 * The Claude accounts this machine's owner lets its own Product Managers move between (a PM that runs low on one account moves to
 * another of these and keeps its conversation), and the moves made. Both are private to this machine: the pool holds profile ids,
 * the history holds account ids and PM names, and neither leaves it except through the owner's own requests.
 *
 * A pool that cannot be read is empty, so a PM never moves: a lost tick costs the owner one tap, a wrong one spends an account.
 * An id of an account that is gone stays in the pool until the owner unticks it, so a folder that is briefly missing (an unmounted
 * disk) is not forgotten.
 */
import { randomUUID } from 'crypto'
import { closeSync, constants, fchmodSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { env } from '../config/env.js'
import { hardenPrivateStateFileIfPresent, readPrivateStateFile, secureStateDirectory } from './secureState.js'

export interface PmMove {
  at: number
  pm: string
  from: string
  to: string
  /** low: under 5% left; out: at its limit; reset: back after an all-out pause; fallback: a failed move undone. */
  why: 'low' | 'out' | 'reset' | 'fallback'
  window?: '5-hour' | 'weekly'
  leftPercent?: number
  awayMs?: number
  ok: boolean
}

const POOL_FILE = join(env.ADAPTER_DATA_DIR, 'pm-account-pool.json')
const MOVES_FILE = join(env.ADAPTER_DATA_DIR, 'pm-account-moves.jsonl')
/** Far above what a machine lists; only stops a runaway file. */
export const MAX_POOL = 32
export const MAX_MOVES = 200
const TOLD_FILE = join(env.ADAPTER_DATA_DIR, 'pm-account-told.json')
const MAX_TOLD_PMS = 64
const MAX_TOLD_KEYS = 64
const MAX_FILE_BYTES = 1024 * 1024

/** The same private, atomic write accountOffers.ts makes: nothing is ever half written, and only its owner can read it. */
function writePrivate(file: string, text: string): void {
  secureStateDirectory(env.ADAPTER_DATA_DIR)
  hardenPrivateStateFileIfPresent(file)
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  let renamed = false
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, text)
      fchmodSync(fd, 0o600)
      fsyncSync(fd)
    } finally { closeSync(fd) }
    renameSync(temporary, file)
    renamed = true
  } finally { if (!renamed) rmSync(temporary, { force: true }) }
}

/** The profile ids the PM may use. A damaged or missing file reads as none. */
export function readPmPool(): string[] {
  try {
    const raw = JSON.parse(readPrivateStateFile(POOL_FILE, MAX_FILE_BYTES)) as unknown
    if (Array.isArray(raw)) return [...new Set(raw.filter((id): id is string => typeof id === 'string' && id !== ''))].slice(0, MAX_POOL)
  } catch { /* None: see above. */ }
  return []
}

/** Replaces the pool: duplicates and anything past [MAX_POOL] are dropped. Synchronous, in the one daemon that writes it. */
export function setPmPool(ids: string[]): void {
  writePrivate(POOL_FILE, JSON.stringify([...new Set(ids)].slice(0, MAX_POOL), null, 2))
}

function isMove(value: unknown): value is PmMove {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  return Number.isFinite(m.at) && typeof m.pm === 'string' && typeof m.from === 'string' && typeof m.to === 'string'
    && (m.why === 'low' || m.why === 'out' || m.why === 'reset' || m.why === 'fallback') && typeof m.ok === 'boolean'
}

function readLines(): string[] {
  try { return readPrivateStateFile(MOVES_FILE, MAX_FILE_BYTES).split('\n').filter(line => line !== '') } catch { return [] }
}

/** Adds one move, keeping the last [MAX_MOVES] lines. A line that is damaged is dropped by the next write too. */
export function appendPmMove(move: PmMove): void {
  const kept = readLines().filter(line => { try { return isMove(JSON.parse(line)) } catch { return false } })
  writePrivate(MOVES_FILE, [...kept, JSON.stringify(move)].slice(-MAX_MOVES).join('\n') + '\n')
}

/** The moves made, newest first; a damaged line is skipped. */
export function readPmMoves(limit = MAX_MOVES): PmMove[] {
  const moves: PmMove[] = []
  for (const line of readLines().reverse()) {
    try { const value = JSON.parse(line) as unknown; if (isMove(value)) moves.push(value) } catch { /* Skipped: see above. */ }
    if (moves.length >= limit) break
  }
  return moves
}

/** The reset windows already told to the owner for a PM (key: the reset's minute), so a restarted daemon does not tell them again. */
function readToldFile(): Record<string, string[]> {
  try {
    const raw = JSON.parse(readPrivateStateFile(TOLD_FILE, MAX_FILE_BYTES)) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).flatMap(([pm, keys]) => Array.isArray(keys) ? [[pm, keys.filter((k): k is string => typeof k === 'string')]] : []))
  } catch { return {} }
}

export function readPmTold(pm: string): string[] {
  return readToldFile()[pm]?.slice(-MAX_TOLD_KEYS) ?? []
}

/** Keeps the last [MAX_TOLD_PMS] PMs told; a PM's own list is cut to its last [MAX_TOLD_KEYS]. */
export function writePmTold(pm: string, keys: string[]): void {
  const { [pm]: _old, ...others } = readToldFile()
  writePrivate(TOLD_FILE, JSON.stringify(Object.fromEntries(Object.entries({ ...others, [pm]: keys.slice(-MAX_TOLD_KEYS) }).slice(-MAX_TOLD_PMS)), null, 2))
}
