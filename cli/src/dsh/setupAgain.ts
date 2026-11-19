/**
 * After Harness's folder moves, what each package's setup built (venvs, launchers, uv and micromamba environments)
 * names the old folder. The move marks every package it moved `pending`; the Store runs each one's setup again at
 * its new folder, then its viewer and its doctor, as an install does. One that fails is marked `needs-setup`, which
 * the Store lists and an update clears, so it never holds the old folder's bridge for good.
 */
import { finishInstall } from './install.js'
import { awaitsSetup, isBrokenDsh, markSetup, readInstalledIndex, resolveInstalled, type InstalledDshRecord } from './installed.js'
import { lockDsh } from './lock.js'

/** Each setup is minutes of downloads and builds: two at a time leave the person's machine usable. */
export const SETUP_AGAIN_AT_ONCE = 2

export interface SetupAgainDeps {
  records(): InstalledDshRecord[]
  resolve: typeof resolveInstalled
  lock: typeof lockDsh
  finish: typeof finishInstall
  mark: typeof markSetup
  log(line: string): void
}

const DEFAULTS: SetupAgainDeps = {
  records: readInstalledIndex, resolve: resolveInstalled, lock: lockDsh, finish: finishInstall, mark: markSetup,
  log: (line) => console.warn(line),
}

// The setup ran: what the doctor or the viewer then says is shown as after any install, and is no setup to run again.
const SETUP_RAN = new Set(['DOCTOR_FAILED', 'VIEWER_UNAVAILABLE'])

type Outcome = 'done' | 'needsSetup' | 'busy'

export async function setupAgain(deps: SetupAgainDeps = DEFAULTS): Promise<{ done: number; needsSetup: number; busy: number }> {
  const queue = deps.records().filter(awaitsSetup).map((record) => record.id)
  const counts = { done: 0, needsSetup: 0, busy: 0 }
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const outcome = await setUpOne(id, deps)
      if (outcome) counts[outcome]++
    }
  }
  await Promise.all(Array.from({ length: SETUP_AGAIN_AT_ONCE }, worker))
  return counts
}

async function setUpOne(id: string, deps: SetupAgainDeps): Promise<Outcome | null> {
  let unlock: (() => void) | null = null
  try {
    // Held by an install, update or removal: the mark stays for the Store's next start.
    unlock = deps.lock(id)
    if (!unlock) return 'busy'
    // Read again under the lock: an update or removal that ended since keeps what it wrote.
    const record = deps.records().find((row) => row.id === id)
    if (!record || !awaitsSetup(record)) return null
    const resolved = deps.resolve(record)
    const result = isBrokenDsh(resolved)
      ? { ok: false as const, error: 'BROKEN' }
      // It writes back the record it was given, mark included, so the mark changes after it.
      : await deps.finish(resolved, { source: record.source }, true)
    if (result.ok || SETUP_RAN.has(result.error)) {
      deps.mark(id, null)
      return 'done'
    }
    return needsSetup(id, result.error, deps)
  } catch {
    // Thrown rather than answered, it is marked all the same: left pending, it would hold the old folder's bridge for good.
    return needsSetup(id, 'SETUP_THREW', deps)
  } finally {
    unlock?.()
  }
}

function needsSetup(id: string, code: string, deps: SetupAgainDeps): Outcome {
  deps.mark(id, 'needs-setup')
  // The code only: a setup's detail, or what it threw, holds its folder and whatever it printed.
  deps.log(`[dsh] ${id} needs setup · ${code}`)
  return 'needsSetup'
}
