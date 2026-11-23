import { describe, expect, it } from "vitest";
import { deviceArch } from "./deviceArch";

const CHROME_ON_LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const FIREFOX_ON_LINUX_ARM = "Mozilla/5.0 (X11; Linux aarch64; rv:140.0) Gecko/20100101 Firefox/140.0";
const EDGE_ON_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

function hints(arch: string | null, bitness: string | null, userAgent?: string): Headers {
  const headers = new Headers();
  if (arch !== null) headers.set("Sec-CH-UA-Arch", arch);
  if (bitness !== null) headers.set("Sec-CH-UA-Bitness", bitness);
  if (userAgent) headers.set("User-Agent", userAgent);
  return headers;
}

describe("deviceArch", () => {
  it("the hints name arm64 or x64", () => {
    for (const os of ["windows", "linux"] as const) {
      expect(deviceArch(hints('"arm"', '"64"'), os), os).toBe("arm64");
      expect(deviceArch(hints('"x86"', '"64"'), os), os).toBe("x64");
    }
  });

  it("a 32-bit or unknown hint is x64", () => {
    for (const os of ["windows", "linux"] as const) {
      expect(deviceArch(hints('"arm"', '"32"'), os), os).toBe("x64");
      expect(deviceArch(hints('"riscv"', '"64"'), os), os).toBe("x64");
      expect(deviceArch(hints('"arm"', null), os), os).toBe("x64");
      expect(deviceArch(hints(null, '"64"'), os), os).toBe("x64");
    }
  });

  it("a Chromium on Linux that sends the hints gets arm64 although its user agent says x86_64", () => {
    expect(deviceArch(hints('"arm"', '"64"', CHROME_ON_LINUX), "linux")).toBe("arm64");
  });

  it("Firefox on Linux names its CPU", () => {
    expect(deviceArch(hints(null, null, FIREFOX_ON_LINUX_ARM), "linux")).toBe("arm64");
    expect(deviceArch(hints(null, null, CHROME_ON_LINUX), "linux")).toBe("x64");
  });

  // Windows on ARM writes `Win64; x64` too, so its user agent says nothing either way.
  it("Windows on ARM without hints gets x64", () => {
    expect(deviceArch(hints(null, null, EDGE_ON_WINDOWS), "windows")).toBe("x64");
    expect(deviceArch(hints(null, null, "Mozilla/5.0 (Windows NT 10.0; ARM64) Gecko/20100101 Firefox/140.0"), "windows")).toBe(
      "x64",
    );
  });

  it("nothing said is x64", () => {
    for (const os of ["windows", "linux"] as const) {
      expect(deviceArch(new Headers(), os), os).toBe("x64");
    }
  });
});
