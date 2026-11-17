/**
 * The two files of the dial skill, in a throwaway data folder each: whether each engine is On, and the skills folders
 * Harness wrote into. A later Turn off removes from every folder the list holds, so a damaged or hand-edited list must
 * read as nothing it may not hold.
 */
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DIAL_SETUP_FILE, DIAL_SKILL_FILE, DIAL_SKILL_HOMES_FILE, MAX_HOMES, listable, readAnswers, readHomes, readRemoved, readSetup, readWritten, writeAnswer, writeHomes, writeRemoved, writeSetup } from './dialSkillFiles.js'

const folders: string[] = []
afterEach(() => {
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

describe('whether each engine is On', () => {
  it('answers: missing, bad or oversized reads as no answer', () => {
    const dataDir = aDataDir()
    expect(readAnswers(dataDir)).toEqual({})
    for (const text of ['not json', '[]', 'null', '{"claude":"yes","codex":1}']) {
      writeFileSync(join(dataDir, DIAL_SKILL_FILE), text)
      expect(readAnswers(dataDir)).toEqual({})
    }
    // Good answers, padded one byte past the bound: two full lists of the command's folders fit under it.
    const answers = '{"claude":true,"codex":true,"pad":""}'
    writeFileSync(join(dataDir, DIAL_SKILL_FILE), answers.replace('""', `"${'x'.repeat(256 * 1024 + 1 - answers.length)}"`))
    expect(readAnswers(dataDir)).toEqual({})
    // At the bound it still reads.
    writeFileSync(join(dataDir, DIAL_SKILL_FILE), answers.replace('""', `"${'x'.repeat(256 * 1024 - answers.length)}"`))
    expect(readAnswers(dataDir)).toEqual({ claude: true, codex: true })
  })

  it('only a boolean is an answer, engine by engine', () => {
    const dataDir = aDataDir()
    writeFileSync(join(dataDir, DIAL_SKILL_FILE), '{"claude":false,"codex":"true"}')
    expect(readAnswers(dataDir)).toEqual({ claude: false })
  })

  it("an answer is written whole, 0600, and keeps the other engine's", () => {
    const dataDir = aDataDir()
    expect(writeAnswer(dataDir, 'codex', true)).toBeUndefined()
    expect(readAnswers(dataDir)).toEqual({ codex: true })
    expect(writeAnswer(dataDir, 'claude', false)).toBeUndefined()
    expect(readAnswers(dataDir)).toEqual({ claude: false, codex: true })
    expect(JSON.parse(readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8'))).toEqual({ claude: false, codex: true })
    expect(statSync(join(dataDir, DIAL_SKILL_FILE)).mode & 0o777).toBe(0o600)
    // The temp file it wrote first is gone.
    expect(readdirSync(dataDir)).toEqual([DIAL_SKILL_FILE])
  })

  it('the command\'s folders: saved with an answer, kept by the next, read like a list', () => {
    const dataDir = aDataDir()
    expect(readWritten(dataDir)).toEqual({ claude: [], codex: [] })
    expect(writeAnswer(dataDir, 'codex', true, ['/Users/someone/.codex/skills'])).toBeUndefined()
    expect(writeAnswer(dataDir, 'claude', true, ['/Users/someone/.claude/skills', 'relative/skills', '/Users/someone/.claude/skills'])).toBeUndefined()
    // An answer given no folders keeps them.
    expect(writeAnswer(dataDir, 'codex', false)).toBeUndefined()
    expect(readAnswers(dataDir)).toEqual({ claude: true, codex: false })
    expect(readWritten(dataDir)).toEqual({ claude: ['/Users/someone/.claude/skills'], codex: ['/Users/someone/.codex/skills'] })
    // Emptied, the file holds the answers alone.
    writeAnswer(dataDir, 'claude', false, [])
    writeAnswer(dataDir, 'codex', false, [])
    expect(JSON.parse(readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8'))).toEqual({ claude: false, codex: false })
    // Two full lists of the longest paths read back whole, 64 an engine.
    const longest = Array.from({ length: 70 }, (_, i) => `/${String(i).padStart(2, '0')}${'a'.repeat(1021)}`)
    expect(Buffer.byteLength(longest[0])).toBe(1024)
    writeAnswer(dataDir, 'claude', true, longest)
    writeAnswer(dataDir, 'codex', true, longest)
    expect(readWritten(dataDir)).toEqual({ claude: longest.slice(0, MAX_HOMES), codex: longest.slice(0, MAX_HOMES) })
    expect(readAnswers(dataDir)).toEqual({ claude: true, codex: true })
  })

  it('a write that fails says its code and leaves the file', () => {
    const dataDir = aDataDir()
    writeAnswer(dataDir, 'claude', true)
    writeHomes(dataDir, { claude: ['/Users/someone/.claude/skills'], codex: [] })
    const answers = readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8')
    const homes = readFileSync(join(dataDir, DIAL_SKILL_HOMES_FILE), 'utf8')
    chmodSync(dataDir, 0o500)
    expect(writeAnswer(dataDir, 'claude', false)).toBe('EACCES')
    expect(writeHomes(dataDir, { claude: [], codex: [] })).toBe('EACCES')
    expect(readFileSync(join(dataDir, DIAL_SKILL_FILE), 'utf8')).toBe(answers)
    expect(readFileSync(join(dataDir, DIAL_SKILL_HOMES_FILE), 'utf8')).toBe(homes)
    expect(readdirSync(dataDir).sort()).toEqual([DIAL_SKILL_FILE, DIAL_SKILL_HOMES_FILE].sort())
  })
})

describe('the skills folders Harness wrote into', () => {
  it('homes: only absolute, normalised paths, at most 64 an engine', () => {
    const dataDir = aDataDir()
    expect(readHomes(dataDir)).toEqual({ claude: [], codex: [] })
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
    writeFileSync(join(dataDir, DIAL_SKILL_HOMES_FILE), JSON.stringify({
      claude: [bad[0], kept[0], ...bad.slice(1), kept[0], ...kept.slice(1)],
      codex: 'not a list',
    }))
    expect(readHomes(dataDir)).toEqual({ claude: kept.slice(0, MAX_HOMES), codex: [] })
    expect(MAX_HOMES).toBe(64)
    // A path of exactly 1024 bytes is kept.
    const longest = `/${'a'.repeat(1023)}`
    writeFileSync(join(dataDir, DIAL_SKILL_HOMES_FILE), JSON.stringify({ claude: [], codex: [longest] }))
    expect(readHomes(dataDir)).toEqual({ claude: [], codex: [longest] })
  })

  it('listable: the one check of a path a list holds', () => {
    for (const path of ['/Users/someone/.codex/skills', '/Users/someone/Library/Application Support/orca/ä/skills', `/${'a'.repeat(1023)}`]) {
      expect(listable(path), path).toBe(true)
    }
    for (const path of ['relative/skills', '/Users/someone/../skills', '/Users/someone/skills/', '/Users/some\u0085one/skills', `/${'é'.repeat(600)}`]) {
      expect(listable(path), JSON.stringify(path)).toBe(false)
    }
  })

  it('homes: a list that is not one reads as two empty lists', () => {
    const dataDir = aDataDir()
    for (const text of ['{', '[]', 'null', '"/Users/someone/skills"']) {
      writeFileSync(join(dataDir, DIAL_SKILL_HOMES_FILE), text)
      expect(readHomes(dataDir)).toEqual({ claude: [], codex: [] })
    }
    // Good homes, padded past 256 KiB.
    writeFileSync(join(dataDir, DIAL_SKILL_HOMES_FILE), JSON.stringify({ claude: goodHomes(1), codex: [], pad: 'x'.repeat(256 * 1024) }))
    expect(readHomes(dataDir)).toEqual({ claude: [], codex: [] })
  })

  it('homes are written whole, 0600', () => {
    const dataDir = aDataDir()
    const homes = { claude: ['/Users/someone/.claude/skills'], codex: ['/Users/someone/.codex/skills', '/Volumes/work/codex home/skills'] }
    expect(writeHomes(dataDir, homes)).toBeUndefined()
    expect(readHomes(dataDir)).toEqual(homes)
    expect(statSync(join(dataDir, DIAL_SKILL_HOMES_FILE)).mode & 0o777).toBe(0o600)
    expect(readdirSync(dataDir)).toEqual([DIAL_SKILL_HOMES_FILE])
    // A full list keeps its first 64, so the file never holds more than a read keeps.
    const many = goodHomes(70)
    expect(writeHomes(dataDir, { claude: many, codex: [] })).toBeUndefined()
    expect(readHomes(dataDir)).toEqual({ claude: many.slice(0, MAX_HOMES), codex: [] })
    expect(JSON.parse(readFileSync(join(dataDir, DIAL_SKILL_HOMES_FILE), 'utf8')).claude).toHaveLength(MAX_HOMES)
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
