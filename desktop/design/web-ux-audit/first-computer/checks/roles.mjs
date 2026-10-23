// S14: which New tab page buttons the accessibility tree exposes under the
// first-computer page, per scenario. Usage: node roles.mjs <build dir>
import { chromium } from '/Users/macbook/harnesses/worktrees/autonomous-harness/49bd0460396b54e8ac20f248/desktop/tool/web_ux/playwright.mjs';
import { serve } from '/Users/macbook/harnesses/worktrees/autonomous-harness/49bd0460396b54e8ac20f248/desktop/tool/web_ux/serve.mjs';
import { contextFor, settle, urlFor, VIEWPORTS } from '/Users/macbook/harnesses/worktrees/autonomous-harness/49bd0460396b54e8ac20f248/desktop/tool/web_ux/capture.mjs';

const NEW_TAB_PAGE = ['New Pane', 'Keyboard practice', 'Search harnesses', 'Browse the Harness Store'];
const SCENARIOS = ['first-machine', 'first-machine-loading', 'first-machine-failed', 'computers', 'offline-only'];
const server = await serve(process.argv[2]);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
for (const width of ['390', '1440']) {
  const viewport = VIEWPORTS.find((v) => v.name === width);
  const context = await contextFor(browser, viewport, 'dark', server.origin, new Set());
  for (const scenario of SCENARIOS) {
    const page = await context.newPage();
    await page.goto(urlFor(server.origin, { scenario }, 'dark'));
    await settle(page);
    const found = [];
    for (const name of NEW_TAB_PAGE) {
      const n = await page.getByRole('button', { name }).count() + await page.getByRole('textbox', { name }).count();
      if (n) found.push(name);
    }
    const headings = await page.getByRole('heading').allInnerTexts();
    console.log(width, scenario, 'heading:', JSON.stringify(headings), 'New tab page controls:', JSON.stringify(found));
    await page.close();
  }
  await context.close();
}
await browser.close();
server.close?.();
process.exit(0);
