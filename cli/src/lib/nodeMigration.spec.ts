import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { NODE_MIGRATION_FILE, failedNode, nodeMigration, recordNodeMigration, settleNodeMigration } from './nodeMigration.js'

describe('the node migration record', () => {
  let dir = ''
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const fresh = (): string => (dir = mkdtempSync(join(tmpdir(), 'node-migration-')))

  it('keeps the Node that failed through later reasons, until nothing holds the daemon back', () => {
    fresh()
    recordNodeMigration(dir, 'rolled-back', '/h/runtime/node-v24.22.2-darwin-arm64/bin/node')
    // A later update that could not reach the manifest must not forget which Node failed here.
    recordNodeMigration(dir, 'manifest-unreachable')
    expect(nodeMigration(dir)).toBe('manifest-unreachable')
    expect(failedNode(dir)).toBe('/h/runtime/node-v24.22.2-darwin-arm64/bin/node')
    recordNodeMigration(dir, null)
    expect(existsSync(join(dir, NODE_MIGRATION_FILE))).toBe(false)
    expect(failedNode(dir)).toBeNull()
  })

  it('is cleared by a core that runs on Node 24, and kept by one below it', () => {
    fresh()
    recordNodeMigration(dir, 'rolled-back', '/h/runtime/node-v24.22.2-darwin-arm64/bin/node')
    settleNodeMigration(dir, '22.23.2')
    expect(nodeMigration(dir)).toBe('rolled-back')
    settleNodeMigration(dir, '24.22.2')
    expect(existsSync(join(dir, NODE_MIGRATION_FILE))).toBe(false)
  })
})
