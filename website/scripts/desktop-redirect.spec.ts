import { readFileSync } from "fs";
import { join } from "path";
import { expect, it } from "vitest";
import nextConfig from "../next.config.js";

it("sends /desktop, and only that path, to /device for good", async () => {
  const site = (await nextConfig.redirects()).filter((r) => !("has" in r));
  expect(site).toContainEqual({ source: "/desktop", destination: "/device", permanent: true });
  // /device then sends it on to the Meet Harness page, temporarily, so this permanent hop never names an outside URL.
  expect(site).toContainEqual({ source: "/device", destination: "https://www.autonomous.ai/meet-harness", permanent: false });
  // Next matches a source exactly, so only a /desktop/... source could catch the download routes.
  expect(site.filter((r) => r.source.startsWith("/desktop/")).map((r) => r.source)).toEqual(["/desktop/install.sh"]);
});

it("lists /device in the sitemap, not /desktop", () => {
  const sitemap = readFileSync(join(process.cwd(), "public", "sitemap.xml"), "utf8");
  expect(sitemap).toContain("<loc>https://harness.autonomous.ai/device</loc>");
  expect(sitemap).not.toContain("harness.autonomous.ai/desktop<");
});
