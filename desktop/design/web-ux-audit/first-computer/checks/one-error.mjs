// first-machine-failed: how many times the list error and Retry appear.
import { chromium } from '/Users/macbook/harnesses/worktrees/autonomous-harness/49bd0460396b54e8ac20f248/desktop/tool/web_ux/playwright.mjs';
import { serve } from '/Users/macbook/harnesses/worktrees/autonomous-harness/49bd0460396b54e8ac20f248/desktop/tool/web_ux/serve.mjs';
import { contextFor, settle, urlFor, VIEWPORTS } from '/Users/macbook/harnesses/worktrees/autonomous-harness/49bd0460396b54e8ac20f248/desktop/tool/web_ux/capture.mjs';
const server = await serve(process.argv[2]);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
for (const width of ['360', '390', '1440']) {
  const context = await contextFor(browser, VIEWPORTS.find((v) => v.name === width), 'dark', server.origin, new Set());
  const page = await context.newPage();
  await page.goto(urlFor(server.origin, { scenario: 'first-machine-failed' }, 'dark'));
  await settle(page);
  const errors = await page.getByText('Could not load machines: the server did not answer.').count();
  const retries = await page.getByRole('button', { name: 'Retry' }).count();
  console.log(width, 'first-machine-failed: error shown', errors, 'time(s); Retry buttons', retries);
  await context.close();
}
await browser.close();
process.exit(0);
