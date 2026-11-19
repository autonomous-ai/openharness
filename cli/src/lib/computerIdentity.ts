import { existsSync, mkdirSync, renameSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import { atomicWriteFile, readState } from './secureState.js'

/**
 * This computer's identity: minted ONCE, then never regenerated.
 *
 * The backend BINDS a machine to this value — `harness login` reuses the machine already bound
 * to it, and creates one only when there is none. So regenerating it is not a cosmetic reset: it
 * orphans the machine this box was using and mints a replacement. Every path here is therefore
 * write-once, and the file itself lives at the product root (`~/.harness/computer-id`), above
 * everything `reset`, `unjoin`, the self-updater and the legacy migrations touch.
 *
 * Deliberately parameterised and free of any `env` import: paths in, string out, so the invariants
 * below can be tested against a temp dir instead of the user's real home.
 */

/**
 * Move an id written by an older build up to the canonical path.
 *
 * Only ever moves onto a FREE target, so the first location that lands wins and the rest are no-ops —
 * this can relocate an identity but never replace or mint one. Order `legacyPaths` newest-tree-first.
 * Returns the number of files moved (0 or 1 in practice; the loop stops mattering once one lands).
 */
export function adoptComputerId(canonicalFile: string, legacyPaths: string[]): number {
  let moved = 0
  for (const legacy of legacyPaths) {
    try {
      if (existsSync(canonicalFile) || !existsSync(legacy)) continue
      // Created lazily, only once there is something to move: this runs at import time on every
      // command, and a run with nothing to adopt must not leave a directory behind. The parent has to
      // exist or the rename fails with ENOENT, stranding the id in a tree a later migration is about
      // to rewrite — which is exactly how an identity gets lost.
      mkdirSync(dirname(canonicalFile), { recursive: true, mode: 0o700 })
      renameSync(legacy, canonicalFile)
      moved++
    } catch { /* best-effort: a failed adoption must never stop the CLI from starting */ }
  }
  return moved
}

/**
 * Read this computer's id, minting one only if the file does not exist yet.
 *
 * `pinned` (ADAPTER_COMPUTER_ID) is a pin, not a regeneration: it is never written to disk, so
 * unsetting it returns you to the file's id. It exists for boxes with no durable home — a container or
 * CI job that gets a fresh `~/.harness` every boot would otherwise look like a new computer each time
 * and collect a machine per start.
 */
export function readOrMintComputerId(file: string, pinned?: string): string {
  const pin = pinned?.trim()
  if (pin) return pin
  const existing = readId(file)
  if (existing) return existing

  const id = randomUUID()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  let published: boolean
  try {
    // Published once, whole: two CLI processes starting together must not end up disagreeing about
    // who this computer is. The loser reads the winner's value instead of clobbering it.
    published = atomicWriteFile(file, id + '\n', 'cache', { exclusive: true })
  } catch (err) {
    throw new Error(
      `could not establish a computer id at ${file}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (published) return id
  const raced = readId(file)
  if (raced) return raced
  throw new Error(`could not establish a computer id at ${file}: it is there but cannot be read`)
}

/**
 * A blank file (a crashed write from an older build, a full disk) is set aside and read as missing:
 * it was never sent to the backend, so there is no identity to protect and minting cannot orphan a
 * machine. Refusing here would instead brick every command, `harness status` included.
 */
function readId(file: string): string | null {
  const read = readState(file, 'cache', (text) => {
    const id = text.trim()
    if (!id) throw new Error('blank')
    return id
  })
  return read.state === 'ok' ? read.value : null
}
