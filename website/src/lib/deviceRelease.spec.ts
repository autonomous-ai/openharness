import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVICE_MANIFEST_URL, fetchDeviceRelease, parseDeviceRelease, pickBuild, type DeviceBuild } from "./deviceRelease";

const CDN = "https://cdn.autonomous.ai/harness/device/0.1.10/";
const DMG = `${CDN}Harness-Device.dmg`;

// The shape of the live device manifest on 2026-11-20.
const LIVE = {
  version: "0.1.10",
  pub_date: "2026-11-19T15:19:46Z",
  platforms: {
    "darwin-aarch64": { url: `${CDN}Harness-Device.app.tar.gz`, signature: "s" },
    "darwin-x86_64": { url: `${CDN}Harness-Device.app.tar.gz`, signature: "s" },
  },
  "device-macos": { url: `${CDN}Harness-Device.app.tar.gz`, size: 11000000 },
  "device-macos-arm64": { url: `${CDN}Harness-Device.app.tar.gz`, size: 11000000 },
  "device-macos-dmg": { url: DMG, size: 11650555 },
  "device-macos-arm64-dmg": { url: DMG, size: 11650555 },
  notes:
    "Harness Device 0.1.10\n\n- Harness Device: the Orca plugin is set up by default; the Connect Orca row is gone (#4498)\n- Linux: Harness follows the XDG Base Directory paths, and moves ~/.harness there once (#4469)",
};

