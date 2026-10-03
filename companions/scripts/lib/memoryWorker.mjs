import * as esbuild from 'esbuild'
import { fileURLToPath } from 'node:url'
import { assertOptionalBundle } from './boundary.mjs'

export async function memoryWorkerSource({ minify = false } = {}) {
  const result = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../../src/memory/worker.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20', minify,
    legalComments: 'none', logLevel: 'silent', metafile: true,
  })
  assertOptionalBundle(result.metafile)
  return result.outputFiles[0].text
}
