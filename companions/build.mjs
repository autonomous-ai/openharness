import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { memoryWorkerSource } from './scripts/lib/memoryWorker.mjs'
import { plateWorkerSource } from './scripts/lib/plateWorker.mjs'
import { assertOptionalBundle } from './scripts/lib/boundary.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
const [memory, plate] = await Promise.all([memoryWorkerSource(), plateWorkerSource()])
const entries = [
  ['companion', 'src/companion/api.ts', { __PLATE_WORKER__: JSON.stringify(plate) }],
  ['memory', 'src/memory/index.ts', { __MEMORY_WORKER__: JSON.stringify(memory) }],
  ['application', 'src/application/index.ts', {}],
]
await mkdir(new URL('./dist/', import.meta.url), { recursive: true })
for (const [name, entry, define] of entries) {
  const result = await build({ absWorkingDir: root, entryPoints: [entry], outfile: `dist/${name}.js`,
    bundle: true, platform: 'node', format: 'esm', target: 'node22', define, metafile: true,
    // Dependencies are installed with this package, not taken from the installed Harness CLI.
    packages: 'external', logLevel: 'silent',
  })
  assertOptionalBundle(result.metafile)
  await writeFile(new URL(`./dist/${name}.meta.json`, import.meta.url), JSON.stringify(result.metafile, null, 2))
}
console.log('Built optional companion, memory and application entry points.')
