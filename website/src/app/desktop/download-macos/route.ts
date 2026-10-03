/**
 * `GET /desktop/download-macos` — hand a macOS visitor the current signed `.dmg`.
 *
 * The dmg is deliberately NOT the artifact the in-app updater consumes: `DesktopUpdater` reads the
 * `desktop-macos` zip, unpacks it with `ditto`, and replaces the running bundle in place. This route
 * reads a separate `desktop-macos-dmg` key, so the first-install and self-update paths cannot break
 * each other. See `lib/desktopManifest.ts` for the shared manifest-resolution/redirect logic, also
 * used by the Linux download routes alongside this one.
 */

import { resolveDesktopDownload } from "@/lib/desktopManifest";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return resolveDesktopDownload("desktop-macos-dmg", ".dmg");
}
