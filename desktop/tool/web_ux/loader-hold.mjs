// The loader waits for main.dart.js (web/flutter_bootstrap.js), so it must hear that the preload
// in web/index.html is done even when that finished first. Here the page's HTML stops for 0.5 s
// after </head>, as a slow network can deliver it, while main.dart.js is already in the browser's
// cache. The app must still draw on every visit; exits 1 on a visit that never draws.
// Each visit forgets the mark that lets a browser skip the wait, so every one of them waits.
//
//   node tool/web_ux/loader-hold.mjs <release-build> [visits]
//
// <release-build> is build/web-release from scripts/build-web-release.sh. Run from desktop/ with
// PLAYWRIGHT_DIR set (see playwright.mjs).
import { chromium } from './playwright.mjs';
import { createServer, request } from 'node:http';
import { brotliDecompressSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRelease } from './serve-release.mjs';
const [root, visitsArg = '4'] = process.argv.slice(2);
const upstream = await serveRelease(root);
const up = new URL(upstream.origin);
const proxy = createServer((req, res) => {
  const out = request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
    const isPage = (r.headers['content-type'] ?? '').startsWith('text/html');
    if (!isPage) { res.writeHead(r.statusCode, r.headers); r.pipe(res); return; }
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => {
      const html = brotliDecompressSync(Buffer.concat(chunks)).toString();
      const cut = html.indexOf('</head>');
      const headers = { ...r.headers }; delete headers['content-encoding']; delete headers['content-length'];
      res.writeHead(r.statusCode, headers);
      res.write(html.slice(0, cut));
      setTimeout(() => res.end(html.slice(cut)), 500);
    });
  });
  req.pipe(out);
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${proxy.address().port}`;
const dir = mkdtempSync(join(tmpdir(), 'split-'));
const context = await chromium.launchPersistentContext(dir, { executablePath: process.env.CHROME_PATH, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
await context.addInitScript(() => {
  addEventListener('flutter-first-frame', () => { window.__ff = 1; }, { once: true });
  // Forget that this browser loaded the script before, so the loader waits for it every visit.
  try { localStorage.removeItem('harness.web.v1.main_script_loaded'); } catch (e) { /* about:blank */ }
});
let stuck = 0;
for (let i = 0; i < Number(visitsArg); i++) {
  const page = await context.newPage();
  await page.goto(`${origin}/harness-web/`, { waitUntil: 'commit' });
  const ok = await page.waitForFunction(() => window.__ff, null, { timeout: i === 0 ? 300000 : 20000 }).then(() => true, () => false);
  if (!ok) stuck++;
  console.log(`visit ${i + 1}: ${ok ? 'drawn' : 'STUCK, no first frame in 20 s'}`);
  await page.close();
}
await context.close(); rmSync(dir, { recursive: true, force: true }); proxy.close(); upstream.close();
process.exit(stuck ? 1 : 0);
