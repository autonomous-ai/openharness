import { expect, it } from "vitest";
import nextConfig from "../next.config.js";

const siteRedirects = async () => (await nextConfig.redirects()).filter((r) => !("has" in r));
const beforeFiles = async () => (await nextConfig.rewrites()).beforeFiles;

const viewer = [{ type: "query", key: "viewer" }];
const meetHarness = "https://www.autonomous.ai/meet-harness";

it("sends the home page to autonomous.ai's Meet Harness page, temporarily", async () => {
  expect(await siteRedirects()).toContainEqual({ source: "/", missing: viewer, destination: meetHarness, permanent: false });
});

it("sends the /device page to autonomous.ai's Meet Harness page, temporarily", async () => {
  expect(await siteRedirects()).toContainEqual({ source: "/device", destination: meetHarness, permanent: false });
});

it("keeps hn view's viewer links at /?viewer=1 on the web app", async () => {
  // tui/src/viewer.rs links to /?viewer=1; the web app's viewer reads it at path '/'.
  expect((await beforeFiles()).filter((r) => r.source === "/")).toEqual([
    { source: "/", has: viewer, destination: "/harness-web/index.html" },
  ]);
});

it("keeps the web app's other entry points on the web app", async () => {
  const rewrites = await beforeFiles();
  for (const source of ["/s/:id", "/auth/callback", "/callback", "/harness-web"]) {
    expect(rewrites).toContainEqual({ source, destination: "/harness-web/index.html" });
  }
});

it("redirects none of the pages the home page and /device change must not reach", async () => {
  // Next matches a source exactly, so the '/' and '/device' sources catch only those two pages.
  const kept = ["/app", "/pair", "/signin", "/machine-checkout", "/hub", "/download", "/s/:id", "/auth/callback", "/callback"];
  const sources = (await siteRedirects()).map((r) => r.source);
  expect(sources.filter((s) => kept.includes(s) || s.startsWith("/desktop/download") || s.startsWith("/device/"))).toEqual([]);
});

it("keeps the /desktop and /web redirects", async () => {
  const site = await siteRedirects();
  expect(site).toContainEqual({ source: "/desktop", destination: "/device", permanent: true });
  expect(site).toContainEqual({ source: "/web", destination: "/", permanent: false });
});
