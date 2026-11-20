"use client";

import type { VisitorPlatform } from "@/lib/desktopPlatform";
import { DEVICE_FALLBACK_URL, OS_NAME, pickBuild, type DeviceBuild, type DeviceOs } from "@/lib/deviceRelease";
import { DEVICE_INSTALL_COMMAND } from "@/lib/installCommand";
import { useVisitorPlatform } from "@/lib/useVisitorPlatform";
import styles from "./page.module.css";

/** The computer's OS, or null where it is not a computer we can name. */
function visitorOs(platform: VisitorPlatform | null): DeviceOs | null {
  if (platform === "macos" || platform === "macos-arm64") return "macos";
  if (platform === "windows") return "windows";
  if (platform === "linux" || platform === "linux-x64" || platform === "linux-arm64") return "linux";
  return null;
}

function DownloadButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <>
      <a className={styles.btn} href={href}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
        </svg>
        Download
      </a>
      <span className={styles.meta}>{children}</span>
    </>
  );
}

function Offer({ build, version }: { build: DeviceBuild; version: string | null }) {
  return (
    <DownloadButton href={build.url}>
      For <b>{build.label}</b> · version {version}
      {build.os === "macos" && " · macOS 13 or later"}
    </DownloadButton>
  );
}

function InstallLine() {
  return (
    <span className={styles.meta}>
      Or in a terminal: <code className={styles.kbd}>{DEVICE_INSTALL_COMMAND}</code>
    </span>
  );
}

function Others({ builds }: { builds: readonly DeviceBuild[] }) {
  return (
    <span className={styles.others}>
      {builds.map((build) => (
        <a key={build.url} href={build.url}>
          {build.label}
        </a>
      ))}
    </span>
  );
}

/** The hero's download: this computer's build as the button, every other build as a link. */
export function DeviceDownload({ builds, version }: { builds: readonly DeviceBuild[]; version: string | null }) {
  const platform = useVisitorPlatform();

  if (builds.length === 0) {
    // The manifest is unusable: the route still hands a Mac the current dmg, and no version is claimed.
    return (
      <div className={styles.dl}>
        <DownloadButton href={DEVICE_FALLBACK_URL}>For Mac · macOS 13 or later</DownloadButton>
      </div>
    );
  }

  if (platform === "mobile") {
    return (
      <div className={styles.dl}>
        <p className={styles.none}>Open this page on your computer to download the app.</p>
        <Others builds={builds} />
      </div>
    );
  }

  const os = visitorOs(platform);
  // The script installs the AppImage, so the line shows only once the live release has one.
  const installLine = os === "linux" && builds.some((build) => build.os === "linux" && build.pkg === "appimage");

  const pick = pickBuild(builds, platform);
  if (pick) {
    return (
      <div className={styles.dl}>
        <Offer build={pick} version={version} />
        {installLine && <InstallLine />}
        <Others builds={builds.filter((build) => build !== pick)} />
      </div>
    );
  }

  if (os === null || builds.some((build) => build.os === os)) {
    // This OS has builds, but which one runs here depends on a CPU the browser did not give: no guess.
    return (
      <div className={styles.dl}>
        {installLine && <InstallLine />}
        <Others builds={builds} />
      </div>
    );
  }

  // No build for this OS (owner, 2026-11-20): say so, and offer the Mac build, never a button for a build that does not exist.
  const mac = pickBuild(builds, "macos");
  return (
    <div className={styles.dl}>
      <p className={styles.none}>
        {builds.every((build) => build.os === "macos") ? "Harness Device is macOS-only for now." : `Harness Device isn't on ${OS_NAME[os]} yet.`}
      </p>
      {mac && <Offer build={mac} version={version} />}
      <Others builds={builds.filter((build) => build !== mac)} />
    </div>
  );
}
