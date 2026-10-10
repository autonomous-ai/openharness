/** Exercise the same esbuild define, materialization and process-discovery path
 * as the portable CLI. Only this Node process and a private cache are queried. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { readProcessImageBundle } from './lib/processImageBundle.mjs'

assert.equal(process.platform, 'darwin', 'Run the native bundle smoke check on macOS')
const artifact = readProcessImageBundle({ path: process.env.HARNESS_PROCESS_IMAGES_ARTIFACT, required: true })
const cli = fileURLToPath(new URL('..', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'harness-images-bundled-'))
try {
  const noLsof = join(root, 'bin')
  mkdirSync(noLsof)
  writeFileSync(join(noLsof, 'lsof'), '#!/bin/sh\nprintf "unexpected fallback" >&2\nexit 64\n', { mode: 0o700 })
  const entry = `
    import assert from 'node:assert/strict';
    import { realpathSync, rmSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { env } from ${JSON.stringify(join(cli, 'src/config/env.ts'))};
    import { nativeProcessControl } from ${JSON.stringify(join(cli, 'src/lib/nativeProcessControl.ts'))};
    import { NativeEvidenceBudget } from ${JSON.stringify(join(cli, 'src/engines/kit/nativeEvidence.ts'))};
    import { bundledProcessImageHelper, nativeProcessImages } from ${JSON.stringify(join(cli, 'src/lib/nativeProcessImages.ts'))};
    import { processRows, enrichProcessRows } from ${JSON.stringify(join(cli, 'src/lib/tmux.ts'))};
    env.ADAPTER_RUNTIME_DIR = process.argv[2];
    const native = await nativeProcessImages([process.pid], 3000);
    assert.equal(realpathSync(native.images.get(process.pid).path), realpathSync(process.execPath));
    const rows = await processRows();
    const own = rows.filter(row => row.pid === process.pid);
    assert.equal(own.length, 1);
    const enriched = await enrichProcessRows(own);
    assert.equal(enriched.length, 1);
    assert.equal(enriched[0].imagePath, native.images.get(process.pid).path);
    assert.ok(enriched[0].imageFileKey);
    const child = spawn(process.execPath, ['-e', ${JSON.stringify('process.stdout.write("ready\\n"); setTimeout(() => process.exit(0), 30_000)')}], {
      env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Private control fixture exited before readiness'); })]);
      const control = () => nativeProcessControl([child.pid], 0, new NativeEvidenceBudget());
      const first = await control();
      assert.equal(first.rows.size, 1);
      assert.equal(realpathSync(first.rows.get(child.pid).imagePath), realpathSync(process.execPath));
      assert.ok(first.rows.get(child.pid).commandDigest);
      const prepared = await bundledProcessImageHelper();
      assert.ok(prepared);
      rmSync(prepared.path); // Only the private cache this smoke check created.
      await assert.rejects(control, /identity is held/i);
      const recovered = await control();
      assert.equal(recovered.rows.get(child.pid).birth, first.rows.get(child.pid).birth);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } }
    console.log('Bundled native query, discovery, control and cache recovery passed on ' + process.arch);
  `
  const outfile = join(root, 'probe.mjs')
  await build({ stdin: { contents: entry, resolveDir: cli, sourcefile: 'probe.mjs' },
    outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20',
    external: ['bufferutil', 'utf-8-validate'],
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    define: { __DARWIN_PROCESS_IMAGES__: JSON.stringify(artifact) }, logLevel: 'silent' })
  const stdout = execFileSync(process.execPath, [outfile, join(root, 'runtime')], {
    timeout: 15_000, encoding: 'utf8', env: { ...process.env, PATH: noLsof + ':' + process.env.PATH,
      ADAPTER_HOME: root, ADAPTER_CONFIG_DIR: join(root, 'config'), ADAPTER_DATA_DIR: join(root, 'data') },
  })
  process.stdout.write(stdout)
} finally { rmSync(root, { recursive: true, force: true }) }