function builds(manifest: unknown): DeviceBuild[] {
  return parseDeviceRelease(manifest)!.builds;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("parseDeviceRelease", () => {
  it("reads today's manifest as one universal Mac build", () => {
    const r = parseDeviceRelease(LIVE)!;
    expect(r.version).toBe("0.1.10");
    expect(r.date).toBe("Nov 19, 2026");
    expect(r.builds).toEqual([
      {
        os: "macos",
        arch: null,
        pkg: "dmg",
        url: DMG,
        label: "Mac · Apple silicon and Intel",
        detail: ".dmg · 11.1 MB",
      },
    ]);
    expect(r.notes).toEqual([
      "Harness Device: the Orca plugin is set up by default; the Connect Orca row is gone",
      "Linux: Harness follows the XDG Base Directory paths, and moves ~/.harness there once",
    ]);
  });

  it("orders Mac, Windows, Linux and labels each OS and CPU", () => {
    const r = builds({
      ...LIVE,
      "device-linux-aarch64-appimage": { url: `${CDN}Harness-Device.AppImage`, size: 1 },
      "device-windows-x64-msi": { url: `${CDN}Harness-Device.msi`, size: 1 },
    });
    expect(r.map((b) => [b.os, b.arch, b.pkg])).toEqual([
      ["macos", null, "dmg"],
      ["windows", "x64", "msi"],
      ["linux", "arm64", "appimage"],
    ]);
    expect(r[1].label).toBe("Windows · x64");
    expect(r[2].label).toBe("Linux · ARM64");
    expect(r[2].detail.startsWith("AppImage")).toBe(true);
  });

  // The keys `make release-device` writes for Windows and Linux (device-app/scripts/device-manifest.py): the
  // installer key only.
  it("lists each Windows and Linux file of a release once, from its installer key", () => {
    const file = (name: string) => ({ version: "0.1.10", url: `${CDN}${name}`, sha256: "x", size: 1 });
    const r = builds({
      ...LIVE,
      "device-windows-x64-exe": file("Harness-Device-windows-x64-setup.exe"),
      "device-windows-arm64-exe": file("Harness-Device-windows-arm64-setup.exe"),
      "device-linux-x64-appimage": file("Harness-Device-linux-x64.AppImage"),
      "device-linux-arm64-appimage": file("Harness-Device-linux-arm64.AppImage"),
    });
    expect(r.map((b) => [b.label, b.pkg])).toEqual([
      ["Mac · Apple silicon and Intel", "dmg"],
      ["Windows · ARM64", "exe"],
      ["Windows · x64", "exe"],
      ["Linux · ARM64", "appimage"],
      ["Linux · x64", "appimage"],
    ]);
    expect(pickBuild(r, "windows")?.url).toBe(`${CDN}Harness-Device-windows-x64-setup.exe`);
    expect(pickBuild(r, "linux-arm64")?.url).toBe(`${CDN}Harness-Device-linux-arm64.AppImage`);
  });

  it.each([
    "https://evil.example/a.dmg",
    "https://cdn.autonomous.ai/harness/desktop/1.2.3/Harness-macos.dmg",
    `${CDN}Harness-Device.app.tar.gz`,
    "https://cdn.autonomous.ai/harness/device/%2e%2e/desktop/1.0.81/x.dmg",
    `${CDN}Harness-Device.msi`,
  ])("refuses a build at %s", (url) => {
    expect(parseDeviceRelease({ version: "0.1.10", "device-macos-dmg": { url, size: 1 } })).toBeNull();
  });

  it("gives an Apple silicon Mac its build and any other Mac the Intel one", () => {
    const a = "https://cdn.autonomous.ai/harness/device/0.1.10/A.dmg";
    const b = "https://cdn.autonomous.ai/harness/device/0.1.10/B.dmg";
    const r = builds({ version: "0.1.10", "device-macos-arm64-dmg": { url: a }, "device-macos-x64-dmg": { url: b } });
    expect(r.map((x) => x.label)).toEqual(["Mac · Apple silicon", "Mac · Intel"]);
    expect(pickBuild(r, "macos-arm64")?.url).toBe(a);
    expect(pickBuild(r, "macos")?.url).toBe(b);
    expect(pickBuild(r, null)?.url).toBe(b);
  });

  it("keeps the bullet lines of the notes, at most 6", () => {
    const notes = ["Harness Device 0.1.10", "", ...Array.from({ length: 8 }, (_, i) => `- Change ${i} (#${i})`)].join("\n");
    expect(parseDeviceRelease({ ...LIVE, notes })!.notes).toEqual([
      "Change 0",
      "Change 1",
      "Change 2",
      "Change 3",
      "Change 4",
      "Change 5",
    ]);
  });

  it("has no notes when there is no bullet line", () => {
    expect(parseDeviceRelease({ ...LIVE, notes: "Harness Device 0.1.10" })!.notes).toEqual([]);
    const noNotes: Record<string, unknown> = { ...LIVE };
    delete noNotes.notes;
    expect(parseDeviceRelease(noNotes)!.notes).toEqual([]);
  });

  it("leaves the date empty when pub_date is missing or not a date", () => {
    const noDate: Record<string, unknown> = { ...LIVE };
    delete noDate.pub_date;
    expect(parseDeviceRelease(noDate)!.date).toBe("");
    expect(parseDeviceRelease({ ...LIVE, pub_date: "soon" })!.date).toBe("");
  });

  it.each([undefined, 0, "12"])("shows the package alone when size is %s", (size) => {
    expect(builds({ version: "0.1.10", "device-macos-dmg": { url: DMG, size } })[0].detail).toBe(".dmg");
  });

  it("keeps at most 12 builds", () => {
    const manifest: Record<string, unknown> = { version: "0.1.10" };
    const exts = { dmg: ".dmg", msi: ".msi", exe: ".exe", deb: ".deb", rpm: ".rpm", appimage: ".AppImage" };
    let i = 0;
    for (const os of ["macos", "windows", "linux"]) {
      for (const arch of ["", "-arm64", "-x64"]) {
        for (const [pkg, ext] of Object.entries(exts)) {
          if (i === 20) break;
          manifest[`device-${os}${arch}-${pkg}`] = { url: `${CDN}H-${i}${ext}` };
          i += 1;
        }
      }
    }
    expect(i).toBe(20);
    expect(builds(manifest)).toHaveLength(12);
  });

  it.each([
    ["null", null],
    ["a string", "x"],
    ["an array", []],
    ["an empty object", {}],
    ["an empty version", { ...LIVE, version: "" }],
    [
      "only tar.gz entries",
      { version: "0.1.10", platforms: LIVE.platforms, "device-macos": LIVE["device-macos"], "device-macos-arm64": LIVE["device-macos-arm64"] },
    ],
  ])("returns null for %s", (_, manifest) => {
    expect(parseDeviceRelease(manifest)).toBeNull();
  });
});

describe("pickBuild", () => {
  it("offers today's Mac build to every Mac and nothing to anyone else", () => {
    const r = builds(LIVE);
    for (const platform of ["macos", "macos-arm64", "unknown", null] as const) {
      expect(pickBuild(r, platform)).toBe(r[0]);
    }
    for (const platform of ["windows", "linux-x64", "linux", "mobile"] as const) {
      expect(pickBuild(r, platform)).toBeNull();
    }
  });

  it("offers a Linux build only to a Linux of that CPU", () => {
    const deb = `${CDN}harness-device.deb`;
    const r = builds({ ...LIVE, "device-linux-x64-deb": { url: deb } });
    expect(pickBuild(r, "linux-x64")?.url).toBe(deb);
    expect(pickBuild(r, "linux-arm64")).toBeNull();
    expect(pickBuild(r, "linux")).toBeNull();
  });

  it("offers Windows the x64 build", () => {
    const msi = `${CDN}Harness-Device.msi`;
    const r = builds({ ...LIVE, "device-windows-x64-msi": { url: msi } });
    expect(pickBuild(r, "windows")?.url).toBe(msi);
  });
});

describe("fetchDeviceRelease", () => {
  it("reads the live manifest, revalidated every minute", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(LIVE), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await fetchDeviceRelease())?.version).toBe("0.1.10");
    expect(fetchMock).toHaveBeenCalledWith(DEVICE_MANIFEST_URL, expect.objectContaining({ next: { revalidate: 60 } }));
  });

  it.each([
    ["unreachable", () => Promise.reject(new TypeError("fetch failed"))],
    ["HTTP 503", () => Promise.resolve(new Response("<html>", { status: 503 }))],
    ["unreadable", () => Promise.resolve(new Response("<html>", { status: 200 }))],
    ["no usable release", () => Promise.resolve(new Response("{}", { status: 200 }))],
  ])("returns null and logs %s", async (reason, answer) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(answer));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await fetchDeviceRelease()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toBe(`device manifest: ${reason}`);
    expect(line).not.toContain("<html>");
  });
});
