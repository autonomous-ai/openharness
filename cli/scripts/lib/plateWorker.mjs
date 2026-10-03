import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'

// The plate worker (src/pair/plateWorker.ts) as one self-contained CommonJS script: the shader, every
// model and the roll bundled in. Both builds define it as `__PLATE_WORKER__`, and harnessd starts it with
// `new Worker(source, { eval: true })` — the release ships a single cli.js, so the worker cannot be a
// file of its own beside it.
export async function plateWorkerSource({ minify = false } = {}) {
  const result = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../../src/pair/plateWorker.ts', import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    minify,
    legalComments: 'none',
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}
