/** One trusted generic decoder literal; it never depends on the selected mutable CLI. */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

export async function workerPreparer() {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const built = await build({ absWorkingDir: root, stdin: { resolveDir: root, sourcefile: 'artifact-preparer-entry.ts',
    contents: "import { prepareArtifact } from './src/harnessd/executionArtifactChild.js'; process.stdout.write(JSON.stringify(prepareArtifact(__HARNESSD_PREPARATION_REQUEST__)) + '\\n')" },
    bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false, metafile: true, minify: true, logLevel: 'silent' })
  const allowed = ['artifact-preparer-entry.ts', 'src/harnessd/executionArtifactChild.ts', 'src/harnessd/executionArtifacts.ts',
    'src/harnessd/leanBundle.ts', 'src/harnessd/bundleFingerprint.ts']
  const inputs = Object.keys(built.metafile.inputs)
  if (inputs.length !== allowed.length || inputs.some(file => !allowed.includes(file))) throw new Error('worker preparer source closure changed')
  const imports = Object.values(built.metafile.outputs).flatMap(output => output.imports.map(item => item.path))
  if (imports.some(name => !['node:crypto', 'node:fs', 'node:path', 'node:os', 'node:zlib'].includes(name))) throw new Error('worker preparer import refused')
  const source = built.outputFiles[0].text
  if (Buffer.byteLength(source) > 128 * 1024) throw new Error('worker preparer exceeds 128KiB')
  return source
}
