/**
 * What the Swarm left in the data folder when it was deleted (anh Dee, 2026-11-14: "remove al the swarm data too"): its
 * hosts' journals and records, its GitHub helper and hooks, the chat files it held for upload, and its saved lists. Looked
 * for at every start of the edge host, a few absent names, so a file an older build writes again after a downgrade goes too.
 * A project it cloned (`swarm-projects/`, `~/harnesses/swarms/`) is the person's work, with commits that may be nowhere else,
 * and is left. Remove this file on or after 2027-01-14.
 */
import { lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const SWARM_LEFTOVERS: readonly string[] = [
  'super-tabs', 'swarm-github', 'uploads',
  'super-tab-basics.json', 'super-tab-first-answers.json', 'super-tab-github-news.json', 'super-tab-next-things.json',
  'super-tab-numbers.json', 'super-tab-offers-told.json', 'super-tab-task-tokens.json',
  'swarm-api-shares.json', 'swarm-offers.json', 'registry-swarm-auto',
]

export interface SwarmLeftoversDeps {
  dataDir: string
  log(line: string): void
}

/** Deletes each of [SWARM_LEFTOVERS] in the data folder, and says how many went. A link goes, never what it points at (`rm`
 *  does not follow one). One that cannot be deleted is named in the log and tried again at the next start. */
export async function removeSwarmLeftovers(deps: SwarmLeftoversDeps): Promise<number> {
  let removed = 0
  for (const name of SWARM_LEFTOVERS) {
    const path = join(deps.dataDir, name)
    try { await lstat(path) } catch { continue }
    try {
      await rm(path, { recursive: true, force: true })
      removed++
    } catch (error) {
      deps.log(`could not remove ${name}, left by the Swarm (${(error as NodeJS.ErrnoException).code ?? 'unknown'}); trying again at the next start`)
    }
  }
  if (removed > 0) deps.log(`removed ${removed} of the Swarm's files and folders from the data folder`)
  return removed
}
