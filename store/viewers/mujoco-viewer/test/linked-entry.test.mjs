import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PACKAGE, startViewer } from './helpers.mjs'

test('a linked package entry starts the real viewer instead of silently exiting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mujoco-linked-entry-'))
  const workspace = join(root, 'project'),
    linked = join(root, 'linked-package')
  mkdirSync(workspace)
  symlinkSync(PACKAGE, linked, 'dir')
  let viewer
  try {
    viewer = await startViewer({
      entry: join(linked, 'viewer.mjs'),
      env: { HARNESS_WORKSPACE: workspace }
    })
    assert.equal((await viewer.get('/')).status, 200)
    assert.equal((await viewer.get('/api/models')).status, 200)
  } finally {
    await viewer?.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
