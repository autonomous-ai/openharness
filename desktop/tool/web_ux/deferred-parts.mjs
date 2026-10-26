// The parts main.dart.js leaves out (lib/web/parts/), loaded as a browser
// loads them.
//
//   node tool/web_ux/deferred-parts.mjs <fixture-build> <release-build> [out-dir]
//
// 1. <release-build> (build/web-release from scripts/build-web-release.sh),
//    served as the website serves it (serve-release.mjs): every part the app
//    names is in the release folder, cached as immutable and compressed.
// 2. <fixture-build> (tool/web_ux_fixture.dart, as capture.mjs builds it), on
//    the finder-part scenario: a Finder tile downloads its part and draws it.
//    With the part's download failing, it says so and offers Retry, and Retry
//    once the network is back draws it. Screens of each go to [out-dir].
// Prints what it saw and exits 1 if any check failed.
import { chromium } from './playwright.mjs';
import { readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { settle } from './capture.mjs';
import { serve } from './serve.mjs';
import { serveRelease } from './serve-release.mjs';

const [fixtureDir, releaseDir, outDir] = process.argv.slice(2);
if (outDir) mkdirSync(outDir, { recursive: true });
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

// 1. The release folder serves every part.
const parts = readdirSync(releaseDir).filter((f) => /^main\.dart\.js_\d+\.part\.js$/.test(f));
check(parts.length > 0, `the release build has parts: ${parts.join(', ')}`);
const release = await serveRelease(releaseDir);
const page = await (await fetch(`${release.origin}/harness-web/`)).text();
const base = page.match(/"entrypointBaseUrl":"([^"]+)"/)?.[1];
for (const part of parts) {
  const response = await fetch(`${release.origin}${base}${part}`);
  check(
    response.ok && /immutable/.test(response.headers.get('cache-control') ?? ''),
    `${base}${part}: ${response.status}, ${response.headers.get('cache-control')}`,
  );
}
release.close();

// 2. A Finder tile, with the network and without.
const fixture = await serve(fixtureDir);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const url = `${fixture.origin}/?scenario=finder-part&theme=dark`;
// No service worker, as the website starts none (harness-web-assets.mjs): the
// fixture's would fetch the part itself, past the page's network.
const PAGE = { viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' };
// dart2js asks again for a part that failed, three times, as ?dart2jsRetry=N.
const isPart = (url) => new URL(url).pathname.endsWith('.part.js');
const partRequests = (tab) => {
  const seen = [];
  tab.on('requestfinished', async (r) => {
    if (isPart(r.url())) seen.push((await r.response())?.status());
  });
  tab.on('requestfailed', (r) => { if (isPart(r.url())) seen.push('failed'); });
  return seen;
};
const shot = (tab, name) => outDir && tab.screenshot({ path: join(outDir, `${name}.png`) });

{
  const context = await browser.newContext(PAGE);
  const tab = await context.newPage();
  const seen = partRequests(tab);
  await tab.goto(url);
  await settle(tab);
  check(seen.length > 0 && seen.every((s) => s === 200), `online: the Finder's part downloaded (${seen.join(', ')})`);
  check(await tab.getByText('Loading…').count() === 0, 'online: no loading line left');
  check(await tab.getByText('Could not load this part of Harness').count() === 0, 'online: no failure');
  await shot(tab, 'finder-part-online');
  await context.close();
}
{
  const context = await browser.newContext(PAGE);
  const tab = await context.newPage();
  const seen = partRequests(tab);
  let offline = true;
  await tab.route(isPart, (route) => (offline ? route.abort('internetdisconnected') : route.continue()));
  await tab.goto(url);
  await settle(tab);
  await tab.getByText('Could not load this part of Harness').first()
    .waitFor({ timeout: 30000 }).catch(() => {});
  check(await tab.getByText('Could not load this part of Harness').count() === 1, 'offline: the tile says it could not load');
  const retry = tab.getByRole('button', { name: 'Retry' });
  check(await retry.count() === 1, 'offline: it offers Retry');
  await shot(tab, 'finder-part-offline');
  offline = false;
  if (await retry.count() === 0) throw new Error('no Retry to press');
  await retry.first().click();
  await tab.waitForTimeout(3000);
  check(seen.includes(200), `back online: Retry downloaded the part (${seen.join(', ')})`);
  check(await tab.getByText('Could not load this part of Harness').count() === 0, 'back online: the failure is gone');
  await shot(tab, 'finder-part-retried');
  await context.close();
}
await browser.close();
fixture.close();
process.exit(failures.length ? 1 : 0);
