import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { precompressFolder } from './precompress.mjs';

let folder;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'precompress-'));
  await mkdir(path.join(folder, 'canvaskit', 'chromium'), { recursive: true });
});
afterEach(() => rm(folder, { recursive: true, force: true }));

const script = 'void main() { print("Harness"); }\n'.repeat(400);

describe('pre-compressed release files', () => {
  it('writes a brotli and a gzip copy beside each file a browser fetches, each decoding to it', async () => {
    const wasm = Buffer.alloc(4096, 7);
    await writeFile(path.join(folder, 'main.dart.js'), script);
    await writeFile(path.join(folder, 'canvaskit', 'chromium', 'canvaskit.wasm'), wasm);

    await precompressFolder(folder);

    for (const [file, original] of [['main.dart.js', Buffer.from(script)], ['canvaskit/chromium/canvaskit.wasm', wasm]]) {
      const at = path.join(folder, file);
      expect(brotliDecompressSync(await readFile(`${at}.br`))).toEqual(original);
      expect(gunzipSync(await readFile(`${at}.gz`))).toEqual(original);
    }
  });

  it('leaves already-compressed images and debug symbols alone', async () => {
    await writeFile(path.join(folder, 'app_icon.png'), Buffer.alloc(4096, 1));
    await writeFile(path.join(folder, 'canvaskit', 'canvaskit.js.symbols'), script);

    await precompressFolder(folder);

    expect((await readdir(folder)).sort()).toEqual(['app_icon.png', 'canvaskit']);
    expect(await readdir(path.join(folder, 'canvaskit'))).toEqual(['canvaskit.js.symbols', 'chromium']);
  });
});
