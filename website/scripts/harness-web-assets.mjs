export function releaseAssetBase(release) {
  return `/harness-web/releases/${release.version}-${release.sha256.slice(0, 12)}/`;
}

// Keep the public URL and base href stable, but never reuse a runtime asset URL
// between archives. Edge/browser cache lifetimes can override origin headers.
export function configureReleaseAssets(html, release) {
  const startup = /_flutter\.loader\.load\(\{[\s\S]*?\}\);\s*(?=<\/script>)/g;
  if ([...html.matchAll(startup)].length !== 1) {
    throw new Error('Unexpected Flutter bootstrap; refusing to publish unversioned assets');
  }
  const assetBase = releaseAssetBase(release);
  const config = {
    entrypointBaseUrl: assetBase,
    assetBase,
    canvasKitBaseUrl: `${assetBase}canvaskit/`,
  };
  // The host serves online workspaces. Do not start the deprecated generated
  // service worker, which can independently retain an older application.
  return html.replace(startup, `_flutter.loader.load(${JSON.stringify({ config })});\n`);
}
