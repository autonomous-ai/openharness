// First load of a release build of the web app, as a new visitor sees it.
//
//   node tool/web_ux/load-time.mjs <release-build-dir> [screenshot-dir]
//
// <release-build-dir> is `flutter build web --release --no-wasm-dry-run
// --no-web-resources-cdn --base-href=/harness-web/` (scripts/build-web-release.sh
// without packaging). It is served at /harness-web/ with gzip, like a static
// host, with every request off the page blocked, so the app stops at the
// sign-in page. Each profile loads with an empty cache three times; the
// median is reported: time until the loading screen from web/index.html is
// visible (null when there is none), time until Flutter's view is in the page,
// time until the screen stops changing (the sign-in page drawn; a release build
// has no accessibility tree to wait on), and bytes transferred. Every run also
// lists the fonts it fetched, the requests that failed and the console errors
// from the page itself, and whether the loading screen was gone by the end.
// The last screen of each profile is saved beside the results so the end state
// can be checked.
import { chromium } from './playwright.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.bin': 'application/octet-stream',
};

// How long a page without a loading screen is waited on before it is reported as having none.
const SPLASH_LIMIT_MS = 5000;

const PROFILES = [
  { name: 'computer, cable', viewport: { width: 1440, height: 900 }, network: null, cpu: 1 },
  // Lighthouse's mobile preset: 1.6 Mbps down, 750 kbps up, 150 ms RTT, 4x CPU.
  {
    name: 'phone, slow 4G',
    viewport: { width: 390, height: 844 },
    network: { latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 },
    cpu: 4,
  },
  // A good phone connection: 9 Mbps down, 40 ms RTT, 2x CPU.
  {
    name: 'phone, fast 4G',
    viewport: { width: 390, height: 844 },
    network: { latency: 40, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 },
    cpu: 2,
  },
];

function serve(root) {
  const cache = new Map();
  const server = createServer(async (req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!path.startsWith('/harness-web/')) { res.writeHead(404); return res.end(); }
    path = path.slice('/harness-web/'.length) || 'index.html';
    const file = join(root, path);
    let body = cache.get(file);
    if (!body) {
      // Unknown paths get index.html, as /s/… links do on the host, but a missing
      // asset is a 404 so a manifest naming a deleted file shows in the request log.
      const fallback = extname(file) === '' || extname(file) === '.html';
      const raw = await readFile(file).catch(() =>
        fallback ? readFile(join(root, 'index.html')) : null);
      if (!raw) { res.writeHead(404); return res.end(); }
      body = gzipSync(raw, { level: 6 });
      cache.set(file, body);
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/html', 'content-encoding': 'gzip' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

/// When the page last changed, once it has held still for [quietMs]. A page
/// that keeps animating is cut off after [limitMs] and reported as such.
async function settled(page, start, quietMs = 2000, limitMs = 120000) {
  let last = null;
  let changedAt = Date.now();
  for (;;) {
    const shot = await page.screenshot({ type: 'jpeg', quality: 40 });
    const hash = createHash('sha1').update(shot).digest('hex');
    if (hash !== last) { last = hash; changedAt = Date.now(); }
    if (Date.now() - changedAt >= quietMs) return { at: changedAt - start, shot };
    if (Date.now() - start >= limitMs) return { at: null, shot };
    await page.waitForTimeout(100);
  }
}

async function once(browser, origin, profile) {
  const context = await browser.newContext({ viewport: profile.viewport, deviceScaleFactor: 1 });
  await context.route('**/*', (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (profile.network) {
    await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile.network });
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  let bytes = 0;
  const urls = new Map();
  const failed = [];
  const consoleErrors = [];
  cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; });
  cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
  cdp.on('Network.responseReceived', (e) => {
    if (e.response.status >= 400) failed.push(`${e.response.status} ${e.response.url}`);
  });
  cdp.on('Network.loadingFailed', (e) => {
    const url = urls.get(e.requestId);
    if (url?.startsWith(origin)) failed.push(`${e.errorText} ${url}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.location().url.startsWith(origin)) consoleErrors.push(msg.text());
  });
  const start = Date.now();
  const splash = page
    .waitForFunction(() => {
      const el = document.getElementById('harness-splash');
      return !!el && el.getBoundingClientRect().width > 0 && el.innerText.includes('Opening Harness…');
    }, null, { polling: 50, timeout: SPLASH_LIMIT_MS })
    .then(() => Date.now() - start, () => null);
  await page.goto(`${origin}/harness-web/`);
  await page.waitForSelector('flutter-view', { timeout: 180000 });
  const firstFrame = Date.now() - start;
  const { at: signIn, shot } = await settled(page, start);
  const splashRemoved = await page.evaluate(() => !document.getElementById('harness-splash'));
  const fonts = [...new Set([...urls.values()].filter((u) => /\.(ttf|otf)$/.test(u)).map((u) => u.split('/harness-web/')[1]))].sort();
  await context.close();
  return {
    splash: await splash, firstFrame, signIn, megabytes: +(bytes / 1e6).toFixed(2),
    fonts, failed, consoleErrors, splashRemoved, shot,
  };
}

const median = (xs) => xs.includes(null)
  ? null
  : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const [root, shotDir] = process.argv.slice(2);
const server = await serve(root);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const results = [];
for (const profile of PROFILES) {
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await once(browser, server.origin, profile));
  if (shotDir) writeFileSync(`${shotDir}/load-${profile.name.replace(/\W+/g, '-')}.jpg`, runs.at(-1).shot);
  for (const run of runs) delete run.shot;
  results.push({
    profile: profile.name,
    splashMs: median(runs.map((r) => r.splash)),
    firstFrameMs: median(runs.map((r) => r.firstFrame)),
    settledMs: median(runs.map((r) => r.signIn)),
    transferredMB: median(runs.map((r) => r.megabytes)),
    runs,
  });
}
console.log(JSON.stringify(results, null, 2));
await browser.close();
server.close();
