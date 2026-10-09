/**
 * Which desktop build suits the browser asking: the answer behind the download buttons on
 * `/desktop` and `/download`.
 *
 * It reads `navigator`, so it only ever runs in the browser. A page therefore renders its
 * no-detection state on the server and on first paint, then refines it once this answers. That state
 * has to stand on its own with every build reachable, because a browser that blocks scripts, or one
 * this cannot place, never leaves it.
 *
 * macOS ships two builds of one universal app (desktop/RELEASE.md "Two macOS builds"): the Intel one
 * on Skia, and the Apple silicon one on Impeller. Both launch on either CPU, so a wrong guess costs a
 * renderer, never a working app. A Mac whose browser reports an ARM CPU gets the Apple silicon build;
 * every other Mac gets the Intel one, which is what the website always served. Only Chromium can say:
 * Safari and Firefox report "Intel" on every Mac.
 *
 * Linux is where the CPU decides whether the app runs at all: x64 and ARM64 are separate AppImages.
 * Chromium freezes its user-agent string at "Linux x86_64" whatever the CPU, so on Chromium the
 * architecture comes from User-Agent Client Hints; Firefox still writes the real one (`aarch64`) into
 * its user agent. When neither says, the answer is "Linux, architecture unknown" and the page offers
 * both builds instead of guessing.
 */

import {
  DESKTOP_DOWNLOAD_LINUX_ARM64_URL,
  DESKTOP_DOWNLOAD_LINUX_X64_URL,
  DESKTOP_DOWNLOAD_MACOS_ARM64_URL,
  DESKTOP_DOWNLOAD_URL,
} from "@/lib/installCommand";

export type DesktopBuildId = "macos" | "macos-arm64" | "linux-x64" | "linux-arm64";

export type DesktopBuild = {
  id: DesktopBuildId;
  name: string;
  detail: string;
  href: string;
};

export const DESKTOP_BUILD = {
  macos: { id: "macos", name: "macOS", detail: "Apple silicon + Intel", href: DESKTOP_DOWNLOAD_URL },
  "macos-arm64": {
    id: "macos-arm64",
    name: "macOS (Apple silicon)",
    detail: "Built for Apple silicon",
    href: DESKTOP_DOWNLOAD_MACOS_ARM64_URL,
  },
  "linux-x64": { id: "linux-x64", name: "Linux (x64)", detail: "AppImage", href: DESKTOP_DOWNLOAD_LINUX_X64_URL },
  "linux-arm64": { id: "linux-arm64", name: "Linux (ARM64)", detail: "AppImage", href: DESKTOP_DOWNLOAD_LINUX_ARM64_URL },
} as const satisfies Record<DesktopBuildId, DesktopBuild>;

/**
 * The builds the pages list for everyone, in order. The Apple silicon build is not among them: it is
 * offered in place of `macos`, and only to a Mac known to be Apple silicon (`buildsFor`).
 */
export const DESKTOP_BUILDS: readonly DesktopBuild[] = [
  DESKTOP_BUILD.macos,
  DESKTOP_BUILD["linux-x64"],
  DESKTOP_BUILD["linux-arm64"],
];

/**
 * What the visitor is on, as far as the desktop download cares:
 * - a `DesktopBuildId`: that build suits this computer (`macos` also covers a Mac of unknown CPU);
 * - `linux`: Linux, but the browser did not say which CPU (or it is one with no build);
 * - `windows`, `mobile`: no desktop build runs here (`mobile` covers phones and tablets, iPad included);
 * - `unknown`: anything else, ChromeOS included. Pages treat it like no detection at all.
 */
export type VisitorPlatform = DesktopBuildId | "linux" | "windows" | "mobile" | "unknown";

/**
 * `DESKTOP_BUILDS` as this visitor should see them: on an ARM Mac, macOS's row (still named "macOS")
 * links the Apple silicon build instead.
 */
export function buildsFor(platform: VisitorPlatform | null): readonly DesktopBuild[] {
  if (platform !== "macos-arm64") return DESKTOP_BUILDS;
  return DESKTOP_BUILDS.map((build) =>
    build.id === "macos" ? { ...DESKTOP_BUILD["macos-arm64"], name: build.name } : build,
  );
}

