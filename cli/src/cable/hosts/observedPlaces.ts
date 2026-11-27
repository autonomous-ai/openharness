import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { AdoptionPlaces } from '../../engines/kit/adoption.js'
// Data the devices process already loads (lib/engineHomes.ts): it must not load core code.
import { sessionStoreContracts } from '../../engines/sessionStoreContracts.js'

const { sessions, live } = sessionStoreContracts.claude
/** Claude Code's process records, `<folder>/<pid><suffix>` beside each projects folder, as its store declares them. */
const recordFolder = 'record' in live ? live.record.folder : undefined

export interface ObservedPlaces { claude: Required<AdoptionPlaces>; codex: AdoptionPlaces }

export interface ObservedPlacesDeps {
  /** Today's folders, asked at each call: claudeProjectsRoots and codexHomeRoots. */
  claudeRoots(): string[]
  codexRoots(): string[]
  /** Orca's account homes, from the last read. */
  orca(): { claude: readonly string[]; codex: readonly string[] }
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** Each folder once: Orca links an account's `projects` to the default one, and a folder read twice is every
 *  session found twice. Two names of one real folder are one; a folder that does not resolve is its own path. */
function unique(folders: readonly string[]): string[] {
  const seen = new Set<string>()
  return folders.filter((folder) => {
    const key = realOrNull(folder) ?? folder
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Where the devices' open scan looks: today's folders, then Orca's account homes, which Harness has not adopted
 * (docs/plans/2026-11-17-new-user-onboarding-design.md, "The open scan"). Asked on every scan, so each answer
 * follows the last read of Orca's homes.
 */
export function observedPlaces(deps: ObservedPlacesDeps): ObservedPlaces {
  // An account with no projects folder yet has no transcripts to find.
  const orcaProjects = () => deps.orca().claude.map((home) => join(home, sessions.moved.folder)).filter((folder) => realOrNull(folder) !== null)
  return {
    claude: {
      roots: () => unique([...deps.claudeRoots(), ...orcaProjects()]),
      // Built as the provider builds today's (engines/kit/adoption.ts), so a record path it gives matches one here.
      records: () => recordFolder === undefined ? [] : unique([
        ...deps.claudeRoots().map((root) => join(root, '..', recordFolder)),
        ...deps.orca().claude.map((home) => join(home, recordFolder)),
      ]),
    },
    codex: { roots: () => unique([...deps.codexRoots(), ...deps.orca().codex]) },
  }
}
