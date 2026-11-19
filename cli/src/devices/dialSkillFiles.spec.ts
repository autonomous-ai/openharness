/**
 * The two files of the dial skill, in a throwaway data folder each: dial-skill.json, what `disable` removed and the
 * folders the command wrote into, and dial-setup.json, the devices service's record of a dial's setup. A later
 * `disable` removes from every folder a list holds, so a damaged or hand-edited list must read as nothing it may not
 * hold.
 */
import * as fs from 'node:fs'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DIAL_SETUP_FILE, DIAL_SKILL_FILE, MAX_HOMES, listable, readOrcaConnected, readPluginHomes, readRemoved, readSetup, readWritten, writeOrcaConnected, writePluginHomes, writeRemoved, writeSetup } from './dialSkillFiles.js'

// A copy of the module, so a test can watch the file calls a write makes.
vi.mock('node:fs', async (original) => ({ ...await original<object>() }))

const folders: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const folder of folders.splice(0)) {
    // A test made it read-only: open it again so it can be removed.
    chmodSync(folder, 0o700)
    rmSync(folder, { recursive: true, force: true })
  }
})

function aDataDir(): string {
  const folder = mkdtempSync(join(tmpdir(), 'dial-skill-files-'))
  folders.push(folder)
  return folder
}

/** [count] good, distinct skills folders. */
const goodHomes = (count: number): string[] => Array.from({ length: count }, (_, i) => `/Users/someone/home ${i}/skills`)

describe('the skills folders Harness wrote into', () => {
  it('a list keeps only absolute, normalised paths, at most 64 an engine', () => {
    const dataDir = aDataDir()
    const good = goodHomes(70)
    const kept = [
      '/Users/someone/Library/Application Support/orca/ä/skills',
      ...good,
    ]
    const bad = [
      'relative/skills',
      '/Users/someone/../other/skills',
      '/Users/someone/./skills',
      '/Users/someone/skills/',
      '/Users/some\none/skills',
      '/Users/some\u0085one/skills',
      `/${'a'.repeat(1999)}`,
      // Under 1024 letters, over 1024 bytes.
      `/${'é'.repeat(600)}`,
      42,
      null,
    ]
    writeFileSync(join(dataDir, DIAL_SETUP_FILE), JSON.stringify({ homes: {
      claude: [bad[0], kept[0], ...bad.slice(1), kept[0], ...kept.slice(1)],
      codex: 'not a list',
    } }))
    expect(readSetup(dataDir).homes).toEqual({ claude: kept.slice(0, MAX_HOMES), codex: [] })
    expect(MAX_HOMES).toBe(64)
    // A path of exactly 1024 bytes is kept.
    const longest = `/${'a'.repeat(1023)}`
    writeFileSync(join(dataDir, DIAL_SETUP_FILE), JSON.stringify({ homes: { claude: [], codex: [longest] } }))
    expect(readSetup(dataDir).homes).toEqual({ claude: [], codex: [longest] })
  })

  it('a file at 256 KiB still reads: two full lists of the longest paths fit under it', () => {
    const dataDir = aDataDir()
    const record = '{"dial":true,"pad":""}'
    writeFileSync(join(dataDir, DIAL_SETUP_FILE), record.replace('""', `"${'x'.repeat(256 * 1024 - record.length)}"`))
    expect(readSetup(dataDir).dial).toBe(true)
    writeFileSync(join(dataDir, DIAL_SETUP_FILE), record.replace('""', `"${'x'.repeat(256 * 1024 + 1 - record.length)}"`))
    expect(readSetup(dataDir).dial).toBe(false)
  })

  it('listable: the one check of a path a list holds', () => {
    for (const path of ['/Users/someone/.codex/skills', '/Users/someone/Library/Application Support/orca/ä/skills', `/${'a'.repeat(1023)}`]) {
      expect(listable(path), path).toBe(true)
    }
    for (const path of ['relative/skills', '/Users/someone/../skills', '/Users/someone/skills/', '/Users/some\u0085one/skills', `/${'é'.repeat(600)}`]) {
      expect(listable(path), JSON.stringify(path)).toBe(false)
    }
  })
})

