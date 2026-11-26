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

  it('on a computer where the daemon never ran, every write makes the data folder first, 0700', () => {
    // Each write, then what a read of its folder finds.
    const writes: Array<[string, (dataDir: string) => string | undefined, (dataDir: string) => unknown, unknown]> = [
      ['writeRemoved', (dataDir) => writeRemoved(dataDir, 'claude', false, ['/Users/someone/.claude/skills']),
        (dataDir) => readWritten(dataDir).claude, ['/Users/someone/.claude/skills']],
      ['writePluginHomes', (dataDir) => writePluginHomes(dataDir, ['/Users/someone/orca/home']),
        (dataDir) => readPluginHomes(dataDir).homes, ['/Users/someone/orca/home']],
      ['writeOrcaConnected', writeOrcaConnected, (dataDir) => readOrcaConnected(dataDir).connected, true],
      ['writeSetup', (dataDir) => writeSetup(dataDir, { dial: true, homes: { claude: [], codex: [] }, pluginHomes: [] }),
        (dataDir) => readSetup(dataDir).dial, true],
    ]
    for (const [name, write, read, found] of writes) {
      const dataDir = join(aDataDir(), 'harness', 'data')
      expect(write(dataDir), name).toBeUndefined()
      expect(read(dataDir), name).toEqual(found)
      expect(statSync(dataDir).mode & 0o777, name).toBe(0o700)
      expect(statSync(join(dataDir, '..')).mode & 0o777, name).toBe(0o700)
    }
  })
})
