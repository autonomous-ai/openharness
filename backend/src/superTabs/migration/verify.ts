/** Verification of one Swarm's migration (design 6.3): the parts read back reassemble into the state they came from. */
import type { SuperTabState } from '../model.js'

/** Lists the parts store keeps only when they have entries: absent and empty are the same list. */
const OPTIONAL_LISTS = ['starts', 'machines', 'harnessReservations', 'releasedHarnesses', 'closingSessions', 'machineCleanups',
  'parkedConversations', 'overlapAlerts'] as const
/** Lists whose order carries no meaning; machine parts regroup them by machine. */
const UNORDERED = ['harnessReservations', 'releasedHarnesses', 'closingSessions', 'machineCleanups', 'overlapAlerts'] as const

/** The state as stored JSON sees it (no undefined), unordered lists sorted, empty optional lists removed. */
function canonical(state: SuperTabState): Record<string, unknown> {
  const plain = JSON.parse(JSON.stringify(state)) as Record<string, unknown[] | undefined>
  for (const key of UNORDERED) plain[key]?.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  for (const key of OPTIONAL_LISTS) if (Array.isArray(plain[key]) && !plain[key]!.length) delete plain[key]
  return plain
}

const shown = (value: unknown) => value === undefined ? '(absent)' : JSON.stringify(value)
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function difference(expected: unknown, actual: unknown, path: string): string | null {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return `${path}: ${expected.length} items ≠ ${actual.length} items`
    for (let i = 0; i < expected.length; i++) {
      const found = difference(expected[i], actual[i], `${path}[${i}]`)
      if (found) return found
    }
    return null
  }
  if (isObject(expected) && isObject(actual)) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      const found = difference(expected[key], actual[key], path ? `${path}.${key}` : key)
      if (found) return found
    }
    return null
  }
  return Object.is(expected, actual) ? null : `${path}: ${shown(expected)} ≠ ${shown(actual)}`
}

/** The first path where two states differ, field by field, or null when they are the same. */
export function stateDifference(expected: SuperTabState, actual: SuperTabState): string | null {
  return difference(canonical(expected), canonical(actual), '')
}
