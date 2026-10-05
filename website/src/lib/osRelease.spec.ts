import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLatestOSRelease, latestOSRelease } from "./osRelease";

function release(version: string) {
  const iso = `harness-${version}-x86_64.iso`;
  return {
    tag_name: "os-v" + version, draft: false, prerelease: version.includes("-preview."),
    html_url: "https://untrusted.example/download",
    assets: [iso, iso + ".sha256", "INSTALL.md", "manifest.json", "validation.json"]
      .map(name => ({ name, state: "uploaded" })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("latest OS release", () => {
  it("orders numeric previews independently of repository release order and other products", () => {
    expect(latestOSRelease([
      { ...release("99.0.0"), tag_name: "v99.0.0_desktop" },
      release("0.1.0-preview.9"), release("0.1.0-preview.13"), release("0.1.0-preview.10"),
    ])).toBe("https://github.com/autonomous-ai/openharness/releases/tag/os-v0.1.0-preview.13");
  });

  it("moves automatically when a new complete release is published", () => {
    const releases = [release("0.1.0-preview.13")];
    expect(latestOSRelease(releases)).toContain("preview.13");
    releases.push(release("0.1.0-preview.14"));
    expect(latestOSRelease(releases)).toContain("preview.14");
  });

  it("prefers the highest stable release once stable OS releases exist", () => {
    expect(latestOSRelease([release("0.1.0"), release("1.0.0-preview.1"), release("0.2.0")]))
      .toBe("https://github.com/autonomous-ai/openharness/releases/tag/os-v0.2.0");
  });

  it("ignores drafts, incomplete uploads and tags inconsistent with their release kind", () => {
    const incomplete = release("0.1.0-preview.15");
    incomplete.assets[0].state = "new";
    expect(latestOSRelease([
      release("0.1.0-preview.13"), incomplete,
      { ...release("0.1.0-preview.16"), draft: true },
      { ...release("0.1.0-preview.17"), assets: [] },
      { ...release("0.1.0-preview.18"), prerelease: false }, null,
    ])).toContain("preview.13");
    expect(() => latestOSRelease([incomplete])).toThrow("No complete OS release");
  });

  it("follows pagination when newer app releases occupy the first page", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("[]", { headers: { link: '<ignored>; rel="next"' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([release("0.1.0-preview.13")])));
    vi.stubGlobal("fetch", request);
    expect(await fetchLatestOSRelease()).toContain("preview.13");
    expect(request.mock.calls[1][0]).toBe("https://api.github.com/repos/autonomous-ai/openharness/releases?per_page=100&page=2");
  });

  it("does not choose an older partial result when a later page fails", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([release("0.1.0-preview.9")]), { headers: { link: '<ignored>; rel="next"' } }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 403 })));
    await expect(fetchLatestOSRelease()).rejects.toThrow("Release lookup failed");
  });
});
