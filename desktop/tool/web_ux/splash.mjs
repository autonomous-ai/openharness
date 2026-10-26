// The loading screen from web/index.html, held on screen, in the themes it must match.
//
//   node tool/web_ux/splash.mjs <build-dir> [out-dir]
//
// <build-dir> is any web build (a release, or the fixture); its main.dart.js is
// never answered, so Flutter never starts and the page stays as a first visit
// sees it for the seconds before the first frame. Each case sets what the
// browser holds (the saved palette, or nothing, or storage that throws) and the
// system theme, then checks the screen reads "Opening Harness…" on the right
// ground: the app opens in the saved palette, Graphite when there is none or it
// cannot be read, whatever the system theme is. Screenshots go to
// <out-dir>/splash/<case>-<width>.png; exits 1 when a case is wrong.
import { chromium, devices } from './playwright.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from './serve.mjs';

const GRAPHITE = 'rgb(20, 20, 20)';
const LIGHT = 'rgb(250, 250, 249)';
const PALETTE_KEY = 'harness.web.v1.app_color_palette';

const CASES = [
  { name: 'empty-storage', system: 'dark', ground: GRAPHITE },
  { name: 'empty-storage-light-system', system: 'light', ground: GRAPHITE },
  { name: 'paper', saved: 'paper', system: 'dark', ground: LIGHT },
  { name: 'mist', saved: 'mist', system: 'light', ground: LIGHT },
  { name: 'graphite', saved: 'graphite', system: 'light', ground: GRAPHITE },
  { name: 'blocked-storage', system: 'light', blocked: true, ground: GRAPHITE },
];

const WIDTHS = [
  { name: '390', width: 390, height: 844, device: 'iPhone 13' },
  { name: '1440', width: 1440, height: 900, device: null },
];

function seedStorage({ saved, blocked, key }) {
  if (blocked) {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('blocked', 'SecurityError'); },
    });
    return;
  }
  if (saved) localStorage.setItem(key, saved);
}

async function check(browser, origin, testCase, viewport, outDir) {
  const base = viewport.device ? { ...devices[viewport.device] } : {};
  const context = await browser.newContext({
    ...base,
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    colorScheme: testCase.system,
  });
  await context.addInitScript(seedStorage, { ...testCase, key: PALETTE_KEY });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (!url.startsWith(origin)) return route.abort();
    // Held, not failed: the engine stays unstarted and the loading screen stays up.
    if (url.endsWith('/main.dart.js')) return undefined;
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'commit' });
  await page.waitForFunction(() => document.getElementById('harness-splash')?.getBoundingClientRect().width > 0);
  const seen = await page.evaluate(() => {
    const splash = document.getElementById('harness-splash');
    return {
      text: splash.innerText.trim(),
      ground: getComputedStyle(document.body).backgroundColor,
      splashGround: getComputedStyle(splash).backgroundColor,
      logoShown: splash.querySelector('img')?.complete && splash.querySelector('img').naturalWidth > 0,
    };
  });
  mkdirSync(join(outDir, 'splash'), { recursive: true });
  await page.screenshot({ path: join(outDir, 'splash', `${testCase.name}-${viewport.name}.png`) });
  await context.close();
  const problems = [];
  if (seen.text !== 'Opening Harness…') problems.push(`text is "${seen.text}"`);
  if (seen.ground !== testCase.ground) problems.push(`ground is ${seen.ground}, expected ${testCase.ground}`);
  if (seen.splashGround !== testCase.ground) problems.push(`splash covers with ${seen.splashGround}`);
  if (!seen.logoShown) problems.push('the logo did not load');
  return { case: testCase.name, width: viewport.name, ...seen, problems };
}

const [buildDir, outDir = '.'] = process.argv.slice(2);
const server = await serve(buildDir);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const results = [];
for (const viewport of WIDTHS) {
  for (const testCase of CASES) results.push(await check(browser, server.origin, testCase, viewport, outDir));
}
await browser.close();
server.close();
console.log(JSON.stringify(results, null, 2));
process.exit(results.some((r) => r.problems.length) ? 1 : 0);
