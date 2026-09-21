import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';

// A Store install contains just one directory. Verify imports and real static
// assets from a relocated copy, without shared-source or sibling dependencies.
for (const [name, icon] of [['ollama', 'ollama'], ['mlx-lm', 'mlx'], ['vllm', 'vllm']]) {
  test(`${name} serves its branded viewer from an independent package copy`, async t => {
    const temp = await mkdtemp(join(tmpdir(), 'local-ai-package-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const directory = join(temp, name);
    await cp(new URL(`../../../agents/${name}/`, import.meta.url), directory, {
      recursive: true,
      filter: path => !path.split('/').some(part => ['.venv', '.harness', '__pycache__'].includes(part)),
    });
    const manifest = JSON.parse(await readFile(join(directory, 'harness.json'), 'utf8'));
    assert.equal(manifest.id, `autonomous/${name}`);
    assert.equal(manifest.category, 'Local AI');
    for (const file of [manifest.agent.instructions, manifest.toolchain.setup,
      manifest.toolchain.doctor, 'toolchain/local-ai', 'viewer.sh']) {
      assert.ok((await readFile(join(directory, file))).length, file);
    }
    const { createServer } = await import(pathToFileURL(join(directory, 'src/server.mjs')));
    if (name !== 'ollama') await import(pathToFileURL(join(directory, `src/${name === 'mlx-lm' ? 'mlx' : 'vllm'}.mjs`)));
    const controller = new EventEmitter();
    controller.profile = { id: name };
    controller.snapshot = () => ({ runtime: { models: [] }, jobs: [] });
    controller.refresh = async () => {};
    const server = createServer(controller, { assetRoot: join(directory, 'dist') });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeEvents(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const html = await (await fetch(`${base}/?view=grid`)).text();
    assert.ok(html.includes(manifest.name));
    assert.ok(html.includes(`${icon}-icon.`));
    for (const path of ['/app.js', '/styles.css', `/assets/${icon}-icon.png`, '/favicon.ico']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length > 0);
      if (path.endsWith('.png') || path.endsWith('.ico')) {
        assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
      }
    }
  });
}
