/**
 * Shared resolver behind every `/desktop/download*` redirect route: fetch the live desktop release
 * manifest, pull one platform's key out of it, and 302 straight to that asset — never a static link,
 * since the artifact path carries the version (`harness/desktop/<version>/...`). Reading the manifest
 * is what lets a release be cut with one `make upload-desktop`/`make upload-desktop-linux` and have
 * these links serve the new build immediately, with no web deploy and no version written down
 * anywhere in this repo.
 */

const METADATA_URL =
  process.env.HARNESS_DESKTOP_METADATA_URL ??
  "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/metadata.json";

/**
 * Only ever redirect into the release bucket — reached either directly (GCS origin) or via the
 * CDN that fronts it 1:1 at the same path (`cdn.autonomous.ai/harness/desktop/...`). Both are listed,
 * not swapped: `upload-desktop.sh`/`upload-desktop-linux.sh` now write CDN URLs into new releases, but
 * the manifest can still carry an older GCS-origin URL from a release cut before that change, and this
 * must accept both rather than pick a moment to flip.
 *
 * The manifest is fetched over the network, so its contents are input, not fact — and each route's
 * whole job is to send a browser wherever that input says. Without this check, anyone able to serve a
 * modified manifest could point a `harness.autonomous.ai` download link at an arbitrary binary. The
 * installer script (`website/scripts/desktop-install.sh`) applies the same rule to the same field;
 * this is that rule, in the other surface — keep the two lists in sync.
 */
const ALLOWED_ASSET_PREFIXES = [
  "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/",
  "https://cdn.autonomous.ai/harness/desktop/",
];

function unavailable(reason: string): Response {
  // 503, not 404: the page and the route exist, the release manifest is what could not be resolved.
  // Saying which one keeps a broken publish from looking like a broken link.
  return new Response(`Desktop download is temporarily unavailable (${reason}).\n`, {
    status: 503,
    headers: { "Cache-Control": "no-store, max-age=0", "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * Fetch the manifest, pull `manifestKey`'s asset, and redirect to it — or a 503 if anything about
 * that is unusable (unreachable manifest, missing key, or a URL that fails the bucket/extension check).
 */
export async function resolveDesktopDownload(manifestKey: string, expectedExt: string): Promise<Response> {
  let manifest: unknown;
  try {
    const res = await fetch(METADATA_URL, { cache: "no-store" });
    if (!res.ok) return unavailable(`manifest HTTP ${res.status}`);
    manifest = await res.json();
  } catch {
    return unavailable("manifest unreachable");
  }

  const entry = (manifest as Record<string, unknown> | null)?.[manifestKey];
  const url = (entry as Record<string, unknown> | undefined)?.url;
  if (typeof url !== "string" || !ALLOWED_ASSET_PREFIXES.some((prefix) => url.startsWith(prefix)) || !url.endsWith(expectedExt)) {
    return unavailable(`no usable ${manifestKey} entry`);
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      // Never cache the hop itself — a cached redirect would keep serving the previous release long
      // after a new one was published, which is exactly what this route exists to avoid.
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
