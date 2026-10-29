/**
 * The kind of job a routed attempt is, from a fixed list, so models are compared on like work (evidence routing spec,
 * 2026-10-29, Ken). Owned paths decide first, then the Lead's route word, else general. The route word stays free-form for
 * owners' preferEngine rules; only its value from this list counts here.
 */
import type { Conversation } from '../model.js'

export const JOB_KINDS = ['docs', 'tests', 'backend', 'cli', 'desktop', 'mobile', 'security', 'review', 'general'] as const
export type JobKind = typeof JOB_KINDS[number]

const COMPONENTS = new Set<JobKind>(['backend', 'cli', 'desktop', 'mobile', 'docs'])
/** Test files and folders in this repository: `*.test.ts`, `*.spec.ts`, `*_test.dart`, `tests/`, `test/`, `integration/`. */
const TEST_PATH = /(\.(test|spec)\.[a-z]+$|_test\.dart$|(^|\/)(tests?|integration)(\/|$))/

/** What one owned entry names: a test path, a component by its first path segment or leading word, a Markdown file as docs,
 *  or nothing. */
function entryKind(entry: string): JobKind | 'tests' | null {
  const plain = entry.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/^\.\//, '')
  if (/^\S+$/.test(plain) && TEST_PATH.test(plain)) return 'tests'
  const first = plain.split(/[\s/]/, 1)[0]!.toLowerCase()
  if (COMPONENTS.has(first as JobKind)) return first as JobKind
  return /^\S+\.md$/i.test(plain) ? 'docs' : null
}

/**
 * The group's job kind. A review group is `review`; `security` from the route word wins, as no path names security work and
 * exploration must never touch it (spec constraint). Otherwise the one component its owned entries name, code with its own
 * tests counting as the code and only tests as `tests`; entries naming several components, or none, leave it to the route
 * word when that is a kind, else `general`.
 */
export function jobKindOf(group: Pick<Conversation, 'reviewOf'> & { task?: { owns: string[] } }, routeWord?: string): JobKind {
  if (group.reviewOf) return 'review'
  if (routeWord === 'security') return 'security'
  const kinds = new Set((group.task?.owns ?? []).map(entryKind).filter(k => k !== null))
  const components = [...kinds].filter(k => k !== 'tests')
  if (components.length === 1) return components[0]!
  if (!components.length && kinds.has('tests')) return 'tests'
  return (JOB_KINDS as readonly string[]).includes(routeWord ?? '') && routeWord !== 'review' ? routeWord as JobKind : 'general'
}
