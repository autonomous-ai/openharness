"use client";

import { Fragment } from "react";
import { Download } from "lucide-react";
import styles from "./page.module.css";
import { DESKTOP_BUILD, DESKTOP_BUILDS, type DesktopBuild, type VisitorPlatform } from "@/lib/desktopPlatform";
import { useVisitorPlatform } from "@/lib/useVisitorPlatform";

type Offer = {
  /** The download buttons: this computer's build, both Linux builds when the CPU is unknown, or none. */
  primary: readonly DesktopBuild[];
  /** Links to the builds that are not buttons, so a wrong (or missing) guess is never a dead end. */
  others: readonly DesktopBuild[];
  /** Lead-in for `others`. */
  othersLabel: string;
  description: string;
  note?: string;
};

/** Every listed build except `primary`. */
function othersThan(primary: readonly DesktopBuild[]): readonly DesktopBuild[] {
  return DESKTOP_BUILDS.filter((build) => !primary.some((offered) => offered.id === build.id));
}

const MAC_DESCRIPTION = "Download the app for macOS, then drag Harness into your Applications folder.";
const MAC_TRUST = "Signed and notarized by Apple, so it opens without a security warning. Requires macOS 12 or later.";
const LINUX_DESCRIPTION = "Download the AppImage, make it executable (chmod +x), then open it.";
const LINUX_NOTE = "Built for Ubuntu 22.04 or later.";

const MAC_OFFER: Offer = {
  primary: [DESKTOP_BUILD.macos],
  others: othersThan([DESKTOP_BUILD.macos]),
  othersLabel: "Other downloads:",
  description: MAC_DESCRIPTION,
  note: `One download for Apple silicon and Intel Macs. ${MAC_TRUST}`,
};

function offerFor(platform: VisitorPlatform | null): Offer {
  switch (platform) {
    case "macos-arm64":
      return {
        primary: [DESKTOP_BUILD["macos-arm64"]],
        // The universal build is still the Intel one, whatever else it runs on.
        others: [{ ...DESKTOP_BUILD.macos, name: "macOS (Intel)" }, ...othersThan([DESKTOP_BUILD.macos])],
        othersLabel: "Other downloads:",
        description: MAC_DESCRIPTION,
        note: `Built for Apple silicon Macs. ${MAC_TRUST}`,
      };
    case "linux-x64":
    case "linux-arm64":
      return {
        primary: [DESKTOP_BUILD[platform]],
        others: othersThan([DESKTOP_BUILD[platform]]),
        othersLabel: "Other downloads:",
        description: LINUX_DESCRIPTION,
        note: LINUX_NOTE,
      };
    case "linux": {
      const primary = [DESKTOP_BUILD["linux-x64"], DESKTOP_BUILD["linux-arm64"]];
      return {
        primary,
        others: othersThan(primary),
        othersLabel: "Other downloads:",
        description: LINUX_DESCRIPTION,
        note: `Not sure which? Run uname -m in a terminal: x86_64 is x64, aarch64 is ARM64. ${LINUX_NOTE}`,
      };
    }
    case "windows":
      return {
        primary: [],
        others: DESKTOP_BUILDS,
        othersLabel: "Downloading for another computer?",
        description: "The Harness desktop app runs on macOS and Linux. There is no Windows version yet.",
      };
    case "mobile":
      return {
        primary: [],
        others: DESKTOP_BUILDS,
        othersLabel: "Downloading for another computer?",
        description:
          "The Harness desktop app runs on a Mac or a Linux computer. Open this page on that computer to download it.",
      };
    default:
      // Not answered yet, a Mac of unknown CPU, or nothing recognizable: exactly what the server rendered.
      return MAC_OFFER;
  }
}

/** The platform-specific half of `/desktop`: a button for the build that suits this computer, links to the rest. */
export function DesktopDownload() {
  const offer = offerFor(useVisitorPlatform());

  return (
    <>
      <p className={styles.description}>{offer.description}</p>
      {offer.primary.length > 0 && (
        <div className={styles.downloads}>
          {offer.primary.map((build) => (
            <a className={styles.download} href={build.href} key={build.id}>
              <Download size={18} aria-hidden="true" />
              {`Download for ${build.name}`}
            </a>
          ))}
        </div>
      )}
      {offer.note && <p className={styles.note}>{offer.note}</p>}
      <p className={styles.others}>
        {offer.othersLabel}{" "}
        {offer.others.map((build, index) => (
          <Fragment key={build.id}>
            {index > 0 && " · "}
            <a className={styles.link} href={build.href}>
              {build.name}
            </a>
          </Fragment>
        ))}
      </p>
    </>
  );
}
