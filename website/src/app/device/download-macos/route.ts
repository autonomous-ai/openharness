/**
 * `GET /device/download-macos` — hand a Mac the current Harness `.dmg` (one universal build).
 * See `lib/desktopManifest.ts` for the shared manifest-resolution/redirect logic.
 */

import { resolveManifestDownload } from "@/lib/desktopManifest";
import { DEVICE_ASSET_PREFIXES, DEVICE_MANIFEST_URL } from "@/lib/deviceRelease";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return resolveManifestDownload({
    manifestUrl: DEVICE_MANIFEST_URL,
    field: "device-macos-dmg",
    allowedPrefixes: DEVICE_ASSET_PREFIXES,
    extension: ".dmg",
    product: "Harness",
  });
}
