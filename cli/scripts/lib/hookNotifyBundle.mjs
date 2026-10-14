import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

/** Both shipped layouts carry one standalone hook, with no runtime imports. */
export function buildHookNotify({ outfile, processImages } = {}) {
  return build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    entryPoints: ['hook/notify.mjs'],
    inject: ['src/engines/kit/nativeHookOriginClient.ts'],
    outfile,
    bundle: true, platform: 'node', format: 'esm', target: 'node20',
    minify: true, legalComments: 'eof', metafile: true, logLevel: 'silent',
    define: { __DARWIN_PROCESS_IMAGES__: processImages ? JSON.stringify(processImages) : 'undefined' },
  })
}
