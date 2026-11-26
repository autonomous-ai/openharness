import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import { CLI_ROOT } from './daemon.js'

/**
 * The `cli.js` a file's daemons and commands run: the run's bundle when there is one (E2E_BUNDLE=1), else one built for
 * the file, as it ships. A run from the sources carries no plugin: only a build inlines Orca's and Claude Code's
 * (`__ORCA_PLUGIN__`, `__CLAUDE_PLUGIN__`). Called at a file's top level; [path] is set before its first test.
 */
export function fileBundle(): { readonly path: string } {
  const bundle = { path: '' }
  let folder: string | null = null
  beforeAll(() => {
    if (process.env.E2E_BUNDLE_PATH) { bundle.path = process.env.E2E_BUNDLE_PATH; return }
    folder = mkdtempSync(join(tmpdir(), 'harness-file-bundle-'))
    execFileSync(process.execPath, ['build-bundle.mjs'], { cwd: CLI_ROOT, env: { ...process.env, BUNDLE_OUT_DIR: folder }, stdio: 'pipe' })
    bundle.path = join(folder, 'cli.js')
  }, 180_000)
  afterAll(() => { if (folder) rmSync(folder, { recursive: true, force: true }) })
  return bundle
}
