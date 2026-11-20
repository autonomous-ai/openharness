import { readFileSync } from "fs";
import { join } from "path";
import { expect, it } from "vitest";
import nextConfig from "../next.config.js";

it("sends /desktop, and only that path, to the device guide for good", async () => {
  const site = (await nextConfig.redirects()).filter((r) => !r.has);
  expect(site).toContainEqual({ source: "/desktop", destination: "/device", permanent: true });
  // Next matches a source exactly, so only a /desktop/... source could catch the download routes.
  expect(site.filter((r) => r.source.startsWith("/desktop/")).map((r) => r.source)).toEqual(["/desktop/install.sh"]);
});

it("lists /device in the sitemap, not /desktop", () => {
  const sitemap = readFileSync(join(process.cwd(), "public", "sitemap.xml"), "utf8");
  expect(sitemap).toContain("<loc>https://harness.autonomous.ai/device</loc>");
  expect(sitemap).not.toContain("harness.autonomous.ai/desktop<");
});
