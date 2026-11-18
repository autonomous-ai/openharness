import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extensionVersion } from './vscodeExtensionBundle.mjs'

const ROOT = fileURLToPath(new URL('../../../plugins/harness-device-orca/', import.meta.url))

/** JSON of { [path relative to the plugin]: text }: the manifest at the build's version, and each source that is not a test. */
export function readOrcaPluginBundle(version) {
  const manifest = { ...JSON.parse(readFileSync(join(ROOT, 'orca-plugin.json'), 'utf8')), version: extensionVersion(version) }
  const files = { 'orca-plugin.json': `${JSON.stringify(manifest, null, 2)}\n` }
  const sources = readdirSync(join(ROOT, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !/\.test\.tsx?$/.test(entry.name))
    // Posix keys, so a build on Windows carries the same JSON.
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
  for (const path of sources) files[path] = readFileSync(join(ROOT, path), 'utf8')
  return JSON.stringify(files)
}
