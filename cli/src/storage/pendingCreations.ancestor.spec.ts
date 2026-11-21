import * as fs from 'node:fs'
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { localPendingCreationDiscovery } from '../testing/pendingCreation.js'

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }))

it('does not recreate the data root when it disappears immediately before creation-leaf mkdir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pending-ancestor-')), moved = `${root}-moved`
  const directory = join(root, 'agent-creations'), discovery = localPendingCreationDiscovery(directory)
  const mkdir = fs.mkdirSync
  let displaced = false
  const change = vi.spyOn(fs, 'mkdirSync').mockImplementation(((...args: Parameters<typeof mkdir>) => {
    if (args[0] === directory && !displaced) {
      renameSync(root, moved); displaced = true
    }
    return mkdir(...args)
  }) as typeof mkdir)
  try {
    await expect(discovery.ensure('pending-ancestor-fixture')).rejects.toThrow()
    expect(displaced).toBe(true)
    expect(existsSync(root)).toBe(false)
    expect(existsSync(join(moved, 'agent-creations'))).toBe(false)
  } finally {
    change.mockRestore()
    rmSync(root, { recursive: true, force: true })
    rmSync(moved, { recursive: true, force: true })
  }
})
