import { NextResponse, type NextRequest } from "next/server"
import { attributionCookies, type SiteOrigin } from "./lib/signInAttribution"

/**
 * The public host and scheme. The standalone server sits behind the ingress, which terminates TLS
 * and forwards the browser's Host; without these headers (local `next dev`) the URL is the truth.
 */
function siteOrigin(request: NextRequest): SiteOrigin {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
  const host = forwardedHost || request.headers.get("host") || request.nextUrl.host
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || request.nextUrl.protocol.replace(/:$/, "")
  return { hostname: host.replace(/:\d+$/, ""), https: proto === "https" }
}

/**
 * Keeps a tagged link's `utm_*` and `rid` for the sign-in (lib/signInAttribution.ts). Every page and
 * download route goes through here — /desktop, a link straight to /desktop/download-macos, the web app
 * at / — and an untagged request passes untouched.
 */
export function proxy(request: NextRequest): NextResponse {
  const response = NextResponse.next()
  const cookies = attributionCookies(request.nextUrl.searchParams, siteOrigin(request))
  if (!cookies.length) return response
  for (const { name, value, ...options } of cookies) response.cookies.set(name, value, options)
  // /desktop is prerendered with `s-maxage=31536000`. Cloudflare passes it through today, but a cache
  // that kept this response would hand one person's referral cookies to everyone after them.
  response.headers.set("Cache-Control", "private, no-store")
  return response
}

export const config = {
  // Static build output and the web app's immutable release files never carry a campaign link. Nor do
  // the sign-in callbacks: auth.autonomous.ai echoes the cookies' own tags onto them, and writing them
  // back on every web sign-in would keep a 30-day attribution alive for as long as someone signs in.
  matcher: ["/((?!_next/|harness-web/releases/|auth/callback|callback|favicon\\.ico).*)"],
}
