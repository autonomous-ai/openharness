import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Ship the manager itself with the CLI. No clone, package manager, or model
// download is needed to make its conversation and viewer available.
export function readModelManagerBundle(root) {
  return readBuiltinBundle(root, ['harness.json', 'AGENTS.md', 'LICENSE', 'VERSIONS', 'viewer.sh', 'viewer.mjs', 'viewer', 'lib', 'toolchain', 'template', 'skills'])
}

export function readHarnessMonitorBundle(root) {
  return readBuiltinBundle(root, ['harness.json', 'AGENTS.md', 'LICENSE', 'package.json', 'viewer.sh', 'viewer.mjs', 'viewer', 'lib', 'toolchain', 'template', 'skills'])
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
