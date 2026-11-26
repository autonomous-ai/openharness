import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extensionVersion } from './vscodeExtensionBundle.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
/** pluginFolder.ts's SEGMENT: the folder writer takes no other name, so a build that carried one would never
 *  install. */
const SEGMENT = /^[A-Za-z0-9._-]+$/
const MARKETPLACE = '.claude-plugin/marketplace.json'
const MANIFEST = '.claude-plugin/plugin.json'
/** What Claude Code installs of each plugin, by path inside it; a trailing `/` is a folder carried whole. Never the
 *  device plugin's tests, Codex's and Cursor's manifests, or Cursor's `mcp.json` (Claude Code reads `.mcp.json`). */
const PLUGINS = {
  'plugins/harness-device': [MANIFEST, 'hooks/', 'README.md'],
  'plugins/harness': [MANIFEST, '.mcp.json', 'skills/', 'assets/', 'README.md'],
}
/** Claude Code runs the device plugin's hook by its path, so the folder must write it executable. */
const EXECUTABLE = ['plugins/harness-device/hooks/asked']
/** Fatal, so a file that is not UTF-8 fails the build rather than ship mangled; the BOM kept, as `readFileSync`'s
 *  `utf8` keeps it. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** The text of [key] under [root]; throws on a name the folder would not take, or bytes that are not UTF-8. */
function readText(root, key) {
  if (!key.split('/').every((segment) => SEGMENT.test(segment))) {
    throw new Error(`${key}: Claude Code's marketplace folder takes only letters, digits, '.', '_' and '-' in a name`)
  }
  try {
    return UTF8.decode(readFileSync(join(root, key)))
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`${key}: Claude Code's marketplace carries only UTF-8 text`)
    throw error
  }
}

/** The marketplace's text; throws when it lists a plugin from anywhere but a folder the build carries, as Claude Code
 *  installs each from where the marketplace says, and would find nothing of it in Harness's folder. */
function marketplaceText(root) {
  const text = readText(root, MARKETPLACE)
  const carried = Object.keys(PLUGINS).map((plugin) => `./${plugin}`)
  for (const { name, source } of JSON.parse(text).plugins) {
    if (!carried.includes(source)) throw new Error(`${MARKETPLACE}: ${name} is not from a folder this build carries (${carried.join(', ')})`)
  }
  return text
}

/** JSON of { files: { [path in the marketplace folder]: text }, executable: string[] }: the repository's marketplace,
 *  and of each plugin the files Claude Code installs, its `plugin.json` at the build's version plus a hash of the
 *  plugin's files, so Claude Code sees a new version whenever they change, even between two builds of one version.
 *  [root] is the repository's root; a test hands its own. Throws on a name the folder writer would not take, a file
 *  that is not UTF-8 text, or a marketplace plugin the build does not carry. */
export function readClaudePluginBundle(version, root = REPO_ROOT) {
  const files = { [MARKETPLACE]: marketplaceText(root) }
  for (const [plugin, include] of Object.entries(PLUGINS)) {
    const paths = include.flatMap((entry) => !entry.endsWith('/') ? [entry]
      : readdirSync(join(root, plugin, entry), { recursive: true, withFileTypes: true })
        .filter((dirent) => dirent.isFile())
        // Posix keys, so a build on Windows carries the same JSON.
        .map((dirent) => relative(join(root, plugin), join(dirent.parentPath, dirent.name)).split(sep).join('/')))
      .sort()
    const texts = paths.map((path) => [path, readText(root, `${plugin}/${path}`)])
    const hash = createHash('sha256').update(JSON.stringify(texts)).digest('hex').slice(0, 8)
    for (const [path, text] of texts) files[`${plugin}/${path}`] = text
    const manifest = { ...JSON.parse(files[`${plugin}/${MANIFEST}`]), version: `${extensionVersion(version)}+${hash}` }
    files[`${plugin}/${MANIFEST}`] = `${JSON.stringify(manifest, null, 2)}\n`
  }
  const sorted = Object.fromEntries(Object.keys(files).sort().map((key) => [key, files[key]]))
  return JSON.stringify({ files: sorted, executable: EXECUTABLE })
}
