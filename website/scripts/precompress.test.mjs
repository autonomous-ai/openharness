import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acceptsEncoding, precompressFolder } from './precompress.mjs';

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

describe('which copy a browser takes', () => {
  // As Next.js tests a has-condition's value: the whole header, anchored.
  const takes = (encoding, header) => new RegExp(`^${acceptsEncoding(encoding)}$`).test(header);

  it('takes an encoding the browser lists, wherever it stands', () => {
    for (const header of ['br', 'gzip, deflate, br, zstd', 'br, gzip', 'gzip,br', 'br;q=1.0, gzip;q=0.8', 'gzip;q=0.5, br;q=0.9']) {
      expect(takes('br', header), header).toBe(true);
    }
    expect(takes('gzip', 'gzip, deflate')).toBe(true);
  });

  it('does not take one it lists at q=0, or does not list', () => {
    for (const header of ['br;q=0, gzip', 'gzip, br; q=0', 'br;q=0.0', 'brotli', 'gzip, deflate', '']) {
      expect(takes('br', header), header).toBe(false);
    }
    expect(takes('gzip', 'br, gzip;q=0')).toBe(false);
  });
});
