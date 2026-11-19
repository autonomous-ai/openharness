import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NODE_MIGRATION_FILE, failedNode, nodeMigration, recordNodeMigration, settleNodeMigration } from './nodeMigration.js'

// Pass-through, recording what reaches each file: opened, written, or renamed onto.
const disk = vi.hoisted(() => ({ events: [] as string[] }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => { disk.events.push(`open ${String(args[0])}`); return actual.openSync(...args) },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => { disk.events.push(`write ${String(args[0])}`); return actual.writeFileSync(...args) },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => { disk.events.push(`rename ${String(args[1])}`); return actual.renameSync(...args) },
  }
})

describe('the node migration record', () => {
  let dir = ''
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })
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

  it('the save goes through a temporary file renamed onto the target', () => {
    const file = join(fresh(), NODE_MIGRATION_FILE)
    disk.events = []
    recordNodeMigration(dir, 'rolled-back')
    expect(disk.events.filter((event) => event.endsWith(` ${file}`))).toEqual([`rename ${file}`])
  })

  it('a file at the old temporary name is left alone', () => {
    const planted = `${join(fresh(), NODE_MIGRATION_FILE)}.tmp`
    writeFileSync(planted, 'planted')
    recordNodeMigration(dir, 'rolled-back')
    expect(readFileSync(planted, 'utf8')).toBe('planted')
  })

  it('a torn node-migration.json is set aside, not written over', () => {
    const file = join(fresh(), NODE_MIGRATION_FILE)
    writeFileSync(file, '{"')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(nodeMigration(dir)).toBeNull()
    recordNodeMigration(dir, 'rolled-back')
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('{"')
    expect(nodeMigration(dir)).toBe('rolled-back')
    expect(warn).toHaveBeenCalledWith('[state] node-migration.json could not be read (not valid JSON); kept as node-migration.json.unreadable, starting empty.')
  })
})
