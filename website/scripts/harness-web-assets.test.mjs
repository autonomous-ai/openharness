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
