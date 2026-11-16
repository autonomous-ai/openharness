/**
 * The two files of the dial skill, in a throwaway data folder each: whether each engine is On, and the skills folders
 * Harness wrote into. A later Turn off removes from every folder the list holds, so a damaged or hand-edited list must
 * read as nothing it may not hold.
 */
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DIAL_SKILL_FILE, DIAL_SKILL_HOMES_FILE, MAX_HOMES, listable, readAnswers, readHomes, readWritten, writeAnswer, writeHomes } from './dialSkillFiles.js'

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
