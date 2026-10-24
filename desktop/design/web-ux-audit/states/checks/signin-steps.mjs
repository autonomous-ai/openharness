import { join } from 'node:path';
const repo = process.env.REPO;
const { chromium } = await import(join(repo, 'tool/web_ux/playwright.mjs'));
const { VIEWPORTS, contextFor, settle, urlFor } = await import(join(repo, 'tool/web_ux/capture.mjs'));
const { serve } = await import(join(repo, 'tool/web_ux/serve.mjs'));
const [buildDir, outDir, tag] = process.argv.slice(2);
const server = await serve(buildDir);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const context = await contextFor(browser, VIEWPORTS.find((v) => v.name === '1440'), 'dark', server.origin, new Set());
const page = await context.newPage();
await page.goto(urlFor(server.origin, { scenario: 'signin' }, 'dark'));
await settle(page);
for (let i = 1; i <= 6; i++) {
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, `signin-${tag}-tab${i}.png`), clip: { x: 0, y: 0, width: 1440, height: 900 } });
  const a = await page.evaluate(() => { const e = document.activeElement; return e ? `${e.tagName} ${(e.getAttribute('aria-label') || e.textContent || '').slice(0, 30)}` : null; });
  console.log(i, a);
}
await browser.close(); server.close();
