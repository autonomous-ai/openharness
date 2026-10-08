import type { PetMapping } from './store.js'

/** What a dial's pets look like to the Devices tab (cableSession fills it, lib/harnessDevices passes it on). */
export interface PetDialState {
  supported: boolean
  held: string[]
  sending: { id: string; percent: number } | null
  /** Packs the dial refused this link (pack id → reason: memory, busy, crc, version, shape). */
  errors?: Record<string, string>
}

// What the dial must be told and sent so it holds exactly the packs the mapping names. Pure: the session decides when.
//   map  - always sent first, so the dial knows which pack stands for what even before the bytes arrive
//   send - mapped ids the dial does not hold, de-duplicated, "all" first then engines by name (a stable order, so a
//          retry or a second dial sees the same sequence)
//   drop - ids the dial holds that nothing maps any more (its 4-pack budget is for packs in use)
export function planPetSync(mapping: PetMapping, held: string[]): { map: PetMapping; send: string[]; drop: string[] } {
  const mapped: string[] = []
  if (mapping.all) mapped.push(mapping.all)
  for (const engine of Object.keys(mapping.engines).sort()) mapped.push(mapping.engines[engine])
  const unique = [...new Set(mapped)]
  const holding = new Set(held)
  return {
    map: { all: mapping.all, engines: { ...mapping.engines } },
    send: unique.filter((id) => !holding.has(id)),
    drop: [...new Set(held)].filter((id) => !unique.includes(id)),
  }
}
