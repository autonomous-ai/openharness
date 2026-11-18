import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';

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

// node.sh runs where no Node is on PATH: it must find the runtime folder the
// daemon resolved, which on Linux follows the XDG rule. A fake uname picks the
// platform so every case runs on any machine.
test('node.sh finds current-node by the rule', async t => {
  const nodeSh = fileURLToPath(new URL('../toolchain/node.sh', import.meta.url));
  for (const name of ['ollama', 'mlx-lm', 'vllm']) {
    assert.equal(await readFile(new URL(`../../../agents/${name}/toolchain/node.sh`, import.meta.url), 'utf8'),
      await readFile(nodeSh, 'utf8'), `${name}'s copy`);
  }
  const cases = [
    { name: 'a fresh Linux home', system: 'Linux', runtime: '.local/state/harness/runtime' },
    { name: 'a legacy Linux home', system: 'Linux', make: ['.harness'], runtime: '.harness/runtime' },
    { name: 'a moved Linux home', system: 'Linux', make: ['.harness', '.local/share/harness'], runtime: '.local/state/harness/runtime' },
    { name: 'XDG bases set', system: 'Linux', env: home => ({ XDG_DATA_HOME: join(home, 'd'), XDG_STATE_HOME: join(home, 's') }),
      make: ['.harness', 'd/harness'], runtime: 's/harness/runtime' },
    { name: 'relative XDG bases', system: 'Linux', env: () => ({ XDG_DATA_HOME: 'd', XDG_STATE_HOME: 's' }),
      make: ['.local/share/harness'], runtime: '.local/state/harness/runtime' },
    { name: 'ADAPTER_RUNTIME_DIR', system: 'Linux', env: home => ({ ADAPTER_RUNTIME_DIR: join(home, 'own') }),
      make: ['.local/share/harness'], runtime: 'own' },
    { name: 'macOS', system: 'Darwin', make: ['.local/share/harness'], runtime: '.harness/runtime' },
  ];
  for (const c of cases) {
    const home = await mkdtemp(join(tmpdir(), 'local-ai-node-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const bin = join(home, 'bin');
    await mkdir(bin);
    await symlink('/bin/cat', join(bin, 'cat'));
    await writeFile(join(bin, 'uname'), `#!/bin/sh\necho ${c.system}\n`);
    await chmod(join(bin, 'uname'), 0o755);
    for (const folder of c.make ?? []) await mkdir(join(home, folder), { recursive: true });
    const runtime = join(home, c.runtime);
    const node = join(runtime, 'node-22', 'bin', 'node');
    await mkdir(join(runtime, 'node-22', 'bin'), { recursive: true });
    await symlink(process.execPath, node);
    await writeFile(join(runtime, 'current-node'), node);
    const run = spawnSync('/bin/sh', ['-c', '. "$1" && printf %s "$LOCAL_AI_NODE"', 'sh', nodeSh], {
      encoding: 'utf8', env: { PATH: bin, HOME: home, ...c.env?.(home) },
    });
    assert.equal(run.stdout, node, `${c.name}: ${run.stderr}`);
  }
});
