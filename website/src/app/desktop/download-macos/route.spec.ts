import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const ASSET = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/1.0.47/Harness-macos.dmg";

function manifest(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /desktop/download-macos", () => {
  it("redirects to the dmg the manifest currently advertises", async () => {
    manifest({ "desktop-macos-dmg": { version: "1.0.47", url: ASSET, sha256: "x", size: 1 } });

    const res = await GET();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(ASSET);
  });

  // Newer releases publish CDN URLs (upload-desktop.sh, CDN_ASSET_BASE_URL); older ones already
  // published may still carry a GCS-origin URL in the live manifest. Both must keep working.
  it("also redirects to a CDN-hosted dmg", async () => {
    const cdnAsset = "https://cdn.autonomous.ai/harness/desktop/1.0.81/Harness-macos.dmg";
    manifest({ "desktop-macos-dmg": { version: "1.0.81", url: cdnAsset, sha256: "x", size: 1 } });

    const res = await GET();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(cdnAsset);
  });

  // The link is the whole point of the redirect: a release publishes a new versioned path and this
  // route must follow it with no code change and no deploy. Caching the hop would defeat that.
  it("never caches the hop, so a new release is served immediately", async () => {
    manifest({ "desktop-macos-dmg": { version: "1.0.47", url: ASSET, sha256: "x", size: 1 } });

    expect((await GET()).headers.get("Cache-Control")).toBe("no-store, max-age=0");
  });

  // The manifest arrives over the network, and this endpoint's job is to send a browser wherever it
  // points. Without this guard, a tampered manifest turns a harness.autonomous.ai link into a
  // download of someone else's binary.
  it("refuses to redirect outside the release bucket", async () => {
    manifest({ "desktop-macos-dmg": { url: "https://evil.example/Harness-macos.dmg" } });

    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("refuses an asset that is not a dmg", async () => {
    const zip = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/1.0.47/Harness-macos.zip";
    manifest({ "desktop-macos-dmg": { url: zip } });

    expect((await GET()).status).toBe(503);
  });

  // Publishing only the zip (an older release, or a half-finished upload) must read as "not ready",
  // not as a broken page.
  it("reports 503 when the manifest carries no dmg entry", async () => {
    manifest({ "desktop-macos": { url: "https://storage.googleapis.com/x.zip" } });

    expect((await GET()).status).toBe(503);
  });

  it("reports 503 when the manifest cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));

    expect((await GET()).status).toBe(503);
  });

  // The self-update path reads `desktop-macos` (a zip, unpacked with ditto). This route must never
  // be the thing that touches it.
  it("does not consume the key the in-app updater depends on", async () => {
    manifest({
      "desktop-macos": { url: "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/1.0.47/Harness-macos.zip" },
      "desktop-macos-dmg": { url: ASSET },
    });

    expect((await GET()).headers.get("Location")).toBe(ASSET);
  });
});
