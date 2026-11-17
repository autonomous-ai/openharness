/** Build only. The coordinator reviews the emitted closure before scheduling a quiet measurement.
 * node scripts/build-client-stream-benchmark.mjs <cli source tree> <new output directory>
 */
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = resolve(process.argv[2] ?? ''), output = resolve(process.argv[3] ?? '')
if (!process.argv[2] || !process.argv[3] || !existsSync(join(source, 'src/core/api.ts')) || existsSync(output)) {
  throw new Error('Supply a CLI source tree and a new private output directory')
}
mkdirSync(output, { recursive: true })
const shared = existsSync(join(source, 'src/core/clientStreams.ts'))
const harness = join(dirname(fileURLToPath(import.meta.url)), 'client-stream-benchmark.ts')
const imports = shared
  ? `import { createClientStreams } from ${JSON.stringify(join(source, 'src/core/clientStreams.ts'))};
import { createClientStreamQueue } from ${JSON.stringify(join(source, 'src/lib/clientStreamQueue.ts'))};`
  : `import { createBrowserStreams } from ${JSON.stringify(join(source, 'src/core/browserStreams.ts'))};
import { createViewerStreams } from ${JSON.stringify(join(source, 'src/core/viewerStreams.ts'))};
import { createViewersLink } from ${JSON.stringify(join(source, 'src/core/viewersLink.ts'))};`
const entry = `${imports}
import { encodeTerminalLocal } from ${JSON.stringify(join(source, 'src/lib/terminalBinary.ts'))};
import { run } from ${JSON.stringify(harness)};
run({ variant: ${JSON.stringify(shared ? 'shared' : 'baseline')}, encodeTerminalLocal,
  ${shared ? 'createClientStreams, createClientStreamQueue' : 'createBrowserStreams, createViewerStreams, createViewersLink'} });
`
const entryPath = join(output, 'entry.ts')
writeFileSync(entryPath, entry, { flag: 'wx' })
const result = await build({ entryPoints: [entryPath],
  absWorkingDir: source, outfile: join(output, 'measure.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', metafile: true,
  // CJS dependencies that esbuild retains must see Node's real require; no runtime source loader is used.
  banner: { js: "import { createRequire as __requireFactory } from 'node:module'; const require = __requireFactory(import.meta.url);" },
})
const sha256 = value => createHash('sha256').update(value).digest('hex')
const external = [...new Set(Object.values(result.metafile.outputs).flatMap(value => value.imports.filter(each => each.external).map(each => each.path)))].sort()
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
if (external.some(name => !builtins.has(name))) throw new Error(`Unbundled runtime dependency: ${external.join(', ')}`)
const inputs = Object.keys(result.metafile.inputs).map(name => {
  const path = resolve(source, name)
  return { path, sha256: sha256(readFileSync(path)) }
}).sort((a, b) => a.path.localeCompare(b.path))
const manifest = { source, variant: shared ? 'shared' : 'baseline', entrySha256: sha256(entry),
  builder: { path: fileURLToPath(import.meta.url), sha256: sha256(readFileSync(fileURLToPath(import.meta.url))) },
  node: { path: process.execPath, version: process.version, sha256: sha256(readFileSync(process.execPath)) },
  inputs, external, outputSha256: sha256(readFileSync(join(output, 'measure.mjs'))),
  requiredRuntime: 'Run with --expose-gc and isolated HOME, ADAPTER_DATA_DIR, ADAPTER_RUNTIME_DIR, HARNESS_TEST_ISOLATED=1; stdout is the result. No daemon or socket is started.',
}
writeFileSync(join(output, 'closure.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
writeFileSync(join(output, 'metafile.json'), JSON.stringify(result.metafile, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ variant: manifest.variant, source, files: inputs.length, output, outputSha256: manifest.outputSha256 }))
