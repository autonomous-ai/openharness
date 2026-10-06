import { NextRequest } from "next/server"
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server"
import { describe, expect, it } from "vitest"
import { config, proxy } from "./proxy"

function setCookies(url: string, headers: Record<string, string> = {}): string[] {
  return proxy(new NextRequest(url, { headers })).headers.getSetCookie()
}

describe("proxy", () => {
  it("keeps a tagged /desktop link's tags on .autonomous.ai, as the browser reached the site", () => {
    // Behind the ingress the server sees its own address; the forwarded host and scheme are the public ones.
    const cookies = setCookies("http://10.0.0.7:3000/desktop?utm_source=x&utm_campaign=launch&rid=r1", {
      "x-forwarded-host": "harness.autonomous.ai",
      "x-forwarded-proto": "https",
    })

    expect(cookies).toEqual(expect.arrayContaining([
      expect.stringMatching(/^utm_source=x;.*Domain=\.autonomous\.ai/i),
      expect.stringMatching(/^utm_campaign=launch;/),
      expect.stringMatching(/^rid=r1;/),
      expect.stringMatching(/^utm_term=;.*Max-Age=0/i),
    ]))
    expect(cookies.find((c) => c.startsWith("rid="))).toMatch(/Secure/i)
  })

  it("does the same for a link straight to a download", () => {
    const cookies = setCookies("https://harness.autonomous.ai/desktop/download-macos?rid=r2", { host: "harness.autonomous.ai" })

    expect(cookies).toEqual(expect.arrayContaining([expect.stringMatching(/^rid=r2;.*Domain=\.autonomous\.ai/i)]))
  })

  it("writes nothing for an untagged request", () => {
    expect(setCookies("https://harness.autonomous.ai/desktop", { host: "harness.autonomous.ai" })).toEqual([])
  })

  it("marks a response that sets them as private, so no shared cache replays one person's referral", () => {
    const tagged = proxy(new NextRequest("https://harness.autonomous.ai/desktop?rid=r1", { headers: { host: "harness.autonomous.ai" } }))
    const plain = proxy(new NextRequest("https://harness.autonomous.ai/desktop", { headers: { host: "harness.autonomous.ai" } }))

    expect(tagged.headers.get("cache-control")).toBe("private, no-store")
    expect(plain.headers.get("cache-control")).toBeNull()
  })

  it("runs for landing pages and downloads, not for build output, release files or sign-in callbacks", () => {
    const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url })
    expect(runs("/desktop?rid=r1")).toBe(true)
    expect(runs("/desktop/download-macos?rid=r1")).toBe(true)
    expect(runs("/?rid=r1")).toBe(true)
    expect(runs("/_next/static/chunks/a.js")).toBe(false)
    expect(runs("/harness-web/releases/1.3.25-abc/main.dart.js")).toBe(false)
    expect(runs("/auth/callback?code=c&state=s&rid=r1")).toBe(false)
    expect(runs("/callback?code=c&state=s&rid=r1")).toBe(false)
  })
})
