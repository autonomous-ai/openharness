/**
 * `GET /desktop/download/macos-arm64` — hand an Apple silicon visitor the current signed `.dmg` of the
 * Apple silicon build (Impeller), the `desktop-macos-arm64-dmg` key. `/desktop` links here only when
 * the browser reports an ARM Mac; every other Mac gets `/desktop/download-macos`, the Intel (Skia)
 * build, which is universal too. See desktop/RELEASE.md "Two macOS builds" for why there are two, and
 * `lib/desktopManifest.ts` for the shared manifest-resolution/redirect logic.
 */

import { resolveDesktopDownload } from "@/lib/desktopManifest";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return resolveDesktopDownload("desktop-macos-arm64-dmg", ".dmg");
}
