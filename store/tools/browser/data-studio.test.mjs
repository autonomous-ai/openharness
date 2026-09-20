import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, before, after } from 'node:test';
import { chromium, preview } from './helpers.mjs';
import { parseCSV } from '../../agents/data-studio/template/data.mjs';

let browser;
before(async () => { browser = await (await chromium()).launch({ headless: true }); });
after(async () => { await browser?.close(); });

test('Data Studio charts actual workspace data, filters, changes metrics, inspects points and exports the selected rows', async () => {
  const run = await preview(browser, 'store/agents/data-studio/template');
  try {
    const frame = await run.open();
    await frame.locator('#total').filter({ hasText: '203,000' }).waitFor();
    assert.equal(await frame.locator('#leader').textContent(), 'East');
    assert.equal(await frame.locator('#plot .point').count(), 16);
    console.log('screenshot:', await run.screenshot('data-studio-desktop'));
    for (const group of ['East', 'South', 'West']) await frame.getByRole('button', { name: group, exact:true }).click();
    assert.equal(await frame.locator('#total').textContent(), '54,600');
    await frame.getByRole('button', { name: 'Bars', exact:true }).click();
    assert.equal(await frame.locator('#plot rect.point').count(), 4);
    await frame.getByRole('button', { name: 'North · 2025-Q1 · 12,400', exact:true }).click();
    assert.equal(await frame.locator('#table tbody tr').count(), 1);
    assert.match(await frame.locator('#table-note').textContent(), /Inspecting North/);
    await frame.getByLabel('From period').selectOption('2025-Q3');
    assert.equal(await frame.locator('#total').textContent(), '29,000');
    const download = run.page.waitForEvent('download');
    await frame.getByRole('button', { name: /Export selection/ }).click();
    const csv = parseCSV(await readFile(await (await download).path(),'utf8'));
    assert.equal(csv.rows.length, 2);
    assert.equal(csv.rows[0].region, 'North');
    await frame.getByRole('button', { name: 'North', exact:true }).click();
    await frame.getByText('A fresh perspective starts with a selection.', {exact:true}).waitFor();
    assert.equal(await frame.locator('#export').isDisabled(),true);
    await frame.getByRole('button', { name: 'Reset filters', exact:true }).click();
    await frame.locator('summary').click();
    await frame.getByLabel('Value column').selectOption('units');
    assert.equal(await frame.locator('#total').textContent(), '5,071');
    await run.page.setViewportSize({width:390,height:844});
    assert.equal(await frame.locator('html').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    console.log('screenshot:', await run.screenshot('data-studio-mobile'));
    assert.deepEqual(run.errors,[]);
  } finally { await run.close(); }
});

test('an uploaded CSV changes the schema, safely displays text, and reports malformed data without sample fallbacks', async () => {
  const run = await preview(browser,'store/agents/data-studio/template');
  try {
    const frame=await run.open();
    await frame.locator('#total').filter({hasText:'203,000'}).waitFor();
    await frame.locator('#upload').setInputFiles({name:'experiment.csv',mimeType:'text/csv',buffer:Buffer.from('month,team,value\nJan,"North, coast",1.5\nFeb,"North, coast",2.5\nFeb,<img src=x onerror=alert(1)>,-1')});
    await frame.locator('#total').filter({hasText:'3'}).waitFor();
    assert.equal(await frame.locator('#total').textContent(),'3');
    assert.equal(await frame.locator('#regions img').count(),0);
    assert.equal(await frame.getByRole('button',{name:'North, coast',exact:true}).count(),1);
    assert.equal(await frame.locator('#plot .point').count(),4);
    await frame.locator('#upload').setInputFiles({name:'invalid.csv',mimeType:'text/csv',buffer:Buffer.from('a,b,c\n"unclosed,1,2')});
    await frame.getByRole('alert').waitFor();
    assert.match(await frame.locator('#error-message').textContent(), /no closing quote/);
    assert.equal(await frame.locator('#dashboard').isVisible(),false);
    assert.equal(await frame.locator('#export').isDisabled(),true);
    await frame.getByRole('button',{name:'Reload data.csv'}).click();
    await frame.locator('#total').filter({hasText:'203,000'}).waitFor();
    assert.deepEqual(run.errors,[]);
  } finally {await run.close();}
});
