/**
 * The current Harness Device release, read from its live manifest: the version, its date, the notes a
 * person can read, and the downloadable builds. The `/device` guide renders from this, so a
 * `make release-device` shows up there with no web deploy, as it already does behind
 * `/device/download-macos`.
 */

import { isReleaseAsset } from "@/lib/desktopManifest";
import type { VisitorPlatform } from "@/lib/desktopPlatform";

// Fixed, with no environment override: nothing but this bucket may decide where the links point.
export const DEVICE_MANIFEST_URL = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json";

/**
 * The device release folders, by the CDN and by the bucket itself, for the reason given above
 * `DESKTOP_ASSET_PREFIXES` in `desktopManifest.ts`: the manifest is input, and a link is only ever
 * built from a URL inside these.
 */
export const DEVICE_ASSET_PREFIXES: readonly string[] = [
  "https://cdn.autonomous.ai/harness/device/",
  "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/",
];

/** Where a Mac downloads when the manifest cannot be read: the route resolves it on each click. */
export const DEVICE_FALLBACK_URL = "/device/download-macos";

export type DeviceOs = "macos" | "windows" | "linux";
export type DeviceArch = "arm64" | "x64";
export type DevicePackage = "dmg" | "msi" | "exe" | "deb" | "rpm" | "appimage";

export type DeviceBuild = {
  os: DeviceOs;
  /** `null`: one build for every CPU of its OS. */
  arch: DeviceArch | null;
  pkg: DevicePackage;
  url: string;
  label: string;
  detail: string;
};

export type DeviceRelease = { version: string; date: string; notes: string[]; builds: DeviceBuild[] };

export const OS_NAME: Record<DeviceOs, string> = { macos: "Mac", windows: "Windows", linux: "Linux" };

const OS_ORDER: readonly DeviceOs[] = ["macos", "windows", "linux"];
const ARCH_ORDER: readonly (DeviceArch | null)[] = [null, "arm64", "x64"];
const PACKAGE_ORDER: readonly DevicePackage[] = ["dmg", "msi", "exe", "deb", "rpm", "appimage"];

const PACKAGE_EXTENSION: Record<DevicePackage, string> = {
  dmg: ".dmg",
  msi: ".msi",
  exe: ".exe",
  deb: ".deb",
  rpm: ".rpm",
  appimage: ".AppImage",
};

const PACKAGE_NAME: Record<DevicePackage, string> = { ...PACKAGE_EXTENSION, appimage: "AppImage" };

// Only installer keys: `platforms` and the bare `device-macos*` keys are the updater's `.app.tar.gz`.
const BUILD_KEY = /^device-(macos|windows|linux)(?:-(arm64|aarch64|x64|x86_64))?-(dmg|msi|exe|deb|rpm|appimage)$/;

const MAX_BUILDS = 12;
const MAX_NOTES = 6;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function label(os: DeviceOs, arch: DeviceArch | null): string {
  if (os === "macos") {
    if (arch === null) return "Mac · Apple silicon and Intel";
    return arch === "arm64" ? "Mac · Apple silicon" : "Mac · Intel";
  }
  if (arch === null) return OS_NAME[os];
  return `${OS_NAME[os]} · ${arch === "arm64" ? "ARM64" : "x64"}`;
}

function detail(pkg: DevicePackage, size: unknown): string {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return PACKAGE_NAME[pkg];
  return `${PACKAGE_NAME[pkg]} · ${(size / 1048576).toFixed(1)} MB`;
}

