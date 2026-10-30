/**
 * GET /flash-circle.ps1 — the Windows twin of /flash-circle.sh (see its route for the why of every choice here):
 * the script beside this file is the single source of truth, served from disk, never cached. `harness flash` on
 * Windows fetches it (cli/src/lib/flash.ts); docs/superpowers/specs/2026-10-19-windows-dial-design.md §3.
 *
 * text/plain, not a PowerShell type: browsers show it, PowerShell's Invoke-WebRequest saves it, and nothing runs it
 * by its type.
 */

import { readFileSync } from "fs";
import { join } from "path";

const SCRIPT = readFileSync(join(process.cwd(), "src/app/flash-circle.ps1/flash-circle.ps1"), "utf8");

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(SCRIPT, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
