/**
 * `GET /device/download-windows` — hand a Windows PC the current Harness installer for its CPU.
 * See `lib/deviceArch.ts` for how the CPU is read and `lib/desktopManifest.ts` for the shared
 * manifest-resolution/redirect logic.
 */

import { resolveManifestDownload } from "@/lib/desktopManifest";
import { deviceArch } from "@/lib/deviceArch";
import { DEVICE_ASSET_PREFIXES, DEVICE_MANIFEST_URL } from "@/lib/deviceRelease";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return resolveManifestDownload({
    manifestUrl: DEVICE_MANIFEST_URL,
    field: `device-windows-${deviceArch(request.headers, "windows")}`,
    allowedPrefixes: DEVICE_ASSET_PREFIXES,
    extension: ".exe",
    product: "Harness",
  });
}
