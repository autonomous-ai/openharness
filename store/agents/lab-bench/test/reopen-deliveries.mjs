import assert from 'node:assert/strict';
import {readFile, writeFile, cp, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from '../toolchain/node_modules/playwright-core/index.mjs';
import {browserPath} from '../toolchain/browser.mjs';
import {fitProject, predict} from '../template/studio/analysis.mjs';
import {number} from '../template/studio/formats.mjs';
const root = resolve(process.argv[2] ?? process.env.LAB_ACCEPTANCE_ROOT ?? 'work/experience-evidence/signal-acceptance');
const acceptance = JSON.parse(await readFile(join(root, 'acceptance.json'), 'utf8'));
const browser = await chromium.launch({headless: true, executablePath: await browserPath()}), proof = [], errors = [];
try {
  for (const item of acceptance.results) {
    const p = JSON.parse(await readFile(join(item.destination, 'project.signal.json'), 'utf8')), fit = fitProject(p);
    const context = await browser.newContext({viewport: {width: 1440, height: 1080}}), page = await context.newPage();
    page.on('pageerror', e => errors.push(item.kind + '/' + item.edition + ': ' + e.message)); await page.route('http**/*', route => route.abort());
    await page.goto(pathToFileURL(join(item.destination, 'experiment.html')).href); await page.waitForSelector('html[data-ready="true"]');
    await page.locator('.sidebar [data-tab="analyze"]').click(); assert.ok((await page.locator('.metrics').innerText()).includes(String(fit.n)));
    await page.screenshot({path: join(item.destination, 'studio-analysis.jpg'), type: 'jpeg', quality: 90});
    await page.locator('.sidebar [data-tab="followup"]').click();
    const factor = p.factors.find(f => f.type === 'category') ?? p.factors[0], control = page.locator(`[data-candidate="b"][data-factor="${factor.id}"]`).last();
    const candidate = p.comparison?.b ?? {settings: Object.fromEntries(p.factors.map(f => [f.id, f.levels.at(-1)])), block: p.design.blocks[0]};
    const changed = {...candidate.settings, [factor.id]: factor.type === 'category' ? factor.levels[0] : (factor.levels[0] + factor.levels.at(-1)) / 2};
    if (factor.type === 'category') await control.selectOption(factor.levels[0]); else {await control.fill(String(changed[factor.id])); await control.press('Tab');}
    const expected = predict(p, fit, changed, candidate.block); await page.waitForFunction(expectedText => document.querySelectorAll('.prediction .value')[1].textContent.includes(expectedText), number(expected.mean));
    await page.locator('[data-candidate="b"][data-block]').selectOption(p.design.blocks.at(-1));
    const blocked = predict(p, fit, changed, p.design.blocks.at(-1)); await page.waitForFunction(expectedText => document.querySelectorAll('.prediction .value')[1].textContent.includes(expectedText), number(blocked.mean));
    await page.screenshot({path: join(item.destination, 'studio-followup.jpg'), type: 'jpeg', quality: 90});
    await page.setViewportSize({width: 390, height: 844});
    for (const tab of ['plan', 'collect', 'analyze', 'followup']) {await page.locator('.sidebar [data-tab="' + tab + '"]').click(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), item.kind + '/' + tab + ' mobile overflow');}
    await page.screenshot({path: join(item.destination, 'studio-mobile.png'), fullPage: true});
    proof.push({kind: item.kind, edition: item.edition, offline: true, actualFactorControl: factor.type, changedPrediction: blocked.mean, mobileTabs: 4}); await context.close();
  }
  assert.deepEqual(errors, []); await writeFile(join(root, 'browser-reopening.json'), JSON.stringify({proof, errors, browser: await browser.version()}, null, 2));
  console.log(JSON.stringify({deliveriesReopened: proof.length, responsiveViews: proof.length * 4, errors}));
  if (process.argv.includes('--showcase')) {
    const target = new URL('../../../showcase/lab-bench/', import.meta.url); await mkdir(target, {recursive: true});
    for (const [kind, name, view] of [['coffee', 'starter', 'followup'], ['canopy', 'canopy', 'analysis'], ['fold', 'fold', 'followup']]) {
      const item = acceptance.results.find(x => x.kind === kind && x.edition === 'after'); await cp(join(item.destination, 'studio-' + view + '.jpg'), new URL(name + '.jpg', target));
    }
  }
} finally {await browser.close();}
