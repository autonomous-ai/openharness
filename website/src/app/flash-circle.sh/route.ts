/**
 * GET /flash-circle.sh — serves the operations USB flasher for the CIRCLE board, so the one-liner is
 *
 *   curl -fsSL https://harness.autonomous.ai/flash-circle.sh -o flash-circle.sh
 *   bash flash-circle.sh
 *
 * Same shape as the sibling `/cli/install.sh` route, and for the same reason: the script next to this file
 * is the single source of truth, it ships with a WEB deploy, and there is no separate publish step to
 * forget. (The firmware it downloads is still published to GCS by `make upload-circle` — that is the
 * payload, not the tool.)
 *
 * Deliberately NOT a redirect to the bucket: the URL people paste into a runbook should keep working
 * when storage moves, and one hop means one thing to debug when an operator says "it didn't download".
 *
 * The .sh is read from disk rather than inlined so it stays a real, lintable shell script
 * (`bash -n flash-circle.sh`). It isn't reachable through an import, so `next.config.js` lists it under
 * `outputFileTracingIncludes` to force it into the standalone build — without that this route works in
 * dev and 500s in production.
 */

import { readFileSync } from "fs";
import { join } from "path";

// Read once per process at module load; the script only changes on redeploy.
const SCRIPT = readFileSync(join(process.cwd(), "src/app/flash-circle.sh/flash-circle.sh"), "utf8");

// Always run the handler (never prerender/cache it into a static asset at build time) so the response
// headers below are exactly what the operator's curl receives.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(SCRIPT, {
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      // A flasher writes firmware to hardware: an operator must never be handed a stale copy from a
      // CDN or a corporate proxy after a fix has shipped.
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
