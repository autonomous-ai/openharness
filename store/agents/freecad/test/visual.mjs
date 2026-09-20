// Optional real-browser QA. Point HARNESS_WORKSPACE at a successful native job,
// CAD_VIEWER_URL at its running shared viewer and PLAYWRIGHT_MODULE at Playwright.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {serve} from '../skills/freecad/scripts/serve-handoff.mjs';

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert.ok(process.env.HARNESS_WORKSPACE, 'HARNESS_WORKSPACE is required');
assert.ok(process.env.CAD_VIEWER_URL, 'CAD_VIEWER_URL is required');
const workspace = resolve(process.env.HARNESS_WORKSPACE);
const output = resolve(process.env.FREECAD_VISUAL_DIR || join(workspace, '.harness/visual'));
await mkdir(output, {recursive:true});
const report = JSON.parse(await readFile(join(workspace, 'handoff/checks.json'), 'utf8'));
const server = await serve(workspace);
let browser;
try {
  browser = await chromium.launch({headless:true});
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [name, width] of [['desktop',1440], ['mobile',390]]) {
    const page = await browser.newPage({viewport:{width,height:1000}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/handoff/index.html');
    await page.locator('h1').waitFor();
    await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    assert.equal(await page.locator('.pass').count(), report.checks.length);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    for (const href of await page.locator('a').evaluateAll(links => links.map(a=>a.href))) {
      assert.equal((await page.request.get(href)).status(),200,href);
    }
    await page.screenshot({path:join(output,`handoff-${name}.png`),fullPage:true});
    await page.screenshot({path:join(output,`handoff-${name}-top.png`)});
    for (const part of report.parts) {
      await page.goto(base + '/handoff/' + part.files.svg);
      const projections = await page.locator('.projection').evaluateAll(groups => groups.map(group => {
        const box = group.getBBox();
        return {actual:[box.width,box.height],expected:[Number(group.dataset.width),Number(group.dataset.height)]};
      }));
      assert.equal(projections.length,3);
      for (const projection of projections) for (let i=0;i<2;i++) {
        assert.ok(Math.abs(projection.actual[i]-projection.expected[i]) < .001, JSON.stringify(projection));
      }
      await page.screenshot({path:join(output,`${part.id}-drawing-${name}.png`)});
    }
    assert.deepEqual(errors,[]);
    await page.close();
  }
  const handoffPage = await browser.newPage({viewport:{width:1600,height:1000}});
  await handoffPage.goto(base + '/handoff/index.html');
  await handoffPage.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await handoffPage.screenshot({path:join(output,'handoff.jpg'),type:'jpeg',quality:88});
  await handoffPage.close();
  const page = await browser.newPage({viewport:{width:1600,height:1000}});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(process.env.CAD_VIEWER_URL);
  await page.locator('canvas').first().waitFor();
  await page.waitForTimeout(7000);
  const before = await page.screenshot();
  await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  await page.waitForTimeout(400);
  const after = await page.screenshot();
  assert.notEqual(createHash('sha256').update(before).digest('hex'),createHash('sha256').update(after).digest('hex'));
  await page.getByRole('button',{name:'Reset view',exact:true}).click();
  await page.waitForTimeout(400);
  await page.screenshot({path:join(output,'cad-viewer.png')});
  await page.screenshot({path:join(output,'cad-viewer.jpg'),type:'jpeg',quality:88});
  assert.deepEqual(errors,[]);
  console.log('PASS: desktop/mobile report, all downloads, geometrically aligned projections and interactive actual CAD viewer.');
  console.log('Visually inspect the captures in',output,'before release.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
