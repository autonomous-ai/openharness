"use client";

import { DEVICE_FALLBACK_URL, pickBuild, type DeviceBuild } from "@/lib/deviceRelease";
import { useVisitorPlatform } from "@/lib/useVisitorPlatform";
import styles from "./page.module.css";

/** Every build of the release, the one for this computer marked. */
export function DeviceFiles({ builds }: { builds: readonly DeviceBuild[] }) {
  const pick = pickBuild(builds, useVisitorPlatform());

  if (builds.length === 0) {
    return (
      <ul className={styles.files}>
        <li>
          <a className={styles.k} href={DEVICE_FALLBACK_URL}>
            Mac · Apple silicon and Intel
          </a>
          <span className={styles.s}>.dmg</span>
        </li>
      </ul>
    );
  }

  return (
    <ul className={styles.files}>
      {builds.map((build) => (
        <li key={build.url}>
          {/* One box, so the mark sits beside the name and the detail stays at the row's end. */}
          <span>
            <a className={styles.k} href={build.url}>
              {build.label}
            </a>
            {build === pick && <span className={styles.here}>This computer</span>}
          </span>
          <span className={styles.s}>{build.detail}</span>
        </li>
      ))}
    </ul>
  );
}
