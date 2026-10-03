import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const ASSET = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/1.0.47/Harness-linux-arm64.AppImage";

function manifest(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /desktop/download/linux-arm64", () => {
  it("redirects to the AppImage the manifest currently advertises", async () => {
    manifest({ "desktop-linux-arm64": { version: "1.0.47", url: ASSET, sha256: "x", size: 1 } });

    const res = await GET();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(ASSET);
  });

  // Newer releases publish CDN URLs (upload-desktop-linux.sh, CDN_ASSET_BASE_URL); older ones already
  // published may still carry a GCS-origin URL in the live manifest. Both must keep working.
  it("also redirects to a CDN-hosted AppImage", async () => {
    const cdnAsset = "https://cdn.autonomous.ai/harness/desktop/1.0.81/Harness-linux-arm64.AppImage";
    manifest({ "desktop-linux-arm64": { version: "1.0.81", url: cdnAsset, sha256: "x", size: 1 } });

    const res = await GET();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(cdnAsset);
  });

  // The link is the whole point of the redirect: a release publishes a new versioned path and this
  // route must follow it with no code change and no deploy. Caching the hop would defeat that.
  it("never caches the hop, so a new release is served immediately", async () => {
    manifest({ "desktop-linux-arm64": { version: "1.0.47", url: ASSET, sha256: "x", size: 1 } });

    expect((await GET()).headers.get("Cache-Control")).toBe("no-store, max-age=0");
  });

  // The manifest arrives over the network, and this endpoint's job is to send a browser wherever it
  // points. Without this guard, a tampered manifest turns a harness.autonomous.ai link into a
  // download of someone else's binary.
  it("refuses to redirect outside the release bucket", async () => {
    manifest({ "desktop-linux-arm64": { url: "https://evil.example/Harness-linux-arm64.AppImage" } });

    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("refuses an asset that is not an AppImage", async () => {
    const zip = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/1.0.47/Harness-linux-arm64.zip";
    manifest({ "desktop-linux-arm64": { url: zip } });

    expect((await GET()).status).toBe(503);
  });

  // Publishing only the other architecture (or a half-finished upload) must read as "not ready",
  // not as a broken page.
  it("reports 503 when the manifest carries no linux-arm64 entry", async () => {
    manifest({ "desktop-linux-x64": { url: "https://storage.googleapis.com/x.AppImage" } });

    expect((await GET()).status).toBe(503);
  });

  it("reports 503 when the manifest cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));

    expect((await GET()).status).toBe(503);
  });

  // Each architecture is published under its own key; this route must never serve the other one's
  // asset even when both are present in the manifest.
  it("does not consume the x64 key", async () => {
    manifest({
      "desktop-linux-x64": { url: "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/1.0.47/Harness-linux-x64.AppImage" },
      "desktop-linux-arm64": { url: ASSET },
    });

    expect((await GET()).headers.get("Location")).toBe(ASSET);
  });
});