function readBuilds(manifest: Record<string, unknown>): DeviceBuild[] {
  // Keyed by URL: the manifest names one universal file under several keys (`device-macos-dmg` and
  // `device-macos-arm64-dmg` today), and a person should see it once.
  const byUrl = new Map<string, { os: DeviceOs; arch: DeviceArch | null; pkg: DevicePackage; url: string; size: unknown }>();
  for (const [key, value] of Object.entries(manifest)) {
    const match = BUILD_KEY.exec(key);
    const url = asRecord(value)?.url;
    if (!match || typeof url !== "string") continue;
    const os = match[1] as DeviceOs;
    const arch: DeviceArch | null = match[2] === undefined ? null : match[2].startsWith("a") ? "arm64" : "x64";
    const pkg = match[3] as DevicePackage;
    if (!isReleaseAsset(url, DEVICE_ASSET_PREFIXES, PACKAGE_EXTENSION[pkg])) continue;
    const seen = byUrl.get(url);
    if (seen) {
      if (arch === null) seen.arch = null;
      continue;
    }
    byUrl.set(url, { os, arch, pkg, url, size: asRecord(value)?.size });
  }
  return [...byUrl.values()]
    .sort(
      (a, b) =>
        OS_ORDER.indexOf(a.os) - OS_ORDER.indexOf(b.os) ||
        ARCH_ORDER.indexOf(a.arch) - ARCH_ORDER.indexOf(b.arch) ||
        PACKAGE_ORDER.indexOf(a.pkg) - PACKAGE_ORDER.indexOf(b.pkg),
    )
    .slice(0, MAX_BUILDS)
    .map(({ os, arch, pkg, url, size }) => ({ os, arch, pkg, url, label: label(os, arch), detail: detail(pkg, size) }));
}

function readDate(pubDate: unknown): string {
  if (typeof pubDate !== "string") return "";
  const date = new Date(pubDate);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** The bullet lines of the release notes, without their pull request numbers, which mean nothing to a person. */
function readNotes(notes: unknown): string[] {
  if (typeof notes !== "string") return [];
  return notes
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).replace(/\s*\(#\d+\)$/, "").trim())
    .filter((line) => line !== "")
    .slice(0, MAX_NOTES);
}

/** The release in `manifest`, or null when it has no version or no build a person can download. */
export function parseDeviceRelease(manifest: unknown): DeviceRelease | null {
  const record = asRecord(manifest);
  if (!record || typeof record.version !== "string" || record.version === "") return null;
  const builds = readBuilds(record);
  if (builds.length === 0) return null;
  return { version: record.version, date: readDate(record.pub_date), notes: readNotes(record.notes), builds };
}

/**
 * The one build to offer this visitor, or null when none fits or the CPU decides and is unknown. A Mac
 * of unknown CPU gets the build every Mac runs (the rule in `desktopPlatform.ts`); Windows never says its
 * CPU, so it gets the x64 build; Linux of unknown CPU gets no guess.
 */
export function pickBuild(builds: readonly DeviceBuild[], platform: VisitorPlatform | null): DeviceBuild | null {
  const find = (os: DeviceOs, arch: DeviceArch | null) => builds.find((b) => b.os === os && b.arch === arch) ?? null;
  switch (platform) {
    case "macos-arm64":
      return find("macos", "arm64") ?? find("macos", null);
    case "macos":
    case "unknown":
    case null:
      return find("macos", null) ?? find("macos", "x64") ?? builds.find((b) => b.os === "macos") ?? null;
    case "windows":
      return find("windows", null) ?? find("windows", "x64");
    case "linux-x64":
      return find("linux", "x64") ?? find("linux", null);
    case "linux-arm64":
      return find("linux", "arm64") ?? find("linux", null);
    case "linux":
      return find("linux", null);
    case "mobile":
      return null;
  }
}

function unusable(reason: string): null {
  // The reason only: the manifest's content is not ours to log.
  console.warn(`device manifest: ${reason}`);
  return null;
}

/** The live release, or null (with one log line) when the manifest cannot be used. */
export async function fetchDeviceRelease(): Promise<DeviceRelease | null> {
  let res: Response;
  try {
    // Bounded, so a bucket that never answers cannot hold the page's render open.
    res = await fetch(DEVICE_MANIFEST_URL, { next: { revalidate: 60 }, signal: AbortSignal.timeout(10_000) });
  } catch {
    return unusable("unreachable");
  }
  if (!res.ok) return unusable(`HTTP ${res.status}`);
  let manifest: unknown;
  try {
    manifest = await res.json();
  } catch {
    return unusable("unreadable");
  }
  return parseDeviceRelease(manifest) ?? unusable("no usable release");
}
