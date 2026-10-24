// Four Tabs on sign-in, the first-computer page and Settings at 1440, both
// themes; one screenshot each. Run once on a build with the accessibility tree
// on (the review fixture) and once with it off (MODE=off), clicking Settings by
// the positions the tree reported, since without it there are no names.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.env.REPO;
const { chromium } = await import(join(repo, 'tool/web_ux/playwright.mjs'));
const { VIEWPORTS, contextFor, settle, urlFor } = await import(join(repo, 'tool/web_ux/capture.mjs'));
const { serve } = await import(join(repo, 'tool/web_ux/serve.mjs'));

const [buildDir, outDir] = process.argv.slice(2);
const mode = process.env.MODE ?? 'on';
mkdirSync(outDir, { recursive: true });
const positionsFile = join(outDir, '..', 'settings-positions.json');
const computer = VIEWPORTS.find((v) => v.name === '1440');
const server = await serve(buildDir);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const blocked = new Set();
const results = [];
const flows = [
  { name: 'signin', scenario: 'signin' },
  { name: 'first-machine', scenario: 'first-machine' },
  { name: 'settings', scenario: 'workspace', settings: true },
];
for (const theme of ['dark', 'light']) {
  const context = await contextFor(browser, computer, theme, server.origin, blocked);
  for (const f of flows) {
    const page = await context.newPage();
    await page.goto(urlFor(server.origin, f, theme));
    await settle(page);
    if (f.settings) {
      if (mode === 'on') {
        const menu = page.getByRole('button', { name: 'Menu', exact: true });
        const menuBox = await menu.boundingBox();
        await menu.click();
        await page.waitForTimeout(700);
        const row = page.getByRole('menuitem', { name: 'Settings', exact: true }).or(page.getByRole('button', { name: 'Settings', exact: true })).first();
        const rowBox = await row.boundingBox();
        await row.click();
        writeFileSync(positionsFile, JSON.stringify({ menuBox, rowBox }));
      } else {
        const { menuBox, rowBox } = JSON.parse(readFileSync(positionsFile, 'utf8'));
        await page.mouse.click(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2);
        await page.waitForTimeout(700);
        await page.mouse.click(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
      }
      await page.waitForTimeout(900);
    }
    for (let i = 1; i <= 4; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(300);
    }
    const file = `focus-${f.name}-${theme}-a11y-${mode}.png`;
    await page.screenshot({ path: join(outDir, file) });
    const active = await page.evaluate(() => {
      const a = document.activeElement;
      return a ? `${a.tagName.toLowerCase()} ${a.getAttribute('aria-label') || a.textContent?.slice(0, 40) || ''}` : null;
    });
    results.push({ flow: f.name, theme, mode, active, image: file });
    await page.close();
  }
  await context.close();
}
writeFileSync(join(outDir, `focus-${mode}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
await browser.close();
server.close();
