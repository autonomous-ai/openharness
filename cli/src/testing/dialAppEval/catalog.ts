/**
 * The dial eval's scenarios (docs/plans/2026-11-21-dial-app-eval-design.md, "Scenarios"), one catalog both tiers run.
 * Every session is made up: titles start with "Eval ", folders with /work/eval-, ids are fixed UUIDs.
 */
import type { Platform, Scenario, SessionDef, SessionKey, Tier } from './types.js'

const EVERY_PLATFORM: Platform[] = ['darwin', 'win32', 'linux']
const S = 1_000

/** A fixed made-up UUID, distinct per number. */
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

/** A Claude app session: its Claude Code id and its store file's id, both made up from `n`. */
function claudeSession(key: SessionKey, n: number, name: string, ageMs: number): SessionDef {
  return { key, app: 'claude', id: uuid(n), localId: `local_${uuid(0x10000 + n)}`, title: `Eval ${name}`, cwd: `/work/eval-${key}`, ageMs }
}
/** The session only probes name: never written or started, so a check of it fails whatever the product does. */
const claudeGhost: SessionDef = { ...claudeSession('z', 0xfff, 'Zulu', 0), ghost: true }

export const MAIN: Scenario[] = [
  {
    id: 'C1', app: 'claude', title: 'Five sessions in the app: the ring has those five, newest first, by their names',
    dims: ['D1', 'D8'], platforms: EVERY_PLATFORM, tiers: ['a', 'b'], heldOut: false,
    sessions: [
      claudeSession('a', 1, 'Alpha', 60 * S), claudeSession('b', 2, 'Bravo', 120 * S), claudeSession('c', 3, 'Charlie', 180 * S),
      claudeSession('d', 4, 'Delta', 240 * S), claudeSession('e', 5, 'Echo', 300 * S), claudeGhost,
    ],
    steps: [{ kind: 'claude.write', sessions: ['a', 'b', 'c', 'd', 'e'] }],
    checks: [
      { id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a', 'b', 'c', 'd', 'e'] },
      { id: 'cost', kind: 'cost', dim: 'D8' },
    ],
    probes: [{ id: 'ring', kind: 'ring', dim: 'D1', page: 'claude', expect: ['a', 'b', 'c', 'd', 'e', 'z'] }],
  },
]

export const HELD_OUT: Scenario[] = []

/** The scenarios, main and held out, that run on that tier and platform. */
export function scenariosFor(tier: Tier, platform: Platform): Scenario[] {
  return [...MAIN, ...HELD_OUT].filter((s) => s.tiers.includes(tier) && s.platforms.includes(platform))
}
