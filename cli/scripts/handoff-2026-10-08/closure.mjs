// Measure the core's static import closure: esbuild from core/main.ts, every import() external.
// Usage: node closure.mjs <cli dir> [--list]
import { createRequire } from 'node:module'
const { build } = createRequire(process.argv[2] + '/package.json')('esbuild')
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
const cli = process.argv[2]
const src = join(cli, 'src')
const result = await build({
  absWorkingDir: cli, entryPoints: ['src/core/main.ts'], bundle: true, platform: 'node', format: 'esm',
  packages: 'external', metafile: true, write: false, logLevel: 'error',
  plugins: [{ name: 'dyn', setup(b) { b.onResolve({ filter: /.*/ }, a => a.kind === 'dynamic-import' ? { path: a.path, external: true } : undefined) } }],
})
const files = Object.keys(result.metafile.inputs).filter(f => f.startsWith('src/'))
let lines = 0
const per = []
for (const f of files) { const n = readFileSync(join(cli, f), 'utf8').split('\n').length; lines += n; per.push([f.slice(4), n]) }
const others = /^(engines\/(opencode|cursor|kilo|devin|hermes|amp|agy|grok|copilot|commandcode|muse|pi)\/|lib\/sessionSearch\/externals\/(opencode|cursor|kilo|devin|hermes|amp|agy|grok|copilot|commandcode|muse|pi)\.ts$|lib\/(hooks|questionPane|legacyScreen|legacyPane|hermesHome|databaseHistory|transcriptReader)\.ts$|engines\/kit\/screen\.ts$|core\/engines\/cursorTasks\.ts$|core\/turns\/agyBackstop\.ts$|core\/transcripts\/databaseHistory\.ts$)/
const theirs = per.filter(([f]) => others.test(f))
console.log(JSON.stringify({ lines, files: files.length, theirLines: theirs.reduce((s, [, n]) => s + n, 0), theirFiles: theirs.length }))
if (process.argv.includes('--list')) for (const [f, n] of per.sort()) console.log(n, f)
if (process.argv.includes('--theirs')) for (const [f, n] of theirs.sort()) console.log(n, f)
