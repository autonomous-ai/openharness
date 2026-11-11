import { createHash } from 'node:crypto'
import type { Derived } from './contract.js'
import { sorted } from './hostEtag.js'

/** The reader's own marks: a change read sends only those moved since its cursor, so they are no part of the summary. */
export const MARK_FIELDS = ['readMarks', 'unreadMarks', 'threadMarks', 'chatSettings'] as const
export type MarkField = typeof MARK_FIELDS[number]

/**
 * A reader's summary (`derived` without its marks) as a short hash (task #2906): equal summaries, equal etag, whatever
 * order their records were built in. A client echoes it as `derivedEtag` on its next change read, and while it still
 * matches the reply leaves the summary out (read/service.ts changes), as a host's `held` etag does (hostEtag.ts).
 */
export function derivedEtag(derived: Derived): string {
  const summary: Record<string, unknown> = { ...derived }
  for (const field of MARK_FIELDS) delete summary[field]
  return createHash('sha256').update(sorted(summary)).digest('base64url').slice(0, 22)
}

/** Only the reader's marks of `derived`, the fields it has. */
export function marksOf(derived: Derived): Pick<Derived, MarkField> {
  return Object.fromEntries(MARK_FIELDS.filter(field => derived[field] !== undefined).map(field => [field, derived[field]]))
}
