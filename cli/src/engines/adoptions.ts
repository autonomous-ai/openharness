/**
 * Claude Code's and Codex's adoption, composed from their declared contracts (engines/{claude,codex}/adoption.ts)
 * and the kit's provider (kit/adoption.ts): what lib/sessionSearch/externals/index.ts builds for them, so core's
 * adoption loads none of their code.
 */
import { adoption as claude } from './claude/adoption.js'
import { adoption as codex } from './codex/adoption.js'
import type { AdoptionContract } from './facets/adoption.js'
import { adoptionProvider, type AdoptionPlaces } from './kit/adoption.js'
import type { ExternalProvider } from '../lib/sessionSearch/externals/types.js'

export const adoptionContracts = { claude, codex } satisfies Record<string, AdoptionContract>

/** `engine`'s provider, looking where `places` says: Claude Code's sessions folders, Codex's homes. */
export function adoptionProviderOf(engine: keyof typeof adoptionContracts, places: AdoptionPlaces): ExternalProvider {
  return adoptionProvider(engine, adoptionContracts[engine], places)
}
