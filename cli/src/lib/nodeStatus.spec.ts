import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { nodeRow, nodeStatus, readNodeStatus } from './nodeStatus.js'

const REASONS = {
  'no-manifest-entry': 'no Node 24 for this computer yet',
  'manifest-unreachable': 'could not reach the update server',
  'download-failed': 'the download failed',
  'does-not-run': 'Node 24 did not start here',
  unmanaged: 'this Harness runs on a Node it does not manage; install Node 24',
  'rolled-back': 'Node 24 did not come up; back on 22',
} as const

describe('nodeRow', () => {
  it('shows the version alone when nothing held the daemon back', () => {
    expect(nodeRow({ version: 'v24.22.2', managed: true, migration: null })).toBe('v24.22.2')
  })

  for (const [migration, copy] of Object.entries(REASONS)) {
    it(`says why it stays on 22: ${migration}`, () => {
      expect(nodeRow({ version: 'v22.23.2', managed: true, migration: migration as keyof typeof REASONS }, false)).toBe(`v22.23.2 (stays on 22: ${copy})`)
    })
  }

  it('sends a Harness OS computer to its own update for a newer Node', () => {
    expect(nodeRow({ version: 'v22.23.2', managed: false, migration: 'unmanaged' }, true))
      .toBe('v22.23.2 (stays on 22: this Harness runs on the Node of Harness OS; update Harness OS)')
  })
})

describe('nodeStatus', () => {
  const dirWith = (reason?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'node-status-'))
    if (reason) writeFileSync(join(dir, 'node-migration.json'), JSON.stringify({ reason }))
    return dir
  }

  it('reads the recorded reason and whether the Node sits in the runtime folder', () => {
    expect(nodeStatus({ version: 'v22.23.2', execPath: '/h/runtime/node-v22.23.2-linux-x64/bin/node', runtimeDir: '/h/runtime', cliDir: dirWith('download-failed') }))
      .toEqual({ version: 'v22.23.2', managed: true, migration: 'download-failed' })
    expect(nodeStatus({ version: 'v22.23.2', execPath: '/usr/bin/node', runtimeDir: '/h/runtime', cliDir: dirWith() }))
      .toEqual({ version: 'v22.23.2', managed: false, migration: null })
  })

  it('names no reason once the daemon is on Node 24, whatever an earlier update recorded', () => {
    expect(nodeStatus({ version: 'v24.22.2', execPath: '/h/runtime/node-v24.22.2-linux-x64/bin/node', runtimeDir: '/h/runtime', cliDir: dirWith('rolled-back') }))
      .toEqual({ version: 'v24.22.2', managed: true, migration: null })
  })
})

describe('readNodeStatus', () => {
  it('keeps nothing from a daemon too old to report it', () => {
    expect(readNodeStatus({})).toBeNull()
    expect(readNodeStatus({ node: { version: 5 } })).toBeNull()
    expect(readNodeStatus({ node: { version: 'v22.1.0', managed: false, migration: 'bogus' } })).toEqual({ version: 'v22.1.0', managed: false, migration: null })
  })
})
