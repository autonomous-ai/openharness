import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const MANIFEST = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json";
const PAGE = "https://harness.autonomous.ai/device/download-linux";
const X64 = "https://cdn.autonomous.ai/harness/device/0.2.0/Harness-Device-linux-x64.AppImage";
const ARM64 = "https://cdn.autonomous.ai/harness/device/0.2.0/Harness-Device-linux-arm64.AppImage";
const MAC = { "device-macos-dmg": { url: "https://cdn.autonomous.ai/harness/device/0.2.0/Harness-Device.dmg", sha256: "x", size: 1 } };

function manifest(body: unknown): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function both(): Record<string, unknown> {
  return {
    ...MAC,
    "device-linux-x64": { version: "0.2.0", url: X64, sha256: "x", size: 1 },
    "device-linux-arm64": { version: "0.2.0", url: ARM64, sha256: "x", size: 1 },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /device/download-linux", () => {
  it("redirects to x64's file when the request cannot tell", async () => {
    const fetchMock = manifest(both());

    const res = await GET(new Request(PAGE));

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(X64);
    expect(res.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(fetchMock).toHaveBeenCalledWith(MANIFEST, expect.objectContaining({ cache: "no-store" }));
  });

  it("redirects to arm64's file when the hints say arm64", async () => {
    manifest(both());

    const res = await GET(new Request(PAGE, { headers: { "Sec-CH-UA-Arch": '"arm"', "Sec-CH-UA-Bitness": '"64"' } }));

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(ARM64);
  });

  it("redirects Firefox on aarch64 to arm64's file", async () => {
    manifest(both());

    const res = await GET(
      new Request(PAGE, { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux aarch64; rv:140.0) Gecko/20100101 Firefox/140.0" } }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(ARM64);
  });

  it("answers as the macOS route did before its first release", async () => {
    manifest(MAC);

    const missing = await GET(new Request(PAGE));

    expect(missing.status).toBe(503);
    expect(await missing.text()).toBe("Harness download is temporarily unavailable (no usable device-linux-x64 entry).\n");

    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 403 })));

    const refused = await GET(new Request(PAGE));

    expect(refused.status).toBe(503);
    expect(await refused.text()).toBe("Harness download is temporarily unavailable (manifest HTTP 403).\n");
  });

  // The manifest is input: a tampered one must not turn this link into Desktop's installer, a file
  // outside the device folder, or the Windows build.
  it("refuses anything outside its own folder or of another kind", async () => {
    for (const url of [
      "https://cdn.autonomous.ai/harness/desktop/1.2.3/harness-install.exe",
      "https://cdn.autonomous.ai/harness/device/../desktop/1.2.3/Harness-linux-x86_64.AppImage",
      "https://cdn.autonomous.ai/harness/device/%2e%2e/desktop/1.2.3/Harness-linux-x86_64.AppImage",
      "https://cdn.autonomous.ai/harness/device/0.2.0/Harness-Device-linux-x64.AppImage?x=.AppImage",
      "https://cdn.autonomous.ai/harness/device/0.2.0/Harness-Device-windows-x64-setup.exe#.AppImage",
      "https://cdn.autonomous.ai/harness/device/0.2.0/Harness-Device-windows-x64-setup.exe",
    ]) {
      manifest({ ...MAC, "device-linux-x64": { version: "0.2.0", url, sha256: "x", size: 1 } });

      const res = await GET(new Request(PAGE));

      expect(res.status, url).toBe(503);
      expect(res.headers.get("Location"), url).toBeNull();
    }
  });

  // Desktop's override must never point the device link at another manifest.
  it("reads one fixed manifest", async () => {
    vi.stubEnv("HARNESS_DESKTOP_METADATA_URL", "https://example.test/m.json");
    vi.resetModules();
    const { GET: freshGET } = await import("./route");
    const fetchMock = manifest(both());

    await freshGET(new Request(PAGE));

    expect(fetchMock).toHaveBeenCalledWith(MANIFEST, expect.objectContaining({ cache: "no-store" }));
  });
});
