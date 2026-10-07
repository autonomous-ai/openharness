import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gridInUse, wakeModels } from './modelsWake.js'

describe('grid in use on this computer, which starts models\' process with the core', () => {
  let root: string
  let dataDir: string
  let runtimeDir: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'models-wake-'))
    dataDir = join(root, 'data')
    runtimeDir = join(root, 'runtime')
    mkdirSync(dataDir)
    mkdirSync(runtimeDir)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('is none on a computer that never used grid: no managed grid, no pictures, no local models', () => {
    expect(gridInUse({ dataDir, runtimeDir })).toBeNull()
    // Folders that are there and hold nothing of grid's are no use of it either.
    mkdirSync(join(dataDir, 'grid-pictures'))
    writeFileSync(join(dataDir, 'grid-pictures', 'notes.txt'), '')
    mkdirSync(join(dataDir, 'local-models'))
    expect(gridInUse({ dataDir, runtimeDir })).toBeNull()
  })

  it('is a managed grid, whose pin models follows', () => {
    writeFileSync(join(runtimeDir, 'current-grid'), '/runtime/grid-1/bin/grid\n')
    expect(gridInUse({ dataDir, runtimeDir })).toBe('a managed grid')
  })

  it('is a saved grid picture, which agents\' grid notes are read from', () => {
    mkdirSync(join(dataDir, 'grid-pictures'))
    writeFileSync(join(dataDir, 'grid-pictures', 'own.json'), '{}')
    expect(gridInUse({ dataDir, runtimeDir })).toBe('saved grid pictures')
  })

  it('is the Model Manager\'s local models', () => {
    mkdirSync(join(dataDir, 'local-models'))
    writeFileSync(join(dataDir, 'local-models', 'operations.json'), '[]')
    expect(gridInUse({ dataDir, runtimeDir })).toBe('local models')
  })

  it('reads through what it is given, and a folder it cannot list holds nothing', () => {
    expect(gridInUse({ dataDir: '/d', runtimeDir: '/r', exists: () => false, list: () => { throw new Error('EACCES') } })).toBeNull()
    expect(gridInUse({ dataDir: '/d', runtimeDir: '/r', exists: () => false, list: (folder) => (folder === '/d/local-models' ? ['a'] : []) })).toBe('local models')
  })
})

describe('models\' process asked for as the core starts', () => {
  const inUse = { dataDir: '/d', runtimeDir: '/r', exists: (path: string) => path === '/r/current-grid', list: () => [] }

  it('when it runs out here and grid is in use, saying why', () => {
    const wanted: string[] = []
    const lines: string[] = []
    wakeModels({ ...inUse, outOfProcess: new Set(['models']), want: (service) => wanted.push(service), log: (line) => lines.push(line) })
    expect(wanted).toEqual(['models'])
    expect(lines).toEqual(['[models] a managed grid: asking for models\' process'])
  })

  it('not when grid is not in use, nor when models runs in the core\'s process', () => {
    const wanted: string[] = []
    wakeModels({ ...inUse, exists: () => false, outOfProcess: new Set(['models']), want: (service) => wanted.push(service) })
    wakeModels({ ...inUse, outOfProcess: new Set(['search']), want: (service) => wanted.push(service) })
    expect(wanted).toEqual([])
  })

  it('says why on the console by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      wakeModels({ ...inUse, outOfProcess: new Set(['models']), want: () => {} })
      expect(log).toHaveBeenCalledWith('[models] a managed grid: asking for models\' process')
    } finally { log.mockRestore() }
  })
})
