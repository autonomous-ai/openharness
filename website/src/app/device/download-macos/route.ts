/**
 * `GET /device/download-macos` — hand a Mac the current Harness Device `.dmg` (one universal build).
 * See `lib/desktopManifest.ts` for the shared manifest-resolution/redirect logic.
 */

import { resolveManifestDownload } from "@/lib/desktopManifest";

export const dynamic = "force-dynamic";

// Fixed, with no environment override: nothing but this bucket may decide where the link points.
const MANIFEST_URL = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json";

const ALLOWED_PREFIXES = [
  "https://cdn.autonomous.ai/harness/device/",
  "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/",
];

export async function GET(): Promise<Response> {
  return resolveManifestDownload({
    manifestUrl: MANIFEST_URL,
    field: "dmg",
    allowedPrefixes: ALLOWED_PREFIXES,
    extension: ".dmg",
    product: "Harness Device",
  });
}
