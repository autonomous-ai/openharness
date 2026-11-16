/**
 * Shared resolver behind every `/desktop/download*` and `/device/download*` redirect route: fetch a live
 * release manifest, pull one key out of it, and 302 straight to that asset — never a static link,
 * since the artifact path carries the version (`harness/<product>/<version>/...`). Reading the manifest
 * is what lets a release be cut with one `make release-desktop` (Desktop's manifest) or
 * `make release-device` (Harness Device's) and have these links serve the new build immediately, with
 * no web deploy and no version written down anywhere in this repo.
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
const DESKTOP_ASSET_PREFIXES = [
  "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/",
  "https://cdn.autonomous.ai/harness/desktop/",
];

export type ManifestDownload = {
  manifestUrl: string;
  /** The manifest key whose `url` is the asset. */
  field: string;
  /**
   * The release folders the redirect may point into, for the reason given above `DESKTOP_ASSET_PREFIXES`:
   * each is followed by an X.Y.Z version folder and one file name, nothing else.
   */
  allowedPrefixes: readonly string[];
  extension: string;
  /** Names the product in the 503 text. */
  product: string;
};

function unavailable(product: string, reason: string): Response {
  // 503, not 404: the page and the route exist, the release manifest is what could not be resolved.
  // Saying which one keeps a broken publish from looking like a broken link.
  return new Response(`${product} download is temporarily unavailable (${reason}).\n`, {
    status: 503,
    headers: { "Cache-Control": "no-store, max-age=0", "Content-Type": "text/plain; charset=utf-8" },
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The whole URL, not its ends: the browser normalises the Location it follows, so a dot segment in any
 * spelling (`..`, `%2e%2e`, `..\`), a query or a fragment would leave the folder while the raw string
 * still starts with a prefix and ends with the extension. Only `<prefix><X.Y.Z>/<file name>` passes, the
 * file name one segment of [A-Za-z0-9._-] that does not start with a dot.
 */
function isReleaseAsset(url: string, allowedPrefixes: readonly string[], extension: string): boolean {
  const prefixes = allowedPrefixes.map(escapeRegExp).join("|");
  return new RegExp(`^(?:${prefixes})[0-9]+\\.[0-9]+\\.[0-9]+/[A-Za-z0-9_-][A-Za-z0-9._-]*${escapeRegExp(extension)}$`).test(url);
}

/**
 * Fetch the manifest, pull `field`'s asset, and redirect to it — or a 503 if anything about that is
 * unusable (unreachable or unreadable manifest, missing field, or a URL outside the release folders).
 */
export async function resolveManifestDownload(download: ManifestDownload): Promise<Response> {
  const { manifestUrl, field, allowedPrefixes, extension, product } = download;
  let res: Response;
  try {
    // Bounded, so a bucket that never answers cannot hold the visitor's request open.
    res = await fetch(manifestUrl, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch {
    return unavailable(product, "manifest unreachable");
  }
  if (!res.ok) return unavailable(product, `manifest HTTP ${res.status}`);
  let manifest: unknown;
  try {
    manifest = await res.json();
  } catch {
    return unavailable(product, "manifest unreadable");
  }

  const entry = (manifest as Record<string, unknown> | null)?.[field];
  const url = (entry as Record<string, unknown> | undefined)?.url;
  if (typeof url !== "string" || !isReleaseAsset(url, allowedPrefixes, extension)) {
    return unavailable(product, `no usable ${field} entry`);
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

/** One Desktop asset: `manifestKey`'s entry in the desktop manifest, which must end in `expectedExt`. */
export async function resolveDesktopDownload(manifestKey: string, expectedExt: string): Promise<Response> {
  return resolveManifestDownload({
    manifestUrl: METADATA_URL,
    field: manifestKey,
    allowedPrefixes: DESKTOP_ASSET_PREFIXES,
    extension: expectedExt,
    product: "Desktop",
  });
}