/** The few `navigator` fields this reads, so a caller (or a non-browser runtime) can supply them. */
export type NavigatorSnapshot = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: UserAgentData;
};

/** User-Agent Client Hints (Chromium only, secure contexts only); not in TypeScript's DOM lib yet. */
type UserAgentData = {
  platform?: string;
  mobile?: boolean;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }>;
};

/** The Linux build named by an architecture string such as `navigator.platform`'s "Linux aarch64". */
function linuxBuild(text: string): VisitorPlatform {
  // `armv8l` is deliberately not here: it is a 32-bit userland, which the ARM64 AppImage cannot serve.
  if (/\b(aarch64|arm64)\b/.test(text)) return "linux-arm64";
  if (/\b(x86_64|x86-64|amd64)\b/.test(text)) return "linux-x64";
  return "linux";
}

/** Classify from the user-agent string and `navigator.platform` alone: the path every browser has. */
export function platformFromUserAgent({ userAgent = "", platform = "", maxTouchPoints = 0 }: NavigatorSnapshot): VisitorPlatform {
  const agent = userAgent.toLowerCase();
  const os = platform.toLowerCase();

  // Android's user agent also says "Linux", and iOS browsers' say "like Mac OS X", so phones go first.
  if (/android|iphone|ipad|ipod/.test(agent) || /^(iphone|ipad|ipod)/.test(os)) return "mobile";
  // iPadOS Safari asks for desktop sites by default and reports itself as a Mac; only the touchscreen
  // tells it apart, since no Mac has one. Every Mac browser says "Intel" here, so the CPU stays unknown.
  if (/macintosh|mac os x/.test(agent) || os.startsWith("mac")) return maxTouchPoints > 1 ? "mobile" : "macos";
  if (agent.includes("windows") || os.startsWith("win")) return "windows";
  if (agent.includes("cros")) return "unknown";
  if (agent.includes("linux") || os.startsWith("linux")) {
    // Chromium's user agent says x86_64 on every Linux machine, so only `navigator.platform` can be
    // trusted there; other browsers still report the real architecture in both.
    const chromium = /\b(chrome|chromium)\//.test(agent);
    return linuxBuild(chromium ? os : `${os} ${agent}`);
  }
  return "unknown";
}

/**
 * The CPU from Client Hints: `undefined` when the browser would not say (a permissions policy, a
 * privacy setting), `other` when it named one nothing is published for (32-bit, RISC-V...).
 */
async function cpuFromClientHints(data: UserAgentData): Promise<"x64" | "arm64" | "other" | undefined> {
  try {
    const hints = await data.getHighEntropyValues?.(["architecture", "bitness"]);
    const architecture = hints?.architecture ?? "";
    const bitness = hints?.bitness ?? "";
    if (bitness === "64" && architecture === "x86") return "x64";
    if (bitness === "64" && architecture === "arm") return "arm64";
    if (architecture && bitness) return "other";
  } catch {
    // Refused: fall through to "would not say".
  }
  return undefined;
}

/**
 * The visitor's platform, from Client Hints where the browser offers them and the user agent where it
 * does not. Never rejects: anything unreadable resolves to `unknown`.
 */
export async function detectVisitorPlatform(snapshot: NavigatorSnapshot): Promise<VisitorPlatform> {
  try {
    const data = snapshot.userAgentData;
    if (!data?.platform) return platformFromUserAgent(snapshot);
    if (data.mobile) return "mobile";
    switch (data.platform) {
      case "macOS":
        // Anything short of a definite ARM answer keeps the build every Mac can run as before.
        return (await cpuFromClientHints(data)) === "arm64" ? "macos-arm64" : "macos";
      case "Windows":
        return "windows";
      case "Android":
      case "iOS":
        return "mobile";
      case "Linux": {
        const cpu = await cpuFromClientHints(data);
        if (cpu === "x64") return "linux-x64";
        if (cpu === "arm64") return "linux-arm64";
        if (cpu === "other") return "linux";
        return platformFromUserAgent(snapshot);
      }
      default:
        // "Chrome OS", "Chromium OS", "Unknown" and the like: let the user agent have its say.
        return platformFromUserAgent(snapshot);
    }
  } catch {
    return "unknown";
  }
}
