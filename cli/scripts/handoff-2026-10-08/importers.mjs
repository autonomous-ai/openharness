// Who imports each file in the core closure. Usage: node importers.mjs <cli dir> <regex>
import { createRequire } from 'node:module'
const { build } = createRequire(process.argv[2] + '/package.json')('esbuild')
const re = new RegExp(process.argv[3])
const result = await build({
  absWorkingDir: process.argv[2], entryPoints: ['src/core/main.ts'], bundle: true, platform: 'node', format: 'esm',
  packages: 'external', metafile: true, write: false, logLevel: 'error',
  plugins: [{ name: 'dyn', setup(b) { b.onResolve({ filter: /.*/ }, a => a.kind === 'dynamic-import' ? { path: a.path, external: true } : undefined) } }],
})
const by = new Map()
for (const [file, info] of Object.entries(result.metafile.inputs)) for (const imp of info.imports) {
  if (!imp.path.startsWith('src/')) continue
  if (!by.has(imp.path)) by.set(imp.path, new Set()); by.get(imp.path).add(file.slice(4))
}
for (const [file, from] of [...by].sort()) if (re.test(file.slice(4))) console.log(file.slice(4), '<-', [...from].join(', '))
