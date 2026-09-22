import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PACKAGE, startViewer } from './helpers.mjs'

for (const preserveLinks of [false, true])
  test(`a linked package entry starts the real viewer (preserve main symlink: ${preserveLinks})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'mujoco-linked-entry-'))
    const workspace = join(root, 'project'),
      linked = join(root, 'linked-package')
    mkdirSync(workspace)
    symlinkSync(PACKAGE, linked, 'dir')
    let viewer
    try {
      viewer = await startViewer({
        entry: join(linked, 'viewer.mjs'),
        env: {
          HARNESS_WORKSPACE: workspace,
          NODE_OPTIONS: preserveLinks ? '--preserve-symlinks-main' : null
        }
      })
      assert.equal((await viewer.get('/')).status, 200)
      assert.equal((await viewer.get('/api/models')).status, 200)
    } finally {
      await viewer?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
