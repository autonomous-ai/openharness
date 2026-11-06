import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { carryClaudeTranscript } from './claudeTranscriptCarry.js'

const ID = '0a1b2c3d-1111-2222-3333-444455556666'
const CWD = '/work/my.app'
const FOLDER = '-work-my-app'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'carry-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** A throwaway Claude home holding one session; never the developer's own ~/.claude. */
function home(name: string, folder = FOLDER): string {
  const path = join(root, name)
  mkdirSync(join(path, 'projects', folder), { recursive: true })
  return path
}
const writeSession = (from: string, folder = FOLDER) => writeFileSync(join(from, 'projects', folder, `${ID}.jsonl`), '{"turn":1}\n')

describe('carrying a Claude transcript between accounts', () => {
  it("copies the session file into the other account's projects", () => {
    const from = home('a'), to = join(root, 'b')
    writeSession(from)
    const carried = carryClaudeTranscript(from, to, CWD, ID)
    expect(carried).toEqual({ transcriptPath: join(to, 'projects', FOLDER, `${ID}.jsonl`), copied: true })
    expect(readFileSync(carried.transcriptPath, 'utf8')).toBe('{"turn":1}\n')
    expect(existsSync(join(from, 'projects', FOLDER, `${ID}.jsonl`))).toBe(true)
  })

  it('finds the folder by listing when the cwd encoding differs, and replaces an older copy', () => {
    const from = home('a', 'some-other-encoding'), to = home('b', 'some-other-encoding')
    writeSession(from, 'some-other-encoding')
    writeFileSync(join(to, 'projects', 'some-other-encoding', `${ID}.jsonl`), 'stale')
    const carried = carryClaudeTranscript(from, to, CWD, ID)
    expect(carried.copied).toBe(true)
    expect(readFileSync(carried.transcriptPath, 'utf8')).toBe('{"turn":1}\n')
  })

  it('same projects folder copies nothing', () => {
    const from = home('a'), to = join(root, 'orca')
    mkdirSync(to)
    symlinkSync(join(from, 'projects'), join(to, 'projects'))
    writeSession(from)
    expect(carryClaudeTranscript(from, to, CWD, ID)).toEqual({ transcriptPath: join(from, 'projects', FOLDER, `${ID}.jsonl`), copied: false })
  })

  it('a missing session file throws NOT_FOUND', () => {
    const from = home('a')
    expect(() => carryClaudeTranscript(from, join(root, 'b'), CWD, ID)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => carryClaudeTranscript(join(root, 'none'), join(root, 'b'), CWD, ID)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => carryClaudeTranscript(from, join(root, 'b'), CWD, '../escape')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it.each([false, true])('refuses a linked session file (shared projects: %s)', (shared) => {
    const from = home('a'), to = join(root, 'b')
    const outside = join(root, 'unrelated.json')
    writeFileSync(outside, 'unrelated data')
    const source = join(from, 'projects', FOLDER, `${ID}.jsonl`)
    symlinkSync(outside, source)
    if (shared) {
      mkdirSync(to)
      symlinkSync(join(from, 'projects'), join(to, 'projects'), 'junction')
    }

    expect(() => carryClaudeTranscript(from, to, CWD, ID)).toThrow()
    expect(lstatSync(source).isSymbolicLink()).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('unrelated data')
    if (!shared) expect(existsSync(join(to, 'projects', FOLDER, `${ID}.jsonl`))).toBe(false)
  })

  it('refuses a non-file source without exposing its path in the error', () => {
    const from = home('a'), to = join(root, 'b')
    mkdirSync(join(from, 'projects', FOLDER, `${ID}.jsonl`))

    expect(() => carryClaudeTranscript(from, to, CWD, ID)).toThrow(expect.objectContaining({ message: expect.not.stringContaining(root) }))
    expect(existsSync(join(to, 'projects', FOLDER, `${ID}.jsonl`))).toBe(false)
  })

  it.each([FOLDER, 'some-other-encoding'])('refuses a linked source project child: %s', (folder) => {
    const from = join(root, 'a'), to = join(root, 'b')
    const outside = join(root, 'unrelated-project')
    mkdirSync(join(from, 'projects'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, `${ID}.jsonl`), 'unrelated data')
    symlinkSync(outside, join(from, 'projects', folder), 'junction')

    expect(() => carryClaudeTranscript(from, to, CWD, ID)).toThrow()
    expect(existsSync(join(to, 'projects', folder, `${ID}.jsonl`))).toBe(false)
    expect(readFileSync(join(outside, `${ID}.jsonl`), 'utf8')).toBe('unrelated data')
  })

  it('refuses a linked target project child without writing outside projects', () => {
    const from = home('a'), to = join(root, 'b')
    const outside = join(root, 'unrelated-project')
    writeSession(from)
    mkdirSync(join(to, 'projects'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, `${ID}.jsonl`), 'unrelated data')
    symlinkSync(outside, join(to, 'projects', FOLDER), 'junction')

    expect(() => carryClaudeTranscript(from, to, CWD, ID)).toThrow()
    expect(readFileSync(join(outside, `${ID}.jsonl`), 'utf8')).toBe('unrelated data')
    expect(readFileSync(join(from, 'projects', FOLDER, `${ID}.jsonl`), 'utf8')).toBe('{"turn":1}\n')
  })

  it.each(['link', 'dangling link', 'directory'])('refuses a target session that is a %s', (kind) => {
    const from = home('a'), to = home('b')
    const target = join(to, 'projects', FOLDER, `${ID}.jsonl`)
    const outside = join(root, 'unrelated.json')
    writeSession(from)
    if (kind === 'directory') mkdirSync(target)
    else {
      if (kind === 'link') writeFileSync(outside, 'unrelated data')
      symlinkSync(outside, target)
    }

    expect(() => carryClaudeTranscript(from, to, CWD, ID)).toThrow()
    expect(lstatSync(target).isDirectory()).toBe(kind === 'directory')
    expect(lstatSync(target).isSymbolicLink()).toBe(kind !== 'directory')
    if (kind === 'link') expect(readFileSync(outside, 'utf8')).toBe('unrelated data')
    expect(readdirSync(join(to, 'projects', FOLDER))).toEqual([`${ID}.jsonl`])
  })

  it('leaves a planted predictable temporary link and its destination untouched', () => {
    const from = home('a'), to = home('b')
    const target = join(to, 'projects', FOLDER, `${ID}.jsonl`)
    const planted = `${target}.${process.pid}.tmp`
    const outside = join(root, 'unrelated.json')
    writeSession(from)
    writeFileSync(outside, 'unrelated data')
    symlinkSync(outside, planted)

    expect(carryClaudeTranscript(from, to, CWD, ID)).toEqual({ transcriptPath: target, copied: true })
    expect(readFileSync(outside, 'utf8')).toBe('unrelated data')
    expect(lstatSync(planted).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('{"turn":1}\n')
    expect(readdirSync(join(to, 'projects', FOLDER)).sort()).toEqual([`${ID}.jsonl`, `${ID}.jsonl.${process.pid}.tmp`].sort())
  })

  it.skipIf(process.platform === 'win32')('publishes a private copy without changing source permissions', () => {
    const from = home('a'), to = home('b')
    writeSession(from)
    const source = join(from, 'projects', FOLDER, `${ID}.jsonl`)
    chmodSync(source, 0o644)

    const carried = carryClaudeTranscript(from, to, CWD, ID)
    expect(statSync(carried.transcriptPath).mode & 0o777).toBe(0o600)
    expect(statSync(source).mode & 0o777).toBe(0o644)
  })

  it('publishes the whole replacement without modifying the previous file', () => {
    const from = home('a'), to = home('b')
    const target = join(to, 'projects', FOLDER, `${ID}.jsonl`)
    const previous = join(root, 'previous.jsonl')
    const transcript = '{"turn":"' + 'x'.repeat(200_000) + '"}\n'
    writeFileSync(join(from, 'projects', FOLDER, `${ID}.jsonl`), transcript)
    writeFileSync(target, 'previous transcript')
    linkSync(target, previous)

    const carried = carryClaudeTranscript(from, to, CWD, ID)
    expect(readFileSync(carried.transcriptPath, 'utf8')).toBe(transcript)
    expect(readFileSync(previous, 'utf8')).toBe('previous transcript')
    expect(readFileSync(join(from, 'projects', FOLDER, `${ID}.jsonl`), 'utf8')).toBe(transcript)
    expect(readdirSync(join(to, 'projects', FOLDER))).toEqual([`${ID}.jsonl`])
  })

  it('copies through a supported shared projects root when the roots differ', () => {
    const from = home('a'), to = join(root, 'b'), shared = home('shared')
    writeSession(from)
    mkdirSync(to)
    symlinkSync(join(shared, 'projects'), join(to, 'projects'), 'junction')

    const carried = carryClaudeTranscript(from, to, CWD, ID)
    expect(carried.copied).toBe(true)
    expect(readFileSync(carried.transcriptPath, 'utf8')).toBe('{"turn":1}\n')
    expect(readFileSync(join(shared, 'projects', FOLDER, `${ID}.jsonl`), 'utf8')).toBe('{"turn":1}\n')
  })

  it('reports a filesystem failure without exposing account paths', () => {
    const from = home('a'), to = join(root, 'not-a-directory')
    writeSession(from)
    writeFileSync(to, 'unrelated data')

    expect(() => carryClaudeTranscript(from, to, CWD, ID)).toThrow(expect.objectContaining({ message: expect.not.stringContaining(root) }))
    expect(readFileSync(to, 'utf8')).toBe('unrelated data')
  })

  it('the default account is the daemon projects folder', async () => {
    const own = home('default')
    writeSession(own)
    const { env } = await import('../config/env.js')
    const was = env.CLAUDE_PROJECTS_DIR
    env.CLAUDE_PROJECTS_DIR = join(own, 'projects')
    try {
      const to = join(root, 'b')
      expect(carryClaudeTranscript(undefined, to, CWD, ID).copied).toBe(true)
      expect(carryClaudeTranscript(to, undefined, CWD, ID)).toMatchObject({ copied: true, transcriptPath: join(own, 'projects', FOLDER, `${ID}.jsonl`) })
    } finally { env.CLAUDE_PROJECTS_DIR = was }
  })
})
