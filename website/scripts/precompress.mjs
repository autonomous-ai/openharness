import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

// What a release loads that compresses: the app, the engine and its WebAssembly, manifests and
// fonts. Images are compressed already and *.symbols are never fetched. next.config.js serves
// these extensions' .br or .gz copy to a browser that accepts it.
export const PRECOMPRESSED = ['js', 'mjs', 'wasm', 'json', 'ttf', 'otf', 'svg', 'html'];

/// A pattern for an Accept-Encoding header that takes [encoding]: listed as a
/// token, with no q-value or a q-value above 0 (`br;q=0` refuses brotli).
/// Whole-header, as Next.js tests a has-condition (`^value$`).
export function acceptsEncoding(encoding) {
  const nonZero = String.raw`(?:1(?:\.0{0,3})?|0?\.\d*[1-9]\d*)`;
  return String.raw`(?:.*[\s,])?${encoding}(?:\s*;\s*q\s*=\s*${nonZero})?\s*(?:,.*)?`;
}

const compressible = (file) => PRECOMPRESSED.includes(path.extname(file).slice(1));

async function* files(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const at = path.join(folder, entry.name);
    if (entry.isDirectory()) yield* files(at);
    else if (entry.isFile() && compressible(at)) yield at;
  }
}

/// Writes `<file>.br` (brotli at its highest level) and `<file>.gz` (gzip at
/// its highest) beside each file of [folder] a browser fetches, once, at
/// build time: Cloudflare compresses on the fly at brotli 3, which leaves
/// main.dart.js and canvaskit.wasm about 1.4 MB larger than this.
export async function precompressFolder(folder) {
  const work = [];
  for await (const file of files(folder)) {
    work.push((async () => {
      const raw = await readFile(file);
      const [br, gz] = await Promise.all([
        brotli(raw, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        }),
        gzipped(raw, { level: constants.Z_BEST_COMPRESSION }),
      ]);
      await Promise.all([writeFile(`${file}.br`, br), writeFile(`${file}.gz`, gz)]);
    })());
  }
  await Promise.all(work);
}
