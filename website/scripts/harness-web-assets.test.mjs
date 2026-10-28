import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { configureReleaseAssets } from './harness-web-assets.mjs';

const html = `<html><base href="/harness-web/"><script>
_flutter.buildConfig = { builds: [{ mainJsPath: 'main.dart.js' }] };
_flutter.loader.load({
  serviceWorkerSettings: { serviceWorkerVersion: "123" /* generated */ }
});
</script></html>`;
const release = { version: '0.1.4', sha256: 'a'.repeat(64) };

function startup(release) {
  const output = configureReleaseAssets(html, release);
  let options;
  runInNewContext(output.match(/<script>([\s\S]*?)<\/script>/)[1], {
    _flutter: { loader: { load(value) { options = value; } } },
  });
  return { output, options };
}

describe('release asset caching', () => {
  it('loads every runtime resource from the archive namespace without a service worker', () => {
    const { output, options } = startup(release);
    const root = 'https://harness.example/harness-web/releases/0.1.4-aaaaaaaaaaaa/';
    expect(output).toContain('<base href="/harness-web/">');
    expect(new URL('main.dart.js', new URL(options.config.entrypointBaseUrl, root)).href).toBe(`${root}main.dart.js`);
    expect(new URL('assets/FontManifest.json', new URL(options.config.assetBase, root)).href).toBe(`${root}assets/FontManifest.json`);
    expect(new URL('chromium/canvaskit.wasm', new URL(options.config.canvasKitBaseUrl, root)).href).toBe(`${root}canvaskit/chromium/canvaskit.wasm`);
    expect(options.serviceWorkerSettings).toBeUndefined();
  });

  it('preloads the fonts from the archive namespace Flutter fetches them from', () => {
    const preloads = '<link rel="preload" href="assets/FontManifest.json" as="fetch" crossorigin>\n'
      + '<link rel="preload" href="assets/fonts/MaterialIcons-Regular.otf" as="fetch" crossorigin>\n';
    const output = configureReleaseAssets(html.replace('<html>', `<html><head>${preloads}</head>`), release);
    const root = 'https://harness.example/harness-web/';
    const hrefs = [...output.matchAll(/<link rel="preload" href="([^"]+)"/g)].map((m) => new URL(m[1], root).href);
    expect(hrefs).toEqual([
      `${root}releases/0.1.4-aaaaaaaaaaaa/assets/FontManifest.json`,
      `${root}releases/0.1.4-aaaaaaaaaaaa/assets/fonts/MaterialIcons-Regular.otf`,
    ]);
  });

  it('preloads main.dart.js from the archive namespace, keeping the marks the loader reads', () => {
    // desktop/web/index.html and flutter_bootstrap.js: the loader waits for this preload, and the
    // preload marks itself done in case it finishes before the loader listens.
    const preload = '<link rel="preload" href="main.dart.js" as="script" fetchpriority="high" id="harness-main-preload"\n'
      + '      onload="this.dataset.done = \'loaded\'" onerror="this.dataset.done = \'failed\'">';
    const hold = 'var load = _flutter.loader.load.bind(_flutter.loader);\n'
      + '_flutter.loader.load = function (options) { return load(options); };\n';
    const page = html.replace('<html>', `<html><head>${preload}</head>`).replace('<script>\n', `<script>\n${hold}`);
    const output = configureReleaseAssets(page, release);
    const root = 'https://harness.example/harness-web/';
    const href = output.match(/<link rel="preload" href="([^"]+)" as="script"/)[1];
    expect(new URL(href, root).href).toBe(`${root}releases/0.1.4-aaaaaaaaaaaa/main.dart.js`);
    expect(output).toContain(preload.replace('href="main.dart.js"', `href="${href}"`));
    expect(output).toContain(hold);
    expect(output).toContain(`_flutter.loader.load(${JSON.stringify({ config: startup(release).options.config })});`);
  });

  it('changes all browser cache keys when the version or archive changes', () => {
    const before = startup(release).options.config;
    for (const next of [{ ...release, version: '0.1.5' }, { ...release, sha256: 'b'.repeat(64) }]) {
      const after = startup(next).options.config;
      for (const key of Object.keys(before)) expect(after[key]).not.toBe(before[key]);
    }
  });

  it('fails the build if the generated startup is absent or ambiguous', () => {
    expect(() => configureReleaseAssets('<html></html>', release)).toThrow('Unexpected Flutter bootstrap');
    expect(() => configureReleaseAssets(html + html, release)).toThrow('Unexpected Flutter bootstrap');
  });
});
