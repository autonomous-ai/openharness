import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const MANIFEST = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json";
const CDN_DMG = "https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.dmg";
const ORIGIN_DMG = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/0.1.0/Harness-Device.dmg";

function manifest(body: unknown): ReturnType<typeof vi.fn<typeof fetch>> {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /device/download-macos", () => {
  it("redirects to the dmg the manifest names", async () => {
    const fetchMock = manifest({ version: "0.1.0", platforms: {}, "device-macos-dmg": { url: CDN_DMG, sha256: "x", size: 1 } });

    const res = await GET();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(CDN_DMG);
    expect(res.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(fetchMock).toHaveBeenCalledWith(MANIFEST, expect.objectContaining({ cache: "no-store" }));
  });

  it("also redirects to the bucket's own address", async () => {
    manifest({ version: "0.1.0", platforms: {}, "device-macos-dmg": { url: ORIGIN_DMG, sha256: "x", size: 1 } });

    const res = await GET();

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(ORIGIN_DMG);
  });

  // Before the first release the bucket has no manifest and answers 403: the page goes live first.
  it("reports 503 when the bucket refuses the manifest", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 403 })));

    const res = await GET();

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Harness Device download is temporarily unavailable (manifest HTTP 403).\n");
  });

  it("reports 503 when the manifest cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));

    const res = await GET();

    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/\(manifest unreachable\)\.\n$/);
  });

  // The bucket answered: the fault is in what was published, not in the network.
  it("reports 503 when the manifest is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>", { status: 200 })));

    const res = await GET();

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Harness Device download is temporarily unavailable (manifest unreadable).\n");
  });

  // A bucket that never answers must not hold the visitor's request open.
  it("reports 503 when the manifest does not answer within 10 s", async () => {
    vi.useFakeTimers();
    // AbortSignal.timeout runs on a clock the fake timers do not reach: the same signal, on the fake clock.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const timeout = new AbortController();
      setTimeout(() => timeout.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
      return timeout.signal;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
      ),
    );
    let res: Response | undefined;
    void GET().then((answer) => (res = answer));

    await vi.advanceTimersByTimeAsync(10_000);

    expect(res?.status).toBe(503);
    expect(await res?.text()).toMatch(/\(manifest unreachable\)\.\n$/);
  });

  // The manifest is input: a tampered one must not turn this link into someone else's binary, Desktop's,
  // or the updater's archive. A browser normalises the Location it follows, so a dot segment in any
  // spelling, a query or a fragment would leave the folder while the raw text still looks inside it.
  it("refuses anything outside its own folder", async () => {
    for (const url of [
      "https://evil.example/Harness-Device.dmg",
      "https://cdn.autonomous.ai/harness/desktop/1.2.3/Harness-macos.dmg",
      "https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.app.tar.gz",
      "https://cdn.autonomous.ai/harness/device/../desktop/1.0.81/Harness-macos.dmg",
      "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/../../../attacker-bucket/evil.dmg",
      "https://cdn.autonomous.ai/harness/device/%2e%2e/desktop/1.0.81/Harness-macos.dmg",
      "https://cdn.autonomous.ai/harness/device/..\\desktop/1.0.81/Harness-macos.dmg",
      "https://cdn.autonomous.ai/harness/device/0.1.0/../../desktop/1.0.81/Harness-macos.dmg",
      "https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.app.tar.gz#.dmg",
      "https://cdn.autonomous.ai/harness/device/0.1.0/Harness-Device.app.tar.gz?.dmg",
    ]) {
      manifest({ version: "0.1.0", platforms: {}, "device-macos-dmg": { url, sha256: "x", size: 1 } });

      const res = await GET();

      expect(res.status, url).toBe(503);
      expect(res.headers.get("Location"), url).toBeNull();
      expect(await res.text(), url).toMatch(/\(no usable device-macos-dmg entry\)\.\n$/);
    }
  });

  it("reports 503 when the manifest has no dmg", async () => {
    for (const body of [{ platforms: { "darwin-aarch64": { url: CDN_DMG } } }, null, "x"]) {
      manifest(body);

      expect((await GET()).status).toBe(503);
    }
  });

  // The first manifests named the dmg `dmg`; the link reads only `device-macos-dmg` now.
  it("reports 503 when the manifest names the dmg only as dmg", async () => {
    manifest({ version: "0.1.0", platforms: {}, dmg: { url: CDN_DMG, sha256: "x", size: 1 } });

    expect((await GET()).status).toBe(503);
  });

  // Desktop's override must never point the device link at another manifest.
  it("reads one fixed manifest", async () => {
    vi.stubEnv("HARNESS_DESKTOP_METADATA_URL", "https://example.test/m.json");
    vi.resetModules();
    const { GET: freshGET } = await import("./route");
    const fetchMock = manifest({ "device-macos-dmg": { url: CDN_DMG } });

    await freshGET();

    expect(fetchMock).toHaveBeenCalledWith(MANIFEST, expect.objectContaining({ cache: "no-store" }));
  });
});
