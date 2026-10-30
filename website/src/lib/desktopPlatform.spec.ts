import { describe, expect, it } from "vitest";
import { DESKTOP_BUILD, DESKTOP_BUILDS, buildsFor, detectVisitorPlatform, platformFromUserAgent } from "./desktopPlatform";

const EDGE_ON_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

describe("the Windows desktop build", () => {
  it("is one build for both CPUs, behind the manifest-backed route", () => {
    expect(DESKTOP_BUILD.windows).toEqual({ id: "windows", name: "Windows", detail: "x64 and ARM", href: "/desktop/download/windows" });
    expect(DESKTOP_BUILDS.map((build) => build.id)).toEqual(["macos", "linux-x64", "linux-arm64", "windows"]);
  });

  it("is what a Windows browser gets, whatever its CPU", async () => {
    expect(platformFromUserAgent({ userAgent: EDGE_ON_WINDOWS, platform: "Win32" })).toBe("windows");
    for (const architecture of ["x86", "arm"]) {
      const platform = await detectVisitorPlatform({
        userAgent: EDGE_ON_WINDOWS,
        userAgentData: { platform: "Windows", mobile: false, getHighEntropyValues: async () => ({ architecture, bitness: "64" }) },
      });
      expect(platform, architecture).toBe("windows");
    }
  });

  it("is listed for every visitor, the Windows one included", () => {
    for (const platform of ["windows", "macos-arm64", "linux-x64", null] as const) {
      expect(buildsFor(platform).some((build) => build.id === "windows"), String(platform)).toBe(true);
    }
  });
});
