/**
 * `GET /desktop/download/linux-x64` — hand a Linux x64 visitor the current signed `.AppImage`.
 * See `lib/desktopManifest.ts` for the shared manifest-resolution/redirect logic.
 */

import { resolveDesktopDownload } from "@/lib/desktopManifest";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return resolveDesktopDownload("desktop-linux-x64", ".AppImage");
}
