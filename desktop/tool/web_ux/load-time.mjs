// First load of a release build of the web app, as a new visitor and a
// returning one see it.
//
//   node tool/web_ux/load-time.mjs <release-build-dir> [out-dir] [runs]
//
// <release-build-dir> is build/web-release from scripts/build-web-release.sh,
// served as the website serves a release (serve-release.mjs). Every request
// off the page fails, so the app stops at the sign-in page.
//
// Each profile loads [runs] times (3) with an empty cache (cold), and [runs]
// times comes back to it in a browser profile kept on disk, as a person's is:
// once after a first visit (second), and once more (returning). Chrome keeps
// the compiled script only from the second visit on, and never in a private
// window, which Playwright's own contexts are. The median of each is
// reported: time until the loading screen from web/index.html is visible
// (null when there is none), until Flutter's first frame, until the screen
// stops changing (the sign-in page drawn), and the bytes transferred. Every run
// also lists the files it fetched, any fetched twice, the revalidations, the
// requests that failed and the page's console errors, and whether the loading
// screen was gone by the end. The last screen of each profile is saved in
// [out-dir], beside results.json.
import { chromium } from './playwright.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { serveRelease } from './serve-release.mjs';

// How long a page without a loading screen is waited on before it is reported as having none.
const SPLASH_LIMIT_MS = 5000;

// A phone as #180 and #1710 measured it: 390x844 at 3x, touch, an iPhone's
// user agent, 4x CPU, and Chrome DevTools' own network presets
// (front_end/core/sdk/NetworkManager.ts: latency and throughput scaled as there).
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};
const PROFILES = [
  { name: 'computer, cable', context: { viewport: { width: 1440, height: 900 } }, network: null, cpu: 1 },
  {
    name: 'phone, fast 4G',
    context: PHONE,
    network: { latency: 60 * 2.75, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 },
    cpu: 4,
  },
  {
    name: 'phone, slow 4G',
    context: PHONE,
    network: { latency: 150 * 3.75, downloadThroughput: (1.6e6 / 8) * 0.9, uploadThroughput: (750e3 / 8) * 0.9 },
    cpu: 4,
  },
];

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

async function once(context, origin, profile) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  if (profile.network) {
    await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile.network });
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  const requests = new Map();
  const failed = [];
  const consoleErrors = [];
  cdp.on('Network.requestWillBeSent', (e) => requests.set(e.requestId, { url: e.request.url, bytes: 0 }));
  cdp.on('Network.responseReceived', (e) => {
    const request = requests.get(e.requestId);
    if (request) {
      request.status = e.response.status;
      request.fromCache = e.response.fromDiskCache || e.response.fromServiceWorker || false;
    }
    if (e.response.status >= 400) failed.push(`${e.response.status} ${e.response.url}`);
  });
  cdp.on('Network.requestServedFromCache', (e) => {
    const request = requests.get(e.requestId);
    if (request) request.fromCache = true;
  });
  cdp.on('Network.loadingFinished', (e) => {
    const request = requests.get(e.requestId);
    if (request) request.bytes = e.encodedDataLength;
  });
  cdp.on('Network.loadingFailed', (e) => {
    const url = requests.get(e.requestId)?.url;
    if (url?.startsWith(origin)) failed.push(`${e.errorText} ${url}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.location().url.startsWith(origin)) consoleErrors.push(msg.text());
  });
  await page.addInitScript(() => {
    addEventListener('flutter-first-frame', () => { window.__firstFrame = performance.now(); }, { once: true });
  });
  const start = Date.now();
  const splash = page
    .waitForFunction(() => {
      const el = document.getElementById('harness-splash');
      return !!el && el.getBoundingClientRect().width > 0 && el.innerText.includes('Opening Harness…');
    }, null, { polling: 50, timeout: SPLASH_LIMIT_MS })
    .then(() => Date.now() - start, () => null);
  // Not the load event: the page's preloads hold it back, and on slow 4G past any sane timeout.
  await page.goto(`${origin}/harness-web/`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__firstFrame !== undefined, null, { polling: 50, timeout: 180000 });
  const firstFrame = Math.round(await page.evaluate(() => window.__firstFrame));
  const { at: signIn, shot } = await settled(page, start);
  const splashRemoved = await page.evaluate(() => !document.getElementById('harness-splash'));
  await page.close();
  const fetched = [...requests.values()].filter((r) => r.url.startsWith(origin));
  const name = (url) => url.slice(origin.length).replace(/^\/harness-web\/(releases\/[^/]+\/)?/, '');
  const counts = new Map();
  for (const r of fetched) if (!r.fromCache && r.status === 200) counts.set(name(r.url), (counts.get(name(r.url)) ?? 0) + 1);
  return {
    splash: await splash,
    firstFrame,
    signIn,
    megabytes: +(fetched.reduce((sum, r) => sum + r.bytes, 0) / 1e6).toFixed(2),
    files: Object.fromEntries(fetched.filter((r) => r.bytes > 0 && r.status === 200)
      .map((r) => [name(r.url), +(r.bytes / 1e3).toFixed(1)])),
    fetchedTwice: [...counts].filter(([, n]) => n > 1).map(([file]) => file),
    revalidated: fetched.filter((r) => r.status === 304).map((r) => name(r.url)),
    failed, consoleErrors, splashRemoved, shot,
  };
}

const median = (xs) => xs.includes(null)
  ? null
  : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function summary(runs) {
  return {
    splashMs: median(runs.map((r) => r.splash)),
    firstFrameMs: median(runs.map((r) => r.firstFrame)),
    settledMs: median(runs.map((r) => r.signIn)),
    transferredMB: median(runs.map((r) => r.megabytes)),
  };
}

const [root, outDir, runsArg] = process.argv.slice(2);
const count = Number(runsArg ?? 3);
if (outDir) mkdirSync(outDir, { recursive: true });
const server = await serveRelease(root);
// Requests off the page fail at name lookup rather than through Playwright's
// routing, which would turn the browser's HTTP cache off and every warm load cold.
const args = ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'];
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args });
const results = [];
for (const profile of PROFILES) {
  const cold = [], second = [], returning = [];
  for (let i = 0; i < count; i++) {
    const context = await browser.newContext(profile.context);
    cold.push(await once(context, server.origin, profile));
    await context.close();
  }
  for (let i = 0; i < count; i++) {
    const dir = mkdtempSync(join(tmpdir(), 'load-time-'));
    const context = await chromium.launchPersistentContext(dir, {
      executablePath: process.env.CHROME_PATH, args, ...profile.context,
    });
    await once(context, server.origin, { ...profile, network: null, cpu: 1 });
    second.push(await once(context, server.origin, profile));
    returning.push(await once(context, server.origin, profile));
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
  if (outDir) writeFileSync(join(outDir, `load-${profile.name.replace(/\W+/g, '-')}.jpg`), returning.at(-1).shot);
  for (const run of [...cold, ...second, ...returning]) delete run.shot;
  results.push({
    profile: profile.name,
    cold: summary(cold), second: summary(second), returning: summary(returning),
    runs: { cold, second, returning },
  });
}
const text = JSON.stringify(results, null, 2);
if (outDir) writeFileSync(join(outDir, 'results.json'), text);
console.log(JSON.stringify(results.map(({ runs, ...medians }) => medians), null, 2));
await browser.close();
server.close();
