import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { chromium, preview } from './helpers.mjs';

let browser;
before(async () => { browser = await (await chromium()).launch({ headless: true }); });
after(async () => { await browser?.close(); });

test('Field renders immediately, reacts to real controls, respects reduced motion and exports its canvas', async () => {
  const run = await preview(browser, 'store/agents/web-studio/template');
  try {
    const frame = await run.open();
    await frame.getByRole('heading', { name: 'A little room for wonder.' }).waitFor();
    const canvas = frame.locator('#field');
    const pixels = () => canvas.evaluate(canvas => canvas.toDataURL());
    const initial = await pixels();
    assert.ok(initial.length > 20000, 'the first frame already contains the artwork');
    assert.equal(await frame.locator('#play-state').textContent(), 'STILL');
    await run.page.waitForTimeout(120);
    assert.equal(await pixels(), initial, 'reduced motion does not start an animation');
    console.log('screenshot:', await run.screenshot('web-studio-desktop'));
    await frame.getByRole('button', { name: /Weave/ }).click();
    assert.equal(await frame.locator('#scene-name').textContent(), 'Weave');
    assert.notEqual(await pixels(), initial);
    await frame.getByLabel('Detail', { exact: true }).fill('64');
    assert.equal(await frame.locator('#line-count').textContent(), '64');
    await frame.getByRole('button', { name: /Variation/ }).click();
    assert.notEqual(await frame.locator('#seed-label').textContent(), 'SEED 042');
    const box = await canvas.boundingBox();
    const beforePointer = await pixels();
    await run.page.mouse.move(box.x + box.width * .85, box.y + box.height * .75);
    assert.notEqual(await pixels(), beforePointer, 'pointer moves rotate the actual artwork');
    await frame.getByRole('button', { name: '▷ Play', exact: true }).click();
    assert.equal(await frame.locator('#play-state').textContent(), 'LIVE');
    const moving = await pixels();
    await run.page.waitForTimeout(180);
    assert.notEqual(await pixels(), moving);
    await frame.getByRole('button', { name: 'Ⅱ Pause', exact: true }).click();
    const download = run.page.waitForEvent('download');
    await frame.getByRole('button', { name: /Keep this moment/ }).click();
    const file = await download;
    assert.match(file.suggestedFilename(), /^field-weave-\d+\.png$/);
    assert.equal(await file.failure(), null);
    await run.page.setViewportSize({ width: 390, height: 844 });
    await frame.getByRole('button', { name: /Bloom/ }).click();
    await frame.locator('body').evaluate(body => body.scrollTo(0, 0));
    assert.equal(await frame.locator('html').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    console.log('screenshot:', await run.screenshot('web-studio-mobile'));
    assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});
