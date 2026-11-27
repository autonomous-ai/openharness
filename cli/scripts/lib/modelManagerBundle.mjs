import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Ship the manager itself with the CLI. No clone, package manager, or model
// download is needed to make its conversation and viewer available.
export function readModelManagerBundle(root) {
  return readBuiltinBundle(root, ['harness.json', 'AGENTS.md', 'LICENSE', 'VERSIONS', 'viewer.sh', 'viewer.mjs', 'viewer', 'lib', 'toolchain', 'template', 'skills'])
}

export function readHarnessMonitorBundle(root) {
  return readBuiltinBundle(root, ['harness.json', 'AGENTS.md', 'LICENSE', 'package.json', 'viewer.sh', 'viewer.mjs', 'viewer', 'lib', 'toolchain', 'template', 'skills'])
}

/** Memories: everything the harness and its `mem` command run on; its tests and Store page stay behind. */
export function readMemoriesBundle(root) {
  return readBuiltinBundle(root, ['harness.json', 'AGENTS.md', 'LICENSE', 'README.md', 'package.json', 'viewer.sh', 'viewer.mjs', 'viewer', 'lib', 'toolchain', 'template', 'skills'])
}

/** Hachi: its instructions and workspace template, and the `harness` skill. The skill's one copy is the plugin's
 *  (plugins/harness/skills/harness), added here as the package's `skills/harness/SKILL.md`: a second copy in the
 *  package would drift from it, and a link to it is a plain text file in a checkout without symlinks (Windows). */
export function readHachiBundle(root) {
  const files = readBuiltinBundle(root, ['harness.json', 'AGENTS.md', 'LICENSE', 'README.md', 'template'])
  const skill = readBuiltinBundle(fileURLToPath(new URL('../../../plugins/harness/skills/harness', import.meta.url)), ['SKILL.md'])
  files['skills/harness/SKILL.md'] = skill['SKILL.md']
  return files
}

export function readBuiltinBundle(root, paths) {
  const files = {}
  const visit = relative => {
    const path = join(root, relative)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(relative, name))
    } else {
      const bytes = readFileSync(path)
      const text = bytes.toString('utf8')
      const binary = !Buffer.from(text, 'utf8').equals(bytes)
      files[relative] = { content: binary ? bytes.toString('base64') : text,
        ...(binary ? { encoding: 'base64' } : {}), executable: Boolean(stat.mode & 0o111) }
    }
  }
  for (const path of paths) visit(path)
  return files
}
