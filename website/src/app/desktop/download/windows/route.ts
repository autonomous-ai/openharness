/**
 * `GET /desktop/download/windows` — hand a Windows visitor the current `harness-install.exe`, the
 * `desktop-windows-installer` key (docs/superpowers/specs/2026-10-19-windows-installer-design.md §3). One x64
 * program for every Windows PC: it reads the same manifest when it runs and installs the app for the PC's own CPU.
 * See `lib/desktopManifest.ts` for the shared manifest-resolution/redirect logic.
 */

import { resolveDesktopDownload } from "@/lib/desktopManifest";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return resolveDesktopDownload("desktop-windows-installer", ".exe");
}
