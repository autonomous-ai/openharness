import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import { chromium, preview } from './helpers.mjs';

let browser;
before(async () => { browser = await (await chromium()).launch({ headless: true }); });
after(async () => { await browser?.close(); });

test('a real sandbox loads sibling data, ES modules and streaming WASM, but cannot access its parent', async () => {
  const run = await preview(browser, null, { prepare: async workspace => {
    await writeFile(join(workspace, 'index.html'), `<!doctype html><html><body><output id="result">Loading</output><script type="module">
      import { label } from './logic.mjs';
      const data = await (await fetch('./data.json')).json();
      const wasm = await WebAssembly.instantiateStreaming(fetch('./engine.wasm'));
      let isolated = false;
      try { parent.document.body; } catch { isolated = true; }
      document.querySelector('output').textContent = label + data.value + ':' + !!wasm.instance + ':' + isolated;
    </script></body></html>`);
    await writeFile(join(workspace, 'data.json'), '{"value":42}');
    await writeFile(join(workspace, 'logic.mjs'), 'export const label = "Loaded:";');
    await writeFile(join(workspace, 'engine.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
  }});
  try {
    const frame = await run.open();
    await frame.getByText('Loaded:42:true:true', { exact: true }).waitFor();
    assert.deepEqual(run.errors, []);
    await run.page.getByLabel('Preview width').selectOption('390');
    assert.equal((await run.page.locator('#preview').boundingBox()).width, 390);
    await run.page.getByRole('button', { name: 'Live', exact: true }).click();
    await writeFile(join(run.workspace, 'data.json'), '{"value":43}');
    await run.page.getByRole('status').filter({ hasText: 'Changes waiting' }).waitFor();
    assert.equal(await frame.locator('output').textContent(), 'Loaded:42:true:true');
    await run.page.getByRole('button', { name: 'Paused', exact: true }).click();
    await frame.getByText('Loaded:43:true:true', { exact: true }).waitFor();
  } finally { await run.close(); }
});
