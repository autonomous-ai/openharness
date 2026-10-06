/**
 * Where a sign-in came from, as the marketing site tagged it. auth.autonomous.ai carries the
 * `utm_*` and `rid` it was reached with back onto our redirect_uri; the web callback page lifts
 * them off the URL and sends them with `/api/auth/exchange`, which records them on the user: as
 * `signUpAttribution` when that sign-in creates the account, and as `lastAttribution` every time.
 *
 * `/api/auth/exchange` is reachable by anyone holding a fresh code, so only the keys below are
 * read, each trimmed and capped — whatever passes here becomes a stored, reported value.
 */
export interface SignInAttribution {
  source?: string
  medium?: string
  campaign?: string
  term?: string
  content?: string
  /** Autonomous's own referral id, beside the utm tags on its links. */
  rid?: string
}

/** Wire key → stored field. The wire keys are the URL's own, so the client forwards them untouched. */
const ATTRIBUTION_FIELDS = {
  utm_source: 'source',
  utm_medium: 'medium',
  utm_campaign: 'campaign',
  utm_term: 'term',
  utm_content: 'content',
  rid: 'rid',
} as const satisfies Record<string, keyof SignInAttribution>

const MAX_VALUE_LENGTH = 128

function attributionValue(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().slice(0, MAX_VALUE_LENGTH)
  return value || undefined
}

/** The recognised keys of [raw], or nothing when it carries none — never an empty record. */
export function normalizeSignInAttribution(raw: unknown): SignInAttribution | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const input = raw as Record<string, unknown>
  const attribution: SignInAttribution = {}
  for (const [wireKey, field] of Object.entries(ATTRIBUTION_FIELDS)) {
    const value = attributionValue(input[wireKey])
    if (value) attribution[field] = value
  }
  return Object.keys(attribution).length ? attribution : undefined
}
