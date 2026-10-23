// Controls under 44 px on phones in this group's flows, measured as checks.mjs tapTargets does.
import { chromium } from '/Users/macbook/harnesses/worktrees/autonomous-harness/49bd0460396b54e8ac20f248/desktop/tool/web_ux/playwright.mjs';
import { serve } from '/Users/macbook/harnesses/worktrees/autonomous-harness/49bd0460396b54e8ac20f248/desktop/tool/web_ux/serve.mjs';
import { contextFor, settle, urlFor, VIEWPORTS } from '/Users/macbook/harnesses/worktrees/autonomous-harness/49bd0460396b54e8ac20f248/desktop/tool/web_ux/capture.mjs';
const FLOWS = ['first-machine', 'first-machine-loading', 'first-machine-failed', 'computers', 'link-machine', 'offline-only'];
const server = await serve(process.argv[2]);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
for (const width of ['360', '390']) {
  const viewport = VIEWPORTS.find((v) => v.name === width);
  const context = await contextFor(browser, viewport, 'dark', server.origin, new Set());
  for (const scenario of FLOWS) {
    const page = await context.newPage();
    await page.goto(urlFor(server.origin, { scenario }, 'dark'));
    await settle(page);
    const small = await page.evaluate(() =>
      Array.from(document.querySelectorAll('flt-semantics[flt-tappable], flt-semantics[role="button"], flt-semantics[role="link"]'))
        .map((e) => { const r = e.getBoundingClientRect(); return { label: (e.getAttribute('aria-label') || e.textContent || '').split('\n')[0].trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) }; })
        .filter((c) => c.w > 0 && c.h > 0 && (c.w < 44 || c.h < 44) && c.y < window.innerHeight && c.y + c.h > 0));
    console.log(width, scenario, JSON.stringify(small.map((c) => `${c.label} ${c.w}x${c.h}@${c.y}`)));
    await page.close();
  }
  await context.close();
}
await browser.close();
process.exit(0);
