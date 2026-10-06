import { describe, expect, it } from "vitest"
import { ATTRIBUTION_MAX_AGE, attributionCookies } from "./signInAttribution"

const LIVE = { hostname: "harness.autonomous.ai", https: true }

const written = (cookies: ReturnType<typeof attributionCookies>) =>
  Object.fromEntries(cookies.map((c) => [c.name, c.maxAge ? c.value : null]))

describe("attributionCookies", () => {
  it("keeps a tagged link's utm_* and rid where auth.autonomous.ai reads them", () => {
    const cookies = attributionCookies(new URLSearchParams("utm_source=x&utm_medium=social&utm_campaign=launch&rid=r1"), LIVE)

    expect(written(cookies)).toEqual({
      utm_source: "x",
      utm_medium: "social",
      utm_campaign: "launch",
      utm_term: null,
      utm_content: null,
      rid: "r1",
    })
    // The parent domain: auth.autonomous.ai cannot see a cookie that belongs to this host alone.
    expect(cookies.every((c) => c.domain === ".autonomous.ai" && c.path === "/" && c.secure && !c.httpOnly)).toBe(true)
    expect(cookies.find((c) => c.name === "rid")?.maxAge).toBe(ATTRIBUTION_MAX_AGE)
  })

  it("lets the latest link replace the whole set, clearing a tag it did not carry", () => {
    // An older link's rid left beside a newer link's utm_source would credit the wrong referrer.
    const cookies = attributionCookies(new URLSearchParams("utm_source=newsletter"), LIVE)

    expect(cookies.filter((c) => c.maxAge === 0).map((c) => c.name)).toEqual([
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "rid",
    ])
  })

  it("leaves the set alone for an untagged visit", () => {
    expect(attributionCookies(new URLSearchParams(""), LIVE)).toEqual([])
    expect(attributionCookies(new URLSearchParams("platform=mac&utm_source=%20%20"), LIVE)).toEqual([])
  })

  it("trims and caps each value like the backend does", () => {
    const cookies = attributionCookies(new URLSearchParams(`utm_source=%20x%20&rid=${"r".repeat(500)}`), LIVE)

    expect(cookies.find((c) => c.name === "utm_source")?.value).toBe("x")
    expect(cookies.find((c) => c.name === "rid")?.value).toHaveLength(128)
  })

  it("sets a host-only cookie off autonomous.ai, where the parent domain would be refused", () => {
    const cookies = attributionCookies(new URLSearchParams("rid=r1"), { hostname: "localhost", https: false })

    expect(cookies.every((c) => c.domain === undefined && !c.secure)).toBe(true)
  })

  it("names the parent domain for autonomous.ai itself and any of its hosts", () => {
    for (const hostname of ["autonomous.ai", "HARNESS.autonomous.ai", "local-harness.autonomous.ai"]) {
      expect(attributionCookies(new URLSearchParams("rid=r1"), { hostname, https: true })[0].domain).toBe(".autonomous.ai")
    }
    expect(attributionCookies(new URLSearchParams("rid=r1"), { hostname: "evilautonomous.ai", https: true })[0].domain).toBeUndefined()
  })
})