describe('what disable removed', () => {
  it('the old menu\'s answers are not read', () => {
    const dataDir = aDataDir()
    expect(readRemoved(dataDir)).toEqual({})
    writeFileSync(join(dataDir, DIAL_SKILL_FILE), '{"claude":false,"codex":true}')
    expect(readRemoved(dataDir)).toEqual({})
    // Only true is a removal.
    writeFileSync(join(dataDir, DIAL_SKILL_FILE), '{"removed":{"claude":"yes","codex":true,"vscode":1}}')
    expect(readRemoved(dataDir)).toEqual({ codex: true })
    writeFileSync(join(dataDir, DIAL_SKILL_FILE), '{"removed":{"vscode":true}}')
    expect(readRemoved(dataDir)).toEqual({ vscode: true })
    for (const text of ['not json', '[]', '{"removed":[true]}']) {
      writeFileSync(join(dataDir, DIAL_SKILL_FILE), text)
      expect(readRemoved(dataDir), text).toEqual({})
    }
  })

  it('a removal is saved, cleared, and keeps the folders the command wrote; the old answers leave the file', () => {
    const dataDir = aDataDir()
    const file = (): unknown => JSON.parse(readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8'))
    writeFileSync(join(dataDir, DIAL_SKILL_FILE), '{"codex":false,"homes":{"claude":[],"codex":["/a/skills"]}}')
    expect(writeRemoved(dataDir, 'codex', true)).toBeUndefined()
    expect(file()).toEqual({ removed: { codex: true }, homes: { claude: [], codex: ['/a/skills'] } })
    expect(statSync(join(dataDir, DIAL_SKILL_FILE)).mode & 0o777).toBe(0o600)
    // The other engine's removal stays, and [written] becomes that engine's folders.
    expect(writeRemoved(dataDir, 'claude', true, ['/b/skills', 'relative/skills'])).toBeUndefined()
    expect(readRemoved(dataDir)).toEqual({ claude: true, codex: true })
    expect(readWritten(dataDir)).toEqual({ claude: ['/b/skills'], codex: ['/a/skills'] })
    writeRemoved(dataDir, 'claude', false, [])
    writeRemoved(dataDir, 'codex', false, [])
    expect(file()).toEqual({})
    expect(readdirSync(dataDir)).toEqual([DIAL_SKILL_FILE])
  })

  it('VS Code\'s removal is saved and cleared beside the engines\', which keep theirs and their folders', () => {
    const dataDir = aDataDir()
    const file = (): unknown => JSON.parse(readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8'))
    writeRemoved(dataDir, 'codex', true, ['/a/skills'])
    expect(writeRemoved(dataDir, 'vscode', true)).toBeUndefined()
    expect(readRemoved(dataDir)).toEqual({ codex: true, vscode: true })
    expect(readWritten(dataDir)).toEqual({ claude: [], codex: ['/a/skills'] })
    writeRemoved(dataDir, 'codex', false, [])
    expect(file()).toEqual({ removed: { vscode: true } })
    writeRemoved(dataDir, 'vscode', false)
    expect(file()).toEqual({})
  })

  it('removed.cursor: only true is a removal, and alone it still keeps removed in the file', () => {
    const dataDir = aDataDir()
    const file = (): unknown => JSON.parse(readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8'))
    writeFileSync(join(dataDir, DIAL_SKILL_FILE), '{"removed":{"cursor":1}}')
    expect(readRemoved(dataDir)).toEqual({})
    expect(writeRemoved(dataDir, 'cursor', true)).toBeUndefined()
    expect(file()).toEqual({ removed: { cursor: true } })
    expect(writeRemoved(dataDir, 'vscode', true)).toBeUndefined()
    expect(readRemoved(dataDir)).toEqual({ vscode: true, cursor: true })
    writeRemoved(dataDir, 'cursor', false)
    expect(file()).toEqual({ removed: { vscode: true } })
  })

  it('a removal of Cursor writes no skills folder, as VS Code\'s writes none', () => {
    const dataDir = aDataDir()
    const file = (): unknown => JSON.parse(readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8'))
    expect(writeRemoved(dataDir, 'cursor', true, ['/a/skills'])).toBeUndefined()
    expect(readWritten(dataDir)).toEqual({ claude: [], codex: [] })
    // With an engine's folders in the file, the homes it holds are still the engines' alone.
    writeRemoved(dataDir, 'claude', true, ['/b/skills'])
    expect(writeRemoved(dataDir, 'cursor', true, ['/a/skills'])).toBeUndefined()
    expect(file()).toEqual({ removed: { claude: true, cursor: true }, homes: { claude: ['/b/skills'], codex: [] } })
  })

  it('removed.orca: only true is a removal; saved and cleared beside the editors\', and every write keeps orcaConnected', () => {
    const dataDir = aDataDir()
    const file = (): unknown => JSON.parse(readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8'))
    writeFileSync(join(dataDir, DIAL_SKILL_FILE), '{"removed":{"orca":1},"orcaConnected":true}')
    expect(readRemoved(dataDir)).toEqual({})

    // Alone, it still keeps removed in the file: lost, the devices would install the plugin again.
    expect(writeRemoved(dataDir, 'orca', true)).toBeUndefined()
    expect(file()).toEqual({ removed: { orca: true }, orcaConnected: true })
    expect(writeRemoved(dataDir, 'vscode', true)).toBeUndefined()
    expect(readRemoved(dataDir)).toEqual({ vscode: true, orca: true })

    expect(writeRemoved(dataDir, 'orca', false)).toBeUndefined()
    expect(file()).toEqual({ removed: { vscode: true }, orcaConnected: true })
    // Orca's removal writes no skills folder, as an editor's writes none.
    expect(writeRemoved(dataDir, 'orca', true, ['/a/skills'])).toBeUndefined()
    expect(file()).toEqual({ removed: { vscode: true, orca: true }, orcaConnected: true })
  })
})

describe('the devices\' record of a dial\'s setup', () => {
  const empty = { dial: false, homes: { claude: [], codex: [] }, pluginHomes: [] }

  it('a missing, damaged or oversized dial-setup.json is an empty record', () => {
    const dataDir = aDataDir()
    expect(readSetup(dataDir)).toEqual(empty)
    for (const text of ['not json', '[]', 'null', '{"dial":"true","homes":"/Users/someone/skills"}']) {
      writeFileSync(join(dataDir, DIAL_SETUP_FILE), text)
      expect(readSetup(dataDir), text).toEqual(empty)
    }
    // A good record, padded past 256 KiB.
    writeFileSync(join(dataDir, DIAL_SETUP_FILE), JSON.stringify({ dial: true, plugin: '0.6.59', homes: { claude: goodHomes(1), codex: [] }, pad: 'x'.repeat(256 * 1024) }))
    expect(readSetup(dataDir)).toEqual(empty)
  })

  it('the record is written whole, 0600: the dial, the plugin\'s version, 64 listable folders an engine at most', () => {
    const dataDir = aDataDir()
    const many = goodHomes(70)
    expect(writeSetup(dataDir, { dial: true, plugin: '0.6.59', homes: { claude: ['relative/skills', ...many], codex: ['/Users/someone/.codex/skills'] }, pluginHomes: [] })).toBeUndefined()
    const record = { dial: true, plugin: '0.6.59', homes: { claude: many.slice(0, MAX_HOMES), codex: ['/Users/someone/.codex/skills'] }, pluginHomes: [] }
    expect(readSetup(dataDir)).toEqual(record)
    // The file holds no more than a read keeps.
    expect(JSON.parse(readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8'))).toEqual(record)
    expect(statSync(join(dataDir, DIAL_SETUP_FILE)).mode & 0o777).toBe(0o600)
    expect(readdirSync(dataDir)).toEqual([DIAL_SETUP_FILE])
    // A record with no plugin holds none.
    writeSetup(dataDir, { dial: true, homes: { claude: [], codex: [] }, pluginHomes: [] })
    expect(JSON.parse(readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8'))).toEqual({ dial: true, homes: { claude: [], codex: [] }, pluginHomes: [] })
  })

  it('a plugin value that is no version is dropped', () => {
    const dataDir = aDataDir()
    for (const plugin of [true, 659, '', '../x', '0.6.59 beta', 'v'.repeat(65)]) {
      writeFileSync(join(dataDir, DIAL_SETUP_FILE), JSON.stringify({ dial: true, plugin }))
      expect(readSetup(dataDir), String(plugin)).toEqual({ dial: true, homes: { claude: [], codex: [] }, pluginHomes: [] })
    }
    for (const plugin of ['0.6.59', '0.6.59-dev.3+1a2b', 'v'.repeat(64)]) {
      writeFileSync(join(dataDir, DIAL_SETUP_FILE), JSON.stringify({ dial: true, plugin }))
      expect(readSetup(dataDir).plugin, plugin).toBe(plugin)
    }
  })

  it('the VS Code extension\'s version is kept beside the plugin\'s; one that is no version is dropped, and not saved', () => {
    const dataDir = aDataDir()
    const homes = { claude: [], codex: [] }
    expect(writeSetup(dataDir, { dial: true, plugin: '0.6.59', vscode: '0.6.60-dev.g0123', homes, pluginHomes: [] })).toBeUndefined()
    expect(readSetup(dataDir)).toEqual({ dial: true, plugin: '0.6.59', vscode: '0.6.60-dev.g0123', homes, pluginHomes: [] })
    const record = readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')
    // Saved, the extension would read as never set up, and be installed again.
    expect(writeSetup(dataDir, { dial: true, vscode: '0.6.60 beta', homes, pluginHomes: [] })).toBe('EINVAL')
    expect(readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')).toBe(record)
    for (const vscode of [true, 660, '', '../x', '0.6.60 beta', 'v'.repeat(65)]) {
      writeFileSync(join(dataDir, DIAL_SETUP_FILE), JSON.stringify({ dial: true, vscode }))
      expect(readSetup(dataDir), String(vscode)).toEqual({ dial: true, homes, pluginHomes: [] })
    }
  })

  it('dial-setup.json keeps cursor as it keeps vscode: a version, or nothing', () => {
    const dataDir = aDataDir()
    const homes = { claude: [], codex: [] }
    expect(writeSetup(dataDir, { dial: true, vscode: '0.6.60', cursor: '0.6.60-dev.g0123', homes, pluginHomes: [] })).toBeUndefined()
    expect(readSetup(dataDir)).toEqual({ dial: true, vscode: '0.6.60', cursor: '0.6.60-dev.g0123', homes, pluginHomes: [] })
    const record = readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')
    // Saved, the extension would read as never set up in Cursor, and be installed again.
    expect(writeSetup(dataDir, { dial: true, cursor: '0.6.60 beta', homes, pluginHomes: [] })).toBe('EINVAL')
    expect(readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')).toBe(record)
    for (const cursor of [true, 660, '', '../x', '0.6.60 beta', 'v'.repeat(65)]) {
      writeFileSync(join(dataDir, DIAL_SETUP_FILE), JSON.stringify({ dial: true, cursor }))
      expect(readSetup(dataDir), String(cursor)).toEqual({ dial: true, homes, pluginHomes: [] })
    }
  })

  it('dial-setup.json keeps orca and orcaHeld as it keeps cursor: a version, or nothing', () => {
    const dataDir = aDataDir()
    const homes = { claude: [], codex: [] }
    expect(writeSetup(dataDir, { dial: true, cursor: '0.6.60', orca: '0.6.70', orcaHeld: '0.6.71', homes, pluginHomes: [] })).toBeUndefined()
    expect(readSetup(dataDir)).toEqual({ dial: true, cursor: '0.6.60', orca: '0.6.70', orcaHeld: '0.6.71', homes, pluginHomes: [] })
    const record = readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')
    // Saved, the plugin would read as never set up, or never held, and Orca would be run again.
    for (const field of ['orca', 'orcaHeld'] as const) {
      expect(writeSetup(dataDir, { dial: true, [field]: '0.6.60 beta', homes, pluginHomes: [] }), field).toBe('EINVAL')
      expect(readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')).toBe(record)
    }
    // A value that is no version drops that field alone.
    for (const value of [true, 660, '', '../x', '0.6.60 beta', 'v'.repeat(65)]) {
      writeFileSync(join(dataDir, DIAL_SETUP_FILE), JSON.stringify({ dial: true, orca: value, orcaHeld: '0.6.71' }))
      expect(readSetup(dataDir), `orca ${String(value)}`).toEqual({ dial: true, orcaHeld: '0.6.71', homes, pluginHomes: [] })
      writeFileSync(join(dataDir, DIAL_SETUP_FILE), JSON.stringify({ dial: true, orca: '0.6.70', orcaHeld: value }))
      expect(readSetup(dataDir), `orcaHeld ${String(value)}`).toEqual({ dial: true, orca: '0.6.70', homes, pluginHomes: [] })
    }
  })

  it('a file that is there but cannot be read says so, and a removal is not written over it', () => {
    const dataDir = aDataDir()
    writeRemoved(dataDir, 'codex', true)
    writeSetup(dataDir, { dial: true, plugin: '0.6.59', homes: { claude: [], codex: ['/a/skills'] }, pluginHomes: [] })
    const files = [DIAL_SKILL_FILE, DIAL_SETUP_FILE].map((name) => join(dataDir, name))
    // Stands for any read error: EACCES, EIO, EMFILE.
    for (const file of files) chmodSync(file, 0o000)

    expect(readSetup(dataDir)).toEqual({ ...empty, unread: true })
    expect(readRemoved(dataDir)).toEqual({ unread: true })
    // Codex's removal would be lost.
    expect(writeRemoved(dataDir, 'claude', true)).toBe('EACCES')

    for (const file of files) chmodSync(file, 0o600)
    expect(readRemoved(dataDir)).toEqual({ codex: true })
    // A missing file says nothing of the kind.
    rmSync(files[1])
    expect(readSetup(dataDir)).not.toHaveProperty('unread')
  })

  it('a plugin value a read would drop is not saved: the plugin would read as never set up', () => {
    const dataDir = aDataDir()
    const homes = { claude: [], codex: [] }
    writeSetup(dataDir, { dial: true, plugin: '0.6.59', homes, pluginHomes: [] })
    const record = readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')

    expect(writeSetup(dataDir, { dial: true, plugin: '0.6.59 beta', homes, pluginHomes: [] })).toBe('EINVAL')

    expect(readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')).toBe(record)
  })

  it('a file is on disk before it is renamed into place', () => {
    const dataDir = aDataDir()
    const calls: string[] = []
    const module = fs as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const name of ['fsyncSync', 'renameSync']) {
      const real = module[name]
      vi.spyOn(module, name).mockImplementation((...args) => {
        calls.push(name)
        return real(...args)
      })
    }

    expect(writeSetup(dataDir, { dial: true, homes: { claude: [], codex: [] }, pluginHomes: [] })).toBeUndefined()
    expect(writeRemoved(dataDir, 'codex', true)).toBeUndefined()

    expect(calls).toEqual(['fsyncSync', 'renameSync', 'fsyncSync', 'renameSync'])
  })

  it('a record past what a read takes is not written: a read would drop it whole', () => {
    const dataDir = aDataDir()
    writeSetup(dataDir, { dial: true, plugin: '0.6.59', homes: { claude: [], codex: [] }, pluginHomes: [] })
    const record = readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')
    // Listable, 1024 bytes, and every byte but the first one JSON escapes: two full lists outgrow 256 KiB.
    const escaped = Array.from({ length: 2 * MAX_HOMES }, (_, i) => `/${'\\'.repeat(i)}${'"'.repeat(1023 - i)}`)
    for (const path of escaped) expect(listable(path)).toBe(true)

    expect(writeSetup(dataDir, { dial: true, homes: { claude: escaped.slice(0, MAX_HOMES), codex: escaped.slice(MAX_HOMES) }, pluginHomes: [] })).toBe('EFBIG')

    expect(readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')).toBe(record)
    expect(readdirSync(dataDir)).toEqual([DIAL_SETUP_FILE])
  })

  it('a removal or a record that cannot be saved says its code and leaves the file', () => {
    const dataDir = aDataDir()
    writeRemoved(dataDir, 'codex', true)
    writeSetup(dataDir, { dial: true, homes: { claude: [], codex: [] }, pluginHomes: [] })
    const removed = readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8')
    const record = readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')
    chmodSync(dataDir, 0o500)
    expect(writeRemoved(dataDir, 'codex', false)).toBe('EACCES')
    expect(writeSetup(dataDir, { dial: true, plugin: '0.6.59', homes: { claude: [], codex: [] }, pluginHomes: [] })).toBe('EACCES')
    expect(readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8')).toBe(removed)
    expect(readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')).toBe(record)
    expect(readdirSync(dataDir).sort()).toEqual([DIAL_SETUP_FILE, DIAL_SKILL_FILE].sort())
  })
})

describe('the Orca homes Claude Code\'s plugin was turned on in', () => {
  const homesFile = (dataDir: string): Record<string, unknown> => JSON.parse(readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8'))
  const setupFile = (dataDir: string): Record<string, unknown> => JSON.parse(readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8'))
  /** [count] good, distinct Orca Claude Code homes. */
  const orcaHomes = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => `/Users/someone/Library/Application Support/orca/${i}/claude`)

  it('a record from #4399 reads with no plugin homes', () => {
    const dataDir = aDataDir()
    writeFileSync(join(dataDir, DIAL_SETUP_FILE), '{"dial":true,"plugin":"0.6.59","homes":{"claude":[],"codex":[]}}')
    writeFileSync(join(dataDir, DIAL_SKILL_FILE), '{"removed":{"codex":true},"homes":{"claude":[],"codex":["/a/skills"]}}')

    expect(readSetup(dataDir)).toEqual({ dial: true, plugin: '0.6.59', homes: { claude: [], codex: [] }, pluginHomes: [] })
    expect(readPluginHomes(dataDir)).toEqual({ homes: [] })
  })

  it('plugin homes are written and read back', () => {
    const dataDir = aDataDir()
    const homes = orcaHomes(2)

    expect(writeSetup(dataDir, { dial: true, plugin: '0.6.59', homes: { claude: [], codex: [] }, pluginHomes: homes })).toBeUndefined()
    expect(writePluginHomes(dataDir, homes.slice(1))).toBeUndefined()

    expect(readSetup(dataDir)).toEqual({ dial: true, plugin: '0.6.59', homes: { claude: [], codex: [] }, pluginHomes: homes })
    expect(readPluginHomes(dataDir)).toEqual({ homes: homes.slice(1) })
    expect(statSync(join(dataDir, DIAL_SKILL_FILE)).mode & 0o777).toBe(0o600)
    // Emptied, the command's list leaves its file, as its skills folders do.
    expect(writePluginHomes(dataDir, [])).toBeUndefined()
    expect(homesFile(dataDir)).toEqual({})
  })

  it('a damaged plugin homes list keeps only what it may hold', () => {
    const dataDir = aDataDir()
    const good = orcaHomes(70)
    const damaged = ['relative/claude', good[0], '/Users/some\u0007one/claude', 42, null, good[0], ...good.slice(1)]
    const kept = good.slice(0, MAX_HOMES)
    writeFileSync(join(dataDir, DIAL_SETUP_FILE), JSON.stringify({ dial: true, pluginHomes: damaged }))
    writeFileSync(join(dataDir, DIAL_SKILL_FILE), JSON.stringify({ pluginHomes: damaged }))

    expect(readSetup(dataDir).pluginHomes).toEqual(kept)
    expect(readPluginHomes(dataDir)).toEqual({ homes: kept })

    // Each file is written as a read keeps it.
    const asGiven = damaged as string[]
    expect(writeSetup(dataDir, { dial: true, homes: { claude: [], codex: [] }, pluginHomes: asGiven })).toBeUndefined()
    expect(writePluginHomes(dataDir, asGiven)).toBeUndefined()
    expect(setupFile(dataDir).pluginHomes).toEqual(kept)
    expect(homesFile(dataDir).pluginHomes).toEqual(kept)

    // One that is no list is none.
    writeFileSync(join(dataDir, DIAL_SETUP_FILE), JSON.stringify({ dial: true, pluginHomes: good[0] }))
    writeFileSync(join(dataDir, DIAL_SKILL_FILE), JSON.stringify({ pluginHomes: { claude: good } }))
    expect(readSetup(dataDir).pluginHomes).toEqual([])
    expect(readPluginHomes(dataDir)).toEqual({ homes: [] })
  })

  it('three full lists of the longest paths are written and read back: each file holds three', () => {
    const dataDir = aDataDir()
    const full = (list: number): string[] =>
      Array.from({ length: MAX_HOMES }, (_, i) => `/${String(list * MAX_HOMES + i).padStart(3, '0')}${'a'.repeat(1020)}`)
    const record = { dial: true, plugin: '0.6.59', homes: { claude: full(0), codex: full(1) }, pluginHomes: full(2) }

    expect(writeSetup(dataDir, record)).toBeUndefined()
    expect(writeRemoved(dataDir, 'claude', false, full(0))).toBeUndefined()
    expect(writeRemoved(dataDir, 'codex', true, full(1))).toBeUndefined()
    expect(writePluginHomes(dataDir, full(2))).toBeUndefined()

    expect(readSetup(dataDir)).toEqual(record)
    expect(readWritten(dataDir)).toEqual(record.homes)
    expect(readPluginHomes(dataDir)).toEqual({ homes: record.pluginHomes })
  })

  it('the command\'s plugin homes are kept by every write of dial-skill.json', () => {
    const dataDir = aDataDir()
    const homes = orcaHomes(2)
    expect(writePluginHomes(dataDir, homes)).toBeUndefined()

    expect(writeRemoved(dataDir, 'claude', true)).toBeUndefined()
    expect(writeRemoved(dataDir, 'codex', false, ['/a/skills'])).toBeUndefined()

    expect(homesFile(dataDir)).toEqual({ removed: { claude: true }, homes: { claude: [], codex: ['/a/skills'] }, pluginHomes: homes })

    // And the list's own write keeps the removal and the folders.
    expect(writePluginHomes(dataDir, homes.slice(1))).toBeUndefined()
    expect(homesFile(dataDir)).toEqual({ removed: { claude: true }, homes: { claude: [], codex: ['/a/skills'] }, pluginHomes: homes.slice(1) })
  })

  // Root reads a file whatever its mode.
  it.skipIf(process.getuid?.() === 0)('an unreadable dial-skill.json reads as unread and is not written', () => {
    const dataDir = aDataDir()
    expect(writeRemoved(dataDir, 'codex', true)).toBeUndefined()
    const file = join(dataDir, DIAL_SKILL_FILE)
    const before = readFileSync(file, 'utf8')
    // Stands for any read error: EACCES, EIO, EMFILE.
    chmodSync(file, 0o000)

    expect(readPluginHomes(dataDir)).toEqual({ homes: [], unread: true })
    // Codex's removal would be lost.
    expect(writePluginHomes(dataDir, orcaHomes(1))).toBe('EACCES')

    chmodSync(file, 0o600)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})

describe('that Orca was connected', () => {
  const skillFile = (dataDir: string): Record<string, unknown> => JSON.parse(readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8'))

  it('a missing file reads not connected; once written it reads connected, 0600', () => {
    const dataDir = aDataDir()
    expect(readOrcaConnected(dataDir)).toEqual({ connected: false })

    expect(writeOrcaConnected(dataDir)).toBeUndefined()

    expect(readOrcaConnected(dataDir)).toEqual({ connected: true })
    expect(skillFile(dataDir)).toEqual({ orcaConnected: true })
    expect(statSync(join(dataDir, DIAL_SKILL_FILE)).mode & 0o777).toBe(0o600)
  })

  it('only true counts', () => {
    const dataDir = aDataDir()
    for (const orcaConnected of ['yes', 1, false]) {
      writeFileSync(join(dataDir, DIAL_SKILL_FILE), JSON.stringify({ orcaConnected }))
      expect(readOrcaConnected(dataDir), String(orcaConnected)).toEqual({ connected: false })
    }
  })

  it('every other write of dial-skill.json keeps it', () => {
    const dataDir = aDataDir()
    const home = '/Users/someone/Library/Application Support/orca/0/claude'
    expect(writeOrcaConnected(dataDir)).toBeUndefined()

    expect(writeRemoved(dataDir, 'vscode', true)).toBeUndefined()
    expect(readOrcaConnected(dataDir)).toEqual({ connected: true })
    expect(writeRemoved(dataDir, 'claude', false, ['/a/skills'])).toBeUndefined()
    expect(readOrcaConnected(dataDir)).toEqual({ connected: true })
    expect(writePluginHomes(dataDir, [home])).toBeUndefined()
    expect(readOrcaConnected(dataDir)).toEqual({ connected: true })

    // And its own write keeps the removals, the folders and the plugin homes.
    expect(writeOrcaConnected(dataDir)).toBeUndefined()
    expect(skillFile(dataDir)).toEqual({ removed: { vscode: true }, homes: { claude: ['/a/skills'], codex: [] }, pluginHomes: [home], orcaConnected: true })
  })

  // Root reads a file whatever its mode.
  it.skipIf(process.getuid?.() === 0)('a file that cannot be read says so, and is not written over', () => {
    const dataDir = aDataDir()
    expect(writeRemoved(dataDir, 'codex', true)).toBeUndefined()
    const file = join(dataDir, DIAL_SKILL_FILE)
    const before = readFileSync(file, 'utf8')
    // Stands for any read error: EACCES, EIO, EMFILE.
    chmodSync(file, 0o000)

    // Read as never connected, Harness would offer Orca's plugin again to a person who removed it.
    expect(readOrcaConnected(dataDir)).toEqual({ connected: false, unread: true })
    // Codex's removal would be lost.
    expect(writeOrcaConnected(dataDir)).toBe('EACCES')

    chmodSync(file, 0o600)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})

describe('a file that cannot be parsed', () => {
  const empty = { dial: false, homes: { claude: [], codex: [] }, pluginHomes: [] }
  const setAside = (base: string): string => `[state] ${base} could not be read (not valid JSON); kept as ${base}.unreadable, starting empty.`
  const home = '/Users/someone/Library/Application Support/orca/0/claude'

  it('a torn dial-skill.json is set aside, not written over', () => {
    const dataDir = aDataDir()
    const file = join(dataDir, DIAL_SKILL_FILE)
    // What a reader saw while another process was writing it.
    writeFileSync(file, '{"homes":')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(writePluginHomes(dataDir, [home])).toBeUndefined()

    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('{"homes":')
    expect(readPluginHomes(dataDir)).toEqual({ homes: [home] })
    expect(warn).toHaveBeenCalledWith(setAside(DIAL_SKILL_FILE))
  })

  it('a torn dial-setup.json is set aside, not written over', () => {
    const dataDir = aDataDir()
    const file = join(dataDir, DIAL_SETUP_FILE)
    writeFileSync(file, '{"dial":')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const record = { dial: true, plugin: '0.6.59', homes: { claude: [], codex: [] }, pluginHomes: [home] }

    expect(readSetup(dataDir)).toEqual(empty)
    expect(writeSetup(dataDir, record)).toBeUndefined()

    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('{"dial":')
    expect(readSetup(dataDir)).toEqual(record)
    expect(warn).toHaveBeenCalledWith(setAside(DIAL_SETUP_FILE))
  })

  // The first read saw a torn file, the read again failed (EMFILE): nothing says what the file holds now.
  it('a torn dial-skill.json whose read again fails is left as it is', () => {
    const dataDir = aDataDir()
    const file = join(dataDir, DIAL_SKILL_FILE)
    writeFileSync(file, '{"homes":')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const read = fs.readFileSync
    const failing = vi.spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (path === file) throw Object.assign(new Error('EMFILE: fixture'), { code: 'EMFILE' })
      return (read as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof fs.readFileSync)

    expect(readPluginHomes(dataDir)).toEqual({ homes: [], unread: true })
    expect(writePluginHomes(dataDir, [home])).toBe('EMFILE')

    failing.mockRestore()
    expect(readdirSync(dataDir)).toEqual([DIAL_SKILL_FILE])
    expect(readFileSync(file, 'utf8')).toBe('{"homes":')
  })

  it('a file past the bound reads as today', () => {
    const dataDir = aDataDir()
    // Torn as well: past the bound it is not read, so not parsed either.
    const torn = `{"pad":"${'x'.repeat(256 * 1024)}`
    for (const name of [DIAL_SKILL_FILE, DIAL_SETUP_FILE]) writeFileSync(join(dataDir, name), torn)

    expect(readPluginHomes(dataDir)).toEqual({ homes: [] })
    expect(readSetup(dataDir)).toEqual(empty)

    expect(readdirSync(dataDir).sort()).toEqual([DIAL_SETUP_FILE, DIAL_SKILL_FILE])
    for (const name of [DIAL_SKILL_FILE, DIAL_SETUP_FILE]) expect(readFileSync(join(dataDir, name), 'utf8')).toBe(torn)
  })
})
