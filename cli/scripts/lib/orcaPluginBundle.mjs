import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extensionVersion } from './vscodeExtensionBundle.mjs'

const ROOT = fileURLToPath(new URL('../../../plugins/harness-device-orca/', import.meta.url))
/** orcaPluginFolder.ts's SEGMENT: the folder writer takes no other name, so a build that carried one would never
 *  connect. */
const SEGMENT = /^[A-Za-z0-9._-]+$/

/** JSON of { [path relative to the plugin]: text }: the manifest at the build's version, and each `.ts` and `.tsx`
 *  source that is not a test, the only files Orca runs. [root] is the plugin's folder; a test hands its own. Throws on
 *  a name the plugin's folder would not take. */
export function readOrcaPluginBundle(version, root = ROOT) {
  const manifest = { ...JSON.parse(readFileSync(join(root, 'orca-plugin.json'), 'utf8')), version: extensionVersion(version) }
  const files = { 'orca-plugin.json': `${JSON.stringify(manifest, null, 2)}\n` }
  const sources = readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
    // Posix keys, so a build on Windows carries the same JSON.
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
  for (const path of sources) {
    if (!path.split('/').every((segment) => SEGMENT.test(segment))) {
      throw new Error(`harness-device-orca/${path}: the plugin's folder takes only letters, digits, '.', '_' and '-' in a name`)
    }
    files[path] = readFileSync(join(root, path), 'utf8')
  }
  return JSON.stringify(files)
}
