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
    import { realpathSync } from 'node:fs';
    import { env } from ${JSON.stringify(join(cli, 'src/config/env.ts'))};
    import { nativeProcessImages } from ${JSON.stringify(join(cli, 'src/lib/nativeProcessImages.ts'))};
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
    console.log('Bundled native query and discovery passed on ' + process.arch);
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
