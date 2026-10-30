import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const ASSET = "https://cdn.autonomous.ai/harness/desktop/1.3.4/harness-install.exe";

function manifest(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /desktop/download/windows", () => {
  it("redirects to the installer the manifest currently advertises, and never caches the hop", async () => {
    manifest({ "desktop-windows-installer": { version: "1.3.4", url: ASSET, sha256: "x", size: 1 } });

    const res = await GET();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(ASSET);
    expect(res.headers.get("Cache-Control")).toBe("no-store, max-age=0");
  });

  // The zips are what the app's updater and install.ps1 take; a browser gets the installer, never a zip.
  it("serves the installer, not either zip", async () => {
    manifest({
      "desktop-windows-x64": { url: "https://cdn.autonomous.ai/harness/desktop/1.3.4/Harness-windows-x64.zip" },
      "desktop-windows-installer": { url: ASSET },
    });
    expect((await GET()).headers.get("Location")).toBe(ASSET);

    manifest({ "desktop-windows-installer": { url: "https://cdn.autonomous.ai/harness/desktop/1.3.4/Harness-windows-x64.zip" } });
    expect((await GET()).status).toBe(503);
  });

  it("refuses to redirect outside the release bucket", async () => {
    manifest({ "desktop-windows-installer": { url: "https://evil.example/harness-install.exe" } });

    const res = await GET();

    expect(res.status).toBe(503);
    expect(res.headers.get("Location")).toBeNull();
  });

  // Until the first release with Windows, the manifest has no key: "not ready", not a broken page.
  it("reports 503 when the manifest carries no installer yet", async () => {
    manifest({ "desktop-linux-x64": { url: "https://cdn.autonomous.ai/harness/desktop/1.3.4/Harness-linux-x64.AppImage" } });

    expect((await GET()).status).toBe(503);
  });
});
