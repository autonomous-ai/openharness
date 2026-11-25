import { describe, expect, it } from "vitest";
import { DESKTOP_BUILD, DESKTOP_BUILDS, buildsFor, detectVisitorPlatform, platformFromUserAgent } from "./desktopPlatform";

const EDGE_ON_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

describe("the Windows desktop build", () => {
  it("is one build for both CPUs, behind the manifest-backed route", () => {
    expect(DESKTOP_BUILD.windows).toEqual({ id: "windows", name: "Windows", detail: "x64 and ARM", href: "/desktop/download/windows" });
    expect(DESKTOP_BUILDS.map((build) => build.id)).toEqual(["macos", "linux-x64", "linux-arm64", "windows"]);
  });

  it("is what a Windows browser gets unless it says its CPU is ARM", async () => {
    expect(platformFromUserAgent({ userAgent: EDGE_ON_WINDOWS, platform: "Win32" })).toBe("windows");
    const hints = {
      x64: async () => ({ architecture: "x86", bitness: "64" }),
      refused: () => Promise.reject(new Error("blocked")),
      none: undefined,
    };
    for (const [name, getHighEntropyValues] of Object.entries(hints)) {
      const platform = await detectVisitorPlatform({
        userAgent: EDGE_ON_WINDOWS,
        userAgentData: { platform: "Windows", mobile: false, getHighEntropyValues },
      });
      expect(platform, name).toBe("windows");
    }
  });

  it("tells Windows on ARM apart, for the Device's ARM64 installer", async () => {
    const platform = await detectVisitorPlatform({
      userAgent: EDGE_ON_WINDOWS,
      userAgentData: { platform: "Windows", mobile: false, getHighEntropyValues: async () => ({ architecture: "arm", bitness: "64" }) },
    });
    expect(platform).toBe("windows-arm64");
  });

  it("is listed for every visitor, the Windows ones included", () => {
    for (const platform of ["windows", "windows-arm64", "macos-arm64", "linux-x64", null] as const) {
      expect(buildsFor(platform).some((build) => build.id === "windows"), String(platform)).toBe(true);
    }
  });
});
