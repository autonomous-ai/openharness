import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Ship the manager itself with the CLI. No clone, package manager, or model
// download is needed to make its conversation and viewer available.
export function readModelManagerBundle(root) {
  const files = {}
  const visit = relative => {
    const path = join(root, relative)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(relative, name))
    } else {
      files[relative] = { content: readFileSync(path, 'utf8'), executable: Boolean(stat.mode & 0o111) }
    }
  }
  for (const path of ['harness.json', 'AGENTS.md', 'LICENSE', 'VERSIONS', 'viewer.sh', 'viewer.mjs', 'viewer', 'lib', 'toolchain', 'template', 'skills']) visit(path)
  return files
}
