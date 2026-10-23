// First load of a release build of the web app, as a new visitor sees it.
//
//   node tool/web_ux/load-time.mjs <release-build-dir> [screenshot-dir]
//
// <release-build-dir> is `flutter build web --release --no-wasm-dry-run
// --no-web-resources-cdn --base-href=/harness-web/` (scripts/build-web-release.sh
// without packaging). It is served at /harness-web/ with gzip, like a static
// host, with every request off the page blocked, so the app stops at the
// sign-in page. Each profile loads with an empty cache three times; the
// median is reported: time until Flutter's view is in the page, time until
// the screen stops changing (the sign-in page drawn; a release build has no
// accessibility tree to wait on), and bytes transferred. The last screen of
// each profile is saved beside the results so the end state can be checked.
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
      const raw = await readFile(file).catch(() => readFile(join(root, 'index.html')));
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
  cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; });
  const start = Date.now();
  await page.goto(`${origin}/harness-web/`);
  await page.waitForSelector('flutter-view', { timeout: 180000 });
  const firstFrame = Date.now() - start;
  const { at: signIn, shot } = await settled(page, start);
  await context.close();
  return { firstFrame, signIn, megabytes: +(bytes / 1e6).toFixed(2), shot };
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
    firstFrameMs: median(runs.map((r) => r.firstFrame)),
    settledMs: median(runs.map((r) => r.signIn)),
    transferredMB: median(runs.map((r) => r.megabytes)),
    runs,
  });
}
console.log(JSON.stringify(results, null, 2));
await browser.close();
server.close();
