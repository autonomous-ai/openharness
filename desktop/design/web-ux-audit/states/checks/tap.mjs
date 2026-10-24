// Controls under 44 px on phones in this group's flows, measured as checks.mjs tapTargets does
// (the accessibility tree's buttons and links), after each flow's own clicks.
// FIXTURE=super-tab for the Super Tab flows.
import { join } from 'node:path';

const repo = process.env.REPO;
const { chromium } = await import(join(repo, 'tool/web_ux/playwright.mjs'));
const { serve } = await import(join(repo, 'tool/web_ux/serve.mjs'));
const { contextFor, runStep, settle, urlFor, VIEWPORTS } = await import(join(repo, 'tool/web_ux/capture.mjs'));
const { loadFlows } = await import(join(repo, 'tool/web_ux/load-flows.mjs'));

const [buildDir, ...names] = process.argv.slice(2);
const fixture = process.env.FIXTURE ?? 'app';
const flows = (await loadFlows(fixture)).filter((f) => names.includes(f.name));
const server = await serve(buildDir);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
for (const width of ['360', '390']) {
  const viewport = VIEWPORTS.find((v) => v.name === width);
  const context = await contextFor(browser, viewport, 'dark', server.origin, new Set());
  for (const flow of flows) {
    const page = await context.newPage();
    await page.goto(urlFor(server.origin, flow, 'dark'));
    await settle(page);
    try {
      for (const step of flow.compact ?? flow.steps ?? []) {
        await runStep(page, step, Boolean(viewport.device));
        await page.waitForTimeout(700);
      }
    } catch (error) {
      console.log(width, flow.name, 'FLOW FAILED', String(error).slice(0, 80));
      await page.close();
      continue;
    }
    const small = await page.evaluate(() =>
      Array.from(document.querySelectorAll('flt-semantics[flt-tappable], flt-semantics[role="button"], flt-semantics[role="link"]'))
        .map((e) => { const r = e.getBoundingClientRect(); return { label: (e.getAttribute('aria-label') || e.textContent || '').split('\n')[0].trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) }; })
        .filter((c) => c.w > 0 && c.h > 0 && (c.w < 44 || c.h < 44) && c.y < window.innerHeight && c.y + c.h > 0));
    console.log(width, flow.name, JSON.stringify(small.map((c) => `${c.label} ${c.w}x${c.h}@${c.y}`)));
    await page.close();
  }
  await context.close();
}
await browser.close();
server.close();
process.exit(0);
