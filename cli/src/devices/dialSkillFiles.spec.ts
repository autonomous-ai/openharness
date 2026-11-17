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
import { DIAL_SETUP_FILE, DIAL_SKILL_FILE, MAX_HOMES, listable, readRemoved, readSetup, readWritten, writeRemoved, writeSetup } from './dialSkillFiles.js'

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
    writeFileSync(join(dataDir, DIAL_SKILL_FILE), '{"removed":{"claude":"yes","codex":true}}')
    expect(readRemoved(dataDir)).toEqual({ codex: true })
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
})

describe('the devices\' record of a dial\'s setup', () => {
  const empty = { dial: false, homes: { claude: [], codex: [] } }

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
    expect(writeSetup(dataDir, { dial: true, plugin: '0.6.59', homes: { claude: ['relative/skills', ...many], codex: ['/Users/someone/.codex/skills'] } })).toBeUndefined()
    const record = { dial: true, plugin: '0.6.59', homes: { claude: many.slice(0, MAX_HOMES), codex: ['/Users/someone/.codex/skills'] } }
    expect(readSetup(dataDir)).toEqual(record)
    // The file holds no more than a read keeps.
    expect(JSON.parse(readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8'))).toEqual(record)
    expect(statSync(join(dataDir, DIAL_SETUP_FILE)).mode & 0o777).toBe(0o600)
    expect(readdirSync(dataDir)).toEqual([DIAL_SETUP_FILE])
    // A record with no plugin holds none.
    writeSetup(dataDir, { dial: true, homes: { claude: [], codex: [] } })
    expect(JSON.parse(readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8'))).toEqual({ dial: true, homes: { claude: [], codex: [] } })
  })

  it('a plugin value that is no version is dropped', () => {
    const dataDir = aDataDir()
    for (const plugin of [true, 659, '', '../x', '0.6.59 beta', 'v'.repeat(65)]) {
      writeFileSync(join(dataDir, DIAL_SETUP_FILE), JSON.stringify({ dial: true, plugin }))
      expect(readSetup(dataDir), String(plugin)).toEqual({ dial: true, homes: { claude: [], codex: [] } })
    }
    for (const plugin of ['0.6.59', '0.6.59-dev.3+1a2b', 'v'.repeat(64)]) {
      writeFileSync(join(dataDir, DIAL_SETUP_FILE), JSON.stringify({ dial: true, plugin }))
      expect(readSetup(dataDir).plugin, plugin).toBe(plugin)
    }
  })

  it('a file that is there but cannot be read says so, and a removal is not written over it', () => {
    const dataDir = aDataDir()
    writeRemoved(dataDir, 'codex', true)
    writeSetup(dataDir, { dial: true, plugin: '0.6.59', homes: { claude: [], codex: ['/a/skills'] } })
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
    writeSetup(dataDir, { dial: true, plugin: '0.6.59', homes })
    const record = readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')

    expect(writeSetup(dataDir, { dial: true, plugin: '0.6.59 beta', homes })).toBe('EINVAL')

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

    expect(writeSetup(dataDir, { dial: true, homes: { claude: [], codex: [] } })).toBeUndefined()
    expect(writeRemoved(dataDir, 'codex', true)).toBeUndefined()

    expect(calls).toEqual(['fsyncSync', 'renameSync', 'fsyncSync', 'renameSync'])
  })

  it('a record past what a read takes is not written: a read would drop it whole', () => {
    const dataDir = aDataDir()
    writeSetup(dataDir, { dial: true, plugin: '0.6.59', homes: { claude: [], codex: [] } })
    const record = readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')
    // Listable, 1024 bytes, and every byte but the first one JSON escapes: two full lists outgrow 256 KiB.
    const escaped = Array.from({ length: 2 * MAX_HOMES }, (_, i) => `/${'\\'.repeat(i)}${'"'.repeat(1023 - i)}`)
    for (const path of escaped) expect(listable(path)).toBe(true)

    expect(writeSetup(dataDir, { dial: true, homes: { claude: escaped.slice(0, MAX_HOMES), codex: escaped.slice(MAX_HOMES) } })).toBe('EFBIG')

    expect(readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')).toBe(record)
    expect(readdirSync(dataDir)).toEqual([DIAL_SETUP_FILE])
  })

  it('a removal or a record that cannot be saved says its code and leaves the file', () => {
    const dataDir = aDataDir()
    writeRemoved(dataDir, 'codex', true)
    writeSetup(dataDir, { dial: true, homes: { claude: [], codex: [] } })
    const removed = readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8')
    const record = readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')
    chmodSync(dataDir, 0o500)
    expect(writeRemoved(dataDir, 'codex', false)).toBe('EACCES')
    expect(writeSetup(dataDir, { dial: true, plugin: '0.6.59', homes: { claude: [], codex: [] } })).toBe('EACCES')
    expect(readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8')).toBe(removed)
    expect(readFileSync(join(dataDir, DIAL_SETUP_FILE), 'utf8')).toBe(record)
    expect(readdirSync(dataDir).sort()).toEqual([DIAL_SETUP_FILE, DIAL_SKILL_FILE].sort())
  })
})
