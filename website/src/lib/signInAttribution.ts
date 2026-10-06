/**
 * Where a download came from, kept where the sign-in can find it.
 *
 * A person who lands on harness.autonomous.ai/desktop from a tagged link downloads a static
 * installer, so nothing in the app knows the link. The sign-in does: auth.autonomous.ai reads the
 * `utm_*` and `rid` cookies on `.autonomous.ai` and appends them to the redirect_uri, the desktop app's
 * `harness login` sends them with /api/auth/exchange, and the backend records them on the account
 * (backend lib/signInAttribution.ts). www.autonomous.ai/harness-app already sets those cookies; this
 * host sets the same ones, with the same names and lifetime, so a link to either page is attributed.
 *
 * Like www.autonomous.ai, a tagged visit replaces the whole set (the latest link wins, and a tag it
 * did not carry is cleared rather than left over from an older link) and an untagged visit leaves the
 * set alone.
 */
export const ATTRIBUTION_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "rid"] as const

/** www.autonomous.ai keeps them for 30 days. */
export const ATTRIBUTION_MAX_AGE = 30 * 24 * 60 * 60

/** Same cap as the backend: anything longer is cut there anyway. */
const MAX_VALUE_LENGTH = 128

export interface AttributionCookie {
  name: (typeof ATTRIBUTION_KEYS)[number]
  /** Empty with `maxAge: 0` clears a tag the latest link did not carry. */
  value: string
  domain?: string
  path: "/"
  maxAge: number
  sameSite: "lax"
  secure: boolean
  // Not HttpOnly, like www.autonomous.ai's: the sign-in page may read them in the browser.
  httpOnly: false
}

/**
 * The parent domain a cookie must name for auth.autonomous.ai to see it, or none off that domain
 * (local development), where a host-only cookie is the most that can be set.
 */
function cookieDomain(hostname: string): string | undefined {
  return hostname === "autonomous.ai" || hostname.endsWith(".autonomous.ai") ? ".autonomous.ai" : undefined
}

/** The host the person reached, as the browser saw it: the public name and scheme, not the pod's. */
export interface SiteOrigin {
  hostname: string
  https: boolean
}

/** The cookies to write for a request with [query] on [site], or none when it carries no tag. */
export function attributionCookies(query: URLSearchParams, site: SiteOrigin): AttributionCookie[] {
  const values = ATTRIBUTION_KEYS.map((key) => [key, query.get(key)?.trim().slice(0, MAX_VALUE_LENGTH) ?? ""] as const)
  if (!values.some(([, value]) => value)) return []
  const domain = cookieDomain(site.hostname.toLowerCase())
  const secure = site.https
  return values.map(([name, value]) => ({
    name,
    value,
    ...(domain ? { domain } : {}),
    path: "/",
    maxAge: value ? ATTRIBUTION_MAX_AGE : 0,
    sameSite: "lax",
    secure,
    httpOnly: false,
  }))
}
